// API service: logins and accounts. Stateless (users and logins live in Postgres), so it
// scales horizontally.
//
//   GET  /api/auth/config           which sign-in methods are offered: { github, dev }
//   GET  /api/auth/github           start signing in with GitHub (redirects there)
//   GET  /api/auth/github/callback  GitHub sends the browser back here; sets the login cookie
//   GET  /api/auth/dev?name=        development sign-in, only with DEV_LOGIN=1
//   GET  /api/me                    the signed-in user, or 401
//   POST /api/logout                sign out
//   GET  /api/agents                the signed-in user's kept agents, per plan
//
// GitHub's OAuth web flow: the browser is sent to GitHub with a random `state`, also kept in
// a short-lived HttpOnly cookie; the callback must bring the same state back, so another site
// cannot complete a sign-in for you. Only the user's public profile is asked for (no scopes).
//
// Environment: PORT (8080), DATABASE_URL, PUBLIC_URL (where browsers reach the site, for
// GitHub's redirect), GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, DEV_LOGIN=1 for
// development sign-in.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Accounts, MemoryAccounts, SESSION_COOKIE, SESSION_DAYS, cookie, parseCookies } from '@pixel-map-lab/accounts';

const STATE_COOKIE = 'pml_oauth_state';
const STATE_SECONDS = 600;
const AFTER_SIGN_IN = '/play/';

/** GitHub's OAuth endpoints, replaceable in tests. */
export const githubOAuth = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  /** Exchange the callback's code for an access token. */
  async token({ clientId, clientSecret, code, redirectUri }) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    const body = await response.json();
    if (!body.access_token) throw new Error(body.error_description || 'GitHub did not issue a token.');
    return body.access_token;
  },
  /** The signed-in GitHub user's public profile. */
  async profile(accessToken) {
    const response = await fetch('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'pixel-map-lab' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    return response.json();
  },
};

/**
 * Start the API. Resolves to { port, close() } once listening.
 * options: port, accounts (Accounts or MemoryAccounts), publicUrl, github ({ clientId,
 * clientSecret } or null), devLogin, oauth (GitHub's endpoints; tests replace them).
 */
export function startApi({ port = 8080, accounts, publicUrl = 'http://127.0.0.1:8941', github = null, devLogin = false, oauth = githubOAuth }) {
  const secure = publicUrl.startsWith('https:');
  const redirectUri = new URL('/api/auth/github/callback', publicUrl).href;

  const send = (response, status, body, headers = {}) => {
    const json = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(json);
  };
  const redirect = (response, location, cookies = []) => response.writeHead(302, { Location: location, 'Set-Cookie': cookies }).end();
  const signIn = async (response, user) => {
    const token = await accounts.createSession(user.id);
    redirect(response, AFTER_SIGN_IN, [cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure })]);
  };
  const currentUser = request => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return token ? accounts.resolve(token) : null;
  };

  const routes = {
    'GET /healthz': (request, response) => response.writeHead(200).end('ok'),
    'GET /readyz': (request, response) => response.writeHead(200).end('ok'),
    'GET /api/auth/config': (request, response) => send(response, 200, { github: Boolean(github), dev: devLogin }),
    'GET /api/auth/github': (request, response) => {
      if (!github) return send(response, 404, { error: 'GitHub sign-in is not configured.' });
      const state = randomBytes(16).toString('base64url');
      const url = new URL(oauth.authorizeUrl);
      url.search = new URLSearchParams({ client_id: github.clientId, redirect_uri: redirectUri, state, allow_signup: 'true' });
      redirect(response, url.href, [cookie(STATE_COOKIE, state, { maxAge: STATE_SECONDS, secure, path: '/api/auth' })]);
    },
    'GET /api/auth/github/callback': async (request, response, url) => {
      if (!github) return send(response, 404, { error: 'GitHub sign-in is not configured.' });
      const state = url.searchParams.get('state'), expected = parseCookies(request.headers.cookie)[STATE_COOKIE];
      if (!state || state !== expected) return send(response, 400, { error: 'The sign-in could not be verified; please try again.' });
      const accessToken = await oauth.token({ ...github, code: url.searchParams.get('code'), redirectUri });
      const user = await accounts.githubUser(await oauth.profile(accessToken));
      await signIn(response, user);
    },
    'GET /api/auth/dev': async (request, response, url) => {
      if (!devLogin) return send(response, 404, { error: 'Development sign-in is off.' });
      const name = (url.searchParams.get('name') || '').trim();
      if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return send(response, 400, { error: 'Choose a name of up to 32 letters, digits, - or _.' });
      await signIn(response, await accounts.devUser(name));
    },
    'GET /api/me': async (request, response) => {
      const user = await currentUser(request);
      return user ? send(response, 200, { user }) : send(response, 401, { error: 'Not signed in.' });
    },
    'POST /api/logout': async (request, response) => {
      // Cookies are SameSite=Lax; also require the request to come from this site.
      if (request.headers.origin && request.headers.origin !== new URL(publicUrl).origin) return send(response, 403, { error: 'Wrong origin.' });
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) await accounts.revoke(token);
      send(response, 204, undefined, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure }) });
    },
    'GET /api/agents': async (request, response) => {
      const user = await currentUser(request);
      if (!user) return send(response, 401, { error: 'Not signed in.' });
      send(response, 200, { agents: await accounts.agents(user.id) });
    },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) return send(response, 404, { error: 'Not found.' });
    try {
      await route(request, response, url);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) send(response, 502, { error: 'Something went wrong; please try again.' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve({ port: server.address().port, close: () => new Promise(done => server.close(done)) }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const accounts = env.DATABASE_URL ? new Accounts(env.DATABASE_URL) : new MemoryAccounts();
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : null;
  const api = await startApi({ port: Number(env.PORT) || 8080, accounts, publicUrl: env.PUBLIC_URL, github, devLogin: env.DEV_LOGIN === '1' });
  console.log(`API on :${api.port} (${env.DATABASE_URL ? 'Postgres' : 'in-memory accounts'}; GitHub sign-in ${github ? 'on' : 'off'}; dev sign-in ${env.DEV_LOGIN === '1' ? 'on' : 'off'})`);
  process.on('SIGTERM', async () => {
    await api.close();
    await accounts.close();
    process.exit(0);
  });
}

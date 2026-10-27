// The API end to end, with a fake GitHub and accounts in memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAccounts, SESSION_COOKIE } from '@pixel-map-lab/accounts';
import { startApi } from '../src/server.js';

const fakeGitHub = {
  authorizeUrl: 'https://github.example/login/oauth/authorize',
  token: async ({ code }) => { if (code !== 'good') throw new Error('bad code'); return 'gh-token'; },
  profile: async token => ({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.example/42', token }),
};

async function api(options = {}) {
  const accounts = new MemoryAccounts();
  const started = await startApi({ port: 0, accounts, github: { clientId: 'cid', clientSecret: 'secret' }, oauth: fakeGitHub, ...options });
  const base = `http://127.0.0.1:${started.port}`;
  const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });
  return { ...started, accounts, base, get };
}

/** The value of a cookie set by a response. */
const setCookie = (response, name) => response.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`))?.split('=')[1];

test('signing in with GitHub: state checked, user created, login cookie set', async t => {
  const server = await api();
  t.after(server.close);
  assert.deepEqual(await (await server.get('/api/auth/config')).json(), { github: true, dev: false });

  const start = await server.get('/api/auth/github');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin + location.pathname, fakeGitHub.authorizeUrl);
  assert.equal(location.searchParams.get('client_id'), 'cid');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://127.0.0.1:8941/api/auth/github/callback');
  const state = location.searchParams.get('state');
  assert.equal(setCookie(start, 'pml_oauth_state'), state);

  const forged = await server.get(`/api/auth/github/callback?code=good&state=${state}`, { cookie: 'pml_oauth_state=other' });
  assert.equal(forged.status, 400, 'a callback without the matching state cookie is refused');

  const done = await server.get(`/api/auth/github/callback?code=good&state=${state}`, { cookie: `pml_oauth_state=${state}` });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/play/');
  const token = setCookie(done, SESSION_COOKIE);
  assert.ok(token);
  assert.match(done.headers.getSetCookie().join(), /HttpOnly; SameSite=Lax/);
  const me = await (await server.get('/api/me', { cookie: `${SESSION_COOKIE}=${token}` })).json();
  assert.deepEqual([me.user.login, me.user.name], ['octo', 'Octo Cat']);

  const failed = await server.get(`/api/auth/github/callback?code=bad&state=${state}`, { cookie: `pml_oauth_state=${state}` });
  assert.equal(failed.status, 502);
});

test('development sign-in only when switched on, with sane names', async t => {
  const off = await api();
  t.after(off.close);
  assert.equal((await off.get('/api/auth/dev?name=alice')).status, 404);
  const on = await api({ devLogin: true, github: null });
  t.after(on.close);
  assert.deepEqual(await (await on.get('/api/auth/config')).json(), { github: false, dev: true });
  assert.equal((await on.get('/api/auth/github')).status, 404);
  assert.equal((await on.get('/api/auth/dev?name=bad%20name!')).status, 400);
  const signed = await on.get('/api/auth/dev?name=alice');
  const token = setCookie(signed, SESSION_COOKIE);
  assert.equal((await (await on.get('/api/me', { cookie: `${SESSION_COOKIE}=${token}` })).json()).user.login, 'dev:alice');
});

test('signing out, from this site only; agents need a login', async t => {
  const server = await api({ devLogin: true });
  t.after(server.close);
  const token = setCookie(await server.get('/api/auth/dev?name=bob'), SESSION_COOKIE);
  const cookie = `${SESSION_COOKIE}=${token}`;
  assert.equal((await server.get('/api/agents')).status, 401);
  assert.deepEqual(await (await server.get('/api/agents', { cookie })).json(), { agents: [] });
  const elsewhere = await fetch(`${server.base}/api/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(elsewhere.status, 403);
  const out = await fetch(`${server.base}/api/logout`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:8941' } });
  assert.equal(out.status, 204);
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await server.get('/api/me', { cookie })).status, 401);
});

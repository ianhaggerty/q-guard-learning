// Users and login sessions, shared by the API (which logs people in) and the room server
// (which recognises them when their browser connects).
//
// A login is a random token in an HttpOnly cookie; only its SHA-256 is stored, so the
// database cannot be used to impersonate anyone. Accounts (Postgres, the schema in
// deploy/db/migrations) and MemoryAccounts (tests and runs without a database) offer the
// same methods.

import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

/** The login cookie's name. */
export const SESSION_COOKIE = 'pml_session';

/** How long a login lasts. */
export const SESSION_DAYS = 30;

const hash = token => createHash('sha256').update(token).digest();
const newToken = () => randomBytes(32).toString('base64url');

/** The cookies in a Cookie header, as an object. */
export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in cookies)) {
      try {
        cookies[name] = decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        // A malformed value is ignored.
      }
    }
  }
  return cookies;
}

/** A Set-Cookie header value. maxAge in seconds; 0 deletes the cookie. */
export function cookie(name, value, { maxAge, secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** The user a Cookie header's login belongs to, or null. */
export async function userFromCookies(accounts, header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  return token && accounts ? accounts.resolve(token) : null;
}

/** Public fields of a user row. */
function publicUser(row) {
  return row && { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

export class Accounts {
  constructor(databaseUrl) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }

  /** The user for a GitHub profile ({ id, login, name, avatar_url }), created or updated. */
  async githubUser(profile) {
    const { rows } = await this.pool.query(
      `insert into users (github_id, login, name, avatar_url) values ($1, $2, $3, $4)
       on conflict (github_id) do update set login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, last_seen = now()
       returning *`,
      [profile.id, profile.login, profile.name ?? null, profile.avatar_url ?? null],
    );
    return publicUser(rows[0]);
  }

  /** A development user ("dev:<name>"), created if needed. Never offered in production. */
  async devUser(name) {
    const { rows } = await this.pool.query(
      `insert into users (login, name) values ($1, $2)
       on conflict (login) do update set last_seen = now() returning *`,
      [`dev:${name}`, name],
    );
    return publicUser(rows[0]);
  }

  /** Start a login for the user. Returns the cookie token. */
  async createSession(userId) {
    const token = newToken();
    await this.pool.query(
      `insert into login_sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
      [hash(token), userId, SESSION_DAYS],
    );
    return token;
  }

  /** The user a login token belongs to, or null if it is unknown or expired. */
  async resolve(token) {
    const { rows } = await this.pool.query(
      `select users.* from login_sessions join users on users.id = login_sessions.user_id
       where token_hash = $1 and expires_at > now()`,
      [hash(token)],
    );
    return publicUser(rows[0]) ?? null;
  }

  async revoke(token) {
    await this.pool.query('delete from login_sessions where token_hash = $1', [hash(token)]);
  }

  /** The user's kept agents: one row per plan, with the latest training job. */
  async agents(userId) {
    const { rows } = await this.pool.query(
      `select m.plan_id, m.version, m.demos, m.report, m.updated_at,
              (select row_to_json(j) from (select status, not_before, finished_at, result from training_jobs
                 where user_id = m.user_id and plan_id = m.plan_id order by id desc limit 1) j) as job
       from agent_models m where m.user_id = $1 order by m.plan_id`,
      [userId],
    );
    return rows.map(row => ({ plan: row.plan_id, version: row.version, demos: row.demos, report: row.report, updatedAt: row.updated_at, job: row.job }));
  }

  async close() {
    await this.pool.end();
  }
}

/** Accounts kept in memory: for tests, and for running without a database. */
export class MemoryAccounts {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
  }

  upsert(key, fields) {
    const existing = [...this.users.values()].find(user => user.key === key);
    const user = existing ?? { id: randomBytes(16).toString('hex'), key };
    Object.assign(user, fields);
    this.users.set(user.id, user);
    return { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null };
  }

  async githubUser(profile) {
    return this.upsert(`github:${profile.id}`, { login: profile.login, name: profile.name, avatarUrl: profile.avatar_url });
  }

  async devUser(name) {
    return this.upsert(`dev:${name}`, { login: `dev:${name}`, name });
  }

  async createSession(userId) {
    const token = newToken();
    this.sessions.set(hash(token).toString('hex'), userId);
    return token;
  }

  async resolve(token) {
    const user = this.users.get(this.sessions.get(hash(token).toString('hex')));
    return user ? { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null } : null;
  }

  async revoke(token) {
    this.sessions.delete(hash(token).toString('hex'));
  }

  async agents() {
    return [];
  }

  async close() {}
}

// Cookies, and logins in memory and (with TEST_DATABASE_URL) in Postgres.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { Accounts, MemoryAccounts, SESSION_COOKIE, cookie, parseCookies, userFromCookies } from '../src/index.js';

test('cookies parse and print', () => {
  assert.deepEqual(parseCookies('a=1; pml_session=abc%3D; a=2; broken'), { a: '1', pml_session: 'abc=' });
  assert.equal(cookie('x', 'y z', { maxAge: 60, secure: true }), 'x=y%20z; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
});

async function exerciseLogins(accounts) {
  const alice = await accounts.githubUser({ id: 101, login: 'alice', name: 'Alice', avatar_url: 'https://a' });
  const again = await accounts.githubUser({ id: 101, login: 'alice2', name: 'Alice', avatar_url: 'https://a' });
  assert.equal(again.id, alice.id, 'the same GitHub account is the same user');
  assert.equal(again.login, 'alice2');
  const dev = await accounts.devUser('bob');
  assert.equal(dev.login, 'dev:bob');
  const token = await accounts.createSession(alice.id);
  assert.equal((await accounts.resolve(token)).id, alice.id);
  assert.equal((await userFromCookies(accounts, `${SESSION_COOKIE}=${token}`)).login, 'alice2');
  assert.equal(await accounts.resolve('nonsense'), null);
  assert.equal(await userFromCookies(accounts, 'other=1'), null);
  await accounts.revoke(token);
  assert.equal(await accounts.resolve(token), null);
}

test('logins in memory', () => exerciseLogins(new MemoryAccounts()));

test('logins in Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL' }, async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const name = `pml_test_${randomBytes(5).toString('hex')}`;
  await admin.query(`create database ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const setup = new pg.Client({ connectionString: url.href });
  await setup.connect();
  const dir = new URL('../../../deploy/db/migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) await setup.query(readFileSync(new URL(file, dir), 'utf8'));
  await setup.end();
  const accounts = new Accounts(url.href);
  try {
    await exerciseLogins(accounts);
    const { rows } = await accounts.pool.query('select count(*)::int as n from login_sessions');
    assert.equal(rows[0].n, 0);
    const user = await accounts.devUser('carol');
    await accounts.pool.query(`insert into agent_models (user_id, plan_id, version, object_key, base_checkpoint, guards, demos)
                               values ($1, '2', 3, 'k', 'm2_g1.pt', 1, 240)`, [user.id]);
    assert.deepEqual((await accounts.agents(user.id)).map(a => [a.plan, a.version, a.demos]), [['2', 3, 240]]);
  } finally {
    await accounts.close();
    await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  }
});

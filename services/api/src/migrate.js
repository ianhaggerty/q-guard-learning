// Applies the SQL migrations in deploy/db/migrations in name order, once each, recording
// them in schema_migrations. Run with DATABASE_URL set: `npm run migrate -w services/api`
// (Kubernetes runs it as a Job before each release).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || fileURLToPath(new URL('../../../deploy/db/migrations/', import.meta.url));

/** Apply every migration not yet applied. Returns the names applied now. */
export async function migrate(databaseUrl, dir = MIGRATIONS_DIR) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    // One migrator at a time, even if several start together.
    await client.query('select pg_advisory_lock(7242001)');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map(row => row.name));
    const applied = [];
    for (const name of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${error.message}`);
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
  const applied = await migrate(process.env.DATABASE_URL);
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
}

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.ts';

// fileURLToPath rather than URL.pathname: pathname percent-encodes spaces (a project under
// "My Projects" would break) and prefixes Windows paths with a stray slash.
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Applies each pending .sql file in one transaction. Filenames sort lexically, so zero-pad them. */
export async function migrate(): Promise<void> {
  const pool = db();
  await pool.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const applied = new Set(
    (await pool.query<{ version: string }>('select version from schema_migrations')).rows.map(
      (row) => row.version,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  const pending = files.filter((name) => !applied.has(name));

  if (pending.length === 0) {
    console.log(`Up to date (${applied.size} migration(s) applied).`);
    return;
  }

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      client.release();
    }
  }
}

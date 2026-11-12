import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from '../db.ts';
import { withTransaction } from '../db.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTransaction(pool, async (c) => {
      // serialise concurrent migrators
      await c.query('SELECT pg_advisory_xact_lock(8675309)');
      const { rowCount } = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) return;
      await c.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

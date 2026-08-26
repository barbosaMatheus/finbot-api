import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { pool } from '../db.js';

// Anchor on the package cwd rather than import.meta so this module also
// loads under the CommonJS test transform. Dev/tsx and jest run from the
// package root with src/ present; the production image ships only dist/.
const MIGRATION_DIR_CANDIDATES = [
  path.resolve(process.cwd(), 'src', 'db', 'migrations'),
  path.resolve(process.cwd(), 'dist', 'db', 'migrations'),
];

const migrationsDir =
  MIGRATION_DIR_CANDIDATES.find((dir) => existsSync(dir)) ??
  MIGRATION_DIR_CANDIDATES[0]!;

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE id = $1',
      [id],
    );

    if (rows.length > 0) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

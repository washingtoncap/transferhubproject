import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';

/** Default location of the versioned SQL migrations shipped with this package. */
export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant: only one migrator may run at a time across all processes.
const MIGRATION_LOCK_KEY = 7_316_620_250;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations = files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(`Migration file name must look like 0001_name.sql: ${file}`);
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version: Number(match[1]),
      name: match[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migrations must be numbered consecutively from 0001; found ${String(m.version).padStart(4, '0')} at position ${i + 1}`,
      );
    }
  });
  return migrations;
}

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    integer PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function appliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  await ensureTable(pool);
  const { rows } = await pool.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  return rows;
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock.
 * Refuses to run if an already-applied migration file has been edited: applied migrations are
 * part of the financial system's history and are corrected with a new migration, never rewritten.
 */
export async function migrate(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<{ applied: Migration[] }> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureTable(pool);
    const { rows: done } = await client.query<AppliedMigration>(
      'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
    );
    const doneByVersion = new Map(done.map((r) => [r.version, r]));

    for (const row of done) {
      const file = migrations.find((m) => m.version === row.version);
      if (!file) {
        throw new MigrationError(
          `Database has migration ${row.version} (${row.name}) but no matching file exists`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationError(
          `Migration ${row.version} (${row.name}) was edited after being applied. Add a new migration instead.`,
        );
      }
    }

    const applied: Migration[] = [];
    for (const m of migrations) {
      if (doneByVersion.has(m.version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        applied.push(m);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const detail = err instanceof Error ? err.message : String(err);
        throw new MigrationError(`Migration ${m.version} (${m.name}) failed: ${detail}`);
      }
    }
    return { applied };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

/**
 * Drops and recreates the application schemas. Only permitted against a database whose name ends
 * in `_test`, so it can never be pointed at development, sandbox or production data by mistake.
 */
export async function resetTestDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const db = rows[0]?.db ?? '';
  if (!db.endsWith('_test')) {
    throw new MigrationError(`Refusing to reset non-test database "${db}"`);
  }
  await pool.query(`
    DROP SCHEMA IF EXISTS platform CASCADE;
    DROP TABLE IF EXISTS public.schema_migrations;
  `);
}

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testPool } from '../../../test/db';
import {
  appliedMigrations,
  loadMigrations,
  migrate,
  MigrationError,
  resetTestDatabase,
} from './migrate';
import { createPool } from './pool';

const pool = testPool();
afterAll(() => pool.end());

describe('migrations', () => {
  it('has applied every shipped migration to the test database', async () => {
    const applied = await appliedMigrations(pool);
    expect(applied.map((m) => m.version)).toEqual(loadMigrations().map((m) => m.version));
  });

  it('is a no-op when re-run', async () => {
    const { applied } = await migrate(pool);
    expect(applied).toHaveLength(0);
  });

  it('refuses to run when an applied migration file has been edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'th-mig-'));
    const original = loadMigrations()[0]!;
    writeFileSync(join(dir, `0001_${original.name}.sql`), `${original.sql}\n-- edited`);
    await expect(migrate(pool, dir)).rejects.toThrow(/edited after being applied/);
  });

  it('rejects gaps in migration numbering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'th-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
  });

  it('refuses to reset a database that is not a test database', async () => {
    const dev = createPool({
      connectionString: 'postgres://th:th@localhost:5432/transferhub_dev',
      applicationName: 'th-test',
    });
    try {
      await expect(resetTestDatabase(dev)).rejects.toThrow(/non-test database/);
    } finally {
      await dev.end();
    }
  });

  it('stores timestamps in UTC regardless of server locale', async () => {
    const { rows } = await pool.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
    expect(rows[0]?.tz).toBe('UTC');
  });
});

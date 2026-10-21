import { createPool, migrate, resetTestDatabase } from '../packages/db/src';
import { testDatabaseUrl } from './db';

/** Rebuilds the test database from migrations once per test run, so every run starts clean. */
export default async function setup(): Promise<void> {
  const pool = createPool({
    connectionString: testDatabaseUrl(),
    applicationName: 'th-test-setup',
  });
  try {
    await resetTestDatabase(pool);
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

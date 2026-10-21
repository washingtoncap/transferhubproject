import { createPool, type Pool } from '../packages/db/src';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://th:th@localhost:5432/transferhub_test';
  if (!/_test(\?|$)/.test(url)) {
    throw new Error('TEST_DATABASE_URL must point at a database whose name ends in _test');
  }
  return url;
}

export function testPool(max = 10): Pool {
  return createPool({ connectionString: testDatabaseUrl(), applicationName: 'th-test', max });
}

/** Unique suffix so tests never collide on unique columns, even when re-run. */
export function uniq(prefix = 't'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

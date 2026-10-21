import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type { Pool, PoolClient } from 'pg';

export interface CreatePoolOptions {
  connectionString: string;
  /** Name shown in pg_stat_activity — helps operators see which service holds a connection. */
  applicationName: string;
  max?: number;
  statementTimeoutMs?: number;
}

/**
 * Every connection runs in UTC so stored timestamps never depend on server locale.
 * Display in America/Port_of_Spain happens at the edge (web/API formatting), never in storage.
 */
export function createPool(opts: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    application_name: opts.applicationName,
    max: opts.max ?? 10,
    options: `-c timezone=UTC -c statement_timeout=${opts.statementTimeoutMs ?? 15_000}`,
  };
  return new Pool(config);
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Runs `fn` inside a single database transaction. Commits on success, rolls back on any error.
 * State changes, their audit record, their outbox event and their idempotency record must all be
 * written through the same client so they commit or fail together.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  isolation: IsolationLevel = 'READ COMMITTED',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw err;
  } finally {
    client.release();
  }
}

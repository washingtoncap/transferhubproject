import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Anything that can run a query: a pool, or a client inside a transaction. Functions that write
 * alongside a state change take a Queryable so callers pass the transaction's client and every
 * write commits (or rolls back) together.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

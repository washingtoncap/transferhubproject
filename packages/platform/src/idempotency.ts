import { sha256OfJson } from './hash';
import type { Queryable } from './queryable';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const DEFAULT_RETENTION_HOURS = 24 * 7;

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_key_reused';
  constructor() {
    super('This Idempotency-Key was already used with a different request.');
    this.name = 'IdempotencyConflictError';
  }
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** True when this is a stored response from an earlier identical request. */
  replayed: boolean;
}

/**
 * Executes a command at most once per (scope, key) — TH-REQ §6.
 *
 * Must be called with a client inside an open transaction; the command's own writes go through the
 * same client. The key is stored in that transaction, so:
 *  - if the command fails, the transaction rolls back and the key is free to retry;
 *  - if two identical requests race, the second waits on the key's unique index, then replays the
 *    first one's stored response instead of executing again;
 *  - reusing the key with a different request body is rejected with a conflict.
 */
export async function runIdempotent<T>(
  tx: Queryable,
  params: { scope: string; key: string; request: unknown; retentionHours?: number },
  execute: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(params.key)) {
    throw new Error('Invalid Idempotency-Key format');
  }
  const requestHash = sha256OfJson(params.request);

  // Claim the key first. A concurrent identical request blocks here until this transaction ends.
  const placeholder = await tx.query<{ key: string }>(
    `INSERT INTO platform.idempotency_keys
       (scope, key, request_sha256, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, 102, '{}'::jsonb, now() + make_interval(hours => $4))
     ON CONFLICT (scope, key) DO NOTHING
     RETURNING key`,
    [params.scope, params.key, requestHash, params.retentionHours ?? DEFAULT_RETENTION_HOURS],
  );

  if (!placeholder.rows[0]) {
    const { rows } = await tx.query<{
      request_sha256: Buffer;
      response_status: number;
      response_body: T;
    }>(
      `SELECT request_sha256, response_status, response_body
         FROM platform.idempotency_keys WHERE scope = $1 AND key = $2`,
      [params.scope, params.key],
    );
    const prior = rows[0]!;
    if (!prior.request_sha256.equals(requestHash)) throw new IdempotencyConflictError();
    return { status: prior.response_status, body: prior.response_body, replayed: true };
  }

  const result = await execute();
  if (result.status === 102) throw new Error('A command cannot complete with status 102');
  // Fill in the placeholder written above in this same transaction. The database permits this one
  // update (from status 102) and rejects any later change to a stored response.
  await tx.query(
    `UPDATE platform.idempotency_keys SET response_status = $3, response_body = $4
      WHERE scope = $1 AND key = $2`,
    [params.scope, params.key, result.status, JSON.stringify(result.body ?? null)],
  );
  return { ...result, replayed: false };
}

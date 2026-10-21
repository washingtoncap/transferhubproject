import { randomUUID } from 'node:crypto';
import type { Queryable } from './queryable';

export interface OutboxEvent {
  topic: string;
  payload: Record<string, unknown>;
  aggregateType?: string;
  aggregateId?: string;
  dedupeKey?: string;
  correlationId?: string;
  availableAt?: Date;
}

export interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  attempts: number;
  lease_token: string;
}

/**
 * Writes an event in the caller's transaction. If the transaction rolls back, the event never
 * existed; if it commits, the event is guaranteed to be dispatched at least once.
 * Returns the event id, or the existing id when `dedupeKey` was already used.
 */
export async function writeOutbox(db: Queryable, event: OutboxEvent): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform.outbox
       (topic, aggregate_type, aggregate_id, payload, dedupe_key, correlation_id, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      event.topic,
      event.aggregateType ?? null,
      event.aggregateId ?? null,
      JSON.stringify(event.payload),
      event.dedupeKey ?? null,
      event.correlationId ?? null,
      event.availableAt ?? null,
    ],
  );
  if (rows[0]) return rows[0].id;
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM platform.outbox WHERE dedupe_key = $1',
    [event.dedupeKey],
  );
  return existing.rows[0]!.id;
}

/**
 * Claims up to `limit` events for dispatch. Rows locked by another dispatcher are skipped, and a
 * dispatcher that crashed mid-dispatch releases its rows when the lease expires.
 */
export async function claimOutbox(
  db: Queryable,
  limit: number,
  leaseSeconds: number,
): Promise<OutboxRow[]> {
  const token = randomUUID();
  const { rows } = await db.query<OutboxRow>(
    `UPDATE platform.outbox o
        SET status = 'dispatching', attempts = o.attempts + 1,
            lease_token = $1, lease_expires_at = now() + make_interval(secs => $3)
      WHERE o.id IN (
        SELECT id FROM platform.outbox
         WHERE available_at <= now()
           AND (status = 'pending' OR (status = 'dispatching' AND lease_expires_at < now()))
         ORDER BY available_at, created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.correlation_id,
                o.attempts, o.lease_token`,
    [token, limit, leaseSeconds],
  );
  return rows;
}

/** Returns false when the lease was lost (another dispatcher took over); the caller does nothing. */
export async function markOutboxDispatched(
  db: Queryable,
  id: string,
  leaseToken: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE platform.outbox
        SET status = 'dispatched', dispatched_at = now(), lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'dispatching'`,
    [id, leaseToken],
  );
  return rowCount === 1;
}

export async function markOutboxFailed(
  db: Queryable,
  id: string,
  leaseToken: string,
  error: string,
  opts: { retryInSeconds: number; dead: boolean },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE platform.outbox
        SET status = CASE WHEN $4 THEN 'dead' ELSE 'pending' END,
            available_at = now() + make_interval(secs => $5),
            lease_token = NULL, lease_expires_at = NULL, last_error = left($3, 2000)
      WHERE id = $1 AND lease_token = $2 AND status = 'dispatching'`,
    [id, leaseToken, error, opts.dead, opts.retryInSeconds],
  );
  return rowCount === 1;
}

import { randomUUID } from 'node:crypto';
import type { Queryable } from './queryable';

export interface EnqueueOptions {
  queue?: string;
  type: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  correlationId?: string;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

export interface JobRow {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

/**
 * Enqueues a job in the caller's transaction. With a dedupeKey, enqueuing the same work twice
 * returns the original job instead of creating a second one.
 */
export async function enqueueJob(
  db: Queryable,
  opts: EnqueueOptions,
): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform.jobs (queue, type, payload, dedupe_key, correlation_id, run_at, priority, max_attempts)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      opts.queue ?? 'default',
      opts.type,
      JSON.stringify(opts.payload ?? {}),
      opts.dedupeKey ?? null,
      opts.correlationId ?? null,
      opts.runAt ?? null,
      opts.priority ?? 0,
      opts.maxAttempts ?? 10,
    ],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM platform.jobs WHERE dedupe_key = $1',
    [opts.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
}

/**
 * Claims ready jobs. Concurrent workers never claim the same job (FOR UPDATE SKIP LOCKED).
 * A job whose worker died is reclaimed after its lease expires. Reclaiming does NOT mean the
 * previous attempt failed: handlers that call external providers must first look up the outcome
 * of the previous attempt using the original reference before acting again (TH-SEC §4, FX-03).
 */
export async function claimJobs(
  db: Queryable,
  opts: { queue: string; limit: number; leaseSeconds: number; workerId: string },
): Promise<JobRow[]> {
  // A job whose worker died on its final attempt is finished as dead rather than reclaimed again,
  // so a job that crashes its worker every time cannot loop forever.
  await db.query(
    `UPDATE platform.jobs
        SET status = 'dead', completed_at = now(), lease_token = NULL, lease_expires_at = NULL,
            locked_by = NULL, last_error = 'Lease expired after the final attempt; outcome unknown'
      WHERE queue = $1 AND status = 'running' AND lease_expires_at < now()
        AND attempts >= max_attempts`,
    [opts.queue],
  );

  const token = randomUUID();
  const { rows } = await db.query<JobRow>(
    `UPDATE platform.jobs j
        SET status = 'running', attempts = j.attempts + 1, lease_token = $1,
            lease_expires_at = now() + make_interval(secs => $4), locked_by = $5
      WHERE j.id IN (
        SELECT id FROM platform.jobs
         WHERE queue = $2
           AND ((status = 'queued' AND run_at <= now())
             OR (status = 'running' AND lease_expires_at < now()))
         ORDER BY priority DESC, run_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING j.id, j.queue, j.type, j.payload, j.correlation_id, j.attempts, j.max_attempts,
                j.lease_token`,
    [token, opts.queue, opts.limit, opts.leaseSeconds, opts.workerId],
  );
  return rows;
}

/** Extends a running job's lease; returns false if the lease was lost to another worker. */
export async function heartbeatJob(
  db: Queryable,
  id: string,
  leaseToken: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE platform.jobs SET lease_expires_at = now() + make_interval(secs => $3)
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [id, leaseToken, leaseSeconds],
  );
  return rowCount === 1;
}

export async function completeJob(db: Queryable, id: string, leaseToken: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE platform.jobs
        SET status = 'succeeded', completed_at = now(), lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [id, leaseToken],
  );
  return rowCount === 1;
}

/**
 * Records a failed attempt. Retries with backoff until max_attempts, then marks the job "dead" so a
 * person reviews it. `permanent` skips remaining retries for errors that will never succeed.
 */
export async function failJob(
  db: Queryable,
  id: string,
  leaseToken: string,
  error: string,
  opts: { retryInSeconds: number; permanent?: boolean },
): Promise<'retrying' | 'dead' | 'lease_lost'> {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE platform.jobs
        SET status = CASE WHEN $4 OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            run_at = now() + make_interval(secs => $5),
            completed_at = CASE WHEN $4 OR attempts >= max_attempts THEN now() ELSE NULL END,
            lease_token = NULL, lease_expires_at = NULL, locked_by = NULL,
            last_error = left($3, 2000)
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
      RETURNING status`,
    [id, leaseToken, error, opts.permanent ?? false, opts.retryInSeconds],
  );
  if (!rows[0]) return 'lease_lost';
  return rows[0].status === 'dead' ? 'dead' : 'retrying';
}

/** Exponential backoff with full jitter, capped. attempt is 1-based. */
export function backoffSeconds(attempt: number, baseSeconds = 2, capSeconds = 900): number {
  const ceiling = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(Math.random() * ceiling));
}

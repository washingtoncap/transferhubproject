import { enqueueJob, type JobHandler, type Queryable } from '@transferhub/platform';

export const PURGE_IDEMPOTENCY_JOB = 'maintenance.purge_idempotency_keys';

/**
 * Deletes idempotency keys past their retention window, in small batches so it never holds long
 * locks. Only expired keys are removed; a key inside its window always replays its response.
 */
export function purgeExpiredIdempotencyKeys(db: Queryable, batchSize = 1000): JobHandler {
  return async ({ log, signal }) => {
    let total = 0;
    for (;;) {
      if (signal.aborted) break;
      const { rowCount } = await db.query(
        `DELETE FROM platform.idempotency_keys
          WHERE ctid IN (SELECT ctid FROM platform.idempotency_keys
                          WHERE expires_at < now() LIMIT $1)`,
        [batchSize],
      );
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batchSize) break;
    }
    log.info({ deleted: total }, 'expired idempotency keys purged');
  };
}

/**
 * Schedules hourly maintenance. The dedupe key is the UTC hour, so any number of workers starting
 * up (or restarting) in the same hour still produce exactly one job.
 */
export async function scheduleMaintenance(db: Queryable, now = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13); // e.g. 2026-10-21T14
  await enqueueJob(db, {
    type: PURGE_IDEMPOTENCY_JOB,
    dedupeKey: `${PURGE_IDEMPOTENCY_JOB}:${hour}`,
    maxAttempts: 3,
  });
}

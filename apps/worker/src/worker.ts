import type { WorkerConfig } from '@transferhub/config';
import type { Pool } from '@transferhub/db';
import { registerCoreJobs } from '@transferhub/core';
import { type Logger, Runner } from '@transferhub/platform';
import {
  PURGE_IDEMPOTENCY_JOB,
  purgeExpiredIdempotencyKeys,
  scheduleMaintenance,
} from './maintenance';

export interface WorkerDeps {
  config: WorkerConfig;
  pool: Pool;
  log: Logger;
  workerId: string;
}

/**
 * Wires job and event handlers. Each later bucket registers its own here — for example
 * "deposit.match_statement" (bucket 4) or "fx.query_provider_status" (bucket 5).
 */
export function buildWorker(deps: WorkerDeps): { runner: Runner; schedule: () => Promise<void> } {
  const runner = new Runner({
    pool: deps.pool,
    log: deps.log,
    workerId: deps.workerId,
    concurrency: deps.config.WORKER_CONCURRENCY,
    pollIntervalMs: deps.config.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: deps.config.WORKER_LEASE_SECONDS,
  });

  runner.onJob(PURGE_IDEMPOTENCY_JOB, purgeExpiredIdempotencyKeys(deps.pool));
  registerCoreJobs(runner, { pool: deps.pool, partnerSecret: deps.config.PARTNER_WEBHOOK_SECRET });

  return { runner, schedule: () => scheduleMaintenance(deps.pool) };
}

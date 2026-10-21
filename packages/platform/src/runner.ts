import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { backoffSeconds, claimJobs, completeJob, failJob, heartbeatJob, type JobRow } from './jobs';
import { claimOutbox, markOutboxDispatched, markOutboxFailed, type OutboxRow } from './outbox';

/** Throw from a handler when retrying can never succeed (bad payload, unsupported type). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface JobContext {
  job: JobRow;
  log: Logger;
  /** Aborted when the worker is shutting down or the lease was lost; long handlers should stop. */
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;
export type OutboxHandler = (event: OutboxRow, log: Logger) => Promise<void>;

export interface RunnerOptions {
  pool: Pool;
  log: Logger;
  workerId: string;
  queue?: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  maxOutboxAttempts?: number;
}

/**
 * Polls the jobs table and the outbox, running registered handlers.
 *
 * Delivery is at-least-once: a handler can run again after a crash or lease expiry, so every
 * handler must be idempotent — use the job or outbox id as the idempotency key for anything it
 * does externally, and look up existing outcomes before acting.
 */
export class Runner {
  private readonly jobHandlers = new Map<string, JobHandler>();
  private readonly outboxHandlers = new Map<string, OutboxHandler>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: RunnerOptions) {}

  onJob(type: string, handler: JobHandler): this {
    if (this.jobHandlers.has(type)) throw new Error(`Duplicate job handler: ${type}`);
    this.jobHandlers.set(type, handler);
    return this;
  }

  onOutbox(topic: string, handler: OutboxHandler): this {
    if (this.outboxHandlers.has(topic)) throw new Error(`Duplicate outbox handler: ${topic}`);
    this.outboxHandlers.set(topic, handler);
    return this;
  }

  start(): void {
    if (this.loop) return;
    this.opts.log.info(
      { workerId: this.opts.workerId, jobTypes: [...this.jobHandlers.keys()] },
      'worker started',
    );
    this.loop = this.run();
  }

  /** Stops claiming new work and waits for in-flight handlers to finish. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    this.opts.log.info({ workerId: this.opts.workerId }, 'worker stopped');
  }

  /** One polling pass. Exposed for tests; returns how many jobs and events were picked up. */
  async tick(): Promise<{ jobs: number; events: number }> {
    const events = await this.dispatchOutbox();
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return { jobs: 0, events };
    const jobs = await claimJobs(this.opts.pool, {
      queue: this.opts.queue ?? 'default',
      limit: free,
      leaseSeconds: this.opts.leaseSeconds,
      workerId: this.opts.workerId,
    });
    for (const job of jobs) {
      const p = this.execute(job).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return { jobs: jobs.length, events };
  }

  /** Waits for every handler started by previous ticks. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async run(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      let picked = 0;
      try {
        const r = await this.tick();
        picked = r.jobs + r.events;
      } catch (err) {
        this.opts.log.error({ err }, 'worker poll failed');
      }
      if (picked === 0) await sleep(this.opts.pollIntervalMs, this.shutdown.signal);
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const log = this.opts.log.child({
      jobId: job.id,
      jobType: job.type,
      attempt: job.attempts,
      correlationId: job.correlation_id ?? undefined,
    });
    const handler = this.jobHandlers.get(job.type);
    if (!handler) {
      log.error('no handler registered for job type');
      await failJob(this.opts.pool, job.id, job.lease_token, `No handler for ${job.type}`, {
        retryInSeconds: 0,
        permanent: true,
      });
      return;
    }

    const leaseLost = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, leaseLost.signal]);
    const beat = setInterval(
      () => {
        heartbeatJob(this.opts.pool, job.id, job.lease_token, this.opts.leaseSeconds)
          .then((ok) => {
            if (!ok) leaseLost.abort();
          })
          .catch((err: unknown) => log.warn({ err }, 'heartbeat failed'));
      },
      Math.max(1000, (this.opts.leaseSeconds * 1000) / 3),
    );

    try {
      await handler({ job, log, signal });
      if (!(await completeJob(this.opts.pool, job.id, job.lease_token))) {
        log.warn('job finished after its lease was lost; another worker owns it now');
      }
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await failJob(this.opts.pool, job.id, job.lease_token, message, {
        retryInSeconds: backoffSeconds(job.attempts),
        permanent,
      });
      log[outcome === 'dead' ? 'error' : 'warn']({ err, outcome }, 'job attempt failed');
    } finally {
      clearInterval(beat);
    }
  }

  private async dispatchOutbox(): Promise<number> {
    if (this.outboxHandlers.size === 0) return 0;
    const events = await claimOutbox(this.opts.pool, 25, this.opts.leaseSeconds);
    for (const event of events) {
      const log = this.opts.log.child({ outboxId: event.id, topic: event.topic });
      const handler = this.outboxHandlers.get(event.topic);
      try {
        if (handler) await handler(event, log);
        // Topics with no subscriber are recorded as dispatched; the event stays in the outbox as history.
        await markOutboxDispatched(this.opts.pool, event.id, event.lease_token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const dead = event.attempts >= (this.opts.maxOutboxAttempts ?? 20);
        await markOutboxFailed(this.opts.pool, event.id, event.lease_token, message, {
          retryInSeconds: backoffSeconds(event.attempts),
          dead,
        });
        log[dead ? 'error' : 'warn']({ err, dead }, 'outbox dispatch failed');
      }
    }
    return events.length;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '@transferhub/db';
import { testPool, uniq } from '../../../test/db';
import { backoffSeconds, claimJobs, completeJob, enqueueJob, failJob } from './jobs';
import { claimOutbox, markOutboxDispatched, writeOutbox } from './outbox';

const pool = testPool(20);
afterAll(() => pool.end());

let queue: string;
beforeEach(() => {
  // Each test gets its own queue so tests never see each other's jobs.
  queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
});

const claim = (workerId: string, limit = 10, leaseSeconds = 60) =>
  claimJobs(pool, { queue, limit, leaseSeconds, workerId });

describe('job queue', () => {
  it('dedupes enqueues with the same key', async () => {
    const key = uniq('dedupe');
    const a = await enqueueJob(pool, { queue, type: 'test.noop', dedupeKey: key });
    const b = await enqueueJob(pool, { queue, type: 'test.noop', dedupeKey: key });
    expect(b).toEqual({ id: a.id, created: false });
  });

  it('never gives the same job to two concurrent workers', async () => {
    for (let i = 0; i < 40; i++) await enqueueJob(pool, { queue, type: 'test.noop' });
    const batches = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w${i}`, 10)));
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('reclaims a job after its lease expires, and the old worker can no longer finish it', async () => {
    await enqueueJob(pool, { queue, type: 'test.noop' });
    const [first] = await claim('crashed-worker', 1, 1);
    await pool.query(
      `UPDATE platform.jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [first!.id],
    );
    const [second] = await claim('healthy-worker', 1);
    expect(second!.id).toBe(first!.id);
    expect(second!.attempts).toBe(2);
    expect(await completeJob(pool, first!.id, first!.lease_token)).toBe(false);
    expect(await completeJob(pool, second!.id, second!.lease_token)).toBe(true);
  });

  it('marks a job dead when its worker dies on the final attempt, instead of looping', async () => {
    const { id } = await enqueueJob(pool, { queue, type: 'test.crashes_worker', maxAttempts: 1 });
    const [a] = await claim('w', 1);
    expect(a!.id).toBe(id);
    await pool.query(
      `UPDATE platform.jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await claim('w')).toHaveLength(0);
    const { rows } = await pool.query(
      'SELECT status, last_error FROM platform.jobs WHERE id = $1',
      [id],
    );
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toMatch(/outcome unknown/);
  });

  it('retries failures, then marks the job dead for a person to review', async () => {
    await enqueueJob(pool, { queue, type: 'test.flaky', maxAttempts: 2 });
    const [a] = await claim('w');
    expect(await failJob(pool, a!.id, a!.lease_token, 'oops', { retryInSeconds: 0 })).toBe(
      'retrying',
    );
    const [b] = await claim('w');
    expect(await failJob(pool, b!.id, b!.lease_token, 'oops again', { retryInSeconds: 0 })).toBe(
      'dead',
    );
    expect(await claim('w')).toHaveLength(0);
  });

  it('does not run a job before its scheduled time', async () => {
    await enqueueJob(pool, { queue, type: 'test.later', runAt: new Date(Date.now() + 60_000) });
    expect(await claim('w')).toHaveLength(0);
  });

  it('only enqueues when the surrounding transaction commits', async () => {
    await expect(
      withTransaction(pool, async (tx) => {
        await enqueueJob(tx, { queue, type: 'test.noop' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow();
    expect(await claim('w')).toHaveLength(0);
  });

  it('backs off exponentially within a cap', () => {
    for (let attempt = 1; attempt < 30; attempt++) {
      const s = backoffSeconds(attempt);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(900);
    }
  });
});

describe('outbox (NFR-03)', () => {
  it('commits events atomically with the state change', async () => {
    const key = uniq('evt');
    await expect(
      withTransaction(pool, async (tx) => {
        await writeOutbox(tx, { topic: 'test.happened', payload: {}, dedupeKey: key });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow();
    const { rowCount } = await pool.query('SELECT 1 FROM platform.outbox WHERE dedupe_key = $1', [
      key,
    ]);
    expect(rowCount).toBe(0);
  });

  it('dedupes events and never hands one event to two dispatchers', async () => {
    const key = uniq('evt');
    const id1 = await writeOutbox(pool, {
      topic: 'test.happened',
      payload: { n: 1 },
      dedupeKey: key,
    });
    const id2 = await writeOutbox(pool, {
      topic: 'test.happened',
      payload: { n: 1 },
      dedupeKey: key,
    });
    expect(id2).toBe(id1);
    const [a, b] = await Promise.all([claimOutbox(pool, 1000, 60), claimOutbox(pool, 1000, 60)]);
    const mine = [...a, ...b].filter((e) => e.id === id1);
    expect(mine).toHaveLength(1);
    expect(await markOutboxDispatched(pool, mine[0]!.id, mine[0]!.lease_token)).toBe(true);
  });

  it('does not allow outbox history to be deleted', async () => {
    const id = await writeOutbox(pool, { topic: 'test.happened', payload: {} });
    await expect(pool.query('DELETE FROM platform.outbox WHERE id = $1', [id])).rejects.toThrow(
      /append-only/,
    );
  });
});

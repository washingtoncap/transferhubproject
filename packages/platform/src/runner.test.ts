import { afterAll, describe, expect, it } from 'vitest';
import { testPool, uniq } from '../../../test/db';
import { enqueueJob } from './jobs';
import { createLogger } from './logger';
import { writeOutbox } from './outbox';
import { PermanentJobError, Runner } from './runner';

const pool = testPool(20);
afterAll(() => pool.end());
const log = createLogger({ service: 'test', level: 'silent' });

function runner(queue: string) {
  return new Runner({
    pool,
    log,
    workerId: 'test-worker',
    queue,
    concurrency: 4,
    pollIntervalMs: 20,
    leaseSeconds: 30,
  });
}

async function statusOf(id: string): Promise<{ status: string; attempts: number }> {
  const { rows } = await pool.query('SELECT status, attempts FROM platform.jobs WHERE id = $1', [
    id,
  ]);
  return rows[0];
}

describe('worker runner', () => {
  it('runs a registered handler and marks the job succeeded', async () => {
    const queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
    const seen: unknown[] = [];
    const r = runner(queue).onJob('test.echo', async ({ job }) => {
      seen.push(job.payload);
    });
    const { id } = await enqueueJob(pool, {
      queue,
      type: 'test.echo',
      payload: { hello: 'world' },
    });
    await r.tick();
    await r.drain();
    expect(seen).toEqual([{ hello: 'world' }]);
    expect((await statusOf(id)).status).toBe('succeeded');
  });

  it('sends permanent failures straight to dead without retrying', async () => {
    const queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
    const r = runner(queue).onJob('test.bad', async () => {
      throw new PermanentJobError('unsupported route');
    });
    const { id } = await enqueueJob(pool, { queue, type: 'test.bad' });
    await r.tick();
    await r.drain();
    expect(await statusOf(id)).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('schedules a retry for ordinary failures', async () => {
    const queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
    const r = runner(queue).onJob('test.flaky', async () => {
      throw new Error('temporary');
    });
    const { id } = await enqueueJob(pool, { queue, type: 'test.flaky' });
    await r.tick();
    await r.drain();
    expect((await statusOf(id)).status).toBe('queued');
  });

  it('marks unknown job types dead instead of looping on them', async () => {
    const queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
    const { id } = await enqueueJob(pool, { queue, type: 'test.nobody_handles_this' });
    const r = runner(queue);
    await r.tick();
    await r.drain();
    expect((await statusOf(id)).status).toBe('dead');
  });

  it('dispatches outbox events to their topic handler', async () => {
    const topic = `test.${uniq('topic').replace(/[^a-z0-9_]/g, '_')}`;
    const got: string[] = [];
    const r = runner('unused').onOutbox(topic, async (e) => {
      got.push(e.id);
    });
    const id = await writeOutbox(pool, { topic, payload: {} });
    // Other tests leave events in the shared outbox; dispatch in batches until ours is reached.
    for (let i = 0; i < 50 && !got.includes(id); i++) await r.tick();
    expect(got).toContain(id);
    const { rows } = await pool.query('SELECT status FROM platform.outbox WHERE id = $1', [id]);
    expect(rows[0].status).toBe('dispatched');
  });

  it('starts and stops cleanly, finishing in-flight work', async () => {
    const queue = uniq('q').replace(/[^a-z0-9_]/g, '_');
    let finished = false;
    const r = runner(queue).onJob('test.slow', async () => {
      await new Promise((res) => setTimeout(res, 150));
      finished = true;
    });
    await enqueueJob(pool, { queue, type: 'test.slow' });
    r.start();
    await new Promise((res) => setTimeout(res, 60));
    await r.stop();
    expect(finished).toBe(true);
  });
});

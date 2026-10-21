import { afterAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@transferhub/db';
import { testPool, uniq } from '../../../test/db';
import { IdempotencyConflictError, runIdempotent } from './idempotency';

const pool = testPool(20);
afterAll(() => pool.end());

/** Simulates a command whose side effect is counted, so we can prove it ran exactly once. */
async function command(scope: string, key: string, request: unknown, counter: { n: number }) {
  return withTransaction(pool, (tx) =>
    runIdempotent(tx, { scope, key, request }, async () => {
      counter.n += 1;
      await new Promise((r) => setTimeout(r, 50)); // widen the race window
      return { status: 201, body: { quoteId: `q-${counter.n}` } };
    }),
  );
}

describe('idempotent commands (TH-REQ §6, FX-03)', () => {
  it('replays the stored response for a repeated identical request', async () => {
    const counter = { n: 0 };
    const scope = uniq('scope');
    const first = await command(scope, 'key-00000001', { amount: 100 }, counter);
    const second = await command(scope, 'key-00000001', { amount: 100 }, counter);
    expect(counter.n).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ status: 201, body: first.body, replayed: true });
  });

  it('rejects reuse of a key with a different request body', async () => {
    const counter = { n: 0 };
    const scope = uniq('scope');
    await command(scope, 'key-00000002', { amount: 100 }, counter);
    await expect(command(scope, 'key-00000002', { amount: 999 }, counter)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(counter.n).toBe(1);
  });

  it('executes once when many identical requests race', async () => {
    const counter = { n: 0 };
    const scope = uniq('scope');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => command(scope, 'key-00000003', { amount: 5 }, counter)),
    );
    expect(counter.n).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('frees the key when the command fails, so a retry can succeed', async () => {
    const scope = uniq('scope');
    await expect(
      withTransaction(pool, (tx) =>
        runIdempotent(tx, { scope, key: 'key-00000004', request: {} }, async () => {
          throw new Error('provider unavailable');
        }),
      ),
    ).rejects.toThrow('provider unavailable');
    const counter = { n: 0 };
    const retry = await command(scope, 'key-00000004', {}, counter);
    expect(retry.replayed).toBe(false);
  });

  it('keeps keys separate across scopes', async () => {
    const counter = { n: 0 };
    await command(uniq('a'), 'key-00000005', {}, counter);
    await command(uniq('b'), 'key-00000005', {}, counter);
    expect(counter.n).toBe(2);
  });

  it('never lets a stored response be edited', async () => {
    const scope = uniq('scope');
    await command(scope, 'key-00000006', {}, { n: 0 });
    await expect(
      pool.query(`UPDATE platform.idempotency_keys SET response_status = 200 WHERE scope = $1`, [
        scope,
      ]),
    ).rejects.toThrow(/cannot be modified/);
  });

  it('rejects malformed keys', async () => {
    await expect(
      withTransaction(pool, (tx) =>
        runIdempotent(tx, { scope: 's', key: 'short', request: {} }, async () => ({
          status: 200,
          body: {},
        })),
      ),
    ).rejects.toThrow(/Invalid Idempotency-Key/);
  });
});

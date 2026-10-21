import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testPool, uniq } from '../../../test/db';
import { recordInbound, verifyHmacSignature } from './inbox';

const pool = testPool();
afterAll(() => pool.end());

const event = (id: string, payload: Record<string, unknown> = { amount: '1000.00' }) => ({
  source: 'fiat_partner',
  externalEventId: id,
  eventType: 'deposit.cleared',
  payload,
  signatureValid: true,
});

describe('inbox (NFR-03, DEP-02)', () => {
  it('accepts a new event once and treats an identical redelivery as a duplicate', async () => {
    const id = uniq('evt');
    const first = await recordInbound(pool, event(id));
    const second = await recordInbound(pool, event(id));
    expect(first.kind).toBe('accepted');
    expect(second).toEqual({ kind: 'duplicate', id: first.id });
    const { rowCount } = await pool.query(
      'SELECT 1 FROM platform.inbox WHERE external_event_id = $1',
      [id],
    );
    expect(rowCount).toBe(1);
  });

  it('treats key order as irrelevant when comparing redeliveries', async () => {
    const id = uniq('evt');
    await recordInbound(pool, event(id, { a: 1, b: 2 }));
    expect((await recordInbound(pool, event(id, { b: 2, a: 1 }))).kind).toBe('duplicate');
  });

  it('flags the same event id arriving with different content', async () => {
    const id = uniq('evt');
    await recordInbound(pool, event(id, { amount: '1000.00' }));
    const tampered = await recordInbound(pool, event(id, { amount: '9000.00' }));
    expect(tampered.kind).toBe('conflict');
    const { rows } = await pool.query(
      'SELECT payload, conflicting_redeliveries FROM platform.inbox WHERE id = $1',
      [tampered.id],
    );
    expect(rows[0].payload).toEqual({ amount: '1000.00' });
    expect(rows[0].conflicting_redeliveries).toBe(1);
  });

  it('keeps invalid-signature events as evidence that can never be processed', async () => {
    const r = await recordInbound(pool, { ...event(uniq('evt')), signatureValid: false });
    expect(r.kind).toBe('rejected');
    await expect(
      pool.query(`UPDATE platform.inbox SET status = 'processed' WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/inbox_invalid_never_processed/);
  });

  it('does not allow received evidence to be rewritten or deleted', async () => {
    const r = await recordInbound(pool, event(uniq('evt')));
    await expect(
      pool.query(`UPDATE platform.inbox SET payload = '{}'::jsonb WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/cannot be modified/);
    await expect(pool.query('DELETE FROM platform.inbox WHERE id = $1', [r.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('never lets a forged event block the genuine event with the same id', async () => {
    const id = uniq('evt');
    const forged = await recordInbound(pool, {
      ...event(id, { amount: '1.00' }),
      signatureValid: false,
    });
    expect(forged.kind).toBe('rejected');
    const genuine = await recordInbound(pool, event(id, { amount: '1000.00' }));
    expect(genuine.kind).toBe('accepted');
    expect(genuine.id).not.toBe(forged.id);
    // Repeated forgeries are all kept as evidence and still block nothing.
    expect((await recordInbound(pool, { ...event(id), signatureValid: false })).kind).toBe(
      'rejected',
    );
    expect((await recordInbound(pool, event(id, { amount: '1000.00' }))).kind).toBe('duplicate');
  });

  it('records each of many concurrent identical deliveries exactly once', async () => {
    const id = uniq('evt');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordInbound(pool, event(id))),
    );
    expect(results.filter((r) => r.kind === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'duplicate')).toHaveLength(7);
  });
});

describe('webhook signature check', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1"}';
  const now = new Date('2026-10-21T16:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  it('accepts a correct, fresh signature', () => {
    expect(
      verifyHmacSignature({ secret, rawBody: body, timestamp: ts, signatureHex: sig, now }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyHmacSignature({
        secret,
        rawBody: '{"id":"evt_2"}',
        timestamp: ts,
        signatureHex: sig,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a replay outside the time window', () => {
    const later = new Date(now.getTime() + 10 * 60 * 1000);
    expect(
      verifyHmacSignature({ secret, rawBody: body, timestamp: ts, signatureHex: sig, now: later }),
    ).toBe(false);
  });

  it('rejects garbage signatures without throwing', () => {
    expect(
      verifyHmacSignature({ secret, rawBody: body, timestamp: ts, signatureHex: 'zz', now }),
    ).toBe(false);
  });
});

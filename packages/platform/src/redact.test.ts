import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { isSensitiveKey, redact, REDACTED, redactString } from './redact';

describe('redaction (NFR-09)', () => {
  it('masks sensitive fields at any depth', () => {
    const out = redact({
      email: 'kyle@example.com',
      password: 'hunter2',
      nested: { mfa_code: '123456', apiKey: 'sk_live_x', list: [{ cardNumber: '4111' }] },
      headers: { Authorization: 'Bearer abc', cookie: 'sid=1' },
    });
    expect(out.email).toBe('kyle@example.com');
    expect(out.password).toBe(REDACTED);
    expect(out.nested.mfa_code).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.list[0]!.cardNumber).toBe(REDACTED);
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.cookie).toBe(REDACTED);
  });

  it('does not over-match ordinary field names', () => {
    for (const k of [
      'footprint',
      'company',
      'requestId',
      'occurredAt',
      'amountMinor',
      'shipping',
    ]) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
    for (const k of ['otp', 'userPin', 'pan', 'seed', 'x-signature', 'privateKey', 'seed_phrase']) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });

  it('masks card-shaped numbers in free text but keeps ids and timestamps', () => {
    expect(redactString('card 4111 1111 1111 1111 declined')).toBe(`card ${REDACTED} declined`);
    expect(redactString('id 550e8400-e29b-41d4-a716-446655440000')).toContain('446655440000');
    expect(redactString('at 2026-10-21T15:00:00Z')).toContain('2026-10-21');
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a).self).toBe('[CIRCULAR]');
  });

  it('applies to everything the logger writes', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ service: 'test', level: 'info', destination: dest });
    log.info({ body: { password: 'hunter2', token: 'abc' } }, 'card 4111111111111111 seen');
    log.error({ err: new Error('failed for 4111-1111-1111-1111') }, 'boom');
    const text = lines.join('');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('4111-1111-1111-1111');
    expect(text).toContain(REDACTED);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '@transferhub/platform';
import { testPool, uniq } from '../../../test/db';
import {
  PURGE_IDEMPOTENCY_JOB,
  purgeExpiredIdempotencyKeys,
  scheduleMaintenance,
} from './maintenance';

const pool = testPool();
afterAll(() => pool.end());
const log = createLogger({ service: 'test', level: 'silent' });

async function insertKey(scope: string, expiresIn: string) {
  await pool.query(
    `INSERT INTO platform.idempotency_keys (scope, key, request_sha256, response_status, response_body, expires_at)
     VALUES ($1, 'key-00000001', '\\x00', 201, '{}', now() + $2::interval)`,
    [scope, expiresIn],
  );
}

describe('maintenance jobs', () => {
  it('purges only expired idempotency keys', async () => {
    const expired = uniq('expired');
    const live = uniq('live');
    await insertKey(expired, '-1 hour');
    await insertKey(live, '1 hour');
    await purgeExpiredIdempotencyKeys(
      pool,
      2,
    )({
      job: {} as never,
      log,
      signal: new AbortController().signal,
    });
    const { rows } = await pool.query(
      'SELECT scope FROM platform.idempotency_keys WHERE scope = ANY($1)',
      [[expired, live]],
    );
    expect(rows.map((r) => r.scope)).toEqual([live]);
  });

  it('schedules one purge per hour no matter how many workers start', async () => {
    const at = new Date('2031-01-01T10:15:00Z');
    await Promise.all([scheduleMaintenance(pool, at), scheduleMaintenance(pool, at)]);
    await scheduleMaintenance(pool, new Date('2031-01-01T10:59:00Z'));
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM platform.jobs WHERE type = $1 AND dedupe_key LIKE '%2031-01-01T10'`,
      [PURGE_IDEMPOTENCY_JOB],
    );
    expect(rows[0].n).toBe(1);
  });
});

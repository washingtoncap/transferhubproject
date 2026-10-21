import type { ApiConfig } from '@transferhub/config';
import type { SessionUser } from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { describe, expect, it } from 'vitest';
import { OpsController } from './ops.controller';

// Role checks run before any database access, so a pool that fails on use proves that a
// refused call never reached the data.
const pool = {
  query: () => {
    throw new Error('database must not be touched');
  },
  connect: () => {
    throw new Error('database must not be touched');
  },
} as unknown as Pool;
const controller = new OpsController(pool, { APP_ENV: 'local' } as ApiConfig);

const staff = (roles: string[]): SessionUser => ({
  sessionId: 's',
  userId: 'u',
  email: 'x@example.test',
  fullName: 'X',
  isStaff: true,
  staffRoles: roles,
  mfaEnabled: true,
  mfaVerified: true,
});

const credit = { asset: 'TTD', amountMinor: 50000, reference: 'THXXXX', senderName: 'Someone' };

describe('ops role separation', () => {
  it('finance cannot post bank credits or read the deposit queue (separation of duties)', async () => {
    await expect(
      controller.bankCredit(staff(['finance', 'treasury']), credit),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(() => controller.deposits(staff(['finance']))).toThrow(/operations/);
  });

  it('compliance cannot post bank credits', async () => {
    await expect(controller.bankCredit(staff(['compliance']), credit)).rejects.toMatchObject({
      status: 403,
    });
  });
});

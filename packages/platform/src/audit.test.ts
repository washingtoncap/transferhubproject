import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@transferhub/db';
import { testPool, uniq } from '../../../test/db';
import { recordAudit } from './audit';

const pool = testPool();
afterAll(() => pool.end());

const base = {
  actorType: 'staff' as const,
  actorId: 'staff-1',
  action: 'membership.role_changed',
  objectType: 'membership',
};

describe('audit log (TH-REQ §6)', () => {
  it('records actor, entity, action and a content hash', async () => {
    const entityId = randomUUID();
    const rec = await recordAudit(pool, {
      ...base,
      entityId,
      objectId: 'm-1',
      requestId: 'req-1',
      reason: 'Customer request',
      before: { role: 'viewer' },
      after: { role: 'approver' },
    });
    expect(rec.rowHash).toHaveLength(32);
    const { rows } = await pool.query('SELECT * FROM platform.audit_log WHERE id = $1', [rec.id]);
    expect(rows[0]).toMatchObject({
      actor_type: 'staff',
      entity_id: entityId,
      action: 'membership.role_changed',
      before_state: { role: 'viewer' },
      after_state: { role: 'approver' },
    });
  });

  it('cannot be updated, deleted or truncated — even by the table owner', async () => {
    const rec = await recordAudit(pool, base);
    await expect(
      pool.query(`UPDATE platform.audit_log SET reason = 'x' WHERE id = $1`, [rec.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM platform.audit_log WHERE id = $1', [rec.id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE platform.audit_log')).rejects.toThrow(/append-only/);
  });

  it('rejects a maker approving their own action', async () => {
    await expect(recordAudit(pool, { ...base, approverId: base.actorId })).rejects.toThrow(
      /audit_approver_is_not_actor/,
    );
  });

  it('accepts a different approver (maker/checker)', async () => {
    const rec = await recordAudit(pool, { ...base, approverId: 'staff-2' });
    expect(rec.id).toBeTruthy();
  });

  it('redacts secrets in stored snapshots', async () => {
    const rec = await recordAudit(pool, { ...base, after: { password: 'hunter2', role: 'x' } });
    const { rows } = await pool.query('SELECT after_state FROM platform.audit_log WHERE id = $1', [
      rec.id,
    ]);
    expect(JSON.stringify(rows[0].after_state)).not.toContain('hunter2');
  });

  it('disappears together with the state change when the transaction rolls back', async () => {
    const marker = uniq('rollback');
    await expect(
      withTransaction(pool, async (tx) => {
        await recordAudit(tx, { ...base, objectId: marker });
        throw new Error('state change failed');
      }),
    ).rejects.toThrow('state change failed');
    const { rowCount } = await pool.query('SELECT 1 FROM platform.audit_log WHERE object_id = $1', [
      marker,
    ]);
    expect(rowCount).toBe(0);
  });

  it('rejects malformed action names', async () => {
    await expect(recordAudit(pool, { ...base, action: 'DeleteEverything' })).rejects.toThrow();
  });
});

import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit, runIdempotent } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { loadEntity, requireApproved } from './access';
import { currentSubscription } from './entities';
import { DomainError, invalid, notFound } from './errors';
import { ownRate } from './fx';
import { customerAccountId, lockAccounts, postJournal, requireAvailable } from './ledger';
import { formatMoney, formatRate, toNumber } from './money';
import { ratePolicy } from './plans';

export const CONSENT_TEXT =
  'I agree to sell USD through this main seller’s TransferHub network at the rate they set for me. ' +
  'I understand the main seller earns the difference between their rate and mine, that my balance ' +
  'remains mine and cannot be taken by the main seller, and that I can leave the network at any time.';

async function requireMainSeller(db: Queryable, entityId: string) {
  const e = await requireApproved(db, entityId);
  if (e.customer_role !== 'seller') throw new DomainError('not_a_seller', 'Only seller accounts have a seller network.', 403);
  const isChild = await db.query(`SELECT 1 FROM app.seller_links WHERE child_entity_id = $1 AND status = 'active'`, [entityId]);
  if (isChild.rowCount) {
    throw new DomainError('nested_network', 'You sell under a main seller, so you cannot have your own network.', 403);
  }
  return e;
}

async function parentContext(db: Queryable, entityId: string) {
  const policy = await ratePolicy(db);
  const parent = await ownRate(db, entityId, 'sell_usd', 0);
  const sub = await currentSubscription(db, entityId);
  return { policy, parentRateE4: parent.rateE4, childLimit: sub?.plan?.audience === 'seller' ? sub.plan.childLimit : 0 };
}

function validateChildRate(rateE4: unknown, parentRateE4: number, floorE4: number): number {
  const r = Number(rateE4);
  if (!Number.isInteger(r)) throw invalid('Enter a rate such as 7.7000.');
  if (r > parentRateE4) {
    throw new DomainError('child_rate_exceeds_parent', `A child rate cannot be above your own rate of ${formatRate(parentRateE4)}.`, 422);
  }
  if (r < floorE4) {
    throw new DomainError('child_rate_below_floor', `A child rate cannot be below the current floor of ${formatRate(floorE4)}.`, 422);
  }
  return r;
}

export async function network(db: Queryable, entityId: string) {
  await requireMainSeller(db, entityId);
  const ctx = await parentContext(db, entityId);
  const { rows } = await db.query<{
    id: string; child_entity_id: string; legal_name: string; reference_code: string; onboarding_status: string;
    child_rate_e4: number; status: string; invited_at: Date; accepted_at: Date | null; margin: string; volume: string;
  }>(
    `SELECT l.id, l.child_entity_id, c.legal_name, c.reference_code, c.onboarding_status, l.child_rate_e4, l.status,
            l.invited_at, l.accepted_at,
            COALESCE((SELECT sum(q.parent_margin_minor) FROM app.quotes q
                       WHERE q.entity_id = l.child_entity_id AND q.parent_entity_id = l.parent_entity_id AND q.status = 'accepted'), 0) AS margin,
            COALESCE((SELECT sum(q.usd_minor) FROM app.quotes q
                       WHERE q.entity_id = l.child_entity_id AND q.parent_entity_id = l.parent_entity_id AND q.status = 'accepted'), 0) AS volume
       FROM app.seller_links l JOIN app.entities c ON c.id = l.child_entity_id
      WHERE l.parent_entity_id = $1 AND l.status IN ('invited', 'active', 'detached')
      ORDER BY (l.status = 'active') DESC, l.invited_at DESC`,
    [entityId],
  );
  const earnings = await db.query<{ total: string; last30: string }>(
    `SELECT COALESCE(sum(parent_margin_minor), 0) AS total,
            COALESCE(sum(parent_margin_minor) FILTER (WHERE accepted_at > now() - interval '30 days'), 0) AS last30
       FROM app.quotes WHERE parent_entity_id = $1 AND status = 'accepted'`,
    [entityId],
  );
  const alloc = await db.query<{ total: string }>(
    `SELECT COALESCE(sum(p.amount_minor), 0) AS total FROM ledger.postings p
       JOIN ledger.journals j ON j.id = p.journal_id JOIN ledger.accounts a ON a.id = p.account_id
      WHERE j.kind = 'allocation' AND a.entity_id = $1 AND p.line_type = 'allocation_out'`,
    [entityId],
  );
  return {
    parentRateE4: ctx.parentRateE4,
    childFloorE4: ctx.policy.childFloorE4,
    childLimit: ctx.childLimit,
    activeChildren: rows.filter((r) => r.status === 'active').length,
    links: rows.map((r) => ({
      id: r.id,
      child: { id: r.child_entity_id, legalName: r.legal_name, referenceCode: r.reference_code, onboardingStatus: r.onboarding_status },
      childRateE4: r.child_rate_e4,
      status: r.status,
      invitedAt: r.invited_at.toISOString(),
      acceptedAt: r.accepted_at?.toISOString() ?? null,
      marginEarnedMinor: toNumber(r.margin),
      childVolumeUsdMinor: toNumber(r.volume),
    })),
    earnings: {
      totalMarginMinor: toNumber(earnings.rows[0]!.total),
      last30DaysMarginMinor: toNumber(earnings.rows[0]!.last30),
      allocationsOutMinor: toNumber(alloc.rows[0]!.total),
    },
  };
}

async function linkView(db: Queryable, parentId: string, linkId: string) {
  const n = await network(db, parentId);
  const l = n.links.find((x) => x.id === linkId);
  if (!l) throw notFound('Network member');
  return l;
}

/** SEL-01: invite another verified seller by its reference code. The child must consent. */
export async function inviteChild(pool: Pool, user: SessionUser, parentId: string, raw: { childReferenceCode?: unknown; childRateE4?: unknown }) {
  const code = String(raw.childReferenceCode ?? '').trim().toUpperCase();
  if (!/^TH[A-Z0-9]{6}$/.test(code)) throw invalid('Enter the seller’s TransferHub reference code, e.g. THPOS7K2.');
  const linkId = await withTransaction(pool, async (tx) => {
    await requireMainSeller(tx, parentId);
    const ctx = await parentContext(tx, parentId);
    const rate = validateChildRate(raw.childRateE4, ctx.parentRateE4, ctx.policy.childFloorE4);
    const child = await tx.query<{ id: string; customer_role: string }>('SELECT id, customer_role FROM app.entities WHERE reference_code = $1', [code]);
    const c = child.rows[0];
    // Buyers cannot be invited (SEL-01: buyer subaccounts are excluded).
    if (!c || c.customer_role !== 'seller') throw new DomainError('not_a_seller', 'No seller account has that reference code.', 404);
    if (c.id === parentId) throw invalid('You cannot invite yourself.');
    const count = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.seller_links WHERE parent_entity_id = $1 AND status IN ('invited', 'active')`,
      [parentId],
    );
    if (toNumber(count.rows[0]!.n) >= ctx.childLimit) {
      throw new DomainError('child_limit_reached', `Your plan allows ${ctx.childLimit} network members. Upgrade your plan to add more.`, 409);
    }
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO app.seller_links (parent_entity_id, child_entity_id, child_rate_e4, invited_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [parentId, c.id, rate, user.userId],
      );
      await recordAudit(tx, {
        actorType: 'customer', actorId: user.userId, entityId: parentId, action: 'seller_link.invited', objectType: 'seller_link',
        objectId: rows[0]!.id, after: { childEntityId: c.id, childRateE4: rate },
      });
      return rows[0]!.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/seller_links_one_parent/.test(msg)) throw new DomainError('invalid_state', 'That seller already belongs to, or is invited to, a network.', 409);
      if (/one level/.test(msg)) throw new DomainError('nested_network', 'That seller runs their own network. Networks are one level only.', 409);
      throw err;
    }
  });
  return linkView(pool, parentId, linkId);
}

export async function setChildRate(pool: Pool, user: SessionUser, parentId: string, linkId: string, rateE4: unknown) {
  await withTransaction(pool, async (tx) => {
    await requireMainSeller(tx, parentId);
    const ctx = await parentContext(tx, parentId);
    const rate = validateChildRate(rateE4, ctx.parentRateE4, ctx.policy.childFloorE4);
    const { rows } = await tx.query<{ child_rate_e4: number }>(
      `SELECT child_rate_e4 FROM app.seller_links WHERE id = $1 AND parent_entity_id = $2 AND status IN ('invited', 'active') FOR UPDATE`,
      [linkId, parentId],
    );
    if (!rows[0]) throw notFound('Network member');
    await tx.query('UPDATE app.seller_links SET child_rate_e4 = $2 WHERE id = $1', [linkId, rate]);
    await recordAudit(tx, {
      actorType: 'customer', actorId: user.userId, entityId: parentId, action: 'seller_link.rate_changed', objectType: 'seller_link',
      objectId: linkId, before: { childRateE4: rows[0].child_rate_e4 }, after: { childRateE4: rate },
    });
  });
  return linkView(pool, parentId, linkId);
}

/** Detaching ends the parent's authority. The child keeps its account and its money. */
export async function detachChild(pool: Pool, user: SessionUser, parentId: string, linkId: string) {
  await withTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE app.seller_links SET status = 'detached', ended_at = now()
        WHERE id = $1 AND parent_entity_id = $2 AND status IN ('invited', 'active')`,
      [linkId, parentId],
    );
    if (!rowCount) throw notFound('Network member');
    await recordAudit(tx, {
      actorType: 'customer', actorId: user.userId, entityId: parentId, action: 'seller_link.detached', objectType: 'seller_link', objectId: linkId,
    });
  });
  return linkView(pool, parentId, linkId);
}

export async function invitationsFor(db: Queryable, childId: string) {
  const { rows } = await db.query<{ id: string; parent_entity_id: string; legal_name: string; child_rate_e4: number; status: string; invited_at: Date }>(
    `SELECT l.id, l.parent_entity_id, p.legal_name, l.child_rate_e4, l.status, l.invited_at
       FROM app.seller_links l JOIN app.entities p ON p.id = l.parent_entity_id
      WHERE l.child_entity_id = $1 AND l.status IN ('invited', 'active') ORDER BY l.invited_at DESC`,
    [childId],
  );
  return rows.map((r) => ({
    id: r.id,
    parent: { id: r.parent_entity_id, legalName: r.legal_name },
    childRateE4: r.child_rate_e4,
    status: r.status,
    invitedAt: r.invited_at.toISOString(),
    consentText: CONSENT_TEXT,
  }));
}

export async function respondToInvitation(pool: Pool, user: SessionUser, childId: string, linkId: string, accept: boolean, consent: unknown) {
  if (accept && consent !== true) throw new DomainError('consent_required', 'You must agree to the network terms to join.', 422);
  await withTransaction(pool, async (tx) => {
    await requireApproved(tx, childId);
    const { rows } = await tx.query<{ status: string }>(
      `SELECT status FROM app.seller_links WHERE id = $1 AND child_entity_id = $2 FOR UPDATE`,
      [linkId, childId],
    );
    if (!rows[0]) throw notFound('Invitation');
    if (rows[0].status !== 'invited') throw new DomainError('invalid_state', 'This invitation is no longer open.', 409);
    try {
      await tx.query(
        accept
          ? `UPDATE app.seller_links SET status = 'active', accepted_at = now(), consent_text = $2 WHERE id = $1`
          : `UPDATE app.seller_links SET status = 'declined', ended_at = now() WHERE id = $1`,
        accept ? [linkId, CONSENT_TEXT] : [linkId],
      );
    } catch (err) {
      if (err instanceof Error && /one level/.test(err.message)) {
        throw new DomainError('nested_network', 'You run your own seller network, so you cannot join another.', 409);
      }
      throw err;
    }
    await recordAudit(tx, {
      actorType: 'customer', actorId: user.userId, entityId: childId,
      action: accept ? 'seller_link.accepted' : 'seller_link.declined', objectType: 'seller_link', objectId: linkId,
      metadata: accept ? { consent: CONSENT_TEXT } : {},
    });
  });
  return (await invitationsFor(pool, childId)).find((i) => i.id === linkId) ?? null;
}

/**
 * SEL-04: a parent moves its OWN available TTD to an active child. No FX, no margin. The child's
 * principal is never touched — the only debit is to the parent's account.
 */
export async function allocate(pool: Pool, user: SessionUser, parentId: string, raw: { childEntityId?: unknown; amountMinor?: unknown }, idempotencyKey: string) {
  const amount = Number(raw.amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid('Enter an amount greater than zero.');
  const childId = String(raw.childEntityId ?? '');
  const res = await withTransaction(pool, (tx) =>
    runIdempotent(tx, { scope: `entity:${parentId}:allocate`, key: idempotencyKey, request: { childId, amount } }, async () => {
      await requireMainSeller(tx, parentId);
      const link = await tx.query(`SELECT id FROM app.seller_links WHERE parent_entity_id = $1 AND child_entity_id = $2 AND status = 'active'`, [parentId, childId]);
      if (!link.rowCount) throw notFound('Active network member');
      const child = await loadEntity(tx, childId);
      const from = await customerAccountId(tx, parentId, 'TTD');
      const to = await customerAccountId(tx, childId, 'TTD');
      await lockAccounts(tx, [from, to]);
      await requireAvailable(tx, from, 'TTD', amount);
      const sourceId = `${parentId}:${idempotencyKey}`;
      const journalId = await postJournal(tx, {
        kind: 'allocation', sourceType: 'allocation', sourceId,
        memo: `Allocation of ${formatMoney(amount, 'TTD')} to ${child.legal_name}`,
        createdBy: `user:${user.userId}`,
        lines: [
          { accountId: from, asset: 'TTD', amountMinor: amount, lineType: 'allocation_out' },
          { accountId: to, asset: 'TTD', amountMinor: -amount, lineType: 'allocation_in' },
        ],
      });
      await recordAudit(tx, {
        actorType: 'customer', actorId: user.userId, entityId: parentId, action: 'allocation.posted', objectType: 'allocation',
        objectId: journalId, after: { childEntityId: childId, amountMinor: amount },
      });
      return { status: 201, body: { journalId } };
    }),
  );
  return res.body;
}

import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit, runIdempotent } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { requireApproved } from './access';
import { currentSubscription } from './entities';
import { DomainError, invalid } from './errors';
import { customerAccountId, lockAccounts, postJournal, requireAvailable, systemAccountId } from './ledger';
import { formatMoney, toNumber } from './money';
import { monthlyUsdVolume, planView } from './plans';

export async function subscriptionOverview(db: Queryable, entityId: string) {
  const sub = await currentSubscription(db, entityId);
  const { rows } = await db.query<{
    id: string; number: string; description: string; amount_minor: string; period_start: Date; period_end: Date; status: string; created_at: Date;
  }>(
    `SELECT id, number, description, amount_minor, period_start, period_end, status, created_at
       FROM app.invoices WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [entityId],
  );
  return {
    subscription: sub?.subscription ?? null,
    plan: sub?.plan ?? null,
    invoices: rows.map((r) => ({
      id: r.id, number: r.number, description: r.description, amountMinor: toNumber(r.amount_minor), currency: 'TTD',
      periodStart: r.period_start.toISOString(), periodEnd: r.period_end.toISOString(), status: r.status, createdAt: r.created_at.toISOString(),
    })),
    usage: { usdVolumeMinor: await monthlyUsdVolume(db, entityId), allowanceUsdMinor: sub?.plan?.volumeAllowanceUsdMinor ?? null },
  };
}

/**
 * BILL-01: subscribe or change plan. Charged in TTD from the customer's own available balance, only
 * with explicit consent, only for an approved account. Annual = 10 × monthly (enforced by the
 * plans table). A plan change ends the current subscription immediately; proration and refunds
 * are decision D07 and not modelled in the sandbox.
 */
export async function subscribe(
  pool: Pool,
  user: SessionUser,
  entityId: string,
  raw: { planCode?: unknown; billingInterval?: unknown; consent?: unknown },
  idempotencyKey: string,
) {
  if (raw.consent !== true) throw new DomainError('consent_required', 'Please authorise the charge to continue.', 422);
  const interval = raw.billingInterval;
  if (interval !== 'monthly' && interval !== 'annual') throw invalid('Choose monthly or annual billing.');
  const planCode = String(raw.planCode ?? '');
  await withTransaction(pool, (tx) =>
    runIdempotent(tx, { scope: `entity:${entityId}:subscribe`, key: idempotencyKey, request: { planCode, interval } }, async () => {
      const e = await requireApproved(tx, entityId);
      const plan = await planView(tx, planCode);
      if (plan.audience !== e.customer_role) throw invalid(`That plan is for ${plan.audience}s.`);
      const existing = await currentSubscription(tx, entityId);
      if (existing?.subscription.planCode === planCode && existing.subscription.billingInterval === interval && existing.subscription.status === 'active') {
        throw new DomainError('invalid_state', 'You are already on this plan.', 409);
      }
      if (plan.audience === 'seller' && existing?.plan && plan.childLimit < existing.plan.childLimit) {
        const n = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM app.seller_links WHERE parent_entity_id = $1 AND status IN ('invited','active')`, [entityId]);
        if (toNumber(n.rows[0]!.n) > plan.childLimit) {
          // BILL-02 / AT07: never strand a network silently — the seller detaches members first.
          throw new DomainError('child_limit_reached', `You have more network members than the ${plan.name} plan allows (${plan.childLimit}). Detach members first.`, 409);
        }
      }
      const amount = interval === 'annual' ? plan.annualMinor : plan.monthlyMinor;
      const cust = await customerAccountId(tx, entityId, 'TTD');
      const rev = await systemAccountId(tx, 'platform_revenue', 'TTD');
      await lockAccounts(tx, [cust, rev]);
      await requireAvailable(tx, cust, 'TTD', amount);
      if (existing) {
        await tx.query(`UPDATE app.subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [existing.subscription.id]);
      }
      const { rows } = await tx.query<{ id: string; current_period_start: Date; current_period_end: Date }>(
        `INSERT INTO app.subscriptions (entity_id, plan_code, billing_interval, current_period_start, current_period_end)
         VALUES ($1, $2, $3, now(), now() + CASE WHEN $3 = 'annual' THEN interval '1 year' ELSE interval '1 month' END)
         RETURNING id, current_period_start, current_period_end`,
        [entityId, planCode, interval],
      );
      const s = rows[0]!;
      const seq = await tx.query<{ n: string }>("SELECT nextval('app.invoice_number_seq') AS n");
      const number = `TH-INV-${seq.rows[0]!.n}`;
      const description = `${plan.audience === 'buyer' ? 'Buyer' : 'Seller'} ${plan.name} — ${interval}`;
      const { rows: inv } = await tx.query<{ id: string }>(
        `INSERT INTO app.invoices (number, entity_id, subscription_id, description, amount_minor, period_start, period_end, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid') RETURNING id`,
        [number, entityId, s.id, description, amount, s.current_period_start, s.current_period_end],
      );
      const journalId = await postJournal(tx, {
        kind: 'subscription_charge', sourceType: 'invoice', sourceId: inv[0]!.id,
        memo: `Subscription ${number}: ${description} (${formatMoney(amount, 'TTD')})`, createdBy: `user:${user.userId}`,
        lines: [
          { accountId: cust, asset: 'TTD', amountMinor: amount, lineType: 'subscription_fee' },
          { accountId: rev, asset: 'TTD', amountMinor: -amount, lineType: 'subscription_revenue' },
        ],
      });
      await tx.query('UPDATE app.invoices SET journal_id = $2 WHERE id = $1', [inv[0]!.id, journalId]);
      await recordAudit(tx, {
        actorType: 'customer', actorId: user.userId, entityId, action: 'subscription.started', objectType: 'subscription', objectId: s.id,
        before: existing ? { planCode: existing.subscription.planCode } : undefined,
        after: { planCode, interval, invoice: number, amountMinor: amount },
        metadata: { consent: `Authorised charge of ${formatMoney(amount, 'TTD')} to TTD balance` },
      });
      return { status: 201, body: { subscriptionId: s.id } };
    }),
  );
  return subscriptionOverview(pool, entityId);
}

/** BILL-02: cancelling keeps service to period end and never touches balances or statements. */
export async function cancelSubscription(pool: Pool, user: SessionUser, entityId: string) {
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE app.subscriptions SET status = 'cancel_at_period_end', cancelled_at = now()
        WHERE entity_id = $1 AND status = 'active' RETURNING id`,
      [entityId],
    );
    if (!rows[0]) throw new DomainError('invalid_state', 'There is no active subscription to cancel.', 409);
    await recordAudit(tx, {
      actorType: 'customer', actorId: user.userId, entityId, action: 'subscription.cancel_requested', objectType: 'subscription', objectId: rows[0].id,
    });
  });
  return subscriptionOverview(pool, entityId);
}

import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { loadEntity } from './access';
import { balances, entityDetail } from './entities';
import { DomainError, invalid, notFound } from './errors';
import { trialBalance } from './ledger';
import { type Asset, ASSETS, toNumber } from './money';
import { ratePolicy } from './plans';
import { toClaimView } from './deposits';

export async function overview(db: Queryable) {
  const { rows } = await db.query<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM app.entities WHERE onboarding_status IN ('submitted','vendor_checks','compliance_review')) AS kyc,
      (SELECT count(*) FROM app.deposit_claims WHERE status = 'pending') AS deposits,
      (SELECT count(*) FROM app.withdrawals WHERE status = 'pending_approval') AS withdrawals,
      (SELECT count(*) FROM platform.jobs WHERE status = 'dead') AS dead_jobs,
      (SELECT count(*) FROM app.entities) AS customers,
      (SELECT count(*) FROM app.entities WHERE onboarding_status = 'approved') AS approved,
      (SELECT count(*) FROM app.quotes WHERE status = 'accepted' AND accepted_at > now() - interval '24 hours') AS trades,
      (SELECT COALESCE(sum(usd_minor),0) FROM app.quotes WHERE status = 'accepted' AND accepted_at > now() - interval '24 hours') AS trades_usd,
      (SELECT count(*) FROM app.deposit_claims WHERE status = 'cleared' AND cleared_at > now() - interval '24 hours') AS cleared,
      (SELECT -COALESCE(sum(p.amount_minor),0) FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id
        WHERE a.code = 'system:platform_revenue:TTD') AS revenue`);
  const r = rows[0]!;
  const recon = await reconciliation(db);
  return {
    kycQueue: toNumber(r.kyc),
    pendingDeposits: toNumber(r.deposits),
    withdrawalsAwaitingApproval: toNumber(r.withdrawals),
    // Number of currencies whose ledger cash differs from the partner statement. Unmatched
    // statement lines explain a break; they are not counted as extra breaks.
    reconciliationBreaks: recon.assets.filter((a) => a.status === 'break').length,
    deadJobs: toNumber(r.dead_jobs),
    customers: { total: toNumber(r.customers), approved: toNumber(r.approved) },
    last24h: {
      tradesCount: toNumber(r.trades),
      tradesUsdMinor: toNumber(r.trades_usd),
      depositsClearedCount: toNumber(r.cleared),
    },
    platformRevenueTtdMinor: toNumber(r.revenue),
  };
}

const CUSTOMER_SELECT = `
  SELECT e.id, e.kind, e.customer_role, e.legal_name, e.reference_code, e.onboarding_status, e.created_at, e.submitted_at,
         e.risk_rating, e.screening_result,
         (SELECT plan_code FROM app.subscriptions s WHERE s.entity_id = e.id AND s.status IN ('active','cancel_at_period_end')) AS plan_code,
         (SELECT u.full_name FROM app.memberships m JOIN app.users u ON u.id = m.user_id WHERE m.entity_id = e.id AND m.role = 'owner' LIMIT 1) AS owner_name,
         (SELECT u.email FROM app.memberships m JOIN app.users u ON u.id = m.user_id WHERE m.entity_id = e.id AND m.role = 'owner' LIMIT 1) AS owner_email
    FROM app.entities e`;

interface CustRow {
  id: string;
  kind: string;
  customer_role: string;
  legal_name: string;
  reference_code: string;
  onboarding_status: string;
  created_at: Date;
  submitted_at: Date | null;
  risk_rating: string | null;
  screening_result: string | null;
  plan_code: string | null;
  owner_name: string | null;
  owner_email: string | null;
}
const toCust = (r: CustRow) => ({
  id: r.id,
  kind: r.kind,
  customerRole: r.customer_role,
  legalName: r.legal_name,
  referenceCode: r.reference_code,
  onboardingStatus: r.onboarding_status,
  createdAt: r.created_at.toISOString(),
  submittedAt: r.submitted_at?.toISOString() ?? null,
  riskRating: r.risk_rating,
  screeningResult: r.screening_result,
  planCode: r.plan_code,
  owner: r.owner_name ? { name: r.owner_name, email: r.owner_email! } : null,
});

export async function customers(db: Queryable, status?: string) {
  const { rows } = await db.query<CustRow>(
    `${CUSTOMER_SELECT} WHERE ($1::text IS NULL OR e.onboarding_status = ANY(string_to_array($1, ',')))
      ORDER BY e.submitted_at NULLS LAST, e.created_at DESC LIMIT 500`,
    [status ?? null],
  );
  return rows.map(toCust);
}

export async function customerDetail(db: Queryable, entityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw notFound('Customer');
  const { rows } = await db.query<CustRow>(`${CUSTOMER_SELECT} WHERE e.id = $1`, [entityId]);
  if (!rows[0]) throw notFound('Customer');
  const d = await entityDetail(db, entityId);
  const members = await db.query<{ full_name: string; email: string; role: string }>(
    `SELECT u.full_name, u.email, m.role FROM app.memberships m JOIN app.users u ON u.id = m.user_id WHERE m.entity_id = $1 ORDER BY m.created_at`,
    [entityId],
  );
  return {
    ...toCust(rows[0]),
    profile: d.profile,
    reviewReason: d.reviewReason,
    members: members.rows.map((m) => ({ name: m.full_name, email: m.email, role: m.role })),
    balances: await balances(db, entityId),
    audit: await audit(db, { entityId, limit: 50 }),
  };
}

/**
 * Compliance decision on an application (KYC/KYB). A reason is always recorded; approval needs a
 * risk rating. The decision-maker cannot be a member of the customer they are reviewing.
 */
export async function decideCustomer(
  pool: Pool,
  staff: SessionUser,
  entityId: string,
  raw: { decision?: unknown; reason?: unknown; riskRating?: unknown },
) {
  const decision = raw.decision as string;
  const map: Record<string, string> = {
    approve: 'approved',
    reject: 'rejected',
    needs_information: 'needs_information',
    restrict: 'restricted',
  };
  const next = map[decision];
  if (!next) throw invalid('Choose a decision.');
  const reason = String(raw.reason ?? '').trim();
  if (!reason) throw invalid('A reason is required for every decision.');
  const risk = raw.riskRating as string | undefined;
  if (decision === 'approve' && !['low', 'medium', 'high'].includes(risk ?? ''))
    throw invalid('Set a risk rating to approve.');
  await withTransaction(pool, async (tx) => {
    const e = await loadEntity(tx, entityId, true);
    const member = await tx.query(
      'SELECT 1 FROM app.memberships WHERE user_id = $1 AND entity_id = $2',
      [staff.userId, entityId],
    );
    if (member.rowCount)
      throw new DomainError(
        'self_approval',
        'You cannot review a customer account you belong to.',
        403,
      );
    const allowedFrom: Record<string, string[]> = {
      approved: ['submitted', 'vendor_checks', 'compliance_review'],
      rejected: ['submitted', 'vendor_checks', 'compliance_review', 'needs_information'],
      needs_information: ['submitted', 'vendor_checks', 'compliance_review'],
      restricted: ['approved'],
    };
    if (!allowedFrom[next]!.includes(e.onboarding_status)) {
      throw new DomainError(
        'invalid_state',
        `A customer in "${e.onboarding_status}" cannot move to "${next}".`,
        409,
      );
    }
    await tx.query(
      `UPDATE app.entities SET onboarding_status = $2, review_reason = $3, reviewed_by = $4,
              risk_rating = COALESCE($5, risk_rating), approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END
        WHERE id = $1`,
      [entityId, next, reason, staff.userId, risk ?? null],
    );
    await recordAudit(tx, {
      actorType: 'staff',
      actorId: staff.userId,
      entityId,
      action: `entity.${next}`,
      objectType: 'entity',
      objectId: entityId,
      reason,
      before: { status: e.onboarding_status },
      after: { status: next, riskRating: risk ?? null },
    });
  });
  return customerDetail(pool, entityId);
}

export async function opsDeposits(db: Queryable, status?: string) {
  const { rows } = await db.query<
    Parameters<typeof toClaimView>[0] & {
      entity_id: string;
      legal_name: string;
      reference_code: string;
    }
  >(
    `SELECT c.*, e.legal_name, e.reference_code FROM app.deposit_claims c JOIN app.entities e ON e.id = c.entity_id
      WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.created_at DESC LIMIT 200`,
    [status ?? null],
  );
  return rows.map((r) => ({
    ...toClaimView(r),
    entity: { id: r.entity_id, legalName: r.legal_name, referenceCode: r.reference_code },
  }));
}

export async function opsTrades(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    entity_id: string;
    legal_name: string;
    side: string;
    usd_minor: string;
    ttd_minor: string;
    rate_e4: number;
    rate_source: string;
    parent_margin_minor: string;
    platform_share_minor: string;
    accepted_at: Date;
  }>(
    `SELECT q.id, q.entity_id, e.legal_name, q.side, q.usd_minor, q.ttd_minor, q.rate_e4, q.rate_source, q.parent_margin_minor,
            q.platform_share_minor, q.accepted_at
       FROM app.quotes q JOIN app.entities e ON e.id = q.entity_id WHERE q.status = 'accepted' ORDER BY q.accepted_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({
    id: r.id,
    entity: { id: r.entity_id, legalName: r.legal_name },
    side: r.side,
    usdMinor: toNumber(r.usd_minor),
    ttdMinor: toNumber(r.ttd_minor),
    rateE4: r.rate_e4,
    rateSource: r.rate_source,
    parentMarginMinor: toNumber(r.parent_margin_minor),
    platformShareMinor: toNumber(r.platform_share_minor),
    acceptedAt: r.accepted_at.toISOString(),
  }));
}

/**
 * Daily reconciliation (NFR-08, TH-TLR): compare our ledger's cash-at-partner with the partner's
 * own statement, check the classification of that cash (customers + principal + revenue), check
 * the trial balance, and list statement lines no journal accounts for.
 */
export async function reconciliation(db: Queryable) {
  const tb = await trialBalance(db);
  const sums = await db.query<{ asset: Asset; type: string; total: string }>(
    `SELECT a.asset, a.type, COALESCE(sum(p.amount_minor), 0) AS total
       FROM ledger.accounts a LEFT JOIN ledger.postings p ON p.account_id = a.id GROUP BY a.asset, a.type`,
  );
  const partner = await db.query<{ asset: Asset; total: string }>(
    'SELECT asset, COALESCE(sum(amount_minor), 0) AS total FROM sandbox.partner_statement GROUP BY asset',
  );
  const get = (asset: Asset, type: string) =>
    toNumber(sums.rows.find((r) => r.asset === asset && r.type === type)?.total ?? 0);
  const assets = ASSETS.map((asset) => {
    const ledgerCash = get(asset, 'provider_cash');
    const partnerBal = toNumber(partner.rows.find((r) => r.asset === asset)?.total ?? 0);
    const diff = partnerBal - ledgerCash;
    return {
      asset,
      ledgerProviderCashMinor: ledgerCash,
      partnerStatementMinor: partnerBal,
      differenceMinor: diff,
      customerLiabilitiesMinor: 0 - get(asset, 'customer'),
      principalMinor: 0 - get(asset, 'fx_principal'),
      platformRevenueMinor: 0 - get(asset, 'platform_revenue'),
      trialBalanceMinor: tb[asset],
      status: diff === 0 && tb[asset] === 0 ? ('matched' as const) : ('break' as const),
    };
  });
  const unmatched = await db.query<{
    id: string;
    asset: Asset;
    amount_minor: string;
    description: string;
    reference: string | null;
    occurred_at: Date;
  }>(
    `SELECT s.id, s.asset, s.amount_minor, s.description, s.reference, s.occurred_at FROM sandbox.partner_statement s
      WHERE NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.source_type = 'partner_statement' AND j.source_id = s.external_event_id)
      ORDER BY s.occurred_at DESC LIMIT 100`,
  );
  const conflicts = await db.query<{ n: string }>(
    `SELECT COALESCE(sum(conflicting_redeliveries), 0) AS n FROM platform.inbox WHERE source = 'fiat_partner'`,
  );
  return {
    asOf: new Date().toISOString(),
    assets,
    unmatchedStatementLines: unmatched.rows.map((r) => ({
      id: r.id,
      asset: r.asset,
      amountMinor: toNumber(r.amount_minor),
      description: r.description,
      reference: r.reference,
      occurredAt: r.occurred_at.toISOString(),
    })),
    conflictingEvents: toNumber(conflicts.rows[0]!.n),
  };
}

/** Treasury changes to the rate policy. Every change is audited with before/after and a reason. */
export async function updateRatePolicy(
  pool: Pool,
  staff: SessionUser,
  raw: Record<string, unknown>,
) {
  const reason = String(raw.reason ?? '').trim();
  if (!reason) throw invalid('Give a reason for the change.');
  const fields: Record<string, string> = {
    standardBuyE4: 'standard_buy_e4',
    standardSellE4: 'standard_sell_e4',
    childFloorE4: 'child_floor_e4',
    platformShareE4: 'platform_share_e4',
    quoteTtlSeconds: 'quote_ttl_seconds',
    dualApprovalUsdMinor: 'dual_approval_usd_minor',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, col] of Object.entries(fields)) {
    if (raw[k] === undefined) continue;
    const n = Number(raw[k]);
    if (!Number.isSafeInteger(n) || n < 0) throw invalid(`${k} must be a whole number.`);
    values.push(n);
    sets.push(`${col} = $${values.length}`);
  }
  if (!sets.length) throw invalid('Nothing to change.');
  await withTransaction(pool, async (tx) => {
    const before = await ratePolicy(tx);
    values.push(staff.userId);
    try {
      await tx.query(
        `UPDATE app.rate_policy SET ${sets.join(', ')}, updated_by = $${values.length}, updated_at = now()`,
        values,
      );
    } catch (err) {
      if (err instanceof Error && /check constraint/.test(err.message))
        throw invalid('Those values are outside the allowed range.');
      throw err;
    }
    const after = await ratePolicy(tx);
    await recordAudit(tx, {
      actorType: 'staff',
      actorId: staff.userId,
      action: 'rate_policy.updated',
      objectType: 'rate_policy',
      objectId: 'current',
      reason,
      before,
      after,
    });
  });
  return ratePolicy(pool);
}

export async function audit(
  db: Queryable,
  params: { limit?: number; objectType?: string; entityId?: string },
) {
  const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
  const { rows } = await db.query<{
    id: string;
    occurred_at: Date;
    actor_type: string;
    actor_id: string;
    actor_name: string | null;
    entity_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    reason: string | null;
    approver_id: string | null;
    request_id: string | null;
  }>(
    `SELECT a.id, a.occurred_at, a.actor_type, a.actor_id, u.full_name AS actor_name, a.entity_id, a.action, a.object_type, a.object_id,
            a.reason, a.approver_id, a.request_id
       FROM platform.audit_log a
       LEFT JOIN app.users u ON a.actor_type IN ('customer','staff') AND u.id::text = a.actor_id
      WHERE ($1::text IS NULL OR a.object_type = $1) AND ($2::uuid IS NULL OR a.entity_id = $2)
      ORDER BY a.id DESC LIMIT $3`,
    [params.objectType || null, params.entityId || null, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: r.occurred_at.toISOString(),
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    entityId: r.entity_id,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    reason: r.reason,
    approverId: r.approver_id,
    requestId: r.request_id,
  }));
}

export async function system(db: Queryable) {
  const count = async (table: string, statuses: string[]) => {
    const { rows } = await db.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM ${table} GROUP BY status`,
    );
    return Object.fromEntries(
      statuses.map((s) => [s, toNumber(rows.find((r) => r.status === s)?.n ?? 0)]),
    );
  };
  const dead = await db.query<{
    id: string;
    type: string;
    last_error: string | null;
    attempts: number;
    updated_at: Date;
  }>(
    `SELECT id, type, last_error, attempts, updated_at FROM platform.jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 50`,
  );
  const recent = await db.query<{
    id: string;
    type: string;
    status: string;
    attempts: number;
    updated_at: Date;
  }>(
    `SELECT id, type, status, attempts, updated_at FROM platform.jobs ORDER BY updated_at DESC LIMIT 25`,
  );
  return {
    jobs: await count('platform.jobs', ['queued', 'running', 'succeeded', 'dead']),
    outbox: await count('platform.outbox', ['pending', 'dispatching', 'dispatched', 'dead']),
    inbox: await count('platform.inbox', [
      'received',
      'processing',
      'processed',
      'rejected',
      'dead',
    ]),
    deadJobs: dead.rows.map((r) => ({
      id: r.id,
      type: r.type,
      lastError: r.last_error,
      attempts: r.attempts,
      updatedAt: r.updated_at.toISOString(),
    })),
    recentJobs: recent.rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      attempts: r.attempts,
      updatedAt: r.updated_at.toISOString(),
    })),
  };
}

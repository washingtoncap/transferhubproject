import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { loadEntity } from './access';
import { DomainError, invalid } from './errors';
import { accountBalance, customerAccountId } from './ledger';
import { type Asset, ASSETS, toNumber } from './money';
import { planView, type PlanView } from './plans';

export interface Profile {
  address?: string;
  dateOfBirth?: string;
  occupation?: string;
  registrationNumber?: string;
  businessActivity?: string;
  beneficialOwners?: Array<{ name: string; ownershipPercent: number }>;
  purpose?: string;
  expectedMonthlyUsd?: number;
  sourceOfFunds?: string;
}

const PROFILE_STRING_FIELDS = [
  'address',
  'dateOfBirth',
  'occupation',
  'registrationNumber',
  'businessActivity',
  'purpose',
  'sourceOfFunds',
] as const;

export function cleanProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object') throw invalid('Profile must be an object.');
  const r = raw as Record<string, unknown>;
  const p: Profile = {};
  for (const k of PROFILE_STRING_FIELDS) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') {
      if (typeof r[k] !== 'string' || (r[k] as string).length > 500)
        throw invalid(`${k} is not valid.`);
      p[k] = (r[k] as string).trim();
    }
  }
  if (
    r.expectedMonthlyUsd !== undefined &&
    r.expectedMonthlyUsd !== null &&
    r.expectedMonthlyUsd !== ''
  ) {
    const n = Number(r.expectedMonthlyUsd);
    if (!Number.isFinite(n) || n < 0 || n > 1e9)
      throw invalid('Expected monthly USD is not valid.');
    p.expectedMonthlyUsd = Math.round(n);
  }
  if (Array.isArray(r.beneficialOwners)) {
    p.beneficialOwners = r.beneficialOwners.slice(0, 20).map((o: unknown) => {
      const x = o as Record<string, unknown>;
      const pct = Number(x.ownershipPercent);
      if (
        typeof x.name !== 'string' ||
        !x.name.trim() ||
        !Number.isFinite(pct) ||
        pct < 0 ||
        pct > 100
      ) {
        throw invalid(
          'Each beneficial owner needs a name and an ownership percentage from 0 to 100.',
        );
      }
      return { name: x.name.trim(), ownershipPercent: pct };
    });
  }
  return p;
}

/** Fields required before a customer can submit for verification (KYC-01 / KYB-01). */
export function missingProfileFields(kind: 'individual' | 'business', p: Profile): string[] {
  const common = ['address', 'purpose', 'expectedMonthlyUsd', 'sourceOfFunds'] as const;
  const specific =
    kind === 'individual'
      ? (['dateOfBirth', 'occupation'] as const)
      : (['registrationNumber', 'businessActivity'] as const);
  const missing: string[] = [...common, ...specific].filter(
    (k) => p[k] === undefined || p[k] === '',
  );
  if (kind === 'business') {
    const owners = p.beneficialOwners ?? [];
    // KYB-02: an incomplete ownership graph prevents activation. Provisional 25% threshold.
    if (owners.length === 0) missing.push('beneficialOwners');
    const total = owners.reduce((s, o) => s + o.ownershipPercent, 0);
    if (total > 100.0001) missing.push('beneficialOwners (total over 100%)');
  }
  return missing;
}

export async function entityDetail(db: Queryable, entityId: string) {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    customer_role: string;
    legal_name: string;
    reference_code: string;
    onboarding_status: string;
    profile: Profile;
    risk_rating: string | null;
    review_reason: string | null;
    created_at: Date;
    approved_at: Date | null;
  }>(
    `SELECT id, kind, customer_role, legal_name, reference_code, onboarding_status, profile, risk_rating,
            review_reason, created_at, approved_at FROM app.entities WHERE id = $1`,
    [entityId],
  );
  const e = rows[0];
  if (!e) throw new DomainError('not_found', 'Account not found.', 404);
  const sub = await currentSubscription(db, entityId);
  const parent = await db.query<{
    parent_entity_id: string;
    legal_name: string;
    child_rate_e4: number;
  }>(
    `SELECT l.parent_entity_id, p.legal_name, l.child_rate_e4
       FROM app.seller_links l JOIN app.entities p ON p.id = l.parent_entity_id
      WHERE l.child_entity_id = $1 AND l.status = 'active'`,
    [entityId],
  );
  const pr = parent.rows[0];
  return {
    id: e.id,
    kind: e.kind,
    customerRole: e.customer_role,
    legalName: e.legal_name,
    referenceCode: e.reference_code,
    onboardingStatus: e.onboarding_status,
    profile: e.profile,
    riskRating: e.risk_rating,
    reviewReason: e.review_reason,
    createdAt: e.created_at.toISOString(),
    approvedAt: e.approved_at?.toISOString() ?? null,
    subscription: sub?.subscription ?? null,
    plan: sub?.plan ?? null,
    parent: pr
      ? { entityId: pr.parent_entity_id, legalName: pr.legal_name, childRateE4: pr.child_rate_e4 }
      : null,
  };
}

export async function currentSubscription(db: Queryable, entityId: string) {
  const { rows } = await db.query<{
    id: string;
    plan_code: string;
    billing_interval: string;
    status: string;
    current_period_start: Date;
    current_period_end: Date;
  }>(
    `SELECT id, plan_code, billing_interval, status, current_period_start, current_period_end
       FROM app.subscriptions WHERE entity_id = $1 AND status IN ('active', 'cancel_at_period_end')`,
    [entityId],
  );
  const s = rows[0];
  if (!s) return null;
  const plan: PlanView = await planView(db, s.plan_code);
  return {
    subscription: {
      id: s.id,
      planCode: s.plan_code,
      billingInterval: s.billing_interval,
      status: s.status,
      currentPeriodStart: s.current_period_start.toISOString(),
      currentPeriodEnd: s.current_period_end.toISOString(),
    },
    plan,
  };
}

export async function updateProfile(pool: Pool, user: SessionUser, entityId: string, raw: unknown) {
  const profile = cleanProfile(raw);
  await withTransaction(pool, async (tx) => {
    const e = await loadEntity(tx, entityId, true);
    if (!['draft', 'needs_information'].includes(e.onboarding_status)) {
      throw new DomainError(
        'invalid_state',
        'Your details are locked while verification is in progress.',
        409,
      );
    }
    await tx.query('UPDATE app.entities SET profile = $2 WHERE id = $1', [
      entityId,
      JSON.stringify(profile),
    ]);
    await recordAudit(tx, {
      actorType: 'customer',
      actorId: user.userId,
      entityId,
      action: 'entity.profile_updated',
      objectType: 'entity',
      objectId: entityId,
    });
  });
  return entityDetail(pool, entityId);
}

/**
 * Submits for verification. In the sandbox the hosted KYC/KYB vendor and sanctions/PEP screening
 * are simulated: names containing "match" produce a possible match for compliance to review
 * (CMP-01 — a possible match is reviewed, never auto-rejected).
 */
export async function submitOnboarding(pool: Pool, user: SessionUser, entityId: string) {
  await withTransaction(pool, async (tx) => {
    const e = await loadEntity(tx, entityId, true);
    if (!['draft', 'needs_information'].includes(e.onboarding_status)) {
      throw new DomainError('invalid_state', 'This application has already been submitted.', 409);
    }
    const { rows } = await tx.query<{ profile: Profile }>(
      'SELECT profile FROM app.entities WHERE id = $1',
      [entityId],
    );
    const missing = missingProfileFields(e.kind, rows[0]!.profile);
    if (missing.length) {
      throw invalid(
        'Complete your profile before submitting.',
        missing.map((m) => ({ path: m, message: 'Required' })),
      );
    }
    const screening = /match/i.test(e.legal_name) ? 'possible_match' : 'clear';
    await tx.query(
      `UPDATE app.entities SET onboarding_status = 'compliance_review', screening_result = $2, submitted_at = now(),
              review_reason = NULL WHERE id = $1`,
      [entityId, screening],
    );
    await recordAudit(tx, {
      actorType: 'customer',
      actorId: user.userId,
      entityId,
      action: 'entity.submitted',
      objectType: 'entity',
      objectId: entityId,
      before: { status: e.onboarding_status },
      after: { status: 'compliance_review', screening },
    });
  });
  return entityDetail(pool, entityId);
}

export async function balances(db: Queryable, entityId: string) {
  const out = [];
  for (const asset of ASSETS) {
    const accountId = await customerAccountId(db, entityId, asset);
    const b = await accountBalance(db, accountId);
    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_minor), 0) AS total FROM app.deposit_claims
        WHERE entity_id = $1 AND asset = $2 AND status = 'pending'`,
      [entityId, asset],
    );
    out.push({ asset, ...b, pendingDepositsMinor: toNumber(rows[0]!.total) });
  }
  return out;
}

export interface ActivityLine {
  postingId: number;
  journalId: string;
  at: string;
  kind: string;
  lineType: string;
  memo: string;
  asset: Asset;
  amountMinor: number;
  balanceAfterMinor: number;
}

/** Customer statement lines with running balance, newest first (REP-01). */
export async function activity(
  db: Queryable,
  entityId: string,
  limit = 50,
  asset?: Asset,
): Promise<ActivityLine[]> {
  const { rows } = await db.query<{
    id: string;
    journal_id: string;
    created_at: Date;
    kind: string;
    line_type: string;
    memo: string;
    asset: Asset;
    amount: string;
    running: string;
  }>(
    `SELECT * FROM (
       SELECT p.id, p.journal_id, j.created_at, j.kind, p.line_type,
              -- A parent's margin line names the child whose sale earned it.
              CASE WHEN p.line_type = 'parent_margin' AND ce.legal_name IS NOT NULL
                   THEN 'Network margin from ' || ce.legal_name || ' (' || j.memo || ')'
                   ELSE j.memo END AS memo,
              p.asset,
              -p.amount_minor AS amount,
              sum(-p.amount_minor) OVER (PARTITION BY p.account_id ORDER BY p.id) AS running
         FROM ledger.postings p
         JOIN ledger.journals j ON j.id = p.journal_id
         JOIN ledger.accounts a ON a.id = p.account_id
         LEFT JOIN app.quotes q ON j.source_type = 'quote' AND q.id::text = j.source_id
         LEFT JOIN app.entities ce ON ce.id = q.entity_id
        WHERE a.entity_id = $1 AND a.type = 'customer' AND ($3::text IS NULL OR p.asset = $3)
     ) x ORDER BY id DESC LIMIT $2`,
    [entityId, Math.min(Math.max(limit, 1), 500), asset ?? null],
  );
  return rows.map((r) => ({
    postingId: Number(r.id),
    journalId: r.journal_id,
    at: r.created_at.toISOString(),
    kind: r.kind,
    lineType: r.line_type,
    memo: r.memo,
    asset: r.asset,
    amountMinor: toNumber(r.amount),
    balanceAfterMinor: toNumber(r.running),
  }));
}

export async function statementCsv(db: Queryable, entityId: string, asset: Asset): Promise<string> {
  const lines = (await activity(db, entityId, 500, asset)).reverse();
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const fmt = (m: number) => (m / 100).toFixed(2);
  const header = 'date_utc,description,type,currency,amount,balance_after,journal_id';
  const body = lines.map((l) =>
    [
      l.at,
      esc(l.memo),
      l.lineType,
      l.asset,
      fmt(l.amountMinor),
      fmt(l.balanceAfterMinor),
      l.journalId,
    ].join(','),
  );
  return [header, ...body].join('\n') + '\n';
}

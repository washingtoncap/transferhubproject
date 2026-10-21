import { randomBytes } from 'node:crypto';
import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { enqueueJob, type Queryable, recordAudit, runIdempotent, writeOutbox } from '@transferhub/platform';
import { requireFreshMfa, type SessionUser } from './auth';
import { requireApproved } from './access';
import { DomainError, invalid, notFound } from './errors';
import { createHold, customerAccountId, lockAccounts, postJournal, requireAvailable, resolveHold, systemAccountId } from './ledger';
import { type Asset, formatMoney, isAsset, toNumber, ttdToUsd } from './money';
import { partnerQueryPayout, PartnerTimeoutError, partnerSubmitPayout } from './partner';
import { ratePolicy } from './plans';

// ------------------------------------------------------------------------------------------------
// Beneficiaries
// ------------------------------------------------------------------------------------------------
interface BenRow { id: string; label: string; bank_name: string; account_holder: string; account_last4: string; currency: Asset; verified_at: Date | null; created_at: Date }
const toBen = (r: BenRow) => ({
  id: r.id, label: r.label, bankName: r.bank_name, accountHolder: r.account_holder, accountLast4: r.account_last4,
  currency: r.currency, verified: r.verified_at !== null, createdAt: r.created_at.toISOString(),
});

export async function listBeneficiaries(db: Queryable, entityId: string) {
  const { rows } = await db.query<BenRow>('SELECT * FROM app.beneficiaries WHERE entity_id = $1 ORDER BY created_at', [entityId]);
  return rows.map(toBen);
}

/**
 * Only the last four digits are kept; the partner holds full account details. In the sandbox the
 * account-ownership check is simulated as passed immediately.
 */
export async function addBeneficiary(pool: Pool, user: SessionUser, entityId: string, raw: Record<string, unknown>) {
  const label = String(raw.label ?? '').trim();
  const bankName = String(raw.bankName ?? '').trim();
  const holder = String(raw.accountHolder ?? '').trim();
  const number = String(raw.accountNumber ?? '').replace(/[\s-]/g, '');
  if (!label || !bankName || !holder) throw invalid('Enter a label, bank name and account holder.');
  if (!/^[0-9]{6,20}$/.test(number)) throw invalid('Enter the account number using digits only (6–20).');
  if (!isAsset(raw.currency)) throw invalid('Choose the account currency.');
  return withTransaction(pool, async (tx) => {
    await requireApproved(tx, entityId);
    const { rows } = await tx.query<BenRow>(
      `INSERT INTO app.beneficiaries (entity_id, label, bank_name, account_holder, account_last4, currency, verified_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7) RETURNING *`,
      [entityId, label, bankName, holder, number.slice(-4), raw.currency, user.userId],
    );
    await recordAudit(tx, {
      actorType: 'customer', actorId: user.userId, entityId, action: 'beneficiary.added', objectType: 'beneficiary', objectId: rows[0]!.id,
      after: { label, bankName, last4: number.slice(-4), currency: raw.currency },
    });
    return toBen(rows[0]!);
  });
}

// ------------------------------------------------------------------------------------------------
// Withdrawals
// ------------------------------------------------------------------------------------------------
const WITHDRAWAL_SELECT = `
  SELECT w.*, b.label AS ben_label, b.bank_name AS ben_bank, b.account_last4 AS ben_last4,
         e.legal_name AS entity_name, u.full_name AS requested_by_name,
         (SELECT count(*) FROM app.withdrawal_approvals a WHERE a.withdrawal_id = w.id AND a.decision = 'approve') AS approvals
    FROM app.withdrawals w
    JOIN app.beneficiaries b ON b.id = w.beneficiary_id
    JOIN app.entities e ON e.id = w.entity_id
    JOIN app.users u ON u.id = w.requested_by`;

interface WRow {
  id: string; reference: string; entity_id: string; asset: Asset; amount_minor: string; status: string; required_approvals: number;
  failure_reason: string | null; created_at: Date; updated_at: Date; beneficiary_id: string; ben_label: string; ben_bank: string;
  ben_last4: string; entity_name: string; requested_by_name: string; approvals: string; hold_id: string; partner_reference: string | null;
}

const toW = (r: WRow) => ({
  id: r.id, reference: r.reference, asset: r.asset, amountMinor: toNumber(r.amount_minor), status: r.status,
  beneficiary: { id: r.beneficiary_id, label: r.ben_label, bankName: r.ben_bank, accountLast4: r.ben_last4 },
  requiredApprovals: r.required_approvals, approvals: toNumber(r.approvals), failureReason: r.failure_reason,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

export async function listWithdrawals(db: Queryable, entityId: string) {
  const { rows } = await db.query<WRow>(`${WITHDRAWAL_SELECT} WHERE w.entity_id = $1 ORDER BY w.created_at DESC LIMIT 100`, [entityId]);
  return rows.map(toW);
}

/**
 * WDR-01: verified beneficiary + fresh MFA code + available funds → hold the funds and wait for
 * staff approval. Large withdrawals need two different approvers (maker/checker, TH-SEC §3).
 */
export async function requestWithdrawal(pool: Pool, user: SessionUser, entityId: string, raw: Record<string, unknown>, idempotencyKey: string) {
  if (!isAsset(raw.asset)) throw invalid('Choose USD or TTD.');
  const asset = raw.asset;
  const amount = Number(raw.amountMinor);
  if (!Number.isSafeInteger(amount) || amount < 100) throw invalid('Enter an amount of at least 1.00.');
  const beneficiaryId = String(raw.beneficiaryId ?? '');
  // Step-up check happens before anything is written; a wrong code leaves no trace but an audit.
  await requireFreshMfa(pool, user.userId, raw.mfaCode);

  const res = await withTransaction(pool, (tx) =>
    runIdempotent(tx, { scope: `entity:${entityId}:withdraw`, key: idempotencyKey, request: { asset, amount, beneficiaryId } }, async () => {
      await requireApproved(tx, entityId);
      const ben = await tx.query<BenRow>('SELECT * FROM app.beneficiaries WHERE id = $1 AND entity_id = $2', [beneficiaryId, entityId]);
      const b = ben.rows[0];
      if (!b) throw notFound('Beneficiary');
      if (!b.verified_at) throw new DomainError('beneficiary_unverified', 'This beneficiary has not been verified yet.', 409);
      if (b.currency !== asset) throw new DomainError('currency_mismatch', `This beneficiary receives ${b.currency}, not ${asset}.`, 422);

      const acct = await customerAccountId(tx, entityId, asset);
      await lockAccounts(tx, [acct]);
      await requireAvailable(tx, acct, asset, amount);

      const policy = await ratePolicy(tx);
      const usdEquivalent = asset === 'USD' ? amount : ttdToUsd(amount, policy.standardSellE4);
      const required = usdEquivalent >= policy.dualApprovalUsdMinor ? 2 : 1;
      const reference = `WD-${randomBytes(4).toString('hex').toUpperCase()}`;
      const holdId = await createHold(tx, { accountId: acct, amountMinor: amount, reason: 'withdrawal', sourceType: 'withdrawal', sourceId: reference });
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO app.withdrawals (reference, entity_id, beneficiary_id, asset, amount_minor, required_approvals, hold_id, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [reference, entityId, beneficiaryId, asset, amount, required, holdId, user.userId],
      );
      await recordAudit(tx, {
        actorType: 'customer', actorId: user.userId, entityId, action: 'withdrawal.requested', objectType: 'withdrawal', objectId: rows[0]!.id,
        after: { reference, asset, amountMinor: amount, requiredApprovals: required, beneficiaryLast4: b.account_last4 },
        metadata: { stepUpMfa: true },
      });
      const w = await tx.query<WRow>(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [rows[0]!.id]);
      return { status: 201, body: toW(w.rows[0]!) };
    }),
  );
  return res.body;
}

// ------------------------------------------------------------------------------------------------
// Operations: approvals and payout lifecycle
// ------------------------------------------------------------------------------------------------
export async function opsWithdrawals(db: Queryable, staff: SessionUser, status?: string) {
  const { rows } = await db.query<WRow>(
    `${WITHDRAWAL_SELECT} WHERE ($1::text IS NULL OR w.status = ANY(string_to_array($1, ','))) ORDER BY w.created_at DESC LIMIT 200`,
    [status ?? null],
  );
  const ids = rows.map((r) => r.id);
  const approvers = await db.query<{ withdrawal_id: string; staff_user_id: string; full_name: string; decision: 'approve' | 'reject'; created_at: Date }>(
    `SELECT a.withdrawal_id, a.staff_user_id, u.full_name, a.decision, a.created_at
       FROM app.withdrawal_approvals a JOIN app.users u ON u.id = a.staff_user_id
      WHERE a.withdrawal_id = ANY($1::uuid[]) ORDER BY a.created_at`,
    [ids],
  );
  return rows.map((r) => {
    const mine = approvers.rows.filter((a) => a.withdrawal_id === r.id);
    return {
      ...toW(r),
      entity: { id: r.entity_id, legalName: r.entity_name },
      requestedBy: r.requested_by_name,
      approvers: mine.map((a) => ({ name: a.full_name, decision: a.decision, at: a.created_at.toISOString() })),
      canAct: r.status === 'pending_approval' && !mine.some((a) => a.staff_user_id === staff.userId),
    };
  });
}

export async function decideWithdrawal(pool: Pool, staff: SessionUser, withdrawalId: string, decision: 'approve' | 'reject', reason?: string) {
  if (decision === 'reject' && !reason?.trim()) throw invalid('Give a reason for rejecting.');
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; required_approvals: number; entity_id: string; hold_id: string; requested_by: string; reference: string }>(
      'SELECT id, status, required_approvals, entity_id, hold_id, requested_by, reference FROM app.withdrawals WHERE id = $1 FOR UPDATE',
      [withdrawalId],
    );
    const w = rows[0];
    if (!w) throw notFound('Withdrawal');
    if (w.status !== 'pending_approval') throw new DomainError('already_decided', 'This withdrawal is no longer awaiting approval.', 409);
    // No one approves a withdrawal for a customer account they belong to, or that they requested.
    const member = await tx.query('SELECT 1 FROM app.memberships WHERE user_id = $1 AND entity_id = $2', [staff.userId, w.entity_id]);
    if (member.rowCount || w.requested_by === staff.userId) {
      throw new DomainError('self_approval', 'You cannot approve a withdrawal for an account you belong to.', 403);
    }
    try {
      await tx.query(
        'INSERT INTO app.withdrawal_approvals (withdrawal_id, staff_user_id, decision, reason) VALUES ($1, $2, $3, $4)',
        [withdrawalId, staff.userId, decision, reason ?? null],
      );
    } catch (err) {
      if (err instanceof Error && /duplicate key/.test(err.message)) {
        throw new DomainError('already_decided', 'You have already acted on this withdrawal. A different approver is needed.', 409);
      }
      throw err;
    }
    if (decision === 'reject') {
      await tx.query(`UPDATE app.withdrawals SET status = 'rejected', failure_reason = $2 WHERE id = $1`, [withdrawalId, `Rejected: ${reason}`]);
      await resolveHold(tx, w.hold_id, 'released');
    } else {
      const c = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.withdrawal_approvals WHERE withdrawal_id = $1 AND decision = 'approve'`, [withdrawalId]);
      if (toNumber(c.rows[0]!.n) >= w.required_approvals) {
        await tx.query(`UPDATE app.withdrawals SET status = 'approved' WHERE id = $1`, [withdrawalId]);
        await enqueueJob(tx, { type: 'withdrawal.submit', payload: { withdrawalId }, dedupeKey: `withdrawal_submit:${withdrawalId}:1`, priority: 5 });
        await writeOutbox(tx, { topic: 'withdrawal.approved', aggregateType: 'withdrawal', aggregateId: withdrawalId, payload: { withdrawalId } });
      }
    }
    await recordAudit(tx, {
      actorType: 'staff', actorId: staff.userId, entityId: w.entity_id, action: `withdrawal.${decision === 'approve' ? 'approval_given' : 'rejected'}`,
      objectType: 'withdrawal', objectId: withdrawalId, reason: reason ?? null,
    });
  });
  return (await opsWithdrawals(pool, staff)).find((x) => x.id === withdrawalId)!;
}

/** Worker: send an approved withdrawal to the partner. A timeout means "unknown", never "failed". */
export async function submitWithdrawal(pool: Pool, withdrawalId: string, attempt = 1): Promise<string> {
  const { rows } = await pool.query<{ status: string; reference: string; asset: Asset; amount_minor: string }>(
    'SELECT status, reference, asset, amount_minor FROM app.withdrawals WHERE id = $1',
    [withdrawalId],
  );
  const w = rows[0];
  if (!w || w.status !== 'approved') return 'skipped';
  try {
    const p = await partnerSubmitPayout(pool, { clientReference: w.reference, asset: w.asset, amountMinor: toNumber(w.amount_minor) });
    await pool.query(`UPDATE app.withdrawals SET status = 'submitted', partner_reference = $2 WHERE id = $1 AND status = 'approved'`, [withdrawalId, p.partnerReference]);
    await recordAudit(pool, { actorType: 'service', actorId: 'payout-worker', action: 'withdrawal.submitted', objectType: 'withdrawal', objectId: withdrawalId, metadata: { partnerReference: p.partnerReference } });
    return 'submitted';
  } catch (err) {
    if (!(err instanceof PartnerTimeoutError)) throw err;
    await withTransaction(pool, async (tx) => {
      await tx.query(`UPDATE app.withdrawals SET status = 'status_unknown' WHERE id = $1 AND status = 'approved'`, [withdrawalId]);
      await enqueueJob(tx, {
        type: 'withdrawal.query_status', payload: { withdrawalId, attempt },
        dedupeKey: `withdrawal_query:${withdrawalId}:${attempt}`, runAt: new Date(Date.now() + 2500),
      });
      await recordAudit(tx, { actorType: 'service', actorId: 'payout-worker', action: 'withdrawal.status_unknown', objectType: 'withdrawal', objectId: withdrawalId, reason: 'Partner timeout; querying status before any retry' });
    });
    return 'status_unknown';
  }
}

/**
 * WDR-02: after a timeout, ask the partner what happened using our original reference. Only if the
 * partner confirms it has no such payout is it safe to send again; the hold is never released on
 * uncertainty.
 */
export async function queryWithdrawalStatus(pool: Pool, withdrawalId: string, attempt: number): Promise<string> {
  const { rows } = await pool.query<{ status: string; reference: string }>('SELECT status, reference FROM app.withdrawals WHERE id = $1', [withdrawalId]);
  const w = rows[0];
  if (!w || w.status !== 'status_unknown') return 'skipped';
  const p = await partnerQueryPayout(pool, w.reference);
  if (p) {
    await pool.query(`UPDATE app.withdrawals SET status = 'submitted', partner_reference = $2 WHERE id = $1 AND status = 'status_unknown'`, [withdrawalId, p.partnerReference]);
    await recordAudit(pool, { actorType: 'service', actorId: 'payout-worker', action: 'withdrawal.status_confirmed', objectType: 'withdrawal', objectId: withdrawalId, metadata: { partnerStatus: p.status, partnerReference: p.partnerReference } });
    return 'confirmed_with_partner';
  }
  await withTransaction(pool, async (tx) => {
    await tx.query(`UPDATE app.withdrawals SET status = 'approved' WHERE id = $1 AND status = 'status_unknown'`, [withdrawalId]);
    await enqueueJob(tx, { type: 'withdrawal.submit', payload: { withdrawalId, attempt: attempt + 1 }, dedupeKey: `withdrawal_submit:${withdrawalId}:${attempt + 1}` });
  });
  return 'confirmed_not_received_resubmitting';
}

/** Partner says the money left the bank: post the journal once and capture the hold. */
export async function settleWithdrawal(tx: Queryable, data: { clientReference: string; statementLineId: string; amountMinor: number }) {
  const { rows } = await tx.query<{ id: string; entity_id: string; asset: Asset; amount_minor: string; status: string; hold_id: string }>(
    'SELECT id, entity_id, asset, amount_minor, status, hold_id FROM app.withdrawals WHERE reference = $1 FOR UPDATE',
    [data.clientReference],
  );
  const w = rows[0];
  if (!w) return 'unknown_reference';
  if (w.status === 'settled') return 'already_settled';
  const amount = toNumber(w.amount_minor);
  if (amount !== data.amountMinor) throw new Error(`Payout amount mismatch for ${data.clientReference}`);
  const cust = await customerAccountId(tx, w.entity_id, w.asset);
  const cash = await systemAccountId(tx, 'provider_cash', w.asset);
  await lockAccounts(tx, [cust, cash]);
  await resolveHold(tx, w.hold_id, 'captured');
  const journalId = await postJournal(tx, {
    kind: 'withdrawal_settled', sourceType: 'partner_statement', sourceId: data.statementLineId,
    memo: `Withdrawal ${data.clientReference} paid (${formatMoney(amount, w.asset)})`, createdBy: 'service:payout-worker',
    lines: [
      { accountId: cust, asset: w.asset, amountMinor: amount, lineType: 'withdrawal' },
      { accountId: cash, asset: w.asset, amountMinor: -amount, lineType: 'partner_cash_out' },
    ],
  });
  await tx.query(`UPDATE app.withdrawals SET status = 'settled', journal_id = $2 WHERE id = $1`, [w.id, journalId]);
  await recordAudit(tx, { actorType: 'service', actorId: 'payout-worker', entityId: w.entity_id, action: 'withdrawal.settled', objectType: 'withdrawal', objectId: w.id, after: { journalId } });
  return 'settled';
}

/** Partner confirms the payment did NOT complete: only now is the hold released. */
export async function failWithdrawal(tx: Queryable, data: { clientReference: string; reason: string }) {
  const { rows } = await tx.query<{ id: string; entity_id: string; status: string; hold_id: string }>(
    'SELECT id, entity_id, status, hold_id FROM app.withdrawals WHERE reference = $1 FOR UPDATE',
    [data.clientReference],
  );
  const w = rows[0];
  if (!w) return 'unknown_reference';
  if (w.status === 'failed' || w.status === 'settled') return 'already_final';
  await resolveHold(tx, w.hold_id, 'released');
  await tx.query(`UPDATE app.withdrawals SET status = 'failed', failure_reason = $2 WHERE id = $1`, [w.id, data.reason]);
  await recordAudit(tx, { actorType: 'service', actorId: 'payout-worker', entityId: w.entity_id, action: 'withdrawal.failed', objectType: 'withdrawal', objectId: w.id, reason: data.reason });
  return 'failed';
}

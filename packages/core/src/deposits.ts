import { randomBytes } from 'node:crypto';
import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit, runIdempotent, writeOutbox } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { requireApproved } from './access';
import { invalid } from './errors';
import { customerAccountId, lockAccounts, postJournal, systemAccountId } from './ledger';
import { type Asset, formatMoney, isAsset, toNumber } from './money';

/** Sandbox bank instructions. A real partner supplies these per currency (D02 / D06). */
export const SANDBOX_BANK: Record<
  Asset,
  { bankName: string; accountName: string; accountNumber: string }
> = {
  USD: {
    bankName: 'Sandbox Partner Bank (US)',
    accountName: 'TransferHub Client Funds — USD',
    accountNumber: '•••• 4821 (sandbox)',
  },
  TTD: {
    bankName: 'Sandbox Partner Bank (TT)',
    accountName: 'TransferHub Client Funds — TTD',
    accountNumber: '•••• 7316 (sandbox)',
  },
};

interface ClaimRow {
  id: string;
  asset: Asset;
  amount_minor: string;
  reference: string;
  receipt_note: string | null;
  status: string;
  created_at: Date;
  cleared_at: Date | null;
  rejection_reason: string | null;
}

export const toClaimView = (r: ClaimRow) => ({
  id: r.id,
  asset: r.asset,
  amountMinor: toNumber(r.amount_minor),
  reference: r.reference,
  receiptNote: r.receipt_note,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  clearedAt: r.cleared_at?.toISOString() ?? null,
  rejectionReason: r.rejection_reason,
  instructions: { ...SANDBOX_BANK[r.asset], reference: r.reference },
});

export async function listDeposits(db: Queryable, entityId: string) {
  const { rows } = await db.query<ClaimRow>(
    'SELECT * FROM app.deposit_claims WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 100',
    [entityId],
  );
  return rows.map(toClaimView);
}

/**
 * DEP-01: a deposit claim (with an optional receipt note) is only a notice. It creates NO ledger
 * entry and NO spendable balance. Funds become available only when the partner's statement shows
 * the money arrived (see processStatementCredit).
 */
export async function createDeposit(
  pool: Pool,
  user: SessionUser,
  entityId: string,
  raw: { asset?: unknown; amountMinor?: unknown; receiptNote?: unknown },
  idempotencyKey: string,
) {
  if (!isAsset(raw.asset)) throw invalid('Choose USD or TTD.');
  const amount = Number(raw.amountMinor);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100_000_000) {
    throw invalid('Enter an amount between 1.00 and 1,000,000.00.', [
      { path: 'amountMinor', message: 'Out of range' },
    ]);
  }
  const note = raw.receiptNote ? String(raw.receiptNote).slice(0, 500) : null;
  const res = await withTransaction(pool, (tx) =>
    runIdempotent(
      tx,
      {
        scope: `entity:${entityId}:deposit`,
        key: idempotencyKey,
        request: { asset: raw.asset, amount, note },
      },
      async () => {
        const e = await requireApproved(tx, entityId);
        const suffix = randomBytes(2).toString('hex').toUpperCase();
        const reference = `${e.reference_code}-${suffix}`;
        const { rows } = await tx.query<ClaimRow>(
          `INSERT INTO app.deposit_claims (entity_id, asset, amount_minor, reference, receipt_note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [entityId, raw.asset, amount, reference, note, user.userId],
        );
        await recordAudit(tx, {
          actorType: 'customer',
          actorId: user.userId,
          entityId,
          action: 'deposit_claim.created',
          objectType: 'deposit_claim',
          objectId: rows[0]!.id,
          after: { asset: raw.asset, amountMinor: amount, reference },
        });
        return { status: 201, body: toClaimView(rows[0]!) };
      },
    ),
  );
  return res.body;
}

/**
 * DEP-02: match a cleared partner statement credit to a pending claim by reference, currency and
 * amount, and post exactly once (the journal is unique per statement line). An unmatched credit
 * is left for operations — it shows as a reconciliation break until resolved.
 */
export async function processStatementCredit(
  tx: Queryable,
  data: {
    statementLineId: string;
    asset: Asset;
    amountMinor: number;
    reference: string;
    senderName?: string;
  },
  inboxId: string,
): Promise<'cleared' | 'already_posted' | 'unmatched'> {
  const already = await tx.query(
    `SELECT 1 FROM ledger.journals WHERE kind = 'deposit_cleared' AND source_type = 'partner_statement' AND source_id = $1`,
    [data.statementLineId],
  );
  if (already.rowCount) return 'already_posted';

  const ref = String(data.reference ?? '').toUpperCase();
  // Exact claim reference first; otherwise a single pending claim from the customer whose code
  // was quoted, for the same currency and amount.
  const { rows } = await tx.query<{
    id: string;
    entity_id: string;
    reference: string;
    legal_name: string;
  }>(
    `SELECT c.id, c.entity_id, c.reference, e.legal_name FROM app.deposit_claims c JOIN app.entities e ON e.id = c.entity_id
      WHERE c.status = 'pending' AND c.asset = $1 AND c.amount_minor = $2
        AND (c.reference = $3 OR (e.reference_code = split_part($3, '-', 1)))
      ORDER BY (c.reference = $3) DESC, c.created_at
      FOR UPDATE OF c`,
    [data.asset, data.amountMinor, ref],
  );
  const exact = rows.find((r) => r.reference === ref);
  const claim = exact ?? (rows.length === 1 ? rows[0] : undefined);
  if (!claim) {
    await recordAudit(tx, {
      actorType: 'service',
      actorId: 'deposit-matcher',
      action: 'deposit.unmatched_credit',
      objectType: 'partner_statement_line',
      objectId: data.statementLineId,
      metadata: {
        asset: data.asset,
        amountMinor: data.amountMinor,
        reference: ref,
        candidates: rows.length,
      },
    });
    return 'unmatched';
  }
  const cust = await customerAccountId(tx, claim.entity_id, data.asset);
  const cash = await systemAccountId(tx, 'provider_cash', data.asset);
  await lockAccounts(tx, [cust, cash]);
  const journalId = await postJournal(tx, {
    kind: 'deposit_cleared',
    sourceType: 'partner_statement',
    sourceId: data.statementLineId,
    memo: `Deposit ${claim.reference} cleared (${formatMoney(data.amountMinor, data.asset)})`,
    createdBy: 'service:deposit-matcher',
    lines: [
      {
        accountId: cash,
        asset: data.asset,
        amountMinor: data.amountMinor,
        lineType: 'partner_cash_in',
      },
      { accountId: cust, asset: data.asset, amountMinor: -data.amountMinor, lineType: 'deposit' },
    ],
  });
  await tx.query(
    `UPDATE app.deposit_claims SET status = 'cleared', cleared_at = now(), journal_id = $2, inbox_event_id = $3 WHERE id = $1`,
    [claim.id, journalId, inboxId],
  );
  await recordAudit(tx, {
    actorType: 'service',
    actorId: 'deposit-matcher',
    entityId: claim.entity_id,
    action: 'deposit_claim.cleared',
    objectType: 'deposit_claim',
    objectId: claim.id,
    after: { journalId, statementLineId: data.statementLineId },
  });
  await writeOutbox(tx, {
    topic: 'deposit.cleared',
    aggregateType: 'deposit_claim',
    aggregateId: claim.id,
    payload: { claimId: claim.id, entityId: claim.entity_id },
  });
  return 'cleared';
}

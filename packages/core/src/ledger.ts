import type { Queryable } from '@transferhub/platform';
import { DomainError } from './errors';
import { type Asset, formatMoney, toNumber } from './money';

/**
 * Double-entry subledger (NFR-01, TH-TLR).
 *
 * Signed postings: positive = debit, negative = credit. Customer, principal and revenue accounts
 * are credit-normal, so their balance is −Σ(postings). Provider cash is debit-normal: +Σ.
 * The database guarantees every journal balances per asset and that nothing is ever edited.
 */

export type SystemAccountType = 'provider_cash' | 'fx_principal' | 'platform_revenue';

export interface PostingLine {
  accountId: string;
  asset: Asset;
  /** Positive = debit, negative = credit. */
  amountMinor: number;
  lineType: string;
}

export interface JournalInput {
  kind:
    | 'opening_float'
    | 'deposit_cleared'
    | 'fx_trade'
    | 'allocation'
    | 'subscription_charge'
    | 'withdrawal_settled'
    | 'reversal';
  sourceType: string;
  sourceId: string;
  memo: string;
  createdBy: string;
  lines: PostingLine[];
}

export async function ensureCustomerAccounts(db: Queryable, entityId: string, legalName: string) {
  for (const asset of ['USD', 'TTD'] as const) {
    await db.query(
      `INSERT INTO ledger.accounts (code, entity_id, asset, type, name)
       VALUES ($1, $2, $3, 'customer', $4)
       ON CONFLICT (code) DO NOTHING`,
      [`customer:${entityId}:${asset}`, entityId, asset, `${legalName} (${asset})`],
    );
  }
}

export async function customerAccountId(
  db: Queryable,
  entityId: string,
  asset: Asset,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ledger.accounts WHERE entity_id = $1 AND asset = $2 AND type = 'customer'`,
    [entityId, asset],
  );
  if (!rows[0]) throw new DomainError('not_found', 'Customer account not found.', 404);
  return rows[0].id;
}

export async function systemAccountId(
  db: Queryable,
  type: SystemAccountType,
  asset: Asset,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ledger.accounts WHERE code = $1`,
    [`system:${type}:${asset}`],
  );
  return rows[0]!.id;
}

/**
 * Locks accounts in a fixed order (by id) for the rest of the transaction. Every money-moving
 * command locks the accounts it touches before reading balances, so concurrent commands are
 * serialised per account and cannot both spend the same funds (FX-02). Fixed ordering prevents
 * deadlocks between commands touching the same pair of accounts.
 */
export async function lockAccounts(db: Queryable, accountIds: string[]): Promise<void> {
  const ids = [...new Set(accountIds)].sort();
  await db.query(
    'SELECT id FROM ledger.accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
}

export interface AccountBalance {
  /** Credit-normal accounts: what is owed to the holder. Debit-normal: what is held. */
  ledgerMinor: number;
  heldMinor: number;
  availableMinor: number;
}

export async function accountBalance(db: Queryable, accountId: string): Promise<AccountBalance> {
  const { rows } = await db.query<{ type: string; dmc: string; held: string }>(
    `SELECT a.type,
            COALESCE((SELECT sum(amount_minor) FROM ledger.postings WHERE account_id = a.id), 0) AS dmc,
            COALESCE((SELECT sum(amount_minor) FROM ledger.holds
                       WHERE account_id = a.id AND status = 'active'), 0) AS held
       FROM ledger.accounts a WHERE a.id = $1`,
    [accountId],
  );
  const row = rows[0]!;
  const dmc = toNumber(row.dmc);
  const ledgerMinor = row.type === 'provider_cash' ? dmc : 0 - dmc;
  const heldMinor = toNumber(row.held);
  return { ledgerMinor, heldMinor, availableMinor: ledgerMinor - heldMinor };
}

/** Call after lockAccounts. Throws if the account cannot cover `amountMinor`. */
export async function requireAvailable(
  db: Queryable,
  accountId: string,
  asset: Asset,
  amountMinor: number,
  code:
    | 'insufficient_available_funds'
    | 'principal_inventory_insufficient' = 'insufficient_available_funds',
): Promise<AccountBalance> {
  const bal = await accountBalance(db, accountId);
  if (bal.availableMinor < amountMinor) {
    throw new DomainError(
      code,
      code === 'insufficient_available_funds'
        ? `Insufficient available funds: ${formatMoney(bal.availableMinor, asset)} available, ${formatMoney(amountMinor, asset)} needed.`
        : 'Liquidity is temporarily unavailable for this amount. Try a smaller amount or contact support.',
      409,
      { availableMinor: bal.availableMinor, requiredMinor: amountMinor },
    );
  }
  return bal;
}

/**
 * Writes a balanced journal. Balance is checked here for a clear error, and again by the database
 * at commit. A second journal for the same (kind, source) is rejected by a unique constraint, so a
 * replayed event can never post twice.
 */
export async function postJournal(db: Queryable, input: JournalInput): Promise<string> {
  const byAsset = new Map<string, number>();
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor === 0) {
      throw new Error(`Invalid posting amount ${l.amountMinor}`);
    }
    byAsset.set(l.asset, (byAsset.get(l.asset) ?? 0) + l.amountMinor);
  }
  for (const [asset, sum] of byAsset) {
    if (sum !== 0) throw new Error(`Journal does not balance in ${asset}: ${sum}`);
  }
  if (input.lines.length < 2) throw new Error('A journal needs at least two lines');

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger.journals (kind, source_type, source_id, memo, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.kind, input.sourceType, input.sourceId, input.memo, input.createdBy],
  );
  const journalId = rows[0]!.id;
  for (const l of input.lines) {
    await db.query(
      `INSERT INTO ledger.postings (journal_id, account_id, asset, amount_minor, line_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [journalId, l.accountId, l.asset, l.amountMinor, l.lineType],
    );
  }
  return journalId;
}

export async function createHold(
  db: Queryable,
  input: {
    accountId: string;
    amountMinor: number;
    reason: string;
    sourceType: string;
    sourceId: string;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger.holds (account_id, amount_minor, reason, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.accountId, input.amountMinor, input.reason, input.sourceType, input.sourceId],
  );
  return rows[0]!.id;
}

/** Resolves an active hold. Returns false if it was already resolved (safe to call twice). */
export async function resolveHold(
  db: Queryable,
  holdId: string,
  status: 'captured' | 'released',
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE ledger.holds SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'active'`,
    [holdId, status],
  );
  return rowCount === 1;
}

/** Per-asset trial balance: Σ of every posting. Must be zero; anything else is a defect. */
export async function trialBalance(db: Queryable): Promise<Record<Asset, number>> {
  const { rows } = await db.query<{ asset: Asset; total: string }>(
    `SELECT asset, COALESCE(sum(amount_minor), 0) AS total FROM ledger.postings GROUP BY asset`,
  );
  const out: Record<Asset, number> = { USD: 0, TTD: 0 };
  for (const r of rows) out[r.asset] = toNumber(r.total);
  return out;
}

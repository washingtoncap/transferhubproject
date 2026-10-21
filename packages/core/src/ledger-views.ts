import type { Queryable } from '@transferhub/platform';
import { notFound } from './errors';
import { type Asset, toNumber } from './money';

/**
 * Read-only views over the double-entry ledger for finance and audit (TH-TLR). Nothing here can
 * change a balance: the ledger is append-only and only the business services post journals.
 */

export interface LedgerAccountView {
  id: string;
  code: string;
  name: string;
  type: 'customer' | 'provider_cash' | 'fx_principal' | 'platform_revenue';
  asset: Asset;
  normalSide: 'debit' | 'credit';
  entity: { id: string; legalName: string } | null;
  debitsMinor: number;
  creditsMinor: number;
  /** In the account's normal direction (what is owed to the holder, or what is held). */
  balanceMinor: number;
  heldMinor: number;
  postings: number;
}

export async function chartOfAccounts(db: Queryable): Promise<LedgerAccountView[]> {
  const { rows } = await db.query<{
    id: string;
    code: string;
    name: string;
    type: LedgerAccountView['type'];
    asset: Asset;
    entity_id: string | null;
    legal_name: string | null;
    debits: string;
    credits: string;
    held: string;
    n: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type, a.asset, a.entity_id, e.legal_name,
            COALESCE(sum(p.amount_minor) FILTER (WHERE p.amount_minor > 0), 0) AS debits,
            COALESCE(-sum(p.amount_minor) FILTER (WHERE p.amount_minor < 0), 0) AS credits,
            COALESCE((SELECT sum(h.amount_minor) FROM ledger.holds h WHERE h.account_id = a.id AND h.status = 'active'), 0) AS held,
            count(p.id) AS n
       FROM ledger.accounts a
       LEFT JOIN ledger.postings p ON p.account_id = a.id
       LEFT JOIN app.entities e ON e.id = a.entity_id
      GROUP BY a.id, e.legal_name
      ORDER BY CASE a.type WHEN 'provider_cash' THEN 1 WHEN 'fx_principal' THEN 2 WHEN 'platform_revenue' THEN 3 ELSE 4 END,
               e.legal_name NULLS FIRST, a.asset`,
  );
  return rows.map((r) => {
    const debits = toNumber(r.debits);
    const credits = toNumber(r.credits);
    const debitNormal = r.type === 'provider_cash';
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      asset: r.asset,
      normalSide: debitNormal ? 'debit' : 'credit',
      entity: r.entity_id ? { id: r.entity_id, legalName: r.legal_name! } : null,
      debitsMinor: debits,
      creditsMinor: credits,
      balanceMinor: debitNormal ? debits - credits : credits - debits,
      heldMinor: toNumber(r.held),
      postings: toNumber(r.n),
    };
  });
}

export interface JournalLineView {
  postingId: number;
  account: { id: string; code: string; name: string };
  asset: Asset;
  debitMinor: number;
  creditMinor: number;
  lineType: string;
}

export interface JournalView {
  id: string;
  kind: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  createdBy: string;
  createdAt: string;
  reversesJournalId: string | null;
  lines: JournalLineView[];
  /** Per asset: total debits and credits — always equal. */
  totals: Array<{ asset: Asset; debitsMinor: number; creditsMinor: number }>;
}

async function linesFor(db: Queryable, journalIds: string[]) {
  const { rows } = await db.query<{
    id: string;
    journal_id: string;
    account_id: string;
    code: string;
    name: string;
    asset: Asset;
    amount_minor: string;
    line_type: string;
  }>(
    `SELECT p.id, p.journal_id, p.account_id, a.code, a.name, p.asset, p.amount_minor, p.line_type
       FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id
      WHERE p.journal_id = ANY($1::uuid[]) ORDER BY p.id`,
    [journalIds],
  );
  return rows;
}

function toJournal(
  j: {
    id: string;
    kind: string;
    memo: string;
    source_type: string;
    source_id: string;
    created_by: string;
    created_at: Date;
    reverses_journal_id: string | null;
  },
  lines: Awaited<ReturnType<typeof linesFor>>,
): JournalView {
  const mine = lines
    .filter((l) => l.journal_id === j.id)
    .map((l) => {
      const amt = toNumber(l.amount_minor);
      return {
        postingId: Number(l.id),
        account: { id: l.account_id, code: l.code, name: l.name },
        asset: l.asset,
        debitMinor: amt > 0 ? amt : 0,
        creditMinor: amt < 0 ? -amt : 0,
        lineType: l.line_type,
      };
    });
  const assets = [...new Set(mine.map((l) => l.asset))];
  return {
    id: j.id,
    kind: j.kind,
    memo: j.memo,
    sourceType: j.source_type,
    sourceId: j.source_id,
    createdBy: j.created_by,
    createdAt: j.created_at.toISOString(),
    reversesJournalId: j.reverses_journal_id,
    lines: mine,
    totals: assets.map((asset) => ({
      asset,
      debitsMinor: mine.filter((l) => l.asset === asset).reduce((s, l) => s + l.debitMinor, 0),
      creditsMinor: mine.filter((l) => l.asset === asset).reduce((s, l) => s + l.creditMinor, 0),
    })),
  };
}

export async function journals(
  db: Queryable,
  params: { kind?: string; accountId?: string; limit?: number },
): Promise<JournalView[]> {
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 300);
  const { rows } = await db.query<{
    id: string;
    kind: string;
    memo: string;
    source_type: string;
    source_id: string;
    created_by: string;
    created_at: Date;
    reverses_journal_id: string | null;
  }>(
    `SELECT j.* FROM ledger.journals j
      WHERE ($1::text IS NULL OR j.kind = $1)
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM ledger.postings p WHERE p.journal_id = j.id AND p.account_id = $2))
      ORDER BY j.created_at DESC, j.id LIMIT $3`,
    [params.kind || null, params.accountId || null, limit],
  );
  const lines = await linesFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((j) => toJournal(j, lines));
}

export async function journal(db: Queryable, id: string): Promise<JournalView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Journal');
  const { rows } = await db.query<{
    id: string;
    kind: string;
    memo: string;
    source_type: string;
    source_id: string;
    created_by: string;
    created_at: Date;
    reverses_journal_id: string | null;
  }>('SELECT * FROM ledger.journals WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Journal');
  return toJournal(rows[0], await linesFor(db, [id]));
}

/** One account's postings with running balance in the account's normal direction. */
export async function accountLedger(db: Queryable, accountId: string, limit = 200) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw notFound('Account');
  const account = (await chartOfAccounts(db)).find((a) => a.id === accountId);
  if (!account) throw notFound('Account');
  const sign = account.normalSide === 'debit' ? 1 : -1;
  const { rows } = await db.query<{
    id: string;
    journal_id: string;
    created_at: Date;
    kind: string;
    memo: string;
    amount_minor: string;
    line_type: string;
    running: string;
  }>(
    `SELECT * FROM (
       SELECT p.id, p.journal_id, j.created_at, j.kind, j.memo, p.amount_minor, p.line_type,
              sum(p.amount_minor) OVER (ORDER BY p.id) AS running
         FROM ledger.postings p JOIN ledger.journals j ON j.id = p.journal_id
        WHERE p.account_id = $1) x
     ORDER BY id DESC LIMIT $2`,
    [accountId, Math.min(Math.max(limit, 1), 500)],
  );
  return {
    account,
    entries: rows.map((r) => {
      const amt = toNumber(r.amount_minor);
      return {
        postingId: Number(r.id),
        journalId: r.journal_id,
        at: r.created_at.toISOString(),
        kind: r.kind,
        memo: r.memo,
        lineType: r.line_type,
        debitMinor: amt > 0 ? amt : 0,
        creditMinor: amt < 0 ? -amt : 0,
        balanceAfterMinor: sign * toNumber(r.running),
      };
    }),
  };
}

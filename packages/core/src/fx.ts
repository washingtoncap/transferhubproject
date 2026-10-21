import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit, runIdempotent, writeOutbox } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { requireApproved } from './access';
import { currentSubscription } from './entities';
import { DomainError, invalid } from './errors';
import { customerAccountId, lockAccounts, postJournal, requireAvailable, systemAccountId } from './ledger';
import { formatMoney, formatRate, toNumber, usdToTtd } from './money';
import { monthlyUsdVolume, ratePolicy } from './plans';

export type Side = 'buy_usd' | 'sell_usd';

export interface RateDecision {
  rateE4: number;
  rateSource: string;
  parentEntityId: string | null;
  parentRateE4: number | null;
  parentLegalName: string | null;
}

/**
 * The effective rate an entity gets on its own account: its plan rate while inside the plan's
 * monthly rate-eligibility volume, otherwise the standard rate. Plans only apply on their own side
 * (buyer plans to buying USD, seller plans to selling USD).
 */
export async function ownRate(db: Queryable, entityId: string, side: Side, usdMinor: number) {
  const policy = await ratePolicy(db);
  const sub = await currentSubscription(db, entityId);
  const standard = side === 'buy_usd' ? policy.standardBuyE4 : policy.standardSellE4;
  const audience = side === 'buy_usd' ? 'buyer' : 'seller';
  if (sub?.plan && sub.plan.audience === audience) {
    const used = await monthlyUsdVolume(db, entityId);
    if (used + usdMinor <= sub.plan.volumeAllowanceUsdMinor) {
      return { rateE4: sub.plan.usdRateE4, rateSource: `plan:${sub.plan.code}` };
    }
    return { rateE4: standard, rateSource: 'standard:allowance_exceeded' };
  }
  return { rateE4: standard, rateSource: 'standard' };
}

/** Decides the customer's rate, including the seller-network rules (SEL-02). */
export async function decideRate(db: Queryable, entityId: string, side: Side, usdMinor: number): Promise<RateDecision> {
  if (side === 'sell_usd') {
    const { rows } = await db.query<{ parent_entity_id: string; child_rate_e4: number; legal_name: string; onboarding_status: string }>(
      `SELECT l.parent_entity_id, l.child_rate_e4, p.legal_name, p.onboarding_status
         FROM app.seller_links l JOIN app.entities p ON p.id = l.parent_entity_id
        WHERE l.child_entity_id = $1 AND l.status = 'active'`,
      [entityId],
    );
    const link = rows[0];
    if (link) {
      if (link.onboarding_status !== 'approved') {
        throw new DomainError('invalid_state', 'Your seller network is unavailable while the main seller is under review.', 409);
      }
      const parent = await ownRate(db, link.parent_entity_id, 'sell_usd', usdMinor);
      // If the parent's effective rate has fallen below the child's agreed rate, new quotes stop
      // until the parent resets the child rate. Accepted quotes are unaffected (SEL-02).
      if (link.child_rate_e4 > parent.rateE4) {
        throw new DomainError(
          'child_rate_exceeds_parent',
          `Your agreed rate (${formatRate(link.child_rate_e4)}) is above your main seller's current rate. Ask ${link.legal_name} to update it.`,
          409,
        );
      }
      return {
        rateE4: link.child_rate_e4,
        rateSource: 'child_rate',
        parentEntityId: link.parent_entity_id,
        parentRateE4: parent.rateE4,
        parentLegalName: link.legal_name,
      };
    }
  }
  const own = await ownRate(db, entityId, side, usdMinor);
  return { ...own, parentEntityId: null, parentRateE4: null, parentLegalName: null };
}

export interface QuoteView {
  id: string;
  side: Side;
  usdMinor: number;
  ttdMinor: number;
  rateE4: number;
  rateSource: string;
  parentMarginMinor: number;
  parentLegalName: string | null;
  status: 'open' | 'accepted' | 'expired';
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

const MIN_USD = 1000; // US$10.00
const MAX_USD = 50_000_000; // US$500,000.00 — sandbox ceiling; real limits come from D09

export async function createQuote(pool: Pool, user: SessionUser, entityId: string, raw: { side?: unknown; usdMinor?: unknown }) {
  const side = raw.side;
  if (side !== 'buy_usd' && side !== 'sell_usd') throw invalid('Choose whether to buy or sell USD.');
  const usdMinor = Number(raw.usdMinor);
  if (!Number.isSafeInteger(usdMinor) || usdMinor < MIN_USD || usdMinor > MAX_USD) {
    throw invalid('Enter a USD amount between US$10.00 and US$500,000.00.', [{ path: 'usdMinor', message: 'Out of range' }]);
  }
  await requireApproved(pool, entityId);
  const policy = await ratePolicy(pool);
  const d = await decideRate(pool, entityId, side, usdMinor);
  const ttdMinor = usdToTtd(usdMinor, d.rateE4);
  const parentMargin = d.parentRateE4 !== null ? usdToTtd(usdMinor, d.parentRateE4) - ttdMinor : 0;
  const platformShare = usdToTtd(usdMinor, policy.platformShareE4);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app.quotes (entity_id, side, usd_minor, rate_e4, ttd_minor, rate_source, parent_entity_id,
                             parent_rate_e4, parent_margin_minor, platform_share_minor, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11), $12) RETURNING id`,
    [entityId, side, usdMinor, d.rateE4, ttdMinor, d.rateSource, d.parentEntityId, d.parentRateE4, parentMargin,
     platformShare, policy.quoteTtlSeconds, user.userId],
  );
  await recordAudit(pool, {
    actorType: 'customer', actorId: user.userId, entityId, action: 'quote.created', objectType: 'quote', objectId: rows[0]!.id,
    after: { side, usdMinor, rateE4: d.rateE4, rateSource: d.rateSource },
  });
  return getQuote(pool, entityId, rows[0]!.id);
}

export async function getQuote(db: Queryable, entityId: string, quoteId: string): Promise<QuoteView> {
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new DomainError('not_found', 'Quote not found.', 404);
  const { rows } = await db.query<QuoteRow>(`${QUOTE_SELECT} WHERE q.id = $1 AND q.entity_id = $2`, [quoteId, entityId]);
  if (!rows[0]) throw new DomainError('not_found', 'Quote not found.', 404);
  return toQuoteView(rows[0]);
}

interface QuoteRow {
  id: string; side: Side; usd_minor: string; ttd_minor: string; rate_e4: number; rate_source: string;
  parent_margin_minor: string; parent_legal_name: string | null; status: 'open' | 'accepted' | 'expired';
  expires_at: Date; created_at: Date; accepted_at: Date | null;
}

const QUOTE_SELECT = `
  SELECT q.id, q.side, q.usd_minor, q.ttd_minor, q.rate_e4, q.rate_source, q.parent_margin_minor,
         p.legal_name AS parent_legal_name,
         CASE WHEN q.status = 'open' AND q.expires_at <= now() THEN 'expired' ELSE q.status END AS status,
         q.expires_at, q.created_at, q.accepted_at
    FROM app.quotes q LEFT JOIN app.entities p ON p.id = q.parent_entity_id`;

const toQuoteView = (r: QuoteRow): QuoteView => ({
  id: r.id,
  side: r.side,
  usdMinor: toNumber(r.usd_minor),
  ttdMinor: toNumber(r.ttd_minor),
  rateE4: r.rate_e4,
  rateSource: r.rate_source,
  parentMarginMinor: toNumber(r.parent_margin_minor),
  parentLegalName: r.parent_legal_name,
  status: r.status,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  acceptedAt: r.accepted_at?.toISOString() ?? null,
});

/**
 * Executes a quote exactly once (FX-02, FX-03, SEL-03).
 *
 * One transaction: idempotency key → lock the quote → lock every account touched (customer,
 * parent, principal, revenue) in a fixed order → check customer funds AND principal inventory →
 * post one balanced journal → mark accepted → audit → outbox. Concurrent accepts of different
 * quotes against the same balance serialise on the account locks, so the balance can never be
 * spent twice.
 */
export async function acceptQuote(pool: Pool, user: SessionUser, entityId: string, quoteId: string, idempotencyKey: string) {
  const result = await withTransaction(pool, (tx) =>
    runIdempotent(tx, { scope: `entity:${entityId}:accept_quote`, key: idempotencyKey, request: { quoteId } }, async () => {
      await requireApproved(tx, entityId);
      const { rows } = await tx.query<{
        id: string; side: Side; usd_minor: string; ttd_minor: string; rate_e4: number; status: string; expired: boolean;
        parent_entity_id: string | null; parent_margin_minor: string; platform_share_minor: string;
      }>(
        `SELECT id, side, usd_minor, ttd_minor, rate_e4, status, expires_at <= now() AS expired,
                parent_entity_id, parent_margin_minor, platform_share_minor
           FROM app.quotes WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [quoteId, entityId],
      );
      const q = rows[0];
      if (!q) throw new DomainError('not_found', 'Quote not found.', 404);
      if (q.status === 'accepted') throw new DomainError('invalid_state', 'This quote has already been used.', 409);
      if (q.status === 'expired' || q.expired) {
        await tx.query(`UPDATE app.quotes SET status = 'expired' WHERE id = $1 AND status = 'open'`, [quoteId]);
        throw new DomainError('quote_expired', 'This quote expired. Request a new quote to continue.', 409);
      }
      if (q.parent_entity_id) {
        const link = await tx.query(
          `SELECT 1 FROM app.seller_links WHERE child_entity_id = $1 AND parent_entity_id = $2 AND status = 'active'`,
          [entityId, q.parent_entity_id],
        );
        if (!link.rowCount) throw new DomainError('invalid_state', 'Your seller network changed. Request a new quote.', 409);
      }

      const usd = toNumber(q.usd_minor);
      const ttd = toNumber(q.ttd_minor);
      const margin = toNumber(q.parent_margin_minor);
      const share = toNumber(q.platform_share_minor);
      const custUsd = await customerAccountId(tx, entityId, 'USD');
      const custTtd = await customerAccountId(tx, entityId, 'TTD');
      const prinUsd = await systemAccountId(tx, 'fx_principal', 'USD');
      const prinTtd = await systemAccountId(tx, 'fx_principal', 'TTD');
      const revTtd = await systemAccountId(tx, 'platform_revenue', 'TTD');
      const parentTtd = q.parent_entity_id ? await customerAccountId(tx, q.parent_entity_id, 'TTD') : null;
      await lockAccounts(tx, [custUsd, custTtd, prinUsd, prinTtd, revTtd, ...(parentTtd ? [parentTtd] : [])]);

      const lines =
        q.side === 'sell_usd'
          ? (await requireAvailable(tx, custUsd, 'USD', usd),
            await requireAvailable(tx, prinTtd, 'TTD', ttd + margin + share, 'principal_inventory_insufficient'),
            [
              { accountId: custUsd, asset: 'USD' as const, amountMinor: usd, lineType: 'fx_pay' },
              { accountId: prinUsd, asset: 'USD' as const, amountMinor: -usd, lineType: 'principal_receive' },
              { accountId: prinTtd, asset: 'TTD' as const, amountMinor: ttd + margin + share, lineType: 'principal_pay' },
              { accountId: custTtd, asset: 'TTD' as const, amountMinor: -ttd, lineType: 'fx_receive' },
              ...(margin > 0 && parentTtd
                ? [{ accountId: parentTtd, asset: 'TTD' as const, amountMinor: -margin, lineType: 'parent_margin' }]
                : []),
              ...(share > 0 ? [{ accountId: revTtd, asset: 'TTD' as const, amountMinor: -share, lineType: 'platform_share' }] : []),
            ])
          : (await requireAvailable(tx, custTtd, 'TTD', ttd),
            await requireAvailable(tx, prinUsd, 'USD', usd, 'principal_inventory_insufficient'),
            [
              { accountId: custTtd, asset: 'TTD' as const, amountMinor: ttd, lineType: 'fx_pay' },
              { accountId: prinTtd, asset: 'TTD' as const, amountMinor: -(ttd - share), lineType: 'principal_receive' },
              ...(share > 0 ? [{ accountId: revTtd, asset: 'TTD' as const, amountMinor: -share, lineType: 'platform_share' }] : []),
              { accountId: prinUsd, asset: 'USD' as const, amountMinor: usd, lineType: 'principal_pay' },
              { accountId: custUsd, asset: 'USD' as const, amountMinor: -usd, lineType: 'fx_receive' },
            ]);

      const memo =
        q.side === 'sell_usd'
          ? `Sold ${formatMoney(usd, 'USD')} at ${formatRate(q.rate_e4)}`
          : `Bought ${formatMoney(usd, 'USD')} at ${formatRate(q.rate_e4)}`;
      const journalId = await postJournal(tx, {
        kind: 'fx_trade', sourceType: 'quote', sourceId: quoteId, memo, createdBy: `user:${user.userId}`, lines,
      });
      await tx.query(`UPDATE app.quotes SET status = 'accepted', accepted_at = now(), journal_id = $2 WHERE id = $1`, [quoteId, journalId]);
      await recordAudit(tx, {
        actorType: 'customer', actorId: user.userId, entityId, action: 'quote.accepted', objectType: 'quote', objectId: quoteId,
        after: { journalId, side: q.side, usdMinor: usd, ttdMinor: ttd, parentMarginMinor: margin },
      });
      await writeOutbox(tx, { topic: 'fx.trade_executed', aggregateType: 'quote', aggregateId: quoteId, payload: { quoteId, entityId, journalId } });
      return { status: 200, body: await getQuote(tx, entityId, quoteId) };
    }),
  );
  return result.body;
}

export async function listTrades(db: Queryable, entityId: string): Promise<QuoteView[]> {
  const { rows } = await db.query<QuoteRow>(
    `${QUOTE_SELECT} WHERE q.entity_id = $1 AND q.status = 'accepted' ORDER BY q.accepted_at DESC LIMIT 100`,
    [entityId],
  );
  return rows.map(toQuoteView);
}

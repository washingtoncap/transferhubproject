import type { Queryable } from '@transferhub/platform';
import { DomainError } from './errors';
import { toNumber } from './money';

export interface PlanView {
  code: string;
  audience: 'buyer' | 'seller';
  name: string;
  monthlyMinor: number;
  annualMinor: number;
  usdRateE4: number;
  volumeAllowanceUsdMinor: number;
  childLimit: number;
  staffSeats: number;
}

interface PlanRow {
  code: string;
  audience: 'buyer' | 'seller';
  name: string;
  monthly_minor: string;
  annual_minor: string;
  usd_rate_e4: number;
  volume_allowance_usd_minor: string;
  child_limit: number;
  staff_seats: number;
}

const toView = (r: PlanRow): PlanView => ({
  code: r.code,
  audience: r.audience,
  name: r.name,
  monthlyMinor: toNumber(r.monthly_minor),
  annualMinor: toNumber(r.annual_minor),
  usdRateE4: r.usd_rate_e4,
  volumeAllowanceUsdMinor: toNumber(r.volume_allowance_usd_minor),
  childLimit: r.child_limit,
  staffSeats: r.staff_seats,
});

export async function listPlans(db: Queryable): Promise<PlanView[]> {
  const { rows } = await db.query<PlanRow>('SELECT * FROM app.plans ORDER BY audience, sort_order');
  return rows.map(toView);
}

export async function planView(db: Queryable, code: string): Promise<PlanView> {
  const { rows } = await db.query<PlanRow>('SELECT * FROM app.plans WHERE code = $1', [code]);
  if (!rows[0]) throw new DomainError('not_found', 'Plan not found.', 404);
  return toView(rows[0]);
}

export interface RatePolicy {
  standardBuyE4: number;
  standardSellE4: number;
  childFloorE4: number;
  platformShareE4: number;
  quoteTtlSeconds: number;
  dualApprovalUsdMinor: number;
  updatedAt: string;
}

export async function ratePolicy(db: Queryable): Promise<RatePolicy> {
  const { rows } = await db.query<{
    standard_buy_e4: number;
    standard_sell_e4: number;
    child_floor_e4: number;
    platform_share_e4: number;
    quote_ttl_seconds: number;
    dual_approval_usd_minor: string;
    updated_at: Date;
  }>('SELECT * FROM app.rate_policy');
  const r = rows[0]!;
  return {
    standardBuyE4: r.standard_buy_e4,
    standardSellE4: r.standard_sell_e4,
    childFloorE4: r.child_floor_e4,
    platformShareE4: r.platform_share_e4,
    quoteTtlSeconds: r.quote_ttl_seconds,
    dualApprovalUsdMinor: toNumber(r.dual_approval_usd_minor),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** USD bought or sold by the customer this calendar month (UTC) — plan allowance usage. */
export async function monthlyUsdVolume(db: Queryable, entityId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(sum(usd_minor), 0) AS total FROM app.quotes
      WHERE entity_id = $1 AND status = 'accepted' AND accepted_at >= date_trunc('month', now())`,
    [entityId],
  );
  return toNumber(rows[0]!.total);
}

/** USDT parity rule (CRY-03): corresponding USD rate + TT$0.10 per USDT — not a percentage. */
export function usdtParityRate(usdRateE4: number): number {
  return usdRateE4 + 1000;
}

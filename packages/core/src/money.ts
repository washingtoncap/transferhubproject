/**
 * Money arithmetic in integer minor units. Rates are integers in ten-thousandths (8.2200 → 82200).
 * Conversions use BigInt and round half-up, so every result is exact and reproducible.
 */
export type Asset = 'USD' | 'TTD';
export const ASSETS: Asset[] = ['USD', 'TTD'];

export function isAsset(v: unknown): v is Asset {
  return v === 'USD' || v === 'TTD';
}

/** usd cents × (rate / 10000) → ttd cents, rounded half-up. */
export function usdToTtd(usdMinor: number, rateE4: number): number {
  assertMinor(usdMinor);
  const n = BigInt(usdMinor) * BigInt(rateE4);
  const q = (n + 5000n) / 10000n;
  return Number(q);
}

/** ttd cents ÷ (rate / 10000) → usd cents, rounded half-up. Used for USD-equivalent limits. */
export function ttdToUsd(ttdMinor: number, rateE4: number): number {
  assertMinor(ttdMinor);
  const n = BigInt(ttdMinor) * 10000n;
  const r = BigInt(rateE4);
  return Number((n + r / 2n) / r);
}

export function assertMinor(v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`Invalid minor amount: ${v}`);
}

/** "US$1,234.56" — for audit memos and statements. */
export function formatMoney(minor: number, asset: Asset): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${asset === 'USD' ? 'US$' : 'TT$'}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatRate(e4: number): string {
  return (e4 / 10000).toFixed(4);
}

/** Postgres bigint arrives as a string; amounts here stay far below 2^53. */
export function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Unsafe integer from database: ${v}`);
  return n;
}

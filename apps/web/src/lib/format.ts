import type { Asset } from './api';

/** "US$1,234.56" / "TT$8,220.00" — currency always explicit (TH-BRD §4). */
export function money(minor: number, asset: Asset): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${asset === 'USD' ? 'US$' : 'TT$'}${whole}.${cents}`;
}

/** 82200 → "8.2200" */
export function rate(e4: number): string {
  return (e4 / 10000).toFixed(4);
}

/** "12.50" → 1250. Returns null for anything that is not a positive amount with ≤ 2 decimals. */
export function parseMoney(input: string): number | null {
  const s = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const minor = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

/** "8.05" → 80500 */
export function parseRate(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 10000 + Number(f.padEnd(4, '0'));
}

const TT = 'America/Port_of_Spain';

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-TT', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TT,
  }).format(new Date(iso));
}

export function date(iso: string): string {
  return new Intl.DateTimeFormat('en-TT', { dateStyle: 'medium', timeZone: TT }).format(
    new Date(iso),
  );
}

export function humanize(code: string): string {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

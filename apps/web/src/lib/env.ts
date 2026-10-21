/** Server-side only: reads runtime configuration for the web app. */

export const API_BASE_URL =
  process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Every non-production environment shows a persistent banner so nobody mistakes a sandbox for the
 * live service. Production shows none.
 */
export function environmentLabel(): string | null {
  const env = process.env.APP_ENV ?? 'local';
  if (env === 'production') return null;
  const names: Record<string, string> = { local: 'Local', test: 'Test', sandbox: 'Sandbox' };
  return `${names[env] ?? env} · no real money`;
}

/** Customer-facing times are shown in Trinidad and Tobago time with the zone named (TH-BRD §8). */
export function formatLocalTime(date: Date): string {
  return (
    new Intl.DateTimeFormat('en-TT', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'America/Port_of_Spain',
    }).format(date) + ' (Port of Spain)'
  );
}

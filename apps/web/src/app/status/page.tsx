import type { Metadata } from 'next';
import { API_BASE_URL, formatLocalTime } from '@/lib/env';
import styles from './status.module.css';

export const metadata: Metadata = { title: 'System status' };
// Always render on request: a cached status page would be worse than none.
export const dynamic = 'force-dynamic';

interface Readiness {
  status: string;
  environment?: string;
  version?: string;
  checks?: Record<string, string>;
}

async function fetchReadiness(): Promise<{ ok: boolean; data: Readiness | null }> {
  try {
    const res = await fetch(`${API_BASE_URL}/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const json = (await res.json()) as Readiness | { error?: { details?: Readiness } };
    const data = 'status' in json ? json : (json.error?.details ?? null);
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

const LABELS: Record<string, string> = { database: 'Database', migrations: 'Database schema' };

export default async function StatusPage() {
  const { ok, data } = await fetchReadiness();
  const checkedAt = formatLocalTime(new Date());

  return (
    <>
      <h1>System status</h1>
      <p className={ok ? styles.ok : styles.bad} role="status">
        <span aria-hidden="true">{ok ? '●' : '▲'}</span>{' '}
        {ok ? 'All systems operational' : 'The platform API is not reachable or not ready'}
      </p>

      <table className={styles.table}>
        <caption className={styles.caption}>Checked {checkedAt}</caption>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>API</td>
            <td>{data ? 'Responding' : 'No response'}</td>
          </tr>
          {Object.entries(data?.checks ?? {}).map(([name, state]) => (
            <tr key={name}>
              <td>{LABELS[name] ?? name}</td>
              <td>{state === 'ok' ? 'Healthy' : 'Problem'}</td>
            </tr>
          ))}
          {data?.environment && (
            <tr>
              <td>Environment</td>
              <td>{data.environment}</td>
            </tr>
          )}
          {data?.version && (
            <tr>
              <td>Version</td>
              <td className="num">{data.version}</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

'use client';

import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Alert, Card, Grid, Loading, PageHeader, Stat, StatusBadge, Table } from '@/components/ui';
import { useData } from '@/components/session';
import { useAutoRefresh } from '../_shared/hooks';
import s from '../_shared/ops.module.css';

function Counts({ title, counts }: { title: string; counts: Record<string, number> }) {
  return (
    <Card title={title}>
      <Grid min={110}>
        {Object.entries(counts).map(([k, v]) => (
          <Stat
            key={k}
            label={k}
            value={v}
            sub={
              k === 'dead' && v > 0 ? (
                <StatusBadge status="dead" label="Needs attention" />
              ) : undefined
            }
          />
        ))}
      </Grid>
    </Card>
  );
}

export default function OpsSystemPage() {
  const { data, error, reload } = useData(() => api.ops.system(), []);
  useAutoRefresh(reload, 10_000);

  return (
    <>
      <PageHeader
        title="System health"
        description="Background jobs, outbound events (outbox) and partner webhooks (inbox). Refreshes every 10 seconds."
      />
      {error && (
        <Alert tone="error" title="Could not load system health">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <>
          <Grid min={280}>
            <Counts title="Jobs" counts={data.jobs} />
            <Counts title="Outbox" counts={data.outbox} />
            <Counts title="Inbox (webhooks)" counts={data.inbox} />
          </Grid>
          <div className={s.section}>
            <Card title="Dead jobs">
              <p className={s.muted}>
                Jobs that exhausted their retries. Investigate before requeueing.
              </p>
              <Table head={['Type', 'Attempts', 'Last error', 'Updated']} empty="No dead jobs.">
                {data.deadJobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <code className={s.code}>{j.type}</code>
                    </td>
                    <td className="num">{j.attempts}</td>
                    <td className={s.small}>{j.lastError ?? '—'}</td>
                    <td className={s.nowrap}>{dateTime(j.updatedAt)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
          <Card title="Recent jobs">
            <Table head={['Type', 'Status', 'Attempts', 'Updated']} empty="No recent jobs.">
              {data.recentJobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <code className={s.code}>{j.type}</code>
                  </td>
                  <td>
                    <StatusBadge
                      status={
                        j.status === 'succeeded'
                          ? 'ok'
                          : j.status === 'queued' || j.status === 'running'
                            ? 'pending'
                            : j.status
                      }
                      label={j.status}
                    />
                  </td>
                  <td className="num">{j.attempts}</td>
                  <td className={s.nowrap}>{dateTime(j.updatedAt)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}

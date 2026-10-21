'use client';

import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { Alert, Grid, Loading, PageHeader, Stat } from '@/components/ui';
import { useData } from '@/components/session';
import { useAutoRefresh } from './_shared/hooks';
import s from './_shared/ops.module.css';

function Tile({
  href,
  label,
  value,
  sub,
  alert,
}: {
  href: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  alert?: boolean;
}) {
  return (
    <a href={href} className={alert ? `${s.tileLink} ${s.tileAlert}` : s.tileLink}>
      <Stat label={label} value={value} sub={sub} />
    </a>
  );
}

export default function OpsOverviewPage() {
  const { data, error, reload } = useData(() => api.ops.overview(), []);
  useAutoRefresh(reload, 15_000);

  return (
    <>
      <PageHeader
        title="Operations overview"
        description="Queues and controls that need attention. Refreshes every 15 seconds."
      />
      {error && (
        <Alert tone="error" title="Could not load the overview">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <>
          {data.reconciliationBreaks > 0 && (
            <Alert tone="error" title="Reconciliation break">
              {data.reconciliationBreaks} asset
              {data.reconciliationBreaks === 1 ? ' does' : 's do'} not reconcile with the partner
              statement. <a href="/ops/reconciliation">Open reconciliation</a>.
            </Alert>
          )}
          {data.deadJobs > 0 && (
            <Alert tone="warning" title="Dead jobs">
              {data.deadJobs} background job{data.deadJobs === 1 ? ' has' : 's have'} exhausted
              retries. <a href="/ops/system">Open system health</a>.
            </Alert>
          )}
          <Grid min={200}>
            <Tile
              href="/ops/customers"
              label="KYC / KYB review queue"
              value={data.kycQueue}
              sub="Applications awaiting a decision"
            />
            <Tile
              href="/ops/deposits"
              label="Pending deposits"
              value={data.pendingDeposits}
              sub="Claims awaiting partner clearance"
            />
            <Tile
              href="/ops/withdrawals"
              label="Withdrawals awaiting approval"
              value={data.withdrawalsAwaitingApproval}
              sub="Maker/checker queue"
            />
            <Tile
              href="/ops/reconciliation"
              label="Reconciliation breaks"
              value={data.reconciliationBreaks}
              sub={data.reconciliationBreaks > 0 ? 'Action required' : 'All assets matched'}
              alert={data.reconciliationBreaks > 0}
            />
            <Tile
              href="/ops/system"
              label="Dead jobs"
              value={data.deadJobs}
              sub={data.deadJobs > 0 ? 'Needs investigation' : 'No failed jobs'}
              alert={data.deadJobs > 0}
            />
            <Tile
              href="/ops/customers"
              label="Customers approved"
              value={`${data.customers.approved} / ${data.customers.total}`}
              sub="Approved of all registered"
            />
            <Tile
              href="/ops/trades"
              label="Trades, last 24 hours"
              value={data.last24h.tradesCount}
              sub={`${money(data.last24h.tradesUsdMinor, 'USD')} volume · ${data.last24h.depositsClearedCount} deposits cleared`}
            />
            <Tile
              href="/ops/trades"
              label="Platform revenue"
              value={money(data.platformRevenueTtdMinor, 'TTD')}
              sub="TransferHub revenue account balance"
            />
          </Grid>
        </>
      )}
    </>
  );
}

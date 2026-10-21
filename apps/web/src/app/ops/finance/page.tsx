'use client';

import { useCallback } from 'react';
import {
  Alert,
  Card,
  DefinitionList,
  Grid,
  Loading,
  Money,
  PageHeader,
  Stat,
  StatusBadge,
  Table,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { api } from '@/lib/api';
import { dateTime, money, rate } from '@/lib/format';
import { useAutoRefresh } from '../_shared/hooks';

/**
 * Finance landing page: where the money is, whether it reconciles, what TransferHub earned and
 * what is waiting on a finance decision. Read-only; every number traces to ledger postings.
 */
export default function FinancePage() {
  const load = useCallback(
    () =>
      Promise.all([
        api.ops.overview(),
        api.ops.reconciliation(),
        api.ops.trades(),
        api.ops.withdrawals('pending_approval'),
      ]),
    [],
  );
  const { data, error, reload, loading } = useData(load, [load]);
  useAutoRefresh(reload, 20_000);

  if (error)
    return (
      <Alert tone="error" title="Could not load finance data">
        {errorMessage(new Error(error))}
      </Alert>
    );
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const [overview, recon, trades, pending] = data;
  const usd = recon.assets.find((a) => a.asset === 'USD')!;
  const ttd = recon.assets.find((a) => a.asset === 'TTD')!;
  const breaks =
    recon.assets.filter((a) => a.status === 'break').length + recon.unmatchedStatementLines.length;

  const spreadShare = trades.reduce((s, t) => s + t.platformShareMinor, 0);
  const margins = trades.reduce((s, t) => s + t.parentMarginMinor, 0);
  const usdBought = trades.filter((t) => t.side === 'buy_usd').reduce((s, t) => s + t.usdMinor, 0);
  const usdSold = trades.filter((t) => t.side === 'sell_usd').reduce((s, t) => s + t.usdMinor, 0);

  return (
    <>
      <PageHeader
        title="Finance"
        description={`Customer money, principal liquidity and TransferHub revenue, kept separate and reconciled to the partner statement. As of ${dateTime(recon.asOf)} (Port of Spain).`}
      />

      {breaks > 0 ? (
        <Alert
          tone="error"
          title={`${breaks} reconciliation item${breaks === 1 ? '' : 's'} need attention`}
        >
          <a href="/ops/reconciliation">Open reconciliation</a> — assign each break by the next
          business day.
        </Alert>
      ) : (
        <Alert tone="success" title="Ledger and partner statement agree in every currency" />
      )}

      <Grid min={220}>
        <Card>
          <Stat
            label="TransferHub revenue (TTD)"
            value={money(ttd.platformRevenueMinor, 'TTD')}
            sub="Subscriptions + contracted share per USD"
          />
        </Card>
        <Card>
          <Stat
            label="Customer balances owed"
            value={money(ttd.customerLiabilitiesMinor, 'TTD')}
            sub={`and ${money(usd.customerLiabilitiesMinor, 'USD')}`}
          />
        </Card>
        <Card>
          <Stat
            label="Principal inventory"
            value={money(usd.principalMinor, 'USD')}
            sub={`and ${money(ttd.principalMinor, 'TTD')}`}
          />
        </Card>
        <Card>
          <Stat
            label="Payouts awaiting approval"
            value={String(pending.length)}
            sub={<a href="/ops/withdrawals">Review withdrawals</a>}
          />
        </Card>
      </Grid>

      <Grid min={320}>
        {[usd, ttd].map((a) => (
          <Card key={a.asset} title={`${a.asset} position`}>
            <p>
              <StatusBadge status={a.status} />
            </p>
            <DefinitionList
              items={[
                [
                  'Cash at partner (our ledger)',
                  <Money key="l" minor={a.ledgerProviderCashMinor} asset={a.asset} />,
                ],
                [
                  'Partner statement',
                  <Money key="p" minor={a.partnerStatementMinor} asset={a.asset} />,
                ],
                ['Difference', <strong key="d">{money(a.differenceMinor, a.asset)}</strong>],
                [
                  'Customer balances',
                  <Money key="c" minor={a.customerLiabilitiesMinor} asset={a.asset} />,
                ],
                [
                  'Principal inventory',
                  <Money key="pr" minor={a.principalMinor} asset={a.asset} />,
                ],
                [
                  'TransferHub revenue',
                  <Money key="r" minor={a.platformRevenueMinor} asset={a.asset} />,
                ],
                [
                  'Trial balance',
                  a.trialBalanceMinor === 0 ? 'Balanced (0)' : money(a.trialBalanceMinor, a.asset),
                ],
              ]}
            />
          </Card>
        ))}
      </Grid>

      <Card title="Trading summary (all recorded trades)">
        <Grid min={200}>
          <Stat label="USD bought by customers" value={money(usdBought, 'USD')} />
          <Stat label="USD sold by customers" value={money(usdSold, 'USD')} />
          <Stat
            label="TransferHub share from FX"
            value={money(spreadShare, 'TTD')}
            sub="Paid by the principal, not by customers"
          />
          <Stat
            label="Margins paid to main sellers"
            value={money(margins, 'TTD')}
            sub="Owed to parents — not TransferHub revenue"
          />
        </Grid>
        <Table
          caption="Latest trades"
          head={['Time', 'Customer', 'Side', 'USD', 'Rate', 'TTD', 'TransferHub share']}
        >
          {trades.slice(0, 8).map((t) => (
            <tr key={t.id}>
              <td>{dateTime(t.acceptedAt)}</td>
              <td>{t.entity.legalName}</td>
              <td>{t.side === 'buy_usd' ? 'Bought USD' : 'Sold USD'}</td>
              <td className="num">{money(t.usdMinor, 'USD')}</td>
              <td className="num">{rate(t.rateE4)}</td>
              <td className="num">{money(t.ttdMinor, 'TTD')}</td>
              <td className="num">{money(t.platformShareMinor, 'TTD')}</td>
            </tr>
          ))}
        </Table>
        <p>
          <a href="/ops/trades">All trades</a> · Last 24 hours: {overview.last24h.tradesCount}{' '}
          trades, {money(overview.last24h.tradesUsdMinor, 'USD')}
        </p>
      </Card>
    </>
  );
}

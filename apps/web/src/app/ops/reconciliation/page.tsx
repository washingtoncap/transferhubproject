'use client';

import { api, type ReconciliationAsset } from '@/lib/api';
import { dateTime } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Grid,
  Loading,
  Money,
  PageHeader,
  StatusBadge,
  Table,
} from '@/components/ui';
import { useData } from '@/components/session';
import s from '../_shared/ops.module.css';

function AssetCard({ a }: { a: ReconciliationAsset }) {
  const sum = a.customerLiabilitiesMinor + a.principalMinor + a.platformRevenueMinor;
  const componentsTie = sum === a.ledgerProviderCashMinor;
  return (
    <Card title={`${a.asset} reconciliation`}>
      <div className={s.bigBadge}>
        <StatusBadge status={a.status} label={a.status === 'matched' ? '✓ Matched' : '✕ Break'} />
      </div>
      <DefinitionList
        items={[
          [
            'Ledger cash at partner',
            <Money key="l" minor={a.ledgerProviderCashMinor} asset={a.asset} />,
          ],
          [
            'Partner statement balance',
            <Money key="p" minor={a.partnerStatementMinor} asset={a.asset} />,
          ],
          [
            'Difference',
            <span key="d" className={a.differenceMinor !== 0 ? s.diffBad : s.ok}>
              <Money minor={a.differenceMinor} asset={a.asset} />
              {a.differenceMinor !== 0 ? ' — investigate' : ' — none'}
            </span>,
          ],
        ]}
      />
      <div className={s.equation}>
        <strong>
          Ledger cash at partner = Customer balances + Principal inventory + TransferHub revenue
        </strong>
        <DefinitionList
          items={[
            [
              'Customer balances',
              <Money key="c" minor={a.customerLiabilitiesMinor} asset={a.asset} />,
            ],
            ['Principal inventory', <Money key="pr" minor={a.principalMinor} asset={a.asset} />],
            [
              'TransferHub revenue',
              <Money key="r" minor={a.platformRevenueMinor} asset={a.asset} />,
            ],
            [
              'Sum of components',
              <span key="s" className={componentsTie ? undefined : s.diffBad}>
                <Money minor={sum} asset={a.asset} />
                {componentsTie ? ' ✓ equals ledger cash' : ' ✕ does not equal ledger cash'}
              </span>,
            ],
          ]}
        />
      </div>
      {a.trialBalanceMinor === 0 ? (
        <p className={s.ok}>
          <span aria-hidden="true">✓</span> Trial balance: Balanced (all {a.asset} postings sum to
          zero)
        </p>
      ) : (
        <Alert tone="error" title="Trial balance does not net to zero">
          {a.asset} postings sum to <Money minor={a.trialBalanceMinor} asset={a.asset} />. The
          ledger is out of balance; stop processing and escalate to finance.
        </Alert>
      )}
    </Card>
  );
}

export default function OpsReconciliationPage() {
  const { data, error, reload, loading } = useData(() => api.ops.reconciliation(), []);

  return (
    <>
      <PageHeader
        title="Daily reconciliation"
        description={
          data ? `As of ${dateTime(data.asOf)} (Port of Spain)` : 'Ledger versus partner statement'
        }
        actions={
          <Button variant="secondary" onClick={() => void reload()} busy={loading && !!data}>
            Refresh
          </Button>
        }
      />
      {error && (
        <Alert tone="error" title="Could not load reconciliation">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <>
          {data.conflictingEvents > 0 && (
            <Alert
              tone="error"
              title={`${data.conflictingEvents} conflicting partner event${data.conflictingEvents === 1 ? '' : 's'}`}
            >
              The same event id was redelivered with different content. These were rejected and need
              security review.
            </Alert>
          )}
          {data.assets.length === 0 ? (
            <Alert tone="info">No assets to reconcile yet.</Alert>
          ) : (
            <Grid min={320}>
              {data.assets.map((a) => (
                <AssetCard key={a.asset} a={a} />
              ))}
            </Grid>
          )}
          <Card title="Unmatched statement lines">
            <p className={s.muted}>
              Money the bank received that matches no deposit claim. Owned queue: assign by next
              business day.
            </p>
            <Table
              head={['Received', 'Asset', 'Amount', 'Description', 'Reference']}
              empty="No unmatched statement lines."
            >
              {data.unmatchedStatementLines.map((l) => (
                <tr key={l.id}>
                  <td className={s.nowrap}>{dateTime(l.occurredAt)}</td>
                  <td>{l.asset}</td>
                  <td>
                    <Money minor={l.amountMinor} asset={l.asset} />
                  </td>
                  <td>{l.description}</td>
                  <td>{l.reference ? <code className={s.code}>{l.reference}</code> : '—'}</td>
                </tr>
              ))}
            </Table>
            <DefinitionList
              items={[
                [
                  'Conflicting events',
                  <span key="c" className={data.conflictingEvents > 0 ? s.diffBad : undefined}>
                    {data.conflictingEvents}
                    {data.conflictingEvents > 0
                      ? ' — same event id redelivered with different content; security review'
                      : ' — none'}
                  </span>,
                ],
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}

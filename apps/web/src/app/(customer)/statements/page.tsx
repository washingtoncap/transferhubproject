'use client';

import { useState } from 'react';
import { useData } from '@/components/session';
import { Alert, Card, Grid, Loading, Money, PageHeader, Stat, Table, Tabs } from '@/components/ui';
import { api, type Asset, type EntitySummary } from '@/lib/api';
import { dateTime, humanize, money } from '@/lib/format';
import { CustomerOnly } from '../_lib/common';
import c from '../_lib/customer.module.css';

export default function StatementsPage() {
  return <CustomerOnly title="Statements">{(e) => <Statements entity={e} />}</CustomerOnly>;
}

function Statements({ entity }: { entity: EntitySummary }) {
  const [asset, setAsset] = useState<Asset>('TTD');
  const activity = useData(() => api.activity(entity.id, 200), [entity.id]);
  const lines = (activity.data ?? []).filter((l) => l.asset === asset);
  const totalIn = lines.reduce((s, l) => s + (l.amountMinor > 0 ? l.amountMinor : 0), 0);
  const totalOut = lines.reduce((s, l) => s + (l.amountMinor < 0 ? -l.amountMinor : 0), 0);

  return (
    <>
      <PageHeader
        title="Statements"
        description="Every settled entry on your USD and TTD balances. Pending deposits do not appear until they clear."
        actions={
          <a className={c.actionLink} href={api.statementCsvUrl(entity.id, asset)} download>
            Download CSV ({asset})
          </a>
        }
      />
      <Tabs<Asset>
        label="Currency"
        value={asset}
        onChange={setAsset}
        options={[
          { value: 'TTD', label: 'TTD' },
          { value: 'USD', label: 'USD' },
        ]}
      />
      {activity.error && <Alert tone="error">{activity.error}</Alert>}
      {activity.loading && !activity.data ? (
        <Loading />
      ) : (
        <>
          <Grid min={200}>
            <Card>
              <Stat label="Money in (shown lines)" value={money(totalIn, asset)} />
            </Card>
            <Card>
              <Stat label="Money out (shown lines)" value={money(totalOut, asset)} />
            </Card>
            <Card>
              <Stat
                label="Entries"
                value={String(lines.length)}
                sub="Most recent 200 across both currencies"
              />
            </Card>
          </Grid>
          <Table
            caption={`${asset} entries · times in Port of Spain`}
            head={['Date', 'Description', 'Type', 'Amount', 'Balance after']}
            empty={`No ${asset} entries yet.`}
          >
            {lines.map((l) => (
              <tr key={l.postingId}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(l.at)}</td>
                <td>{l.memo}</td>
                <td>{humanize(l.lineType)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Money minor={l.amountMinor} asset={l.asset} signed />
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Money minor={l.balanceAfterMinor} asset={l.asset} />
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </>
  );
}

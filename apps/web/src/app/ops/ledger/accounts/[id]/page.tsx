'use client';

import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import {
  Alert,
  Card,
  DefinitionList,
  Grid,
  Loading,
  PageHeader,
  Stat,
  Table,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { api } from '@/lib/api';
import { dateTime, humanize, money } from '@/lib/format';

export default function AccountLedgerPage() {
  const { id } = useParams<{ id: string }>();
  const load = useCallback(() => api.ops.ledgerAccount(id), [id]);
  const { data, error, loading } = useData(load, [load]);
  if (error) return <Alert tone="error">{errorMessage(new Error(error))}</Alert>;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const a = data.account;

  return (
    <>
      <p>
        <a href="/ops/ledger">← Ledger</a>
      </p>
      <PageHeader
        title={a.entity ? `${a.entity.legalName} · ${a.asset}` : a.name}
        description={<code>{a.code}</code>}
      />
      <Grid min={220}>
        <Card>
          <Stat
            label="Balance"
            value={money(a.balanceMinor, a.asset)}
            sub={`${humanize(a.normalSide)}-normal account`}
          />
        </Card>
        <Card>
          <Stat
            label="Held for withdrawals"
            value={money(a.heldMinor, a.asset)}
            sub={`Available ${money(a.balanceMinor - a.heldMinor, a.asset)}`}
          />
        </Card>
        <Card>
          <DefinitionList
            items={[
              ['Total debits', money(a.debitsMinor, a.asset)],
              ['Total credits', money(a.creditsMinor, a.asset)],
              ['Postings', String(a.postings)],
            ]}
          />
        </Card>
      </Grid>
      <Card title="Account ledger (newest first)">
        <Table
          head={['Date', 'Description', 'Type', 'Debit', 'Credit', 'Balance after']}
          empty="No postings yet."
        >
          {data.entries.map((e) => (
            <tr key={e.postingId}>
              <td>{dateTime(e.at)}</td>
              <td>{e.memo}</td>
              <td>{humanize(e.lineType)}</td>
              <td className="num">{e.debitMinor ? money(e.debitMinor, a.asset) : ''}</td>
              <td className="num">{e.creditMinor ? money(e.creditMinor, a.asset) : ''}</td>
              <td className="num">
                <strong>{money(e.balanceAfterMinor, a.asset)}</strong>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

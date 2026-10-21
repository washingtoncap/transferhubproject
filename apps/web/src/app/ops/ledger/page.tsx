'use client';

import { useCallback, useState } from 'react';
import {
  Alert,
  Card,
  Grid,
  Loading,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  Table,
  Tabs,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { api, type Asset, type Journal, type LedgerAccount } from '@/lib/api';
import { dateTime, humanize, money } from '@/lib/format';
import s from './ledger.module.css';

const TYPE_LABEL: Record<LedgerAccount['type'], string> = {
  provider_cash: 'Cash at fiat partner',
  fx_principal: 'FX principal inventory',
  platform_revenue: 'TransferHub revenue',
  customer: 'Customer balance',
};

const KINDS = [
  'opening_float',
  'deposit_cleared',
  'fx_trade',
  'allocation',
  'subscription_charge',
  'withdrawal_settled',
  'reversal',
];

export default function LedgerPage() {
  const [tab, setTab] = useState<'accounts' | 'journal'>('accounts');
  return (
    <>
      <PageHeader
        title="Ledger"
        description="TransferHub's double-entry subledger. Every movement of money is a journal whose debits equal its credits in each currency. Entries are permanent: corrections are new, linked entries, never edits."
      />
      <Tabs
        label="Ledger views"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'accounts', label: 'Chart of accounts' },
          { value: 'journal', label: 'Journal' },
        ]}
      />
      {tab === 'accounts' ? <Accounts /> : <JournalList />}
    </>
  );
}

function Accounts() {
  const load = useCallback(() => api.ops.ledgerAccounts(), []);
  const { data, error, loading } = useData(load, [load]);
  if (error) return <Alert tone="error">{errorMessage(new Error(error))}</Alert>;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const system = data.filter((a) => a.type !== 'customer');
  const customers = data.filter((a) => a.type === 'customer');
  const check = (asset: Asset) => {
    const rows = data.filter((a) => a.asset === asset);
    const debits = rows.reduce((t, a) => t + a.debitsMinor, 0);
    const credits = rows.reduce((t, a) => t + a.creditsMinor, 0);
    return { debits, credits, ok: debits === credits };
  };
  const usd = check('USD');
  const ttd = check('TTD');

  return (
    <>
      <Grid min={260}>
        {(['USD', 'TTD'] as const).map((asset) => {
          const c = asset === 'USD' ? usd : ttd;
          return (
            <Card key={asset}>
              <Stat
                label={`Trial balance — ${asset}`}
                value={c.ok ? 'Balanced' : 'OUT OF BALANCE'}
                sub={`Debits ${money(c.debits, asset)} = Credits ${money(c.credits, asset)}`}
              />
            </Card>
          );
        })}
        <Card>
          <Stat
            label="Accounts"
            value={String(data.length)}
            sub={`${system.length} system · ${customers.length} customer`}
          />
        </Card>
      </Grid>

      <Card title="System accounts">
        <AccountTable rows={system} />
        <p className={s.note}>
          Cash at the partner is what the bank holds for us (debit-normal). It must always equal
          customer balances + principal inventory + TransferHub revenue in the same currency — the
          reconciliation page checks this against the partner&apos;s own statement.
        </p>
      </Card>
      <Card title="Customer accounts">
        <AccountTable rows={customers} />
      </Card>
    </>
  );
}

function AccountTable({ rows }: { rows: LedgerAccount[] }) {
  return (
    <Table
      head={[
        'Account',
        'Type',
        'Currency',
        'Normal side',
        'Debits',
        'Credits',
        'Balance',
        'Held',
        'Postings',
      ]}
    >
      {rows.map((a) => (
        <tr key={a.id}>
          <td>
            <a href={`/ops/ledger/accounts/${a.id}`}>{a.entity ? a.entity.legalName : a.name}</a>
            <div className={s.code}>{a.code.replace(/:[0-9a-f-]{36}:/, ':…:')}</div>
          </td>
          <td>{TYPE_LABEL[a.type]}</td>
          <td>{a.asset}</td>
          <td>{humanize(a.normalSide)}</td>
          <td className="num">{money(a.debitsMinor, a.asset)}</td>
          <td className="num">{money(a.creditsMinor, a.asset)}</td>
          <td className="num">
            <strong>{money(a.balanceMinor, a.asset)}</strong>
          </td>
          <td className="num">{a.heldMinor ? money(a.heldMinor, a.asset) : '—'}</td>
          <td className="num">{a.postings}</td>
        </tr>
      ))}
    </Table>
  );
}

function JournalList() {
  const [kind, setKind] = useState('');
  const load = useCallback(() => api.ops.journals({ kind: kind || undefined, limit: 100 }), [kind]);
  const { data, error, loading } = useData(load, [load]);
  return (
    <>
      <div className={s.filters}>
        <label>
          <span className={s.filterLabel}>Journal type</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All types</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {error && <Alert tone="error">{errorMessage(new Error(error))}</Alert>}
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <p>No journals of this type yet.</p>
      ) : null}
      {data?.map((j) => (
        <JournalCard key={j.id} j={j} />
      ))}
    </>
  );
}

export function JournalCard({ j }: { j: Journal }) {
  const balanced = j.totals.every((t) => t.debitsMinor === t.creditsMinor);
  return (
    <details className={s.journal}>
      <summary>
        <span className={s.when}>{dateTime(j.createdAt)}</span>
        <StatusBadge status="open" label={humanize(j.kind)} />
        <span className={s.memo}>{j.memo}</span>
        <span className={s.totals}>
          {j.totals.map((t) => money(t.debitsMinor, t.asset)).join(' · ')}
        </span>
      </summary>
      <Table head={['Account', 'Line', 'Debit', 'Credit']}>
        {j.lines.map((l) => (
          <tr key={l.postingId}>
            <td>
              <a href={`/ops/ledger/accounts/${l.account.id}`}>{l.account.name}</a>
            </td>
            <td>{humanize(l.lineType)}</td>
            <td className="num">{l.debitMinor ? money(l.debitMinor, l.asset) : ''}</td>
            <td className="num">{l.creditMinor ? money(l.creditMinor, l.asset) : ''}</td>
          </tr>
        ))}
        {j.totals.map((t) => (
          <tr key={t.asset} className={s.totalRow}>
            <td colSpan={2}>Total {t.asset}</td>
            <td className="num">{money(t.debitsMinor, t.asset)}</td>
            <td className="num">{money(t.creditsMinor, t.asset)}</td>
          </tr>
        ))}
      </Table>
      <p className={s.meta}>
        {balanced ? '✓ Balanced' : '✕ Unbalanced'} · Source: {humanize(j.sourceType)}{' '}
        <code>{j.sourceId}</code> · Posted by {j.createdBy} · Journal <code>{j.id}</code>
      </p>
    </details>
  );
}

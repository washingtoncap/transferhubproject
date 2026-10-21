'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, type Asset, type OpsDeposit } from '@/lib/api';
import { dateTime, money, parseMoney } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Loading,
  Money,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Tabs,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import s from '../_shared/ops.module.css';

type Tab = 'pending' | 'cleared' | 'rejected' | 'all';

interface CreditInput {
  asset: Asset;
  amountMinor: number;
  reference: string;
  senderName: string;
}

const OUTCOME_TEXT: Record<
  string,
  { tone: 'success' | 'info' | 'warning' | 'error'; text: string }
> = {
  accepted: {
    tone: 'success',
    text: 'Accepted. The signed webhook was received and queued; the worker will match it to a deposit claim.',
  },
  duplicate: {
    tone: 'info',
    text: 'Duplicate. The partner re-sent the same statement line; it was recognised and produced no second posting.',
  },
  conflict: {
    tone: 'error',
    text: 'Conflict. An event with the same id arrived with different content. It was rejected and flagged for security review.',
  },
  unmatched: {
    tone: 'warning',
    text: 'Unmatched. No pending deposit claim has this reference, amount and currency. It now appears on the reconciliation page as an unmatched statement line.',
  },
};

function BankSimulator({
  prefill,
  onSent,
}: {
  prefill: (CreditInput & { nonce: number }) | null;
  onSent: () => void;
}) {
  const [asset, setAsset] = useState<Asset>('TTD');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [sender, setSender] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ eventId: string; outcome: string; at: string }>>(
    [],
  );
  const [last, setLast] = useState<CreditInput | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setAsset(prefill.asset);
    setAmount((prefill.amountMinor / 100).toFixed(2));
    setReference(prefill.reference);
    setSender(prefill.senderName);
    setError(null);
    setAmountError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [prefill]);

  const send = async (input: CreditInput) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.ops.simulateBankCredit(input);
      setResults((r) => [{ ...res, at: new Date().toISOString() }, ...r].slice(0, 5));
      setLast(input);
      onSent();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const minor = parseMoney(amount);
    if (minor === null) {
      setAmountError('Enter a positive amount with at most two decimals.');
      return;
    }
    setAmountError(null);
    void send({
      asset,
      amountMinor: minor,
      reference: reference.trim(),
      senderName: sender.trim(),
    });
  };

  const latest = results[0];
  const latestText = latest ? OUTCOME_TEXT[latest.outcome] : undefined;

  return (
    <Card title="Bank simulator (sandbox)" tone="lavender">
      <p>
        Simulates the fiat partner receiving a transfer. The partner then sends a signed webhook;
        the platform matches it to a deposit claim by reference, amount and currency.
      </p>
      <form ref={formRef} onSubmit={submit} noValidate>
        <div className={s.formGrid}>
          <Field label="Asset">
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={asset}
                onChange={(e) => setAsset(e.target.value as Asset)}
              >
                <option value="TTD">TTD</option>
                <option value="USD">USD</option>
              </Select>
            )}
          </Field>
          <Field label={`Amount (${asset === 'USD' ? 'US$' : 'TT$'})`} error={amountError}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                aria-invalid={amountError ? true : undefined}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
              />
            )}
          </Field>
          <Field label="Payment reference" hint="As written on the customer's transfer.">
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <Field label="Sender name">
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
        </div>
        {error && (
          <Alert tone="error" title="Simulated credit failed">
            {error}
          </Alert>
        )}
        <div className={s.actions}>
          <Button
            type="submit"
            busy={busy}
            disabled={!amount || !reference.trim() || !sender.trim()}
          >
            Send simulated bank credit
          </Button>
          {last && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void send(last)}
            >
              Send again (duplicate)
            </Button>
          )}
        </div>
      </form>
      {latest && (
        <div style={{ marginTop: 16 }}>
          <Alert tone={latestText?.tone ?? 'info'} title={`Outcome: ${latest.outcome}`}>
            {latestText?.text ?? 'The partner event was processed.'}{' '}
            <span className={s.small}>
              Event <code className={s.code}>{latest.eventId}</code>
            </span>
          </Alert>
          {last && latest.outcome === 'accepted' && (
            <p className={s.muted}>
              Press “Send again (duplicate)” to replay the same statement line and confirm that it
              produces exactly one ledger posting.
            </p>
          )}
          {results.length > 1 && (
            <Table caption="Recent simulated credits" head={['Sent', 'Outcome', 'Event id']}>
              {results.map((r) => (
                <tr key={`${r.eventId}-${r.at}`}>
                  <td className={s.nowrap}>{dateTime(r.at)}</td>
                  <td>{r.outcome}</td>
                  <td>
                    <code className={s.code}>{r.eventId}</code>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

export default function OpsDepositsPage() {
  const [tab, setTab] = useState<Tab>('pending');
  const { data, error, reload } = useData(
    () => api.ops.deposits(tab === 'all' ? undefined : tab),
    [tab],
  );
  const [prefill, setPrefill] = useState<(CreditInput & { nonce: number }) | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const afterSend = () => {
    window.clearTimeout(timer.current);
    // The worker processes the inbox event asynchronously.
    timer.current = window.setTimeout(() => void reload(), 1500);
  };

  const simulate = (d: OpsDeposit) =>
    setPrefill({
      asset: d.asset,
      amountMinor: d.amountMinor,
      reference: d.reference,
      senderName: d.entity.legalName,
      nonce: Date.now(),
    });

  return (
    <>
      <PageHeader
        title="Deposits"
        description="Customer deposit claims. A claim is not spendable until the partner confirms the money arrived."
        actions={
          <Button variant="secondary" onClick={() => void reload()}>
            Refresh
          </Button>
        }
      />
      <Tabs
        label="Deposit status"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'cleared', label: 'Cleared' },
          { value: 'rejected', label: 'Rejected' },
          { value: 'all', label: 'All' },
        ]}
      />
      {error && (
        <Alert tone="error" title="Could not load deposits">
          {error}
        </Alert>
      )}
      {!data && !error && <Loading />}
      {data && (
        <Table
          caption={`${data.length} deposit claim${data.length === 1 ? '' : 's'}`}
          head={['Customer', 'Reference', 'Asset', 'Amount', 'Status', 'Created', 'Cleared', '']}
          empty="No deposit claims in this view."
        >
          {data.map((d) => (
            <tr key={d.id}>
              <td>
                <a className={s.rowLink} href={`/ops/customers/${encodeURIComponent(d.entity.id)}`}>
                  {d.entity.legalName}
                </a>
                <div className={s.muted}>{d.entity.referenceCode}</div>
              </td>
              <td>
                <code className={s.code}>{d.reference}</code>
              </td>
              <td>{d.asset}</td>
              <td>
                <Money minor={d.amountMinor} asset={d.asset} />
              </td>
              <td>
                <StatusBadge status={d.status} />
                {d.rejectionReason && <div className={s.muted}>{d.rejectionReason}</div>}
              </td>
              <td className={s.nowrap}>{dateTime(d.createdAt)}</td>
              <td className={s.nowrap}>{d.clearedAt ? dateTime(d.clearedAt) : '—'}</td>
              <td>
                {d.status === 'pending' && (
                  <Button
                    variant="secondary"
                    onClick={() => simulate(d)}
                    aria-label={`Simulate credit of ${money(d.amountMinor, d.asset)} for ${d.reference}`}
                  >
                    Simulate credit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <BankSimulator prefill={prefill} onSent={afterSend} />
    </>
  );
}

'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { api, type RatePolicy } from '@/lib/api';
import { dateTime, humanize, money, parseMoney, parseRate, rate } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Loading,
  Money,
  PageHeader,
  Table,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { useHasRole } from '../_shared/hooks';
import s from '../_shared/ops.module.css';

type Editable = Omit<RatePolicy, 'updatedAt'>;
type FormState = Record<keyof Editable, string>;

function toForm(p: RatePolicy): FormState {
  return {
    standardBuyE4: rate(p.standardBuyE4),
    standardSellE4: rate(p.standardSellE4),
    childFloorE4: rate(p.childFloorE4),
    platformShareE4: rate(p.platformShareE4),
    quoteTtlSeconds: String(p.quoteTtlSeconds),
    dualApprovalUsdMinor: (p.dualApprovalUsdMinor / 100).toFixed(2),
  };
}

function parseField(key: keyof Editable, v: string): number | null {
  if (key === 'quoteTtlSeconds') {
    return /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : null;
  }
  if (key === 'dualApprovalUsdMinor') return parseMoney(v);
  return parseRate(v);
}

const FIELDS: Array<{
  key: keyof Editable;
  label: string;
  hint: string;
  mode: 'decimal' | 'numeric';
}> = [
  {
    key: 'standardBuyE4',
    label: 'Standard buy rate (TT$ per US$)',
    hint: 'Rate a customer pays to buy USD, 4 decimals.',
    mode: 'decimal',
  },
  {
    key: 'standardSellE4',
    label: 'Standard sell rate (TT$ per US$)',
    hint: 'Rate a customer receives selling USD, 4 decimals.',
    mode: 'decimal',
  },
  {
    key: 'childFloorE4',
    label: 'Child seller rate floor (TT$ per US$)',
    hint: 'Lowest rate a parent seller may set for a child.',
    mode: 'decimal',
  },
  {
    key: 'platformShareE4',
    label: 'Platform share (TT$ per US$)',
    hint: 'TransferHub revenue per US$1 traded, 4 decimals.',
    mode: 'decimal',
  },
  {
    key: 'quoteTtlSeconds',
    label: 'Quote validity (seconds)',
    hint: 'How long a quote can be accepted.',
    mode: 'numeric',
  },
  {
    key: 'dualApprovalUsdMinor',
    label: 'Dual-approval threshold (US$)',
    hint: 'Withdrawals at or above this US$ equivalent need two approvers.',
    mode: 'decimal',
  },
];

function PolicyForm({ policy, onSaved }: { policy: RatePolicy; onSaved: (p: RatePolicy) => void }) {
  const canEdit = useHasRole('treasury', 'admin');
  const [form, setForm] = useState<FormState>(() => toForm(policy));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Partial<Record<keyof FormState | 'reason', string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(toForm(policy)), [policy]);

  const changes: Partial<Editable> = {};
  for (const f of FIELDS) {
    const n = parseField(f.key, form[f.key]);
    if (n !== null && n !== policy[f.key]) changes[f.key] = n;
  }
  const changedCount = Object.keys(changes).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    for (const f of FIELDS) {
      if (parseField(f.key, form[f.key]) === null) {
        errs[f.key] =
          f.key === 'quoteTtlSeconds'
            ? 'Enter a whole number of seconds.'
            : f.key === 'dualApprovalUsdMinor'
              ? 'Enter a positive US$ amount.'
              : 'Enter a rate with up to 4 decimals.';
      }
    }
    if (!reason.trim()) errs.reason = 'A reason is required and is written to the audit log.';
    setErrors(errs);
    if (Object.keys(errs).length || changedCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.ops.updateRatePolicy({ ...changes, reason: reason.trim() });
      setReason('');
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Rate policy"
      footer={<span className={s.muted}>Last updated {dateTime(policy.updatedAt)}</span>}
    >
      {!canEdit && (
        <Alert tone="info">
          Read only. Only staff with the Treasury or Admin role can change the rate policy.
        </Alert>
      )}
      <form onSubmit={submit} noValidate>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className={s.formGrid}>
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
                {(id, d) => (
                  <Input
                    id={id}
                    aria-describedby={d}
                    aria-invalid={errors[f.key] ? true : undefined}
                    inputMode={f.mode}
                    value={form[f.key]}
                    onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          {canEdit && (
            <>
              <Field
                label="Reason for change (required)"
                hint="Recorded in the append-only audit log."
                error={errors.reason}
              >
                {(id, d) => (
                  <textarea
                    id={id}
                    aria-describedby={d}
                    aria-invalid={errors.reason ? true : undefined}
                    className={s.textarea}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={1000}
                  />
                )}
              </Field>
              {error && (
                <Alert tone="error" title="Rate policy not saved">
                  {error}
                </Alert>
              )}
              <div className={s.actions}>
                <Button type="submit" busy={busy} disabled={changedCount === 0}>
                  {changedCount === 0
                    ? 'No changes to save'
                    : `Save ${changedCount} rate policy change${changedCount === 1 ? '' : 's'}`}
                </Button>
                {changedCount > 0 && (
                  <Button type="button" variant="ghost" onClick={() => setForm(toForm(policy))}>
                    Discard changes
                  </Button>
                )}
              </div>
            </>
          )}
        </fieldset>
      </form>
    </Card>
  );
}

export default function OpsRatesPage() {
  const policy = useData(() => api.ops.ratePolicy(), []);
  const plans = useData(() => api.plans(), []);
  const indicative = useData(() => api.indicativeRates(), []);
  const [saved, setSaved] = useState<string | null>(null);

  const ex = indicative.data?.usdtExample;
  const diff = ex ? ex.usdtRateE4 - ex.usdRateE4 : 0;

  return (
    <>
      <PageHeader
        title="Rates and limits"
        description="FX pricing policy, plan rates and the USDT parity rule."
      />
      {saved && (
        <Alert tone="success" title="Rate policy saved">
          {saved}
        </Alert>
      )}
      {policy.error && (
        <Alert tone="error" title="Could not load the rate policy">
          {policy.error}
        </Alert>
      )}
      {!policy.data && !policy.error && <Loading />}
      {policy.data && (
        <div className={s.section}>
          <PolicyForm
            policy={policy.data}
            onSaved={(p) => {
              setSaved(`New policy in effect from ${dateTime(p.updatedAt)}.`);
              void policy.reload();
            }}
          />
        </div>
      )}

      <div className={s.section}>
        <Card title="Plans (read only)">
          {plans.error && (
            <Alert tone="error" title="Could not load plans">
              {plans.error}
            </Alert>
          )}
          {!plans.data && !plans.error && <Loading />}
          {plans.data && (
            <Table
              head={[
                'Plan',
                'Audience',
                'Monthly',
                'Annual',
                'USD rate',
                'Volume allowance',
                'Child limit',
                'Staff seats',
              ]}
              empty="No plans configured."
            >
              {plans.data.map((p) => (
                <tr key={p.code}>
                  <td>
                    {p.name}
                    <div>
                      <code className={s.code}>{p.code}</code>
                    </div>
                  </td>
                  <td>{humanize(p.audience)}</td>
                  <td>
                    <Money minor={p.monthlyMinor} asset="TTD" />
                  </td>
                  <td>
                    <Money minor={p.annualMinor} asset="TTD" />
                  </td>
                  <td className="num">{rate(p.usdRateE4)}</td>
                  <td>{money(p.volumeAllowanceUsdMinor, 'USD')}/month</td>
                  <td className="num">{p.childLimit}</td>
                  <td className="num">{p.staffSeats}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="USDT parity example (indicative)" tone="lavender">
        {indicative.error && (
          <Alert tone="error" title="Could not load indicative rates">
            {indicative.error}
          </Alert>
        )}
        {!indicative.data && !indicative.error && <Loading />}
        {ex && (
          <>
            <p>
              <strong className="num">
                USD {rate(ex.usdRateE4)} → USDT {rate(ex.usdtRateE4)}
              </strong>
              : {diff >= 0 ? '+' : '−'}TT${(Math.abs(diff) / 10000).toFixed(2)} per USDT, not{' '}
              {(Math.abs(diff) / 10000).toFixed(2)}%.
            </p>
            <Alert tone="warning">Not yet tradable; seller-side rule awaits decision D05.</Alert>
          </>
        )}
      </Card>
    </>
  );
}

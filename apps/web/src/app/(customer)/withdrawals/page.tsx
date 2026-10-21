'use client';

import { type FormEvent, useState } from 'react';
import { useData, useSession } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  Field,
  Grid,
  Input,
  Loading,
  Money,
  PageHeader,
  Select,
  StatusBadge,
  Table,
} from '@/components/ui';
import { api, type Asset, type Beneficiary, type EntitySummary, type Withdrawal } from '@/lib/api';
import { dateTime, money, parseMoney } from '@/lib/format';
import { CustomerOnly, messageFor, NOT_APPROVED_COPY, SANDBOX } from '../_lib/common';
import c from '../_lib/customer.module.css';

const ERRORS: Record<string, string> = {
  insufficient_available_funds:
    'You do not have enough available balance for this withdrawal. Pending deposits cannot be withdrawn until they clear.',
  not_approved: NOT_APPROVED_COPY,
  invalid_mfa_code: 'That code did not work. Enter the current 6-digit code and try again.',
  mfa_invalid: 'That code did not work. Enter the current 6-digit code and try again.',
};

const STATUS_UNKNOWN_COPY =
  'We are confirming the transaction status. Please do not submit it again.';

export default function WithdrawalsPage() {
  return <CustomerOnly title="Withdrawals">{(e) => <Withdrawals entity={e} />}</CustomerOnly>;
}

function Withdrawals({ entity }: { entity: EntitySummary }) {
  const approved = entity.onboardingStatus === 'approved';
  const beneficiaries = useData(
    () => (approved ? api.beneficiaries(entity.id) : Promise.resolve([] as Beneficiary[])),
    [entity.id, approved],
  );
  const withdrawals = useData(
    () => (approved ? api.withdrawals(entity.id) : Promise.resolve([] as Withdrawal[])),
    [entity.id, approved],
  );
  const balances = useData(() => api.balances(entity.id), [entity.id]);

  const anyUnknown = (withdrawals.data ?? []).some((w) => w.status === 'status_unknown');

  return (
    <>
      <PageHeader
        title="Withdrawals"
        description="Send money from your available balance to a saved beneficiary. Each request is authorised with a fresh two-step verification code and may need operations approval."
      />
      {!approved && (
        <Alert tone="warning" title="Verification required">
          {NOT_APPROVED_COPY} <a href="/settings">Go to Account & verification</a>
        </Alert>
      )}
      {anyUnknown && <Alert tone="warning">{STATUS_UNKNOWN_COPY}</Alert>}

      {approved && (
        <>
          <Grid min={320}>
            <RequestForm
              entity={entity}
              beneficiaries={beneficiaries.data ?? []}
              loading={beneficiaries.loading && !beneficiaries.data}
              available={balances.data ?? []}
              onDone={async () => {
                await Promise.all([withdrawals.reload(), balances.reload()]);
              }}
            />
            <BeneficiaryForm entity={entity} onAdded={beneficiaries.reload} />
          </Grid>

          <Card title="Saved beneficiaries">
            {beneficiaries.error && <Alert tone="error">{beneficiaries.error}</Alert>}
            {beneficiaries.loading && !beneficiaries.data ? (
              <Loading />
            ) : (
              <Table
                head={['Label', 'Bank', 'Account holder', 'Account', 'Currency', 'Verified']}
                empty="No beneficiaries yet. Add one to request a withdrawal."
              >
                {(beneficiaries.data ?? []).map((b) => (
                  <tr key={b.id}>
                    <td>{b.label}</td>
                    <td>{b.bankName}</td>
                    <td>{b.accountHolder}</td>
                    <td className="num">••••{b.accountLast4}</td>
                    <td>{b.currency}</td>
                    <td>
                      <StatusBadge
                        status={b.verified ? 'approved' : 'pending'}
                        label={b.verified ? 'Verified' : 'Not yet verified'}
                      />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Your withdrawals">
            {withdrawals.error && <Alert tone="error">{withdrawals.error}</Alert>}
            {withdrawals.loading && !withdrawals.data ? (
              <Loading />
            ) : (
              <Table
                head={['Requested', 'Reference', 'To', 'Amount', 'Status', 'Approvals', 'Notes']}
                empty="No withdrawals yet."
              >
                {(withdrawals.data ?? []).map((w) => (
                  <tr key={w.id}>
                    <td>{dateTime(w.createdAt)}</td>
                    <td className={c.mono}>{w.reference}</td>
                    <td>
                      {w.beneficiary.label}
                      <div className={c.small}>
                        {w.beneficiary.bankName} ••••{w.beneficiary.accountLast4}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Money minor={w.amountMinor} asset={w.asset} />
                    </td>
                    <td>
                      <StatusBadge
                        status={w.status}
                        label={w.status === 'status_unknown' ? 'Confirming status' : undefined}
                      />
                    </td>
                    <td className="num">
                      {w.approvals}/{w.requiredApprovals}
                    </td>
                    <td className={c.small}>
                      {w.failureReason}
                      {w.status === 'status_unknown' && STATUS_UNKNOWN_COPY}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function RequestForm({
  entity,
  beneficiaries,
  loading,
  available,
  onDone,
}: {
  entity: EntitySummary;
  beneficiaries: Beneficiary[];
  loading: boolean;
  available: Array<{ asset: Asset; availableMinor: number }>;
  onDone: () => Promise<void>;
}) {
  const { me } = useSession();
  const [beneficiaryId, setBeneficiaryId] = useState('');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Withdrawal | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeHint, setCodeHint] = useState<string | null>(null);

  const beneficiary = beneficiaries.find((b) => b.id === beneficiaryId) ?? null;
  // The asset must match the beneficiary's currency, so it is derived rather than chosen freely.
  const asset: Asset = beneficiary?.currency ?? 'TTD';
  const avail = available.find((b) => b.asset === asset);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const minor = parseMoney(amount);
    if (!beneficiary) next.beneficiary = 'Choose a beneficiary.';
    if (minor === null) next.amount = 'Enter an amount greater than zero with up to 2 decimals.';
    else if (avail && minor > avail.availableMinor)
      next.amount = `This is more than your available ${money(avail.availableMinor, asset)}.`;
    const cleanCode = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(cleanCode)) next.code = 'Enter the 6-digit code.';
    setErrors(next);
    if (Object.keys(next).length > 0 || !beneficiary || minor === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const w = await api.requestWithdrawal(entity.id, {
        beneficiaryId: beneficiary.id,
        asset,
        amountMinor: minor,
        mfaCode: cleanCode,
      });
      setDone(w);
      setAmount('');
      setCode('');
      setCodeHint(null);
      await onDone();
    } catch (err) {
      setError(messageFor(err, ERRORS));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function fillSandbox() {
    try {
      const r = await api.sandboxMfaCode(me.user.email);
      setCode(r.code);
      setCodeHint(`Sandbox code filled, valid ${r.secondsRemaining}s more.`);
    } catch {
      setCodeHint('No sandbox code available for this account.');
    }
  }

  return (
    <Card title="Request a withdrawal">
      {done && (
        <Alert tone="success">
          Withdrawal requested. Track its progress using reference{' '}
          <strong className={c.mono}>{done.reference}</strong>.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {loading ? (
        <Loading />
      ) : beneficiaries.length === 0 ? (
        <p>Add a beneficiary first. You can then withdraw to it.</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Beneficiary" error={errors.beneficiary}>
            {(id, describedBy) => (
              <Select
                id={id}
                value={beneficiaryId}
                aria-describedby={describedBy}
                onChange={(e) => setBeneficiaryId(e.target.value)}
              >
                <option value="">Choose a beneficiary</option>
                {beneficiaries.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} · {b.bankName} ••••{b.accountLast4} ({b.currency})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Currency"
            hint="Withdrawals are paid in the beneficiary account's currency."
          >
            {(id, describedBy) => (
              <Select id={id} value={asset} aria-describedby={describedBy} disabled>
                <option value={asset}>{asset}</option>
              </Select>
            )}
          </Field>
          <Field
            label={`Amount (${asset})`}
            error={errors.amount}
            hint={avail ? `Available: ${money(avail.availableMinor, asset)}` : undefined}
          >
            {(id, describedBy) => (
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                aria-describedby={describedBy}
                aria-invalid={errors.amount ? true : undefined}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Verification code"
            error={errors.code}
            hint={codeHint ?? 'Enter the 6-digit code from your authenticator app to authorise.'}
          >
            {(id, describedBy) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                aria-describedby={describedBy}
                aria-invalid={errors.code ? true : undefined}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <div className={c.row}>
            <Button type="submit" busy={busy}>
              Request withdrawal
            </Button>
            {SANDBOX && (
              <Button type="button" variant="ghost" onClick={() => void fillSandbox()}>
                Fill sandbox code
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function BeneficiaryForm({
  entity,
  onAdded,
}: {
  entity: EntitySummary;
  onAdded: () => Promise<void>;
}) {
  const empty = { label: '', bankName: '', accountHolder: '', accountNumber: '' };
  const [form, setForm] = useState(empty);
  const [currency, setCurrency] = useState<Asset>('TTD');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Beneficiary | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.label.trim()) next.label = 'Enter a label.';
    if (!form.bankName.trim()) next.bankName = 'Enter the bank name.';
    if (!form.accountHolder.trim()) next.accountHolder = 'Enter the account holder name.';
    const acct = form.accountNumber.replace(/[\s-]/g, '');
    if (!/^\d{4,20}$/.test(acct)) next.accountNumber = 'Enter 4 to 20 digits.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const b = await api.addBeneficiary(entity.id, {
        label: form.label.trim(),
        bankName: form.bankName.trim(),
        accountHolder: form.accountHolder.trim(),
        accountNumber: acct,
        currency,
      });
      setAdded(b);
      setForm(empty);
      await onAdded();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (
    k: keyof typeof empty,
    label: string,
    extra: { hint?: string; inputMode?: 'numeric'; autoComplete?: string } = {},
  ) => (
    <Field label={label} error={errors[k]} hint={extra.hint}>
      {(id, describedBy) => (
        <Input
          id={id}
          value={form[k]}
          onChange={set(k)}
          aria-describedby={describedBy}
          aria-invalid={errors[k] ? true : undefined}
          inputMode={extra.inputMode}
          autoComplete={extra.autoComplete ?? 'off'}
        />
      )}
    </Field>
  );

  return (
    <Card title="Add a beneficiary" tone="lavender">
      {added && (
        <Alert tone="success">
          {added.label} (••••{added.accountLast4}) saved.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={submit} noValidate>
        {text('label', 'Label', { hint: 'A name you will recognise, e.g. "My RBC TTD account".' })}
        {text('bankName', 'Bank name')}
        {text('accountHolder', 'Account holder', { autoComplete: 'name' })}
        {text('accountNumber', 'Account number', {
          inputMode: 'numeric',
          hint: 'Only the last 4 digits are kept and shown, so you can recognise the account.',
        })}
        <Field label="Currency">
          {(id) => (
            <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value as Asset)}>
              <option value="TTD">TTD</option>
              <option value="USD">USD</option>
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary" busy={busy}>
          Save beneficiary
        </Button>
      </form>
    </Card>
  );
}

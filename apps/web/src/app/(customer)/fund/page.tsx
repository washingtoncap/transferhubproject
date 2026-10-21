'use client';

import { type FormEvent, useState } from 'react';
import { useData } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
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
import { api, type Asset, type DepositClaim, type EntitySummary } from '@/lib/api';
import { dateTime, money, parseMoney } from '@/lib/format';
import { CustomerOnly, messageFor, NOT_APPROVED_COPY, SANDBOX } from '../_lib/common';
import c from '../_lib/customer.module.css';

export default function FundPage() {
  return <CustomerOnly title="Fund your account">{(e) => <Fund entity={e} />}</CustomerOnly>;
}

function Fund({ entity }: { entity: EntitySummary }) {
  const approved = entity.onboardingStatus === 'approved';
  const deposits = useData(
    () => (approved ? api.deposits(entity.id) : Promise.resolve([] as DepositClaim[])),
    [entity.id, approved],
  );
  const [asset, setAsset] = useState<Asset>('TTD');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<DepositClaim | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const minor = parseMoney(amount);
    if (minor === null) {
      setAmountError('Enter an amount greater than zero with up to 2 decimal places.');
      return;
    }
    setAmountError(null);
    setError(null);
    setBusy(true);
    try {
      const claim = await api.createDeposit(entity.id, {
        asset,
        amountMinor: minor,
        receiptNote: note.trim() || undefined,
      });
      setCreated(claim);
      setAmount('');
      setNote('');
      await deposits.reload();
    } catch (err) {
      setError(messageFor(err, { not_approved: NOT_APPROVED_COPY }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Fund your account"
        description="Tell us about a bank transfer you are making to our partner bank. Your funds become available only after the partner confirms they have cleared."
      />

      {!approved && (
        <Alert tone="warning" title="Verification required">
          {NOT_APPROVED_COPY} <a href="/settings">Go to Account & verification</a>
        </Alert>
      )}

      {created && (
        <div className={c.instructions} aria-live="polite">
          <Alert tone="success">
            Receipt received. Funds are pending verification and clearance.
          </Alert>
          <h2 style={{ fontSize: 20 }}>Transfer instructions</h2>
          <p>
            Send exactly <strong>{money(created.amountMinor, created.asset)}</strong> to the partner
            account below and quote the reference so we can match your transfer.
          </p>
          <DefinitionList
            items={[
              ['Bank', created.instructions.bankName],
              ['Account name', created.instructions.accountName],
              [
                'Account number',
                <span key="n" className={c.mono}>
                  {created.instructions.accountNumber}
                </span>,
              ],
              [
                'Reference to quote',
                <span key="r" className={c.reference}>
                  {created.instructions.reference}
                </span>,
              ],
            ]}
          />
          <p className={c.small} style={{ marginTop: 12 }}>
            Without this reference your transfer may take longer to match.
          </p>
        </div>
      )}

      <Grid min={300}>
        <Card title="Record a deposit">
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={submit} noValidate>
            <Field label="Currency">
              {(id) => (
                <Select
                  id={id}
                  value={asset}
                  onChange={(e) => setAsset(e.target.value as Asset)}
                  disabled={!approved}
                >
                  <option value="TTD">TTD — Trinidad and Tobago dollars</option>
                  <option value="USD">USD — US dollars</option>
                </Select>
              )}
            </Field>
            <Field
              label={`Amount (${asset})`}
              error={amountError}
              hint="The amount you are sending, for example 2500.00"
            >
              {(id, describedBy) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  aria-describedby={describedBy}
                  aria-invalid={amountError ? true : undefined}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={!approved}
                  required
                />
              )}
            </Field>
            <Field
              label="Receipt note (optional)"
              hint="For example, your bank's transfer confirmation number."
            >
              {(id, describedBy) => (
                <Input
                  id={id}
                  value={note}
                  maxLength={200}
                  aria-describedby={describedBy}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={!approved}
                />
              )}
            </Field>
            <Button type="submit" busy={busy} disabled={!approved || !amount}>
              Get transfer instructions
            </Button>
          </form>
        </Card>

        <Card title="How funding works" tone="lavender">
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>Record the deposit here to get the partner bank details and your reference.</li>
            <li>Make the transfer from your own bank, quoting the reference.</li>
            <li>
              The partner confirms the money has cleared. Only then does it move from pending to
              available.
            </li>
          </ol>
          <p>
            A receipt or screenshot never makes funds spendable. Only partner clearance does.
            Pending deposits are shown separately from your available balance.
          </p>
          {SANDBOX && (
            <p className={c.small}>
              In this sandbox, an operations user simulates the bank credit.
            </p>
          )}
        </Card>
      </Grid>

      {approved && (
        <Card title="Your deposits">
          {deposits.error && <Alert tone="error">{deposits.error}</Alert>}
          {deposits.loading && !deposits.data ? (
            <Loading />
          ) : (
            <Table
              head={['Recorded', 'Reference', 'Amount', 'Status', 'Details']}
              empty="No deposits recorded yet."
            >
              {(deposits.data ?? []).map((d) => (
                <tr key={d.id}>
                  <td>{dateTime(d.createdAt)}</td>
                  <td className={c.mono}>{d.reference}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Money minor={d.amountMinor} asset={d.asset} />
                  </td>
                  <td>
                    <StatusBadge
                      status={d.status}
                      label={d.status === 'pending' ? 'Pending clearance' : undefined}
                    />
                  </td>
                  <td className={c.small}>
                    {d.status === 'cleared' && d.clearedAt && `Cleared ${dateTime(d.clearedAt)}`}
                    {d.status === 'rejected' && (d.rejectionReason ?? 'Not matched')}
                    {d.status === 'pending' && 'Not yet available to spend'}
                    {d.receiptNote && <div>Note: {d.receiptNote}</div>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

'use client';

import { useParams } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, type OpsCustomerDetail } from '@/lib/api';
import { date, dateTime, humanize, money } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Field,
  Grid,
  Loading,
  Money,
  PageHeader,
  Select,
  StatusBadge,
  Table,
} from '@/components/ui';
import { errorMessage, useData } from '@/components/session';
import { AuditTable, ScreeningBadge } from '../../_shared/components';
import { useHasRole } from '../../_shared/hooks';
import s from '../../_shared/ops.module.css';

type Decision = 'approve' | 'needs_information' | 'reject' | 'restrict';
type Risk = 'low' | 'medium' | 'high';

const DECISION_LABEL: Record<Decision, string> = {
  approve: 'Approve customer',
  needs_information: 'Request information',
  reject: 'Reject application',
  restrict: 'Restrict account',
};

const DECIDABLE = ['submitted', 'vendor_checks', 'compliance_review', 'needs_information'];

function DecisionPanel({
  customer,
  onDecided,
}: {
  customer: OpsCustomerDetail;
  onDecided: (c: OpsCustomerDetail, decision: Decision) => void;
}) {
  const canDecide = useHasRole('compliance', 'admin');
  const [decision, setDecision] = useState<Decision>('approve');
  const [risk, setRisk] = useState<Risk | ''>(customer.riskRating ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ risk?: string; reason?: string }>({});

  if (!canDecide) {
    return (
      <Card title="Decision">
        <Alert tone="info" title="Compliance decision required">
          Only staff with the Compliance or Admin role can approve, reject, restrict or request
          information on a customer. You can review the application and add context via your team
          channel.
        </Alert>
      </Card>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: { risk?: string; reason?: string } = {};
    if (decision === 'approve' && !risk) errs.risk = 'Choose a risk rating before approving.';
    if (!reason.trim()) errs.reason = 'Give a reason. It is recorded in the audit log.';
    setFieldErrors(errs);
    if (errs.risk || errs.reason) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.ops.decide(customer.id, {
        decision,
        reason: reason.trim(),
        ...(risk ? { riskRating: risk } : {}),
      });
      setReason('');
      onDecided(updated, decision);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const terminal = !DECIDABLE.includes(customer.onboardingStatus);

  return (
    <Card title="Decision">
      <p className={s.muted}>
        PEP status or a possible match alone is not an automatic rejection. Review the evidence and
        record your reasoning.
      </p>
      {terminal && (
        <Alert tone="info">
          This customer is currently <strong>{humanize(customer.onboardingStatus)}</strong>. A new
          decision will change that status.
        </Alert>
      )}
      <form onSubmit={submit} noValidate>
        <div className={s.formGrid}>
          <Field label="Decision">
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={decision}
                onChange={(e) => setDecision(e.target.value as Decision)}
              >
                <option value="approve">Approve</option>
                <option value="needs_information">Request more information</option>
                <option value="reject">Reject</option>
                <option value="restrict">Restrict</option>
              </Select>
            )}
          </Field>
          <Field
            label={decision === 'approve' ? 'Risk rating (required)' : 'Risk rating (optional)'}
            error={fieldErrors.risk}
          >
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                aria-invalid={fieldErrors.risk ? true : undefined}
                value={risk}
                onChange={(e) => setRisk(e.target.value as Risk | '')}
              >
                <option value="">Select…</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
        </div>
        <Field
          label="Reason (required)"
          hint="Visible in the audit log. For a request, say exactly what the customer must provide."
          error={fieldErrors.reason}
        >
          {(id, d) => (
            <textarea
              id={id}
              aria-describedby={d}
              aria-invalid={fieldErrors.reason ? true : undefined}
              className={s.textarea}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
            />
          )}
        </Field>
        {error && (
          <Alert tone="error" title="Decision not recorded">
            {error}
          </Alert>
        )}
        <Button type="submit" variant={decision === 'approve' ? 'primary' : 'danger'} busy={busy}>
          {DECISION_LABEL[decision]}
        </Button>
      </form>
    </Card>
  );
}

export default function OpsCustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data, error, reload } = useData(() => api.ops.customer(id), [id]);
  const [result, setResult] = useState<string | null>(null);

  if (error && !data) {
    return (
      <>
        <a className={s.backLink} href="/ops/customers">
          ← Back to customers
        </a>
        <Alert tone="error" title="Could not load this customer">
          {error}
        </Alert>
      </>
    );
  }
  if (!data) return <Loading />;

  const p = data.profile;
  const isBusiness = data.kind === 'business';

  const entityItems: Array<[string, ReactNode]> = [
    ['Legal name', data.legalName],
    [
      'Reference code',
      <span key="r" className={s.code}>
        {data.referenceCode}
      </span>,
    ],
    ['Kind', humanize(data.kind)],
    ['Role', humanize(data.customerRole)],
    ['Status', <StatusBadge key="s" status={data.onboardingStatus} />],
    ['Screening', <ScreeningBadge key="sc" result={data.screeningResult} />],
    ['Risk rating', data.riskRating ? humanize(data.riskRating) : 'Not rated'],
    ['Plan', data.planCode ?? 'None'],
    ['Created', dateTime(data.createdAt)],
    ['Submitted', data.submittedAt ? dateTime(data.submittedAt) : 'Not submitted'],
    ['Last review reason', data.reviewReason ?? '—'],
  ];

  const profileItems: Array<[string, ReactNode]> = [['Address', p.address ?? '—']];
  if (isBusiness) {
    profileItems.push(
      ['Registration number', p.registrationNumber ?? '—'],
      ['Business activity', p.businessActivity ?? '—'],
    );
  } else {
    profileItems.push(
      ['Date of birth', p.dateOfBirth ? date(p.dateOfBirth) : '—'],
      ['Occupation', p.occupation ?? '—'],
    );
  }
  profileItems.push(
    ['Purpose of account', p.purpose ?? '—'],
    [
      'Expected monthly volume',
      p.expectedMonthlyUsd !== undefined
        ? money(Math.round(p.expectedMonthlyUsd * 100), 'USD')
        : '—',
    ],
    ['Source of funds', p.sourceOfFunds ?? '—'],
  );

  const owners = p.beneficialOwners ?? [];

  return (
    <>
      <a className={s.backLink} href="/ops/customers">
        ← Back to customers
      </a>
      <PageHeader
        title={data.legalName}
        description={
          <>
            {humanize(data.kind)} {data.customerRole} ·{' '}
            <StatusBadge status={data.onboardingStatus} />
          </>
        }
        actions={
          <Button variant="secondary" onClick={() => void reload()}>
            Refresh
          </Button>
        }
      />
      {result && (
        <Alert tone="success" title="Decision recorded">
          {result}
        </Alert>
      )}
      {error && (
        <Alert tone="error" title="Refresh failed">
          {error}
        </Alert>
      )}
      {data.screeningResult === 'possible_match' && (
        <Alert tone="warning" title="Screening returned a possible match">
          Review the vendor result before deciding. A possible match is not, on its own, a reason to
          reject.
        </Alert>
      )}

      <Grid min={320}>
        <Card title="Entity">
          <DefinitionList items={entityItems} />
        </Card>
        <Card title={isBusiness ? 'Business profile (KYB)' : 'Personal profile (KYC)'}>
          <DefinitionList items={profileItems} />
        </Card>
      </Grid>

      {isBusiness && (
        <div className={s.section}>
          <Card title="Beneficial owners">
            <p className={s.muted}>Owners holding 25% or more must be individually verified.</p>
            <Table
              head={['Name', 'Ownership', 'Verification threshold']}
              empty="No beneficial owners declared."
            >
              {owners.map((o, i) => (
                <tr key={`${o.name}-${i}`}>
                  <td>{o.name}</td>
                  <td className="num">{o.ownershipPercent}%</td>
                  <td>
                    {o.ownershipPercent >= 25 ? (
                      <StatusBadge status="needs_information" label="≥ 25%: verify individually" />
                    ) : (
                      <StatusBadge status="draft" label="Below 25%" />
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {owners.length > 0 && (
              <p className={s.muted}>
                Declared total:{' '}
                <span className="num">
                  {owners.reduce((sum, o) => sum + o.ownershipPercent, 0)}%
                </span>
              </p>
            )}
          </Card>
        </div>
      )}

      <Grid min={320}>
        <Card title="Members">
          <Table head={['Name', 'Email', 'Role']} empty="No members.">
            {data.members.map((m) => (
              <tr key={m.email}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{humanize(m.role)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Balances">
          <Table
            head={['Asset', 'Ledger', 'Held', 'Available', 'Pending deposits']}
            empty="No balances."
          >
            {data.balances.map((b) => (
              <tr key={b.asset}>
                <td>{b.asset}</td>
                <td>
                  <Money minor={b.ledgerMinor} asset={b.asset} />
                </td>
                <td>
                  <Money minor={b.heldMinor} asset={b.asset} />
                </td>
                <td>
                  <Money minor={b.availableMinor} asset={b.asset} />
                </td>
                <td>
                  <Money minor={b.pendingDepositsMinor} asset={b.asset} />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </Grid>

      <div className={s.section}>
        <DecisionPanel
          customer={data}
          onDecided={(c, d) => {
            setResult(
              `${DECISION_LABEL[d]}: ${c.legalName} is now ${humanize(c.onboardingStatus).toLowerCase()}.`,
            );
            void reload();
          }}
        />
      </div>

      <Card title="Audit trail">
        <AuditTable entries={data.audit} />
      </Card>
    </>
  );
}

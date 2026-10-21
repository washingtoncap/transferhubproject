'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useData, useSession } from '@/components/session';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Field,
  Grid,
  Input,
  Loading,
  PageHeader,
  StatusBadge,
} from '@/components/ui';
import { api, type EntityDetail, type EntitySummary, type Profile } from '@/lib/api';
import { date, humanize } from '@/lib/format';
import { CustomerOnly, messageFor, RESTRICTED_COPY } from '../_lib/common';
import c from '../_lib/customer.module.css';

export default function SettingsPage() {
  return (
    <CustomerOnly title="Account & verification">{(e) => <Settings entity={e} />}</CustomerOnly>
  );
}

const REVIEWING = new Set(['submitted', 'vendor_checks', 'compliance_review']);

function Settings({ entity }: { entity: EntitySummary }) {
  const { me, role, refresh } = useSession();
  const detail = useData(() => api.entity(entity.id), [entity.id]);
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Account & verification"
        description="Your account details and the information we need to verify you."
      />
      {detail.error && <Alert tone="error">{detail.error}</Alert>}
      {!d ? (
        detail.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <StatusMessage detail={d} />
          <Grid min={300}>
            <Card title="Account">
              <DefinitionList
                items={[
                  ['Legal name', d.legalName],
                  ['Account type', humanize(d.kind)],
                  ['Role', humanize(d.customerRole)],
                  [
                    'Reference code',
                    <span key="r" className={c.mono}>
                      {d.referenceCode}
                    </span>,
                  ],
                  ['Verification', <StatusBadge key="s" status={d.onboardingStatus} />],
                  ['Risk rating', d.riskRating ? humanize(d.riskRating) : 'Not yet rated'],
                  ['Opened', date(d.createdAt)],
                  ...(d.approvedAt
                    ? ([['Verified', date(d.approvedAt)]] as Array<[string, string]>)
                    : []),
                ]}
              />
            </Card>
            <Card title="Members">
              <DefinitionList
                items={[
                  ['Name', me.user.fullName],
                  ['Email', me.user.email],
                  ['Your role', role ? humanize(role) : '—'],
                  [
                    'Two-step verification',
                    <StatusBadge
                      key="m"
                      status={me.user.mfaEnabled ? 'active' : 'pending'}
                      label={me.user.mfaEnabled ? 'Enabled' : 'Not set up'}
                    />,
                  ],
                ]}
              />
              <p className={c.small} style={{ marginTop: 12 }}>
                Inviting additional staff members is not available in this release.
              </p>
            </Card>
          </Grid>
          <ProfileForm
            detail={d}
            onSaved={async () => {
              await detail.reload();
            }}
            onSubmitted={async () => {
              await refresh();
              await detail.reload();
            }}
          />
        </>
      )}
    </>
  );
}

function StatusMessage({ detail: d }: { detail: EntityDetail }) {
  const st = d.onboardingStatus;
  if (st === 'approved') return <Alert tone="success">Your account is verified.</Alert>;
  if (st === 'draft')
    return (
      <Alert tone="info" title="Complete your profile">
        Fill in the details below, save them, then submit for verification.
      </Alert>
    );
  if (st === 'needs_information')
    return (
      <Alert tone="warning" title="We need more information">
        {d.reviewReason ?? 'Please review and update your profile, then submit it again.'}
      </Alert>
    );
  if (REVIEWING.has(st))
    return (
      <Alert tone="info" title="Under review">
        Thank you. Your details are being reviewed. You cannot edit them during the review.
      </Alert>
    );
  return <Alert tone="warning">{RESTRICTED_COPY}</Alert>;
}

interface FormState {
  address: string;
  dateOfBirth: string;
  occupation: string;
  registrationNumber: string;
  businessActivity: string;
  owners: Array<{ name: string; percent: string }>;
  purpose: string;
  expectedMonthlyUsd: string;
  sourceOfFunds: string;
}

function toForm(p: Profile): FormState {
  return {
    address: p.address ?? '',
    dateOfBirth: p.dateOfBirth ?? '',
    occupation: p.occupation ?? '',
    registrationNumber: p.registrationNumber ?? '',
    businessActivity: p.businessActivity ?? '',
    owners: (p.beneficialOwners ?? []).map((o) => ({
      name: o.name,
      percent: String(o.ownershipPercent),
    })),
    purpose: p.purpose ?? '',
    expectedMonthlyUsd: p.expectedMonthlyUsd !== undefined ? String(p.expectedMonthlyUsd) : '',
    sourceOfFunds: p.sourceOfFunds ?? '',
  };
}

function ProfileForm({
  detail: d,
  onSaved,
  onSubmitted,
}: {
  detail: EntityDetail;
  onSaved: () => Promise<void>;
  onSubmitted: () => Promise<void>;
}) {
  const editable = d.onboardingStatus === 'draft' || d.onboardingStatus === 'needs_information';
  const business = d.kind === 'business';
  const [f, setF] = useState<FormState>(() => toForm(d.profile));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);

  useEffect(() => {
    if (!dirty) setF(toForm(d.profile));
  }, [d.profile, dirty]);

  const set = (k: Exclude<keyof FormState, 'owners'>) => (e: { target: { value: string } }) => {
    setDirty(true);
    setF((s) => ({ ...s, [k]: e.target.value }));
  };

  function validate(): Profile | null {
    const e: Record<string, string> = {};
    const req = (k: keyof FormState, label: string) => {
      if (typeof f[k] === 'string' && !(f[k] as string).trim()) e[k] = `Enter ${label}.`;
    };
    req('address', 'your address');
    req('purpose', 'the purpose of your account');
    req('sourceOfFunds', 'your source of funds');
    const usd = Number(f.expectedMonthlyUsd.replace(/[,\s]/g, ''));
    if (!f.expectedMonthlyUsd.trim() || !Number.isFinite(usd) || usd < 0 || !Number.isInteger(usd))
      e.expectedMonthlyUsd = 'Enter a whole number of US dollars, e.g. 5000.';
    if (business) {
      req('registrationNumber', 'the company registration number');
      req('businessActivity', 'the business activity');
      f.owners.forEach((o, i) => {
        if (!o.name.trim()) e[`owner-name-${i}`] = 'Enter a name.';
        const p = Number(o.percent);
        if (!o.percent.trim() || !Number.isFinite(p) || p <= 0 || p > 100)
          e[`owner-pct-${i}`] = 'Enter 1–100.';
      });
      const total = f.owners.reduce((s, o) => s + (Number(o.percent) || 0), 0);
      if (total > 100) e.owners = 'Ownership percentages add up to more than 100%.';
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dateOfBirth)) e.dateOfBirth = 'Enter your date of birth.';
      req('occupation', 'your occupation');
    }
    setErrors(e);
    if (Object.keys(e).length > 0) return null;
    const base: Profile = {
      address: f.address.trim(),
      purpose: f.purpose.trim(),
      expectedMonthlyUsd: usd,
      sourceOfFunds: f.sourceOfFunds.trim(),
    };
    return business
      ? {
          ...base,
          registrationNumber: f.registrationNumber.trim(),
          businessActivity: f.businessActivity.trim(),
          beneficialOwners: f.owners.map((o) => ({
            name: o.name.trim(),
            ownershipPercent: Number(o.percent),
          })),
        }
      : { ...base, dateOfBirth: f.dateOfBirth, occupation: f.occupation.trim() };
  }

  async function save(e?: FormEvent): Promise<boolean> {
    e?.preventDefault();
    const profile = validate();
    if (!profile) {
      setError('Please fix the highlighted fields.');
      return false;
    }
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await api.updateProfile(d.id, profile);
      setDirty(false);
      setNotice('Profile saved.');
      await onSaved();
      return true;
    } catch (err) {
      setError(messageFor(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (dirty && !(await save())) return;
    if (!dirty && !validate()) {
      setError('Please complete the highlighted fields before submitting.');
      return;
    }
    setBusy('submit');
    setError(null);
    setNotice(null);
    try {
      await api.submitOnboarding(d.id);
      setNotice('Submitted for verification. We will let you know when the review is complete.');
      await onSubmitted();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(null);
    }
  }

  const text = (
    k: Exclude<keyof FormState, 'owners'>,
    label: string,
    opts: { type?: string; hint?: string; inputMode?: 'numeric'; autoComplete?: string } = {},
  ) => (
    <Field label={label} error={errors[k]} hint={opts.hint}>
      {(id, describedBy) => (
        <Input
          id={id}
          type={opts.type ?? 'text'}
          value={f[k]}
          onChange={set(k)}
          disabled={!editable}
          inputMode={opts.inputMode}
          autoComplete={opts.autoComplete}
          aria-describedby={describedBy}
          aria-invalid={errors[k] ? true : undefined}
        />
      )}
    </Field>
  );

  const ownerTotal = f.owners.reduce((s, o) => s + (Number(o.percent) || 0), 0);

  return (
    <Card title={business ? 'Business profile' : 'Personal profile'}>
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {!editable && (
        <p className={c.small} style={{ marginTop: 0, marginBottom: 16 }}>
          Your profile can be edited only before you submit it, or when we ask for more information.
        </p>
      )}
      <form onSubmit={(e) => void save(e)} noValidate>
        <Grid min={260}>
          <div>
            {text('address', business ? 'Registered address' : 'Home address', {
              autoComplete: 'street-address',
            })}
            {business ? (
              <>
                {text('registrationNumber', 'Company registration number')}
                {text('businessActivity', 'Business activity', {
                  hint: 'What the business does, e.g. "Import of auto parts".',
                })}
              </>
            ) : (
              <>
                {text('dateOfBirth', 'Date of birth', { type: 'date', autoComplete: 'bday' })}
                {text('occupation', 'Occupation', { autoComplete: 'organization-title' })}
              </>
            )}
          </div>
          <div>
            {text('purpose', 'Purpose of the account', {
              hint: 'For example, paying overseas suppliers or receiving remittances.',
            })}
            {text('expectedMonthlyUsd', 'Expected monthly volume (USD)', {
              inputMode: 'numeric',
              hint: 'An estimate in whole US dollars.',
            })}
            {text('sourceOfFunds', 'Source of funds', {
              hint: 'For example, business revenue, salary or savings.',
            })}
          </div>
        </Grid>

        {business && (
          <fieldset className={c.fieldset}>
            <legend>Beneficial owners</legend>
            <p className={c.small} style={{ marginBottom: 8 }}>
              List every person who owns or controls 25% or more of the business.
            </p>
            {errors.owners && <p className={c.inlineError}>{errors.owners}</p>}
            <div className={c.owners}>
              {f.owners.map((o, i) => (
                <div key={i} className={c.ownerRow}>
                  <Field label={`Owner ${i + 1} name`} error={errors[`owner-name-${i}`]}>
                    {(id, describedBy) => (
                      <Input
                        id={id}
                        value={o.name}
                        disabled={!editable}
                        aria-describedby={describedBy}
                        onChange={(e) => {
                          setDirty(true);
                          setF((s) => ({
                            ...s,
                            owners: s.owners.map((x, j) =>
                              j === i ? { ...x, name: e.target.value } : x,
                            ),
                          }));
                        }}
                      />
                    )}
                  </Field>
                  <Field label="Ownership %" error={errors[`owner-pct-${i}`]}>
                    {(id, describedBy) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={o.percent}
                        disabled={!editable}
                        aria-describedby={describedBy}
                        onChange={(e) => {
                          setDirty(true);
                          setF((s) => ({
                            ...s,
                            owners: s.owners.map((x, j) =>
                              j === i ? { ...x, percent: e.target.value } : x,
                            ),
                          }));
                        }}
                      />
                    )}
                  </Field>
                  {editable && (
                    <div className={c.ownerAction}>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setDirty(true);
                          setF((s) => ({ ...s, owners: s.owners.filter((_, j) => j !== i) }));
                        }}
                      >
                        Remove<span className="visually-hidden"> owner {i + 1}</span>
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {f.owners.length > 0 && <p className={c.small}>Total listed: {ownerTotal}%</p>}
            {editable && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDirty(true);
                  setF((s) => ({ ...s, owners: [...s.owners, { name: '', percent: '' }] }));
                }}
              >
                Add owner
              </Button>
            )}
          </fieldset>
        )}

        {editable && (
          <div className={c.row} style={{ marginTop: 16 }}>
            <Button
              type="submit"
              variant="secondary"
              busy={busy === 'save'}
              disabled={busy !== null}
            >
              Save profile
            </Button>
            <Button
              type="button"
              busy={busy === 'submit'}
              disabled={busy !== null}
              onClick={() => void submit()}
            >
              Submit for verification
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

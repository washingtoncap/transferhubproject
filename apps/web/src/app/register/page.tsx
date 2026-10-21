'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { Brand } from '@/components/shell';
import { api, ApiError, type CustomerRole, type EntityKind } from '@/lib/api';
import styles from '../login/login.module.css';
import r from './register.module.css';

const SANDBOX = (process.env.NEXT_PUBLIC_APP_ENV ?? 'local') !== 'production';

function groupBy4(text: string): string {
  return (text.match(/.{1,4}/g) ?? []).join(' ');
}

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  kind: EntityKind;
  customerRole: CustomerRole;
  legalName: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<'details' | 'mfa'>('details');
  const [f, setF] = useState<FormState>({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    kind: 'individual',
    customerRole: 'buyer',
    legalName: '',
  });
  const [legalTouched, setLegalTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  // Individuals: the legal name follows the full name until the user edits it.
  const legalName = f.kind === 'individual' && !legalTouched ? f.fullName : f.legalName;

  useEffect(() => {
    if (step === 'mfa') document.getElementById('mfa-code')?.focus();
  }, [step]);

  const set = (k: keyof FormState) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  async function submitDetails(e: FormEvent) {
    e.preventDefault();
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!f.fullName.trim()) next.fullName = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()))
      next.email = 'Enter a valid email address.';
    if (f.phone.replace(/\D/g, '').length < 7)
      next.phone = 'Enter a phone number we can reach you on.';
    if (f.password.length < 10) next.password = 'Use at least 10 characters.';
    if (!legalName.trim())
      next.legalName =
        f.kind === 'business' ? 'Enter the registered business name.' : 'Enter your legal name.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.register({
        email: f.email.trim().toLowerCase(),
        password: f.password,
        fullName: f.fullName.trim(),
        phone: f.phone.trim(),
        kind: f.kind,
        customerRole: f.customerRole,
        legalName: legalName.trim(),
      });
      setMfa(res.mfaSetup);
      setStep('mfa');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'We could not open your account. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifyMfa(code.replace(/\s/g, ''));
      router.replace('/settings');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
      setBusy(false);
    }
  }

  async function fillSandboxCode() {
    try {
      const res = await api.sandboxMfaCode(f.email.trim().toLowerCase());
      setCode(res.code);
      setHint(`Sandbox code, valid ${res.secondsRemaining}s more.`);
    } catch {
      setHint('No sandbox code available for this account.');
    }
  }

  const choice = <T extends string>(
    name: string,
    legend: string,
    value: T,
    options: Array<{ value: T; label: string; sub: string }>,
    onChange: (v: T) => void,
  ) => (
    <fieldset className={r.fieldset}>
      <legend>{legend}</legend>
      <div className={r.choices}>
        {options.map((o) => (
          <label key={o.value} className={r.choice}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className={r.sub}>{o.sub}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className={styles.page}>
      <div className={styles.rule} aria-hidden="true" />
      <main id="main" className={r.wrap}>
        <div className={styles.panel}>
          <Brand />
          <h1 className={styles.title}>
            {step === 'details' ? 'Open an account' : 'Set up two-step verification'}
          </h1>

          {error && <Alert tone="error">{error}</Alert>}

          {step === 'details' ? (
            <form onSubmit={submitDetails} noValidate>
              <Field label="Full name" error={errors.fullName}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    autoComplete="name"
                    value={f.fullName}
                    aria-describedby={describedBy}
                    aria-invalid={errors.fullName ? true : undefined}
                    onChange={set('fullName')}
                  />
                )}
              </Field>
              <Field label="Email" error={errors.email}>
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    value={f.email}
                    aria-describedby={describedBy}
                    aria-invalid={errors.email ? true : undefined}
                    onChange={set('email')}
                  />
                )}
              </Field>
              <Field
                label="Phone"
                error={errors.phone}
                hint="Include the country code, e.g. +1 868 555 0100."
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="tel"
                    autoComplete="tel"
                    value={f.phone}
                    aria-describedby={describedBy}
                    aria-invalid={errors.phone ? true : undefined}
                    onChange={set('phone')}
                  />
                )}
              </Field>
              <Field label="Password" error={errors.password} hint="At least 10 characters.">
                {(id, describedBy) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    value={f.password}
                    aria-describedby={describedBy}
                    aria-invalid={errors.password ? true : undefined}
                    onChange={set('password')}
                  />
                )}
              </Field>
              {choice<EntityKind>(
                'kind',
                'Account type',
                f.kind,
                [
                  { value: 'individual', label: 'Individual', sub: 'For yourself' },
                  { value: 'business', label: 'Business', sub: 'For a registered company' },
                ],
                (v) => {
                  setF((s) => ({ ...s, kind: v, legalName: v === 'business' ? '' : s.legalName }));
                  setLegalTouched(false);
                },
              )}
              {choice<CustomerRole>(
                'role',
                'I want to',
                f.customerRole,
                [
                  { value: 'buyer', label: 'Buy USD', sub: 'Pay TTD, receive USD' },
                  { value: 'seller', label: 'Sell USD', sub: 'Pay USD, receive TTD' },
                ],
                (v) => setF((s) => ({ ...s, customerRole: v })),
              )}
              <Field
                label={f.kind === 'business' ? 'Registered business name' : 'Legal name'}
                error={errors.legalName}
                hint={
                  f.kind === 'business'
                    ? 'Exactly as shown on your certificate of incorporation.'
                    : 'As shown on your identity document.'
                }
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    autoComplete={f.kind === 'business' ? 'organization' : 'name'}
                    value={legalName}
                    aria-describedby={describedBy}
                    aria-invalid={errors.legalName ? true : undefined}
                    onChange={(e) => {
                      setLegalTouched(true);
                      setF((s) => ({ ...s, legalName: e.target.value }));
                    }}
                  />
                )}
              </Field>
              <Button type="submit" busy={busy}>
                Open account
              </Button>
              <p className={styles.alt}>
                Already have an account? <a href="/login">Sign in</a>
              </p>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate>
              <p>
                Your account is protected with a code from an authenticator app (for example Google
                Authenticator, Microsoft Authenticator or 1Password).
              </p>
              <ol className={r.steps}>
                <li>Open your authenticator app and choose to add an account.</li>
                <li>Choose to enter a setup key, and type in the key below.</li>
                <li>Enter the 6-digit code the app shows.</li>
              </ol>
              {mfa && (
                <>
                  <p className={r.secretLabel} id="secret-label">
                    Setup key
                  </p>
                  <p className={r.secret} aria-labelledby="secret-label">
                    {groupBy4(mfa.secret)}
                  </p>
                  <p className={r.sub}>
                    On a phone with an authenticator app installed, you can also{' '}
                    <a href={mfa.otpauthUrl}>open the setup link</a>.
                  </p>
                </>
              )}
              <Field label="Verification code" hint={hint}>
                {(id, describedBy) => (
                  <Input
                    id="mfa-code"
                    name={id}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    value={code}
                    aria-describedby={describedBy}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                )}
              </Field>
              <div className={styles.row}>
                <Button type="submit" busy={busy} disabled={code.replace(/\s/g, '').length !== 6}>
                  Verify and continue
                </Button>
                {SANDBOX && (
                  <Button type="button" variant="ghost" onClick={() => void fillSandboxCode()}>
                    Fill sandbox code
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

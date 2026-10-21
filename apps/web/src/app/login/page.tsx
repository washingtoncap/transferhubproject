'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { Brand } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import styles from './login.module.css';

/** Demo accounts created by the seed script (sandbox only). */
const DEMO_ACCOUNTS: Array<{ email: string; who: string }> = [
  { email: 'marcus@islandremit.tt', who: 'Main seller · Island Remit Agents (Network plan)' },
  { email: 'priya@postraders.tt', who: 'Child seller · Port of Spain Traders' },
  { email: 'ana@caribimports.tt', who: 'Business buyer · Caribbean Imports Ltd (Plus)' },
  { email: 'daniel.ramdial@example.tt', who: 'Individual seller · Daniel Ramdial' },
  { email: 'sasha.mohammed@example.tt', who: 'New customer · verification under review' },
  { email: 'ops@transparenttransfers.com', who: 'Staff · operations' },
  { email: 'compliance@transparenttransfers.com', who: 'Staff · compliance' },
  { email: 'finance@transparenttransfers.com', who: 'Staff · finance and treasury' },
];
const DEMO_PASSWORD = 'Sandbox!2026';
const SANDBOX = (process.env.NEXT_PUBLIC_APP_ENV ?? 'local') !== 'production';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<'password' | 'mfa'>(
    params.get('step') === 'mfa' ? 'mfa' : 'password',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (step === 'mfa') document.getElementById('mfa-code')?.focus();
  }, [step]);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim().toLowerCase(), password);
      setStep('mfa');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.verifyMfa(code.replace(/\s/g, ''));
      router.replace(me.memberships.length === 0 && me.user.isStaff ? '/ops' : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
      setBusy(false);
    }
  }

  async function fillSandboxCode() {
    try {
      const r = await api.sandboxMfaCode(email.trim().toLowerCase());
      setCode(r.code);
      setHint(`Sandbox code for ${email}, valid ${r.secondsRemaining}s more.`);
    } catch {
      setHint('No sandbox code available for this account.');
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.rule} aria-hidden="true" />
      <main id="main" className={styles.wrap}>
        <div className={styles.panel}>
          <Brand />
          <h1 className={styles.title}>
            {step === 'password' ? 'Sign in' : 'Two-step verification'}
          </h1>

          {error && <Alert tone="error">{error}</Alert>}

          {step === 'password' ? (
            <form onSubmit={submitPassword} noValidate>
              <Field label="Email">
                {(id) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Password">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" busy={busy} disabled={!email || !password}>
                Continue
              </Button>
              <p className={styles.alt}>
                New to TransferHub? <a href="/register">Open an account</a>
              </p>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate>
              <p>Enter the 6-digit code from your authenticator app.</p>
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
                  Verify and sign in
                </Button>
                {SANDBOX && email && (
                  <Button type="button" variant="ghost" onClick={() => void fillSandboxCode()}>
                    Fill sandbox code
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>

        {SANDBOX && step === 'password' && (
          <aside className={styles.demo} aria-labelledby="demo-title">
            <h2 id="demo-title">Sandbox demo accounts</h2>
            <p>
              Password for all: <code>{DEMO_PASSWORD}</code>. Choose one to fill the form.
            </p>
            <ul>
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email}>
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(a.email);
                      setPassword(DEMO_PASSWORD);
                    }}
                  >
                    <strong>{a.email}</strong>
                    <span>{a.who}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

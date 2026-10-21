'use client';

/**
 * TransferHub UI kit (TH-BRD §3–8). Every screen uses these so the product reads as one system.
 * Rules: currency always explicit; status never by colour alone; final financial actions use
 * specific labels ("Request withdrawal", not "Continue").
 */
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';
import type { Asset } from '@/lib/api';
import { humanize, money } from '@/lib/format';
import s from './ui.module.css';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.pageHeader}>
      <div>
        <h1>{title}</h1>
        {description && <p className={s.pageDescription}>{description}</p>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  children,
  footer,
  tone,
}: {
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'lavender';
}) {
  return (
    <section className={tone === 'lavender' ? s.cardLavender : s.card}>
      {title && <h2 className={s.cardTitle}>{title}</h2>}
      {children}
      {footer && <div className={s.cardFooter}>{footer}</div>}
    </section>
  );
}

export function Grid({ children, min = 240 }: { children: ReactNode; min?: number }) {
  return (
    <div
      className={s.grid}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}
    >
      {children}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  busy?: boolean;
};

export function Button({ variant = 'primary', busy, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={s[variant]}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.label}>
        {label}
      </label>
      {children(id, describedBy)}
      {hint && (
        <p id={hintId} className={s.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className={s.fieldError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={s.input} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={s.input} {...props} />;
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children?: ReactNode;
}) {
  const icon = { info: 'ℹ', success: '✓', warning: '!', error: '✕' }[tone];
  return (
    <div className={s[`alert_${tone}`]} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={s.alertIcon} aria-hidden="true">
        {icon}
      </span>
      <div>
        {title && <strong className={s.alertTitle}>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'error' | 'neutral' | 'info'> = {
  approved: 'success',
  cleared: 'success',
  settled: 'success',
  active: 'success',
  accepted: 'success',
  paid: 'success',
  matched: 'success',
  ok: 'success',
  pending: 'warning',
  pending_approval: 'warning',
  submitted: 'warning',
  vendor_checks: 'warning',
  compliance_review: 'warning',
  needs_information: 'warning',
  invited: 'warning',
  approved_pending: 'warning',
  open: 'info',
  draft: 'neutral',
  cancel_at_period_end: 'warning',
  status_unknown: 'warning',
  rejected: 'error',
  failed: 'error',
  restricted: 'error',
  break: 'error',
  dead: 'error',
  expired: 'neutral',
  detached: 'neutral',
  declined: 'neutral',
  cancelled: 'neutral',
  closed: 'neutral',
};

/** Status pill: colour plus a text label (never colour alone). */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return <span className={s[`badge_${tone}`]}>{label ?? humanize(status)}</span>;
}

export function Money({ minor, asset, signed }: { minor: number; asset: Asset; signed?: boolean }) {
  const text = money(minor, asset);
  return (
    <span className={`num ${signed && minor > 0 ? s.moneyIn : ''}`}>
      {signed && minor > 0 ? `+${text}` : text}
    </span>
  );
}

export function Table({
  caption,
  head,
  children,
  empty,
}: {
  caption?: string;
  head: ReactNode[];
  children: ReactNode;
  empty?: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        {caption && <caption className={s.caption}>{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hasRows ? (
            children
          ) : (
            <tr>
              <td colSpan={head.length} className={s.emptyCell}>
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={`${s.statValue} num`}>{value}</div>
      {sub && <div className={s.statSub}>{sub}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className={s.loading} role="status">
      {label}
    </p>
  );
}

export function DefinitionList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className={s.dl}>
      {items.map(([k, v]) => (
        <div key={k} className={s.dlRow}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.tabs} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? s.tabActive : s.tab}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

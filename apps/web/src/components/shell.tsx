'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from './session';
import styles from '@/app/shell.module.css';

export interface NavItem {
  label: string;
  href: string;
  /** Only show when this returns true. */
  when?: boolean;
}

function EnvBadge() {
  const env = process.env.NEXT_PUBLIC_APP_ENV ?? 'local';
  if (env === 'production') return null;
  const names: Record<string, string> = { local: 'Local', test: 'Test', sandbox: 'Sandbox' };
  return (
    <span className={styles.envBadge} role="note">
      {names[env] ?? env} · no real money
    </span>
  );
}

export function Brand({ suffix }: { suffix?: string }) {
  return (
    <a className={styles.brand} href="/">
      {/* Corporate monogram from the supplied asset; replace with the vector master when available. */}
      <img src="/monogram.png" alt="" width={34} height={40} />
      <span className={styles.wordmark}>
        <span className={styles.product}>
          TransferHub{suffix && <span className={styles.suffix}> {suffix}</span>}
        </span>
        <span className={styles.company}>Transparent Transfers Technology</span>
      </span>
    </a>
  );
}

function Nav({ items, label }: { items: NavItem[]; label: string }) {
  const path = usePathname();
  const isCurrent = (href: string) =>
    href === '/' || href === '/ops' ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <nav className={styles.nav} aria-label={label}>
      <ul>
        {items
          .filter((i) => i.when !== false)
          .map((item) => (
            <li key={item.href}>
              <a
                className={styles.navItem}
                href={item.href}
                aria-current={isCurrent(item.href) ? 'page' : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
      </ul>
    </nav>
  );
}

function UserMenu({ extra }: { extra?: ReactNode }) {
  const { me, logout } = useSession();
  return (
    <div className={styles.userMenu}>
      {extra}
      <span className={styles.userName}>{me.user.fullName}</span>
      <button className={styles.signOut} onClick={() => void logout()} type="button">
        Sign out
      </button>
    </div>
  );
}

function EntitySwitcher() {
  const { me, entity, selectEntity } = useSession();
  if (me.memberships.length <= 1) {
    return entity ? <span className={styles.entityName}>{entity.legalName}</span> : null;
  }
  return (
    <label className={styles.entitySwitch}>
      <span className="visually-hidden">Acting for</span>
      <select
        value={entity?.id ?? ''}
        onChange={(e) => {
          selectEntity(e.target.value);
          window.location.reload();
        }}
      >
        {me.memberships.map((m) => (
          <option key={m.entity.id} value={m.entity.id}>
            {m.entity.legalName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CustomerShell({ children }: { children: ReactNode }) {
  const { entity, me } = useSession();
  const seller = entity?.customerRole === 'seller';
  const items: NavItem[] = [
    { label: 'Overview', href: '/' },
    { label: 'Fund', href: '/fund' },
    { label: 'Exchange', href: '/exchange' },
    { label: 'Withdrawals', href: '/withdrawals' },
    { label: 'Seller network', href: '/network', when: seller },
    { label: 'Plans & billing', href: '/billing' },
    { label: 'Statements', href: '/statements' },
    { label: 'Account & verification', href: '/settings' },
    { label: 'System status', href: '/status' },
  ];
  return (
    <>
      <div className={styles.rule} aria-hidden="true" />
      <header className={styles.header}>
        <Brand />
        <div className={styles.headerRight}>
          <EnvBadge />
          <EntitySwitcher />
          <UserMenu
            extra={
              me.user.isStaff ? (
                <a className={styles.headerLink} href="/ops">
                  Operations
                </a>
              ) : null
            }
          />
        </div>
      </header>
      <div className={styles.layout}>
        <Nav items={items} label="Main" />
        <main id="main" className={styles.main}>
          {children}
        </main>
      </div>
      <footer className={styles.footer}>
        TransferHub is software provided by Transparent Transfers Technology. Financial services are
        provided by contracted, identified partners. Sandbox: all customers, balances and partners
        shown are simulated.
      </footer>
    </>
  );
}

export function OpsShell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const items: NavItem[] = [
    { label: 'Overview', href: '/ops' },
    { label: 'Customers & KYC', href: '/ops/customers' },
    { label: 'Deposits', href: '/ops/deposits' },
    { label: 'Withdrawals', href: '/ops/withdrawals' },
    { label: 'Trades', href: '/ops/trades' },
    { label: 'Reconciliation', href: '/ops/reconciliation' },
    { label: 'Rates & policy', href: '/ops/rates' },
    { label: 'Audit log', href: '/ops/audit' },
    { label: 'System health', href: '/ops/system' },
  ];
  return (
    <>
      <div className={styles.ruleOps} aria-hidden="true" />
      <header className={styles.header}>
        <Brand suffix="Operations" />
        <div className={styles.headerRight}>
          <EnvBadge />
          <span className={styles.roles}>{me.user.staffRoles.join(' · ')}</span>
          <UserMenu />
        </div>
      </header>
      <div className={styles.layout}>
        <Nav items={items} label="Operations" />
        <main id="main" className={styles.main}>
          {children}
        </main>
      </div>
    </>
  );
}

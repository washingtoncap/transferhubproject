'use client';

import { usePathname } from 'next/navigation';
import styles from '@/app/shell.module.css';

/**
 * Authenticated customer navigation from TH-BRD §6. Items not yet built are shown, disabled, with
 * the delivery bucket — so the sandbox is honest about what exists.
 */
const ITEMS: Array<{ label: string; href?: string; bucket?: string }> = [
  { label: 'Overview', href: '/' },
  { label: 'Fund', bucket: 'Bucket 4' },
  { label: 'Exchange', bucket: 'Bucket 5' },
  { label: 'Withdrawals', bucket: 'Bucket 4' },
  { label: 'Statements', bucket: 'Bucket 8' },
  { label: 'Support', bucket: 'Later' },
  { label: 'Settings', bucket: 'Bucket 2' },
  { label: 'System status', href: '/status' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className={styles.nav} aria-label="Main">
      <ul>
        {ITEMS.map((item) =>
          item.href ? (
            <li key={item.label}>
              <a
                className={styles.navItem}
                href={item.href}
                aria-current={path === item.href ? 'page' : undefined}
              >
                {item.label}
              </a>
            </li>
          ) : (
            <li key={item.label}>
              <span className={styles.navItemDisabled} aria-disabled="true">
                {item.label}
                <span className={styles.navTag}>{item.bucket}</span>
              </span>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

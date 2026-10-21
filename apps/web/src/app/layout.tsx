import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { environmentLabel } from '@/lib/env';
import styles from './shell.module.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TransferHub', template: '%s · TransferHub' },
  description: 'TransferHub by Transparent Transfers Technology',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  const env = environmentLabel();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <div className={styles.rule} aria-hidden="true" />
        <header className={styles.header}>
          <a className={styles.brand} href="/">
            {/* Corporate monogram from the supplied asset; replace with the vector master when available. */}
            <img src="/monogram.png" alt="" width={34} height={40} />
            <span className={styles.wordmark}>
              <span className={styles.product}>TransferHub</span>
              <span className={styles.company}>Transparent Transfers Technology</span>
            </span>
          </a>
          {env && (
            <span className={styles.envBadge} role="status">
              {env}
            </span>
          )}
        </header>
        <div className={styles.layout}>
          <Nav />
          <main id="main" className={styles.main}>
            {children}
          </main>
        </div>
        <footer className={styles.footer}>
          TransferHub is software provided by Transparent Transfers Technology. Financial services
          are provided by contracted, identified partners.
        </footer>
      </body>
    </html>
  );
}

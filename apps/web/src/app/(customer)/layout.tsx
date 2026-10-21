'use client';

import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session';
import { CustomerShell } from '@/components/shell';

export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <CustomerShell>{children}</CustomerShell>
    </SessionProvider>
  );
}

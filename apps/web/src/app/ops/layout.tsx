'use client';

import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session';
import { OpsShell } from '@/components/shell';

export default function OpsLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider requireStaff>
      <OpsShell>{children}</OpsShell>
    </SessionProvider>
  );
}

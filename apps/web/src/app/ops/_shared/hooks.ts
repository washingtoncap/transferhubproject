'use client';

import { useEffect, useRef } from 'react';
import type { StaffRole } from '@/lib/api';
import { useSession } from '@/components/session';

/** Calls `fn` every `ms` milliseconds while the tab is visible. */
export function useAutoRefresh(fn: () => unknown, ms: number) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void ref.current();
    }, ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

/** True when the signed-in staff member holds any of the given roles. */
export function useHasRole(...roles: StaffRole[]): boolean {
  const { me } = useSession();
  return me.user.staffRoles.some((r) => roles.includes(r));
}

export function sideLabel(side: 'buy_usd' | 'sell_usd'): string {
  return side === 'buy_usd' ? 'Bought USD' : 'Sold USD';
}

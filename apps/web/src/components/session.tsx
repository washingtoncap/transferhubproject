'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, ApiError, type EntitySummary, type Me } from '@/lib/api';

interface SessionValue {
  me: Me;
  /** The customer entity the user is currently acting for. Null for staff-only users. */
  entity: EntitySummary | null;
  role: Me['memberships'][number]['role'] | null;
  selectEntity: (id: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const ENTITY_KEY = 'th.entityId';

/**
 * Loads the signed-in user and guards the page. Unauthenticated (or MFA-incomplete) visitors are
 * sent to /login; `requireStaff` pages send customers back to their overview.
 */
export function SessionProvider({
  children,
  requireStaff = false,
}: {
  children: ReactNode;
  requireStaff?: boolean;
}) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [entityId, setEntityId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await api.me();
      if (!m.session.mfaVerified) {
        router.replace('/login?step=mfa');
        return;
      }
      if (requireStaff && !m.user.isStaff) {
        router.replace('/');
        return;
      }
      if (!requireStaff && m.memberships.length === 0 && m.user.isStaff) {
        router.replace('/ops');
        return;
      }
      setMe(m);
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(ENTITY_KEY);
      } catch {
        /* storage unavailable */
      }
      const valid = m.memberships.find((x) => x.entity.id === stored);
      setEntityId(valid ? valid.entity.id : (m.memberships[0]?.entity.id ?? null));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace('/login');
      else throw err;
    }
  }, [router, requireStaff]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<SessionValue | null>(() => {
    if (!me) return null;
    const membership = me.memberships.find((m) => m.entity.id === entityId) ?? null;
    return {
      me,
      entity: membership?.entity ?? null,
      role: membership?.role ?? null,
      selectEntity: (id) => {
        setEntityId(id);
        try {
          window.localStorage.setItem(ENTITY_KEY, id);
        } catch {
          /* storage unavailable */
        }
      },
      refresh: load,
      logout: async () => {
        await api.logout().catch(() => undefined);
        router.replace('/login');
      },
    };
  }, [me, entityId, load, router]);

  if (!value) {
    return (
      <p role="status" style={{ padding: 32 }}>
        Loading your session…
      </p>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** The current customer entity; throws if a page that needs one renders without it. */
export function useEntity(): EntitySummary {
  const { entity } = useSession();
  if (!entity) throw new Error('No customer account selected');
  return entity;
}

/**
 * Small data hook: runs `load` on mount and whenever `deps` change; exposes `reload`.
 * Keeps pages free of repetitive loading/error state.
 */
export function useData<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; reload: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, loading };
}

/** Turns an API error into a sentence for the user. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}

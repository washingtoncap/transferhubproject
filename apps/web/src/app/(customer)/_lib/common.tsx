'use client';

/**
 * Small helpers shared by the customer pages. Lives in a private (`_lib`) folder so Next.js does
 * not treat it as a route.
 */
import type { ReactNode } from 'react';
import { useSession } from '@/components/session';
import { Alert, PageHeader } from '@/components/ui';
import { ApiError, type EntitySummary } from '@/lib/api';

export const SANDBOX = (process.env.NEXT_PUBLIC_APP_ENV ?? 'local') !== 'production';

/**
 * Renders `children` only when the signed-in user is acting for a customer account. Staff-only
 * users (no customer membership) see a short explanation instead of a crash.
 */
export function CustomerOnly({
  title,
  children,
}: {
  title: string;
  children: (entity: EntitySummary) => ReactNode;
}) {
  const { entity } = useSession();
  if (!entity) {
    return (
      <>
        <PageHeader title={title} />
        <Alert tone="info" title="No customer account selected">
          This page is for customer accounts. Staff members can use the{' '}
          <a href="/ops">operations console</a>.
        </Alert>
      </>
    );
  }
  return <>{children(entity)}</>;
}

/** Human label for a quote's rate source. */
export function rateSourceLabel(source: string, parentLegalName?: string | null): string {
  if (source === 'child_rate') return `Rate set by ${parentLegalName ?? 'your network parent'}`;
  if (source === 'standard') return 'Standard rate';
  if (source.startsWith('plan:')) {
    const code = source.slice(5);
    const tier = code.split('_').pop() ?? code;
    return `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan rate`;
  }
  return source.replace(/_/g, ' ');
}

/**
 * Maps an API error to a user-facing sentence, preferring page-specific copy for known codes.
 */
export function messageFor(err: unknown, byCode: Record<string, string> = {}): string {
  if (err instanceof ApiError) return byCode[err.code] ?? err.message;
  return 'Something went wrong. Please try again.';
}

export const NOT_APPROVED_COPY =
  'Your account must be verified before you can do this. Check Account & verification for the next step.';

export const RESTRICTED_COPY =
  'This service is temporarily restricted. Contact support for the next steps available to you.';

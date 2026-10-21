import type { Queryable } from '@transferhub/platform';
import type { SessionUser } from './auth';
import { DomainError, denied } from './errors';

export type MembershipRole = 'owner' | 'admin' | 'approver' | 'viewer';
export type StaffRole = 'operations' | 'compliance' | 'finance' | 'treasury' | 'admin';

/** Roles allowed to move money or change settings for a customer. Viewers can only look. */
export const ACTING_ROLES: MembershipRole[] = ['owner', 'admin', 'approver'];

/**
 * Object-level authorisation (IAM-02, NFR-02). Checked on every request against current database
 * state — never against claims cached in a token. A non-member gets "not found", so guessing an id
 * reveals nothing about whether that customer exists.
 */
export async function requireMember(
  db: Queryable,
  user: SessionUser,
  entityId: string,
  roles?: MembershipRole[],
): Promise<MembershipRole> {
  if (!/^[0-9a-f-]{36}$/i.test(entityId))
    throw new DomainError('not_found', 'Account not found.', 404);
  const { rows } = await db.query<{ role: MembershipRole }>(
    'SELECT role FROM app.memberships WHERE user_id = $1 AND entity_id = $2',
    [user.userId, entityId],
  );
  const role = rows[0]?.role;
  if (!role) throw new DomainError('not_found', 'Account not found.', 404);
  if (roles && !roles.includes(role))
    throw denied('Your role on this account does not allow that.');
  return role;
}

export interface EntityRow {
  id: string;
  kind: 'individual' | 'business';
  customer_role: 'buyer' | 'seller';
  legal_name: string;
  reference_code: string;
  onboarding_status: string;
}

export async function loadEntity(
  db: Queryable,
  entityId: string,
  lock = false,
): Promise<EntityRow> {
  const { rows } = await db.query<EntityRow>(
    `SELECT id, kind, customer_role, legal_name, reference_code, onboarding_status
       FROM app.entities WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [entityId],
  );
  if (!rows[0]) throw new DomainError('not_found', 'Account not found.', 404);
  return rows[0];
}

/** Financial services are only available to verified, unrestricted customers (IAM-01, KYC-01). */
export async function requireApproved(db: Queryable, entityId: string): Promise<EntityRow> {
  const e = await loadEntity(db, entityId);
  if (e.onboarding_status !== 'approved') {
    throw new DomainError(
      'not_approved',
      e.onboarding_status === 'restricted'
        ? 'This service is temporarily restricted. Contact support for the next steps available to you.'
        : 'Your account must be verified before you can use this service.',
      403,
    );
  }
  return e;
}

export function requireStaff(user: SessionUser, roles?: StaffRole[]): void {
  if (!user.isStaff) throw denied('Staff access only.');
  if (roles && !user.staffRoles.some((r) => r === 'admin' || roles.includes(r as StaffRole))) {
    throw denied(`This needs one of these roles: ${roles.join(', ')}.`);
  }
}

export function requireMfaUser(user: SessionUser): void {
  if (!user.mfaVerified)
    throw new DomainError('mfa_required', 'Complete two-step verification first.', 401);
}

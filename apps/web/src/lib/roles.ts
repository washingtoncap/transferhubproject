import type { StaffRole } from './api';

/**
 * Where each kind of staff member lands after signing in. Admin sees the whole console; finance
 * and treasury land on the finance dashboard; compliance on the review queue; operations on the
 * operations overview.
 */
export function staffLanding(roles: StaffRole[]): string {
  if (roles.includes('admin')) return '/ops';
  if (roles.includes('finance') || roles.includes('treasury')) return '/ops/finance';
  if (roles.includes('compliance')) return '/ops/customers';
  return '/ops';
}

export type OpsArea =
  | 'overview'
  | 'finance'
  | 'customers'
  | 'deposits'
  | 'withdrawals'
  | 'trades'
  | 'reconciliation'
  | 'ledger'
  | 'rates'
  | 'audit'
  | 'system';

/** Least privilege in navigation. The API enforces the same rules on every request. */
const AREAS: Record<Exclude<StaffRole, 'admin'>, OpsArea[]> = {
  operations: ['overview', 'customers', 'deposits', 'withdrawals', 'trades', 'audit', 'system'],
  compliance: ['overview', 'customers', 'withdrawals', 'audit'],
  finance: ['finance', 'ledger', 'withdrawals', 'trades', 'reconciliation', 'rates', 'audit'],
  treasury: ['finance', 'ledger', 'trades', 'reconciliation', 'rates', 'audit'],
};

export function canSee(roles: StaffRole[], area: OpsArea): boolean {
  if (roles.includes('admin')) return true;
  return roles.some((r) => r !== 'admin' && AREAS[r].includes(area));
}

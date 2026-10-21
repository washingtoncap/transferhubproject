/**
 * A rule the business logic refused. `code` is stable and machine-readable (TH-REQ §6); `message`
 * is safe to show a customer. The API turns these into HTTP responses with `status`.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly status: number = 422,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export type DomainErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'mfa_required'
  | 'invalid_mfa_code'
  | 'invalid_credentials'
  | 'account_locked'
  | 'email_taken'
  | 'permission_denied'
  | 'not_found'
  | 'not_approved'
  | 'invalid_state'
  | 'insufficient_available_funds'
  | 'principal_inventory_insufficient'
  | 'quote_expired'
  | 'child_rate_exceeds_parent'
  | 'child_rate_below_floor'
  | 'child_limit_reached'
  | 'not_a_seller'
  | 'nested_network'
  | 'beneficiary_unverified'
  | 'currency_mismatch'
  | 'already_decided'
  | 'self_approval'
  | 'consent_required';

export const notFound = (what: string) => new DomainError('not_found', `${what} not found.`, 404);
export const denied = (msg = 'You do not have permission to do that.') =>
  new DomainError('permission_denied', msg, 403);
export const invalid = (msg: string, details?: unknown) =>
  new DomainError('validation_failed', msg, 400, details);

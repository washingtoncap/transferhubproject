/**
 * TransferHub API contract (sandbox prototype) and browser client.
 *
 * This file is the single source of truth for request/response shapes between the web app and
 * apps/api. The browser calls same-origin `/api/v1/...`; Next.js rewrites that to the API, so the
 * session cookie (httpOnly) is first-party. All money is integer minor units (cents). FX rates are
 * integers in ten-thousandths of TTD per USD (8.2200 → 82200).
 */

// ---------------------------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------------------------
export type Asset = 'USD' | 'TTD';
export type EntityKind = 'individual' | 'business';
export type CustomerRole = 'buyer' | 'seller';
export type MembershipRole = 'owner' | 'admin' | 'approver' | 'viewer';
export type StaffRole = 'operations' | 'compliance' | 'finance' | 'treasury' | 'admin';
export type OnboardingStatus =
  | 'draft'
  | 'submitted'
  | 'vendor_checks'
  | 'needs_information'
  | 'compliance_review'
  | 'approved'
  | 'rejected'
  | 'restricted'
  | 'closed';

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  customerRole: CustomerRole;
  legalName: string;
  referenceCode: string;
  onboardingStatus: OnboardingStatus;
}

export interface Me {
  user: {
    id: string;
    email: string;
    fullName: string;
    isStaff: boolean;
    staffRoles: StaffRole[];
    mfaEnabled: boolean;
  };
  session: { mfaVerified: boolean };
  memberships: Array<{ role: MembershipRole; entity: EntitySummary }>;
}

export interface Profile {
  address?: string;
  dateOfBirth?: string; // individuals
  occupation?: string; // individuals
  registrationNumber?: string; // businesses
  businessActivity?: string; // businesses
  beneficialOwners?: Array<{ name: string; ownershipPercent: number }>; // businesses (KYB-02)
  purpose?: string;
  expectedMonthlyUsd?: number;
  sourceOfFunds?: string;
}

export interface Plan {
  code: string;
  audience: CustomerRole;
  name: string;
  monthlyMinor: number;
  annualMinor: number;
  usdRateE4: number;
  volumeAllowanceUsdMinor: number;
  childLimit: number;
  staffSeats: number;
}

export interface Subscription {
  id: string;
  planCode: string;
  billingInterval: 'monthly' | 'annual';
  status: 'active' | 'cancel_at_period_end' | 'cancelled';
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface EntityDetail extends EntitySummary {
  profile: Profile;
  riskRating: 'low' | 'medium' | 'high' | null;
  reviewReason: string | null;
  createdAt: string;
  approvedAt: string | null;
  subscription: Subscription | null;
  plan: Plan | null;
  /** Set when this entity is an active child in a seller network. */
  parent: { entityId: string; legalName: string; childRateE4: number } | null;
}

export interface Balance {
  asset: Asset;
  /** Settled ledger balance. */
  ledgerMinor: number;
  /** Reserved for pending withdrawals. */
  heldMinor: number;
  /** ledger − held. What the customer can spend. */
  availableMinor: number;
  /** Deposit claims awaiting partner clearance. NOT spendable (DEP-01). */
  pendingDepositsMinor: number;
}

export interface ActivityLine {
  postingId: number;
  journalId: string;
  at: string;
  kind:
    | 'opening_float'
    | 'deposit_cleared'
    | 'fx_trade'
    | 'allocation'
    | 'subscription_charge'
    | 'withdrawal_settled'
    | 'reversal';
  lineType: string; // e.g. 'deposit', 'fx_pay', 'fx_receive', 'parent_margin', 'allocation_in'
  memo: string;
  asset: Asset;
  /** Positive = money in, negative = money out (customer's perspective). */
  amountMinor: number;
  balanceAfterMinor: number;
}

export interface DepositClaim {
  id: string;
  asset: Asset;
  amountMinor: number;
  reference: string;
  receiptNote: string | null;
  status: 'pending' | 'cleared' | 'rejected';
  createdAt: string;
  clearedAt: string | null;
  rejectionReason: string | null;
  instructions: { bankName: string; accountName: string; accountNumber: string; reference: string };
}

export interface Quote {
  id: string;
  side: 'buy_usd' | 'sell_usd';
  usdMinor: number;
  ttdMinor: number;
  rateE4: number;
  /** Where the rate came from, e.g. 'plan:buyer_plus', 'child_rate', 'standard'. */
  rateSource: string;
  /** Child seller only: margin paid to the parent seller on this trade. */
  parentMarginMinor: number;
  parentLegalName: string | null;
  status: 'open' | 'accepted' | 'expired';
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface NetworkLink {
  id: string;
  child: {
    id: string;
    legalName: string;
    referenceCode: string;
    onboardingStatus: OnboardingStatus;
  };
  childRateE4: number;
  status: 'invited' | 'active' | 'declined' | 'detached';
  invitedAt: string;
  acceptedAt: string | null;
  /** Margin earned from this child, all time. */
  marginEarnedMinor: number;
  /** USD sold by this child, all time. */
  childVolumeUsdMinor: number;
}

export interface Network {
  parentRateE4: number;
  childFloorE4: number;
  childLimit: number;
  activeChildren: number;
  links: NetworkLink[];
  earnings: {
    totalMarginMinor: number;
    last30DaysMarginMinor: number;
    allocationsOutMinor: number;
  };
}

export interface NetworkInvitation {
  id: string;
  parent: { id: string; legalName: string };
  childRateE4: number;
  status: 'invited' | 'active' | 'declined' | 'detached';
  invitedAt: string;
  consentText: string;
}

export interface Beneficiary {
  id: string;
  label: string;
  bankName: string;
  accountHolder: string;
  accountLast4: string;
  currency: Asset;
  verified: boolean;
  createdAt: string;
}

export type WithdrawalStatus =
  | 'pending_approval'
  | 'approved'
  | 'submitted'
  | 'settled'
  | 'failed'
  | 'rejected'
  | 'status_unknown';

export interface Withdrawal {
  id: string;
  reference: string;
  asset: Asset;
  amountMinor: number;
  status: WithdrawalStatus;
  beneficiary: { id: string; label: string; bankName: string; accountLast4: string };
  requiredApprovals: number;
  approvals: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  description: string;
  amountMinor: number;
  currency: 'TTD';
  periodStart: string;
  periodEnd: string;
  status: 'paid' | 'void';
  createdAt: string;
}

export interface SubscriptionOverview {
  subscription: Subscription | null;
  plan: Plan | null;
  invoices: Invoice[];
  /** USD volume traded this calendar month (rate-eligibility allowance usage). */
  usage: { usdVolumeMinor: number; allowanceUsdMinor: number | null };
}

export interface IndicativeRates {
  standardBuyE4: number;
  standardSellE4: number;
  childFloorE4: number;
  quoteTtlSeconds: number;
  plans: Plan[];
  /** USDT parity example (CRY-03): USD buy rate + TT$0.10. Not yet tradable. */
  usdtExample: { usdRateE4: number; usdtRateE4: number };
}

// ---------------------------------------------------------------------------------------------
// Operations console types
// ---------------------------------------------------------------------------------------------
export interface OpsOverview {
  kycQueue: number;
  pendingDeposits: number;
  withdrawalsAwaitingApproval: number;
  reconciliationBreaks: number;
  deadJobs: number;
  customers: { total: number; approved: number };
  last24h: { tradesCount: number; tradesUsdMinor: number; depositsClearedCount: number };
  platformRevenueTtdMinor: number;
}

export interface OpsCustomer extends EntitySummary {
  createdAt: string;
  submittedAt: string | null;
  riskRating: 'low' | 'medium' | 'high' | null;
  screeningResult: 'clear' | 'possible_match' | null;
  planCode: string | null;
  owner: { name: string; email: string } | null;
}

export interface OpsCustomerDetail extends OpsCustomer {
  profile: Profile;
  reviewReason: string | null;
  members: Array<{ name: string; email: string; role: MembershipRole }>;
  balances: Balance[];
  audit: AuditEntry[];
}

export interface OpsDeposit extends DepositClaim {
  entity: { id: string; legalName: string; referenceCode: string };
}

export interface OpsWithdrawal extends Withdrawal {
  entity: { id: string; legalName: string };
  requestedBy: string;
  approvers: Array<{ name: string; decision: 'approve' | 'reject'; at: string }>;
  /** True when the signed-in staff member may act (has not already acted). */
  canAct: boolean;
}

export interface OpsTrade {
  id: string;
  entity: { id: string; legalName: string };
  side: 'buy_usd' | 'sell_usd';
  usdMinor: number;
  ttdMinor: number;
  rateE4: number;
  rateSource: string;
  parentMarginMinor: number;
  platformShareMinor: number;
  acceptedAt: string;
}

export interface ReconciliationAsset {
  asset: Asset;
  /** Our ledger's view of cash held at the partner. */
  ledgerProviderCashMinor: number;
  /** The partner's statement balance. */
  partnerStatementMinor: number;
  differenceMinor: number;
  customerLiabilitiesMinor: number;
  principalMinor: number;
  platformRevenueMinor: number;
  /** Sum of all postings in this asset; must be 0. */
  trialBalanceMinor: number;
  status: 'matched' | 'break';
}

export interface Reconciliation {
  asOf: string;
  assets: ReconciliationAsset[];
  /** Partner statement lines with no matching ledger posting (e.g. unmatched deposit). */
  unmatchedStatementLines: Array<{
    id: string;
    asset: Asset;
    amountMinor: number;
    description: string;
    reference: string | null;
    occurredAt: string;
  }>;
  conflictingEvents: number;
}

export interface RatePolicy {
  standardBuyE4: number;
  standardSellE4: number;
  childFloorE4: number;
  platformShareE4: number;
  quoteTtlSeconds: number;
  dualApprovalUsdMinor: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorType: 'customer' | 'staff' | 'service' | 'system';
  actorId: string;
  actorName: string | null;
  entityId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  reason: string | null;
  approverId: string | null;
  requestId: string | null;
}

export interface OpsSystem {
  jobs: Record<'queued' | 'running' | 'succeeded' | 'dead', number>;
  outbox: Record<'pending' | 'dispatching' | 'dispatched' | 'dead', number>;
  inbox: Record<'received' | 'processing' | 'processed' | 'rejected' | 'dead', number>;
  deadJobs: Array<{
    id: string;
    type: string;
    lastError: string | null;
    attempts: number;
    updatedAt: string;
  }>;
  recentJobs: Array<{
    id: string;
    type: string;
    status: string;
    attempts: number;
    updatedAt: string;
  }>;
}

export type LedgerAccountType = 'customer' | 'provider_cash' | 'fx_principal' | 'platform_revenue';

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  asset: Asset;
  normalSide: 'debit' | 'credit';
  entity: { id: string; legalName: string } | null;
  debitsMinor: number;
  creditsMinor: number;
  balanceMinor: number;
  heldMinor: number;
  postings: number;
}

export interface JournalLine {
  postingId: number;
  account: { id: string; code: string; name: string };
  asset: Asset;
  debitMinor: number;
  creditMinor: number;
  lineType: string;
}

export interface Journal {
  id: string;
  kind: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  createdBy: string;
  createdAt: string;
  reversesJournalId: string | null;
  lines: JournalLine[];
  totals: Array<{ asset: Asset; debitsMinor: number; creditsMinor: number }>;
}

export interface AccountLedger {
  account: LedgerAccount;
  entries: Array<{
    postingId: number;
    journalId: string;
    at: string;
    kind: string;
    memo: string;
    lineType: string;
    debitMinor: number;
    creditMinor: number;
    balanceAfterMinor: number;
  }>;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotent?: boolean; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotent || opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? newIdempotencyKey();
  }
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (json as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal_error',
      err?.message ?? `Request failed (${res.status})`,
      err?.requestId,
      err?.details,
    );
  }
  return json as T;
}

const e = (entityId: string) => `/entities/${encodeURIComponent(entityId)}`;

export const api = {
  // Auth (IAM-01, IAM-03)
  register: (input: {
    email: string;
    password: string;
    fullName: string;
    phone: string;
    kind: EntityKind;
    customerRole: CustomerRole;
    legalName: string;
  }) =>
    request<{ userId: string; entityId: string; mfaSetup: { secret: string; otpauthUrl: string } }>(
      'POST',
      '/auth/register',
      input,
    ),
  login: (email: string, password: string) =>
    request<{ mfaRequired: true }>('POST', '/auth/login', { email, password }),
  verifyMfa: (code: string) => request<Me>('POST', '/auth/mfa', { code }),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<Me>('GET', '/me'),
  /** Sandbox only: the current TOTP code for a demo account, so testers need no authenticator app. */
  sandboxMfaCode: (email: string) =>
    request<{ code: string; secondsRemaining: number }>(
      'GET',
      `/sandbox/mfa-code?email=${encodeURIComponent(email)}`,
    ),

  // Public
  plans: () => request<Plan[]>('GET', '/plans'),
  indicativeRates: () => request<IndicativeRates>('GET', '/rates/indicative'),

  // Customer entity (object-level access: caller must be a member — NFR-02)
  entity: (id: string) => request<EntityDetail>('GET', e(id)),
  updateProfile: (id: string, profile: Profile) =>
    request<EntityDetail>('PUT', `${e(id)}/profile`, profile),
  submitOnboarding: (id: string) => request<EntityDetail>('POST', `${e(id)}/submit`),
  balances: (id: string) => request<Balance[]>('GET', `${e(id)}/balances`),
  activity: (id: string, limit = 50) =>
    request<ActivityLine[]>('GET', `${e(id)}/activity?limit=${limit}`),
  /** Use as an <a href> for download. */
  statementCsvUrl: (id: string, asset: Asset) => `/api/v1${e(id)}/statement.csv?asset=${asset}`,

  // Deposits (DEP-01/02)
  deposits: (id: string) => request<DepositClaim[]>('GET', `${e(id)}/deposits`),
  createDeposit: (id: string, input: { asset: Asset; amountMinor: number; receiptNote?: string }) =>
    request<DepositClaim>('POST', `${e(id)}/deposits`, input, { idempotent: true }),

  // Exchange (FX-01..03)
  createQuote: (id: string, input: { side: 'buy_usd' | 'sell_usd'; usdMinor: number }) =>
    request<Quote>('POST', `${e(id)}/quotes`, input),
  acceptQuote: (id: string, quoteId: string, idempotencyKey?: string) =>
    request<Quote>(
      'POST',
      `${e(id)}/quotes/${quoteId}/accept`,
      {},
      { idempotent: true, idempotencyKey },
    ),
  trades: (id: string) => request<Quote[]>('GET', `${e(id)}/trades`),

  // Seller network — parent side (SEL-01..04)
  network: (id: string) => request<Network>('GET', `${e(id)}/network`),
  inviteChild: (id: string, input: { childReferenceCode: string; childRateE4: number }) =>
    request<NetworkLink>('POST', `${e(id)}/network/invitations`, input),
  setChildRate: (id: string, linkId: string, childRateE4: number) =>
    request<NetworkLink>('PATCH', `${e(id)}/network/${linkId}`, { childRateE4 }),
  detachChild: (id: string, linkId: string) =>
    request<NetworkLink>('POST', `${e(id)}/network/${linkId}/detach`),
  allocate: (id: string, input: { childEntityId: string; amountMinor: number }) =>
    request<{ journalId: string }>('POST', `${e(id)}/allocations`, input, { idempotent: true }),

  // Seller network — child side
  networkInvitations: (id: string) =>
    request<NetworkInvitation[]>('GET', `${e(id)}/network-invitations`),
  acceptInvitation: (id: string, linkId: string) =>
    request<NetworkInvitation>('POST', `${e(id)}/network-invitations/${linkId}/accept`, {
      consent: true,
    }),
  declineInvitation: (id: string, linkId: string) =>
    request<NetworkInvitation>('POST', `${e(id)}/network-invitations/${linkId}/decline`),

  // Withdrawals (WDR-01/02)
  beneficiaries: (id: string) => request<Beneficiary[]>('GET', `${e(id)}/beneficiaries`),
  addBeneficiary: (
    id: string,
    input: {
      label: string;
      bankName: string;
      accountHolder: string;
      accountNumber: string;
      currency: Asset;
    },
  ) => request<Beneficiary>('POST', `${e(id)}/beneficiaries`, input),
  withdrawals: (id: string) => request<Withdrawal[]>('GET', `${e(id)}/withdrawals`),
  requestWithdrawal: (
    id: string,
    input: { beneficiaryId: string; asset: Asset; amountMinor: number; mfaCode: string },
  ) => request<Withdrawal>('POST', `${e(id)}/withdrawals`, input, { idempotent: true }),

  // Subscriptions (BILL-01/02)
  subscription: (id: string) => request<SubscriptionOverview>('GET', `${e(id)}/subscription`),
  subscribe: (
    id: string,
    input: { planCode: string; billingInterval: 'monthly' | 'annual'; consent: true },
  ) => request<SubscriptionOverview>('POST', `${e(id)}/subscription`, input, { idempotent: true }),
  cancelSubscription: (id: string) =>
    request<SubscriptionOverview>('POST', `${e(id)}/subscription/cancel`),

  // Operations console (staff only)
  ops: {
    overview: () => request<OpsOverview>('GET', '/ops/overview'),
    customers: (status?: OnboardingStatus) =>
      request<OpsCustomer[]>('GET', `/ops/customers${status ? `?status=${status}` : ''}`),
    customer: (entityId: string) => request<OpsCustomerDetail>('GET', `/ops/customers/${entityId}`),
    decide: (
      entityId: string,
      input: {
        decision: 'approve' | 'reject' | 'needs_information' | 'restrict';
        reason: string;
        riskRating?: 'low' | 'medium' | 'high';
      },
    ) => request<OpsCustomerDetail>('POST', `/ops/customers/${entityId}/decision`, input),
    deposits: (status?: 'pending' | 'cleared' | 'rejected') =>
      request<OpsDeposit[]>('GET', `/ops/deposits${status ? `?status=${status}` : ''}`),
    /** Sandbox: make the simulated bank receive money. The partner then sends a signed webhook. */
    simulateBankCredit: (input: {
      asset: Asset;
      amountMinor: number;
      reference: string;
      senderName: string;
    }) => request<{ eventId: string; outcome: string }>('POST', '/ops/sandbox/bank-credit', input),
    withdrawals: (status?: WithdrawalStatus) =>
      request<OpsWithdrawal[]>('GET', `/ops/withdrawals${status ? `?status=${status}` : ''}`),
    approveWithdrawal: (id: string, reason?: string) =>
      request<OpsWithdrawal>('POST', `/ops/withdrawals/${id}/approve`, { reason }),
    rejectWithdrawal: (id: string, reason: string) =>
      request<OpsWithdrawal>('POST', `/ops/withdrawals/${id}/reject`, { reason }),
    trades: () => request<OpsTrade[]>('GET', '/ops/trades'),
    reconciliation: () => request<Reconciliation>('GET', '/ops/reconciliation'),
    ratePolicy: () => request<RatePolicy>('GET', '/ops/rate-policy'),
    updateRatePolicy: (input: Partial<Omit<RatePolicy, 'updatedAt'>> & { reason: string }) =>
      request<RatePolicy>('PUT', '/ops/rate-policy', input),
    audit: (params: { limit?: number; objectType?: string; entityId?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.limit) q.set('limit', String(params.limit));
      if (params.objectType) q.set('objectType', params.objectType);
      if (params.entityId) q.set('entityId', params.entityId);
      return request<AuditEntry[]>('GET', `/ops/audit${q.size ? `?${q}` : ''}`);
    },
    system: () => request<OpsSystem>('GET', '/ops/system'),
    ledgerAccounts: () => request<LedgerAccount[]>('GET', '/ops/ledger/accounts'),
    ledgerAccount: (id: string) => request<AccountLedger>('GET', `/ops/ledger/accounts/${id}`),
    journals: (params: { kind?: string; accountId?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.kind) q.set('kind', params.kind);
      if (params.accountId) q.set('accountId', params.accountId);
      if (params.limit) q.set('limit', String(params.limit));
      return request<Journal[]>('GET', `/ops/ledger/journals${q.size ? `?${q}` : ''}`);
    },
    journal: (id: string) => request<Journal>('GET', `/ops/ledger/journals/${id}`),
  },
};

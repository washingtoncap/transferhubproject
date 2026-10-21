import { randomUUID } from 'node:crypto';
import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { recordAudit } from '@transferhub/platform';
import {
  createEntity,
  createSession,
  hashPassword,
  newTotpSecret,
  registerCustomer,
  type SessionUser,
  sessionFromToken,
} from './auth';
import { allocate, inviteChild, respondToInvitation, setChildRate } from './network';
import { acceptQuote, createQuote } from './fx';
import { subscribe } from './billing';
import { createDeposit } from './deposits';
import {
  addBeneficiary,
  decideWithdrawal,
  requestWithdrawal,
  submitWithdrawal,
} from './withdrawals';
import { partnerCompletePayout, simulateBankCredit } from './partner';
import { processPartnerEvent } from './jobs';
import { decideCustomer } from './ops';
import { updateProfile, submitOnboarding } from './entities';
import { postJournal, systemAccountId } from './ledger';
import { totpAt } from './auth';

export const DEMO_PASSWORD = 'Sandbox!2026';

/**
 * Demo data for the sandbox. Everything goes through the real services — registration, KYC
 * decisions, signed partner webhooks, quotes, approvals and payouts — so the ledger, audit log and
 * reconciliation are exactly what real usage would produce. Never run against production.
 */
export async function seedDemo(
  pool: Pool,
  partnerSecret: string,
  log: (msg: string) => void = () => undefined,
) {
  const exists = await pool.query(
    `SELECT 1 FROM app.users WHERE email = 'ops@transparenttransfers.com'`,
  );
  if (exists.rowCount) {
    log('Demo data already present.');
    await ensureQuickLogins(pool, log);
    return;
  }
  const k = () => `seed-${randomUUID()}`;

  // ---------------------------------------------------------------- staff
  const staff = async (email: string, name: string, roles: string[]) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO app.users (email, full_name, phone, password_hash, email_verified_at, phone_verified_at, mfa_secret, mfa_enabled_at, is_staff, staff_roles)
       VALUES ($1, $2, '+1 868 555 0100', $3, now(), now(), $4, now(), true, $5) RETURNING id`,
      [email, name, await hashPassword(DEMO_PASSWORD), newTotpSecret(), roles],
    );
    return asUser(pool, rows[0]!.id);
  };
  const kyle = await staff('kyle@transparenttransfers.com', 'Kyle Chung', ['admin']);
  const opsUser = await staff('ops@transparenttransfers.com', 'Renee Baptiste', ['operations']);
  const compliance = await staff('compliance@transparenttransfers.com', 'Andre Mohammed', [
    'compliance',
  ]);
  const finance = await staff('finance@transparenttransfers.com', 'Simone Clarke', [
    'finance',
    'treasury',
  ]);
  log('Staff created');

  // ---------------------------------------------------------------- opening principal float
  // The liquidity principal's own money at the partner (TH-FIN: illustrative US$50,000), kept
  // separate from customer funds. Both our ledger and the partner statement record it.
  for (const [asset, amount] of [
    ['USD', 5_000_000],
    ['TTD', 40_000_000],
  ] as const) {
    const lineId = `stmt_opening_${asset}`;
    await withTransaction(pool, async (tx) => {
      await tx.query(
        `INSERT INTO sandbox.partner_statement (asset, amount_minor, description, reference, external_event_id) VALUES ($1, $2, $3, 'PRINCIPAL-FLOAT', $4)`,
        [asset, amount, 'Principal liquidity float', lineId],
      );
      await postJournal(tx, {
        kind: 'opening_float',
        sourceType: 'partner_statement',
        sourceId: lineId,
        memo: `Principal float ${asset}`,
        createdBy: `user:${finance.userId}`,
        lines: [
          {
            accountId: await systemAccountId(tx, 'provider_cash', asset),
            asset,
            amountMinor: amount,
            lineType: 'partner_cash_in',
          },
          {
            accountId: await systemAccountId(tx, 'fx_principal', asset),
            asset,
            amountMinor: -amount,
            lineType: 'principal_float',
          },
        ],
      });
      await recordAudit(tx, {
        actorType: 'staff',
        actorId: finance.userId,
        action: 'treasury.opening_float',
        objectType: 'ledger_account',
        objectId: `system:fx_principal:${asset}`,
        reason: 'Sandbox principal float',
        after: { amount },
      });
    });
  }
  log('Principal float funded');

  // ---------------------------------------------------------------- helpers
  const customer = async (input: {
    email: string;
    fullName: string;
    kind: 'individual' | 'business';
    role: 'buyer' | 'seller';
    legalName: string;
    profile: Record<string, unknown>;
    decision?: 'approve' | 'submit_only' | 'draft';
    risk?: 'low' | 'medium' | 'high';
  }) => {
    const r = await registerCustomer(pool, {
      email: input.email,
      password: DEMO_PASSWORD,
      fullName: input.fullName,
      phone: '+1 868 555 0199',
      kind: input.kind,
      customerRole: input.role,
      legalName: input.legalName,
    });
    await pool.query('UPDATE app.users SET mfa_enabled_at = now() WHERE id = $1', [r.userId]);
    const user = await asUser(pool, r.userId);
    await updateProfile(pool, user, r.entityId, input.profile);
    if (input.decision !== 'draft') await submitOnboarding(pool, user, r.entityId);
    if (input.decision === 'approve' || input.decision === undefined) {
      await decideCustomer(pool, compliance, r.entityId, {
        decision: 'approve',
        riskRating: input.risk ?? 'low',
        reason: 'Identity, ownership and source of funds verified (sandbox vendor check).',
      });
    }
    const { rows } = await pool.query<{ reference_code: string }>(
      'SELECT reference_code FROM app.entities WHERE id = $1',
      [r.entityId],
    );
    return { user, entityId: r.entityId, code: rows[0]!.reference_code };
  };

  /** Customer files a deposit claim, then the (simulated) bank receives it and tells us. */
  const fund = async (
    c: { user: SessionUser; entityId: string },
    asset: 'USD' | 'TTD',
    amountMinor: number,
    sender: string,
  ) => {
    const claim = await createDeposit(
      pool,
      c.user,
      c.entityId,
      { asset, amountMinor, receiptNote: 'Wire confirmation attached' },
      k(),
    );
    const r = await simulateBankCredit(pool, partnerSecret, {
      asset,
      amountMinor,
      reference: claim.reference,
      senderName: sender,
    });
    await drainPartnerEvents(pool);
    return { claim, r };
  };

  const trade = async (
    c: { user: SessionUser; entityId: string },
    side: 'buy_usd' | 'sell_usd',
    usdMinor: number,
  ) => {
    const q = await createQuote(pool, c.user, c.entityId, { side, usdMinor });
    return acceptQuote(pool, c.user, c.entityId, q.id, k());
  };

  const bizProfile = (activity: string, owners: Array<[string, number]>, monthly: number) => ({
    address: '14 Frederick Street, Port of Spain, Trinidad and Tobago',
    registrationNumber: `C${Math.floor(10000 + Math.random() * 89999)}`,
    businessActivity: activity,
    beneficialOwners: owners.map(([name, ownershipPercent]) => ({ name, ownershipPercent })),
    purpose: 'Settling USD trade and supplier payments',
    expectedMonthlyUsd: monthly,
    sourceOfFunds: 'Business revenue',
  });
  const indProfile = (occupation: string, monthly: number) => ({
    address: '7 Coblentz Avenue, Cascade, Trinidad and Tobago',
    dateOfBirth: '1986-04-12',
    occupation,
    purpose: 'Converting USD income to TTD',
    expectedMonthlyUsd: monthly,
    sourceOfFunds: 'Employment and contract income',
  });

  // ---------------------------------------------------------------- main seller + child
  const island = await customer({
    email: 'marcus@islandremit.tt',
    fullName: 'Marcus Joseph',
    kind: 'business',
    role: 'seller',
    legalName: 'Island Remit Agents Ltd',
    profile: bizProfile(
      'USD remittance agent network',
      [
        ['Marcus Joseph', 60],
        ['Kerry-Ann Joseph', 40],
      ],
      80000,
    ),
    risk: 'medium',
  });
  await fund(island, 'TTD', 9_000_000, 'Island Remit Agents Ltd');
  await fund(island, 'USD', 1_200_000, 'Island Remit Agents Ltd');
  await subscribe(
    pool,
    island.user,
    island.entityId,
    { planCode: 'seller_network', billingInterval: 'monthly', consent: true },
    k(),
  );
  await trade(island, 'sell_usd', 500_000); // US$5,000 at 8.0000

  const pos = await customer({
    email: 'priya@postraders.tt',
    fullName: 'Priya Ramsaran',
    kind: 'business',
    role: 'seller',
    legalName: 'Port of Spain Traders',
    profile: bizProfile('Retail and import agent', [['Priya Ramsaran', 100]], 15000),
  });
  const link = await inviteChild(pool, island.user, island.entityId, {
    childReferenceCode: pos.code,
    childRateE4: 77000,
  });
  await respondToInvitation(pool, pos.user, pos.entityId, link.id, true, true);
  await fund(pos, 'USD', 500_000, 'Port of Spain Traders');
  await trade(pos, 'sell_usd', 100_000); // the documented example: US$1,000 at 7.70 → 7,700 + 300 to parent
  await trade(pos, 'sell_usd', 150_000);
  await allocate(
    pool,
    island.user,
    island.entityId,
    { childEntityId: pos.entityId, amountMinor: 200_000 },
    k(),
  );

  const sando = await customer({
    email: 'devon@sandoagents.tt',
    fullName: 'Devon Persad',
    kind: 'individual',
    role: 'seller',
    legalName: 'Devon Persad',
    profile: indProfile('Independent remittance agent', 6000),
  });
  const link2 = await inviteChild(pool, island.user, island.entityId, {
    childReferenceCode: sando.code,
    childRateE4: 76500,
  });
  await respondToInvitation(pool, sando.user, sando.entityId, link2.id, true, true);
  await fund(sando, 'USD', 300_000, 'Devon Persad');
  await trade(sando, 'sell_usd', 200_000);
  await setChildRate(pool, island.user, island.entityId, link2.id, 77000);
  log('Seller network created');

  // ---------------------------------------------------------------- individual seller (pending invitation)
  const daniel = await customer({
    email: 'daniel.ramdial@example.tt',
    fullName: 'Daniel Ramdial',
    kind: 'individual',
    role: 'seller',
    legalName: 'Daniel Ramdial',
    profile: indProfile('Software contractor (US clients)', 4000),
  });
  await fund(daniel, 'USD', 350_000, 'Daniel Ramdial');
  await trade(daniel, 'sell_usd', 150_000); // standard rate, no plan
  const danielBen = await addBeneficiary(pool, daniel.user, daniel.entityId, {
    label: 'Republic Bank chequing',
    bankName: 'Republic Bank',
    accountHolder: 'Daniel Ramdial',
    accountNumber: '410055512345',
    currency: 'TTD',
  });
  const w1 = await requestWithdrawal(
    pool,
    daniel.user,
    daniel.entityId,
    {
      beneficiaryId: danielBen.id,
      asset: 'TTD',
      amountMinor: 500_000,
      mfaCode: await code(pool, daniel.user.userId),
    },
    k(),
  );
  await decideWithdrawal(pool, opsUser, w1.id, 'approve', 'Beneficiary verified; within limits');
  await runPayout(pool, partnerSecret, w1.id);
  await inviteChild(pool, island.user, island.entityId, {
    childReferenceCode: daniel.code,
    childRateE4: 76000,
  });
  log('Individual seller created');

  // ---------------------------------------------------------------- business buyer
  const carib = await customer({
    email: 'ana@caribimports.tt',
    fullName: 'Ana Lopez',
    kind: 'business',
    role: 'buyer',
    legalName: 'Caribbean Imports Ltd',
    profile: bizProfile(
      'Food and hardware importer',
      [
        ['Ana Lopez', 55],
        ['Ricardo Lopez', 30],
        ['Carib Holdings SRL', 15],
      ],
      40000,
    ),
  });
  await fund(carib, 'TTD', 12_000_000, 'Caribbean Imports Ltd');
  await subscribe(
    pool,
    carib.user,
    carib.entityId,
    { planCode: 'buyer_plus', billingInterval: 'annual', consent: true },
    k(),
  );
  await trade(carib, 'buy_usd', 500_000);
  await trade(carib, 'buy_usd', 250_000);
  const caribBen = await addBeneficiary(pool, carib.user, carib.entityId, {
    label: 'Miami supplier — Sunshine Foods',
    bankName: 'Truist Bank',
    accountHolder: 'Sunshine Foods Wholesale LLC',
    accountNumber: '0098776543',
    currency: 'USD',
  });
  await requestWithdrawal(
    pool,
    carib.user,
    carib.entityId,
    {
      beneficiaryId: caribBen.id,
      asset: 'USD',
      amountMinor: 300_000,
      mfaCode: await code(pool, carib.user.userId),
    },
    k(),
  );
  await createDeposit(
    pool,
    carib.user,
    carib.entityId,
    { asset: 'TTD', amountMinor: 2_500_000, receiptNote: 'RBC transfer slip #88213' },
    k(),
  );
  log('Business buyer created');

  // ---------------------------------------------------------------- large withdrawal needing two approvers
  const islandBen = await addBeneficiary(pool, island.user, island.entityId, {
    label: 'First Citizens operating',
    bankName: 'First Citizens Bank',
    accountHolder: 'Island Remit Agents Ltd',
    accountNumber: '220033445566',
    currency: 'TTD',
  });
  const big = await requestWithdrawal(
    pool,
    island.user,
    island.entityId,
    {
      beneficiaryId: islandBen.id,
      asset: 'TTD',
      amountMinor: 4_000_000,
      mfaCode: await code(pool, island.user.userId),
    },
    k(),
  );
  await decideWithdrawal(pool, opsUser, big.id, 'approve', 'First approval — agent float top-up');

  // ---------------------------------------------------------------- review queue
  await customer({
    email: 'sasha.mohammed@example.tt',
    fullName: 'Sasha Mohammed',
    kind: 'individual',
    role: 'buyer',
    legalName: 'Sasha Mohammed',
    profile: indProfile('Physician', 2500),
    decision: 'submit_only',
  });
  await customer({
    email: 'compliance.demo@globalmatch.example',
    fullName: 'Lionel Hart',
    kind: 'business',
    role: 'buyer',
    legalName: 'Global Match Trading LLC',
    profile: bizProfile(
      'General trading',
      [
        ['Lionel Hart', 20],
        ['Undisclosed nominee', 80],
      ],
      250000,
    ),
    decision: 'submit_only',
  });

  // ---------------------------------------------------------------- an unmatched bank credit (reconciliation break demo)
  await simulateBankCredit(pool, partnerSecret, {
    asset: 'TTD',
    amountMinor: 150_000,
    reference: 'INV-4471',
    senderName: 'Unknown — no reference',
  });
  await drainPartnerEvents(pool);

  await recordAudit(pool, {
    actorType: 'system',
    actorId: 'seed',
    action: 'sandbox.demo_data_loaded',
    objectType: 'sandbox',
    objectId: 'demo',
    after: { by: kyle.email },
  });
  log('Demo data loaded');
  await ensureQuickLogins(pool, log);
}

/**
 * Simple role-based sign-ins for demos:
 *   admin@transferhub.com    full console
 *   finance@transferhub.com  finance dashboard
 *   buyer@transferhub.com    owner of Caribbean Imports Ltd (buyer)
 *   seller@transferhub.com   owner of Island Remit Agents Ltd (main seller)
 * Safe to run repeatedly.
 */
export async function ensureQuickLogins(pool: Pool, log: (msg: string) => void = () => undefined) {
  const add = async (email: string, name: string, staffRoles: string[], entityName?: string) => {
    const found = await pool.query('SELECT 1 FROM app.users WHERE email = $1', [email]);
    if (found.rowCount) return;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO app.users (email, full_name, phone, password_hash, email_verified_at, phone_verified_at, mfa_secret, mfa_enabled_at, is_staff, staff_roles)
       VALUES ($1, $2, '+1 868 555 0100', $3, now(), now(), $4, now(), $5, $6) RETURNING id`,
      [
        email,
        name,
        await hashPassword(DEMO_PASSWORD),
        newTotpSecret(),
        staffRoles.length > 0,
        staffRoles,
      ],
    );
    if (entityName) {
      await pool.query(
        `INSERT INTO app.memberships (user_id, entity_id, role) SELECT $1, id, 'owner' FROM app.entities WHERE legal_name = $2`,
        [rows[0]!.id, entityName],
      );
    }
    await recordAudit(pool, {
      actorType: 'system',
      actorId: 'seed',
      action: 'user.quick_login_created',
      objectType: 'user',
      objectId: rows[0]!.id,
      metadata: { email },
    });
    log(`Created ${email}`);
  };
  await add('admin@transferhub.com', 'TransferHub Admin', ['admin']);
  await add('finance@transferhub.com', 'TransferHub Finance', ['finance', 'treasury']);
  await add('buyer@transferhub.com', 'Demo Buyer (Caribbean Imports)', [], 'Caribbean Imports Ltd');
  await add('seller@transferhub.com', 'Demo Seller (Island Remit)', [], 'Island Remit Agents Ltd');
}

async function asUser(pool: Pool, userId: string): Promise<SessionUser> {
  const s = await createSession(pool, userId, 'seed');
  await pool.query('UPDATE app.sessions SET mfa_verified_at = now() WHERE id = $1', [s.sessionId]);
  return (await sessionFromToken(pool, s.token))!;
}

async function code(pool: Pool, userId: string): Promise<string> {
  const { rows } = await pool.query<{ mfa_secret: string }>(
    'SELECT mfa_secret FROM app.users WHERE id = $1',
    [userId],
  );
  return totpAt(rows[0]!.mfa_secret, Date.now());
}

/** Processes any received partner events right away (the worker would do this a moment later). */
export async function drainPartnerEvents(pool: Pool) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM platform.inbox WHERE status = 'received' ORDER BY received_at`,
  );
  for (const r of rows) await processPartnerEvent(pool, r.id);
}

async function runPayout(pool: Pool, secret: string, withdrawalId: string) {
  await submitWithdrawal(pool, withdrawalId);
  const { rows } = await pool.query<{ partner_reference: string }>(
    'SELECT partner_reference FROM app.withdrawals WHERE id = $1',
    [withdrawalId],
  );
  await partnerCompletePayout(pool, secret, rows[0]!.partner_reference);
  await drainPartnerEvents(pool);
}

export { createEntity };

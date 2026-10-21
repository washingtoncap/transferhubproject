import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@transferhub/db';
import { testPool, uniq } from '../../../test/db';
import { createSession, registerCustomer, type SessionUser, sessionFromToken, totpAt } from './auth';
import { requireMember } from './access';
import { balances, updateProfile, submitOnboarding } from './entities';
import { acceptQuote, createQuote } from './fx';
import { allocate, inviteChild, respondToInvitation, setChildRate } from './network';
import { subscribe } from './billing';
import { createDeposit } from './deposits';
import { addBeneficiary, decideWithdrawal, queryWithdrawalStatus, requestWithdrawal, submitWithdrawal } from './withdrawals';
import { partnerCompletePayout, simulateBankCredit, ingestPartnerWebhook, signPartnerBody } from './partner';
import { processPartnerEvent } from './jobs';
import { decideCustomer, reconciliation } from './ops';
import { postJournal, systemAccountId, trialBalance, usdToTtd } from './index';
import { drainPartnerEvents } from './seed';
import { hashPassword, newTotpSecret } from './auth';

const pool = testPool(30);
const SECRET = 'whsec_test_secret_123456';
const k = () => `test-${randomUUID()}`;
afterAll(() => pool.end());

async function asUser(userId: string): Promise<SessionUser> {
  const s = await createSession(pool, userId);
  await pool.query('UPDATE app.sessions SET mfa_verified_at = now() WHERE id = $1', [s.sessionId]);
  return (await sessionFromToken(pool, s.token))!;
}

let compliance: SessionUser;
let opsA: SessionUser;
let opsB: SessionUser;

async function staffUser(roles: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app.users (email, full_name, password_hash, mfa_secret, mfa_enabled_at, is_staff, staff_roles)
     VALUES ($1, 'Staff', $2, $3, now(), true, $4) RETURNING id`,
    [`${uniq('staff')}@example.com`, await hashPassword('x'.repeat(12)), newTotpSecret(), roles],
  );
  return asUser(rows[0]!.id);
}

async function approvedCustomer(role: 'buyer' | 'seller', kind: 'individual' | 'business' = 'individual') {
  const email = `${uniq('c')}@example.com`;
  const r = await registerCustomer(pool, { email, password: 'correct-horse-1', fullName: 'Test Person', phone: '+1 868 555 0100', kind, customerRole: role, legalName: `Test ${uniq('co')}` });
  const user = await asUser(r.userId);
  await updateProfile(pool, user, r.entityId, kind === 'individual'
    ? { address: 'x', dateOfBirth: '1990-01-01', occupation: 'x', purpose: 'x', expectedMonthlyUsd: 1000, sourceOfFunds: 'x' }
    : { address: 'x', registrationNumber: 'x', businessActivity: 'x', beneficialOwners: [{ name: 'A', ownershipPercent: 100 }], purpose: 'x', expectedMonthlyUsd: 1000, sourceOfFunds: 'x' });
  await submitOnboarding(pool, user, r.entityId);
  await decideCustomer(pool, compliance, r.entityId, { decision: 'approve', riskRating: 'low', reason: 'test' });
  const { rows } = await pool.query<{ reference_code: string }>('SELECT reference_code FROM app.entities WHERE id = $1', [r.entityId]);
  return { user, entityId: r.entityId, code: rows[0]!.reference_code };
}

async function fund(c: { user: SessionUser; entityId: string }, asset: 'USD' | 'TTD', amountMinor: number) {
  const claim = await createDeposit(pool, c.user, c.entityId, { asset, amountMinor }, k());
  await simulateBankCredit(pool, SECRET, { asset, amountMinor, reference: claim.reference, senderName: 'Test' });
  await drainPartnerEvents(pool);
  return claim;
}

const available = async (entityId: string, asset: 'USD' | 'TTD') => (await balances(pool, entityId)).find((b) => b.asset === asset)!.availableMinor;
const mfa = async (userId: string) => {
  const { rows } = await pool.query<{ mfa_secret: string }>('SELECT mfa_secret FROM app.users WHERE id = $1', [userId]);
  return totpAt(rows[0]!.mfa_secret, Date.now());
};

beforeAll(async () => {
  compliance = await staffUser(['compliance']);
  opsA = await staffUser(['operations']);
  opsB = await staffUser(['finance']);
  // Principal float so trades can execute.
  await withTransaction(pool, async (tx) => {
    for (const [asset, amount] of [['USD', 100_000_000], ['TTD', 900_000_000]] as const) {
      const id = `stmt_test_float_${asset}_${uniq()}`;
      await tx.query(`INSERT INTO sandbox.partner_statement (asset, amount_minor, description, external_event_id) VALUES ($1, $2, 'float', $3)`, [asset, amount, id]);
      await postJournal(tx, {
        kind: 'opening_float', sourceType: 'partner_statement', sourceId: id, memo: 'test float', createdBy: 'test',
        lines: [
          { accountId: await systemAccountId(tx, 'provider_cash', asset), asset, amountMinor: amount, lineType: 'partner_cash_in' },
          { accountId: await systemAccountId(tx, 'fx_principal', asset), asset, amountMinor: -amount, lineType: 'principal_float' },
        ],
      });
    }
  });
});

describe('money arithmetic', () => {
  it('converts exactly with half-up rounding', () => {
    expect(usdToTtd(100_000, 77_000)).toBe(770_000); // US$1,000 × 7.70 = TT$7,700.00
    expect(usdToTtd(1, 82_200)).toBe(8); // 0.822 → 1 cent? 0.0822 TTD cents… 8.22 cents rounds to 8
    expect(usdToTtd(3, 81_667)).toBe(25); // 24.5001 → 25
  });
});

describe('ledger integrity (NFR-01)', () => {
  it('rejects an unbalanced journal at the database, even if application checks are bypassed', async () => {
    const cash = await systemAccountId(pool, 'provider_cash', 'USD');
    await expect(
      withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO ledger.journals (kind, source_type, source_id, memo, created_by) VALUES ('reversal', 'test', $1, 'bad', 'test') RETURNING id`,
          [uniq()],
        );
        await tx.query(`INSERT INTO ledger.postings (journal_id, account_id, asset, amount_minor, line_type) VALUES ($1, $2, 'USD', 100, 'x')`, [rows[0]!.id, cash]);
      }),
    ).rejects.toThrow(/does not balance|fewer than two/);
  });

  it('never allows a posting to be edited or deleted', async () => {
    await expect(pool.query('UPDATE ledger.postings SET amount_minor = 1 WHERE id = (SELECT min(id) FROM ledger.postings)')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger.postings WHERE id = (SELECT min(id) FROM ledger.postings)')).rejects.toThrow(/append-only/);
  });
});

describe('deposits (DEP-01, DEP-02, AT04)', () => {
  it('a claim alone never makes money spendable', async () => {
    const c = await approvedCustomer('seller');
    await createDeposit(pool, c.user, c.entityId, { asset: 'USD', amountMinor: 50_000, receiptNote: 'edited receipt' }, k());
    const b = (await balances(pool, c.entityId)).find((x) => x.asset === 'USD')!;
    expect(b.availableMinor).toBe(0);
    expect(b.pendingDepositsMinor).toBe(50_000);
  });

  it('a duplicate partner statement produces exactly one posting', async () => {
    const c = await approvedCustomer('seller');
    const claim = await createDeposit(pool, c.user, c.entityId, { asset: 'USD', amountMinor: 70_000 }, k());
    const input = { asset: 'USD', amountMinor: 70_000, reference: claim.reference, senderName: 'x' };
    await simulateBankCredit(pool, SECRET, input);
    const again = await simulateBankCredit(pool, SECRET, input);
    expect(again.outcome).toBe('redelivered: duplicate');
    await drainPartnerEvents(pool);
    expect(await available(c.entityId, 'USD')).toBe(70_000);
  });

  it('an unsigned or wrongly signed webhook never creates value', async () => {
    const c = await approvedCustomer('seller');
    const claim = await createDeposit(pool, c.user, c.entityId, { asset: 'USD', amountMinor: 90_000 }, k());
    const body = JSON.stringify({ eventId: uniq('evt'), type: 'statement.credit', data: { statementLineId: uniq(), asset: 'USD', amountMinor: 90_000, reference: claim.reference } });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await ingestPartnerWebhook(pool, { secret: SECRET, rawBody: body, timestamp: ts, signature: signPartnerBody('wrong-secret-0000', ts, body) });
    expect(r.outcome).toBe('rejected');
    await drainPartnerEvents(pool);
    expect(await available(c.entityId, 'USD')).toBe(0);
  });

  it('processing the same event twice posts once', async () => {
    const c = await approvedCustomer('seller');
    const claim = await createDeposit(pool, c.user, c.entityId, { asset: 'TTD', amountMinor: 40_000 }, k());
    const { eventId } = await simulateBankCredit(pool, SECRET, { asset: 'TTD', amountMinor: 40_000, reference: claim.reference, senderName: 'x' });
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM platform.inbox WHERE external_event_id = $1 AND signature_valid`, [eventId]);
    await Promise.all([processPartnerEvent(pool, rows[0]!.id), processPartnerEvent(pool, rows[0]!.id)]);
    expect(await available(c.entityId, 'TTD')).toBe(40_000);
  });
});

describe('exchange (FX-01..03)', () => {
  it('concurrent accepts can never overspend one balance', async () => {
    const c = await approvedCustomer('seller');
    await fund(c, 'USD', 100_000); // US$1,000
    const quotes = await Promise.all(Array.from({ length: 5 }, () => createQuote(pool, c.user, c.entityId, { side: 'sell_usd', usdMinor: 40_000 })));
    const results = await Promise.allSettled(quotes.map((q) => acceptQuote(pool, c.user, c.entityId, q.id, k())));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2); // 2 × US$400 fits in US$1,000; the 3rd would overspend
    expect(await available(c.entityId, 'USD')).toBe(20_000);
    expect(Object.values(await trialBalance(pool))).toEqual([0, 0]);
  });

  it('a retried accept with the same key trades once', async () => {
    const c = await approvedCustomer('seller');
    await fund(c, 'USD', 100_000);
    const q = await createQuote(pool, c.user, c.entityId, { side: 'sell_usd', usdMinor: 50_000 });
    const key = k();
    const [a, b] = await Promise.all([acceptQuote(pool, c.user, c.entityId, q.id, key), acceptQuote(pool, c.user, c.entityId, q.id, key)]);
    expect(a.id).toBe(b.id);
    expect(await available(c.entityId, 'USD')).toBe(50_000);
  });

  it('an expired quote cannot be accepted', async () => {
    const c = await approvedCustomer('seller');
    await fund(c, 'USD', 100_000);
    const q = await createQuote(pool, c.user, c.entityId, { side: 'sell_usd', usdMinor: 10_000 });
    await pool.query(`UPDATE app.quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [q.id]);
    await expect(acceptQuote(pool, c.user, c.entityId, q.id, k())).rejects.toMatchObject({ code: 'quote_expired' });
  });

  it('unverified customers cannot trade', async () => {
    const r = await registerCustomer(pool, { email: `${uniq()}@example.com`, password: 'correct-horse-1', fullName: 'x', phone: '+18685550100', kind: 'individual', customerRole: 'buyer', legalName: 'x' });
    const u = await asUser(r.userId);
    await expect(createQuote(pool, u, r.entityId, { side: 'buy_usd', usdMinor: 10_000 })).rejects.toMatchObject({ code: 'not_approved' });
  });
});

describe('seller network (SEL-01..04, AT03)', () => {
  it('credits child proceeds and parent margin separately: US$1,000 at 8.00/7.70 → 7,700 + 300', async () => {
    const parent = await approvedCustomer('seller', 'business');
    await fund(parent, 'TTD', 1_000_000);
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_network', billingInterval: 'monthly', consent: true }, k());
    const child = await approvedCustomer('seller', 'business');
    const link = await inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: child.code, childRateE4: 77000 });
    await respondToInvitation(pool, child.user, child.entityId, link.id, true, true);
    await fund(child, 'USD', 100_000);
    const parentBefore = await available(parent.entityId, 'TTD');
    const q = await createQuote(pool, child.user, child.entityId, { side: 'sell_usd', usdMinor: 100_000 });
    expect(q).toMatchObject({ rateE4: 77000, ttdMinor: 770_000, parentMarginMinor: 30_000 });
    await acceptQuote(pool, child.user, child.entityId, q.id, k());
    expect(await available(child.entityId, 'TTD')).toBe(770_000);
    expect((await available(parent.entityId, 'TTD')) - parentBefore).toBe(30_000);
  });

  it('a child rate can never exceed the parent rate, and buyers cannot be invited', async () => {
    const parent = await approvedCustomer('seller', 'business');
    await fund(parent, 'TTD', 1_000_000);
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_growth', billingInterval: 'monthly', consent: true }, k());
    const child = await approvedCustomer('seller');
    await expect(inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: child.code, childRateE4: 78000 })).rejects.toMatchObject({ code: 'child_rate_exceeds_parent' });
    const buyer = await approvedCustomer('buyer');
    await expect(inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: buyer.code, childRateE4: 76000 })).rejects.toMatchObject({ code: 'not_a_seller' });
  });

  it('networks are one level: a child cannot invite its own children', async () => {
    const parent = await approvedCustomer('seller', 'business');
    await fund(parent, 'TTD', 1_000_000);
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_network', billingInterval: 'monthly', consent: true }, k());
    const child = await approvedCustomer('seller');
    const link = await inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: child.code, childRateE4: 77000 });
    await respondToInvitation(pool, child.user, child.entityId, link.id, true, true);
    const grandchild = await approvedCustomer('seller');
    await expect(inviteChild(pool, child.user, child.entityId, { childReferenceCode: grandchild.code, childRateE4: 76000 })).rejects.toMatchObject({ code: 'nested_network' });
  });

  it('a parent-rate fall blocks new child quotes until the child rate is reset (SEL-02)', async () => {
    const parent = await approvedCustomer('seller', 'business');
    await fund(parent, 'TTD', 1_000_000);
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_network', billingInterval: 'monthly', consent: true }, k());
    const child = await approvedCustomer('seller');
    const link = await inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: child.code, childRateE4: 79000 });
    await respondToInvitation(pool, child.user, child.entityId, link.id, true, true);
    await fund(child, 'USD', 100_000);
    // Parent downgrades to Essential (7.50): the child's 7.90 is now above the parent.
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_essential', billingInterval: 'monthly', consent: true }, k());
    await expect(createQuote(pool, child.user, child.entityId, { side: 'sell_usd', usdMinor: 10_000 })).rejects.toMatchObject({ code: 'child_rate_exceeds_parent' });
    await setChildRate(pool, parent.user, parent.entityId, link.id, 75000);
    await expect(createQuote(pool, child.user, child.entityId, { side: 'sell_usd', usdMinor: 10_000 })).resolves.toMatchObject({ rateE4: 75000 });
  });

  it('allocation debits only the parent, never the child (SEL-04)', async () => {
    const parent = await approvedCustomer('seller', 'business');
    await fund(parent, 'TTD', 1_000_000);
    await subscribe(pool, parent.user, parent.entityId, { planCode: 'seller_growth', billingInterval: 'monthly', consent: true }, k());
    const child = await approvedCustomer('seller');
    const link = await inviteChild(pool, parent.user, parent.entityId, { childReferenceCode: child.code, childRateE4: 76000 });
    await respondToInvitation(pool, child.user, child.entityId, link.id, true, true);
    const before = await available(parent.entityId, 'TTD');
    await allocate(pool, parent.user, parent.entityId, { childEntityId: child.entityId, amountMinor: 200_000 }, k());
    expect(await available(child.entityId, 'TTD')).toBe(200_000);
    expect(before - (await available(parent.entityId, 'TTD'))).toBe(200_000);
    await expect(allocate(pool, parent.user, parent.entityId, { childEntityId: child.entityId, amountMinor: 99_000_000 }, k())).rejects.toMatchObject({ code: 'insufficient_available_funds' });
  });
});

describe('withdrawals (WDR-01, WDR-02, AT05, AT06)', () => {
  async function setup(amountMinor: number, asset: 'USD' | 'TTD' = 'USD') {
    const c = await approvedCustomer('seller');
    await fund(c, asset, 2_000_000);
    const ben = await addBeneficiary(pool, c.user, c.entityId, { label: 'x', bankName: 'x', accountHolder: 'x', accountNumber: '1234567890', currency: asset });
    const w = await requestWithdrawal(pool, c.user, c.entityId, { beneficiaryId: ben.id, asset, amountMinor, mfaCode: await mfa(c.user.userId) }, k());
    return { c, w };
  }
  const status = async (id: string) => (await pool.query<{ status: string }>('SELECT status FROM app.withdrawals WHERE id = $1', [id])).rows[0]!.status;
  const partnerRef = async (id: string) => (await pool.query<{ partner_reference: string }>('SELECT partner_reference FROM app.withdrawals WHERE id = $1', [id])).rows[0]!.partner_reference;

  it('requires a fresh MFA code', async () => {
    const c = await approvedCustomer('seller');
    await fund(c, 'USD', 100_000);
    const ben = await addBeneficiary(pool, c.user, c.entityId, { label: 'x', bankName: 'x', accountHolder: 'x', accountNumber: '1234567890', currency: 'USD' });
    await expect(requestWithdrawal(pool, c.user, c.entityId, { beneficiaryId: ben.id, asset: 'USD', amountMinor: 10_000, mfaCode: '000000' }, k())).rejects.toMatchObject({ code: 'invalid_mfa_code' });
  });

  it('holds funds, needs two different approvers above the threshold, then settles once', async () => {
    const { c, w } = await setup(600_000); // US$6,000 ≥ US$5,000 threshold
    expect(w.requiredApprovals).toBe(2);
    expect(await available(c.entityId, 'USD')).toBe(1_400_000);
    await decideWithdrawal(pool, opsA, w.id, 'approve');
    await expect(decideWithdrawal(pool, opsA, w.id, 'approve')).rejects.toMatchObject({ code: 'already_decided' });
    expect(await status(w.id)).toBe('pending_approval');
    await decideWithdrawal(pool, opsB, w.id, 'approve');
    expect(await status(w.id)).toBe('approved');
    await submitWithdrawal(pool, w.id);
    await partnerCompletePayout(pool, SECRET, await partnerRef(w.id));
    await drainPartnerEvents(pool);
    await drainPartnerEvents(pool);
    expect(await status(w.id)).toBe('settled');
    const b = (await balances(pool, c.entityId)).find((x) => x.asset === 'USD')!;
    expect(b).toMatchObject({ ledgerMinor: 1_400_000, heldMinor: 0, availableMinor: 1_400_000 });
  });

  it('a timeout becomes status_unknown; the status query finds the payout and never pays twice', async () => {
    const { c, w } = await setup(10_077); // .77 → simulated lost response
    await decideWithdrawal(pool, opsA, w.id, 'approve');
    expect(await submitWithdrawal(pool, w.id)).toBe('status_unknown');
    expect(await available(c.entityId, 'USD')).toBe(2_000_000 - 10_077); // still held
    expect(await queryWithdrawalStatus(pool, w.id, 1)).toBe('confirmed_with_partner');
    await partnerCompletePayout(pool, SECRET, await partnerRef(w.id));
    await drainPartnerEvents(pool);
    expect(await status(w.id)).toBe('settled');
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM sandbox.partner_payouts WHERE client_reference = $1`, [w.reference]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('a returned payment releases the hold only after the partner confirms it (AT06)', async () => {
    const { c, w } = await setup(10_099); // .99 → returned
    await decideWithdrawal(pool, opsA, w.id, 'approve');
    await submitWithdrawal(pool, w.id);
    expect(await available(c.entityId, 'USD')).toBe(2_000_000 - 10_099);
    await partnerCompletePayout(pool, SECRET, await partnerRef(w.id));
    await drainPartnerEvents(pool);
    expect(await status(w.id)).toBe('failed');
    expect(await available(c.entityId, 'USD')).toBe(2_000_000);
  });

  it('staff cannot approve withdrawals for an account they belong to', async () => {
    const { c, w } = await setup(10_000);
    await pool.query(`INSERT INTO app.memberships (user_id, entity_id, role) VALUES ($1, $2, 'viewer')`, [opsA.userId, c.entityId]);
    await expect(decideWithdrawal(pool, opsA, w.id, 'approve')).rejects.toMatchObject({ code: 'self_approval' });
  });
});

describe('access control (IAM-02, NFR-02)', () => {
  it('a customer cannot reach another customer’s account even with its id', async () => {
    const a = await approvedCustomer('buyer');
    const b = await approvedCustomer('buyer');
    await expect(requireMember(pool, a.user, b.entityId)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('a viewer cannot move money', async () => {
    const c = await approvedCustomer('buyer');
    const viewer = await registerCustomer(pool, { email: `${uniq()}@example.com`, password: 'correct-horse-1', fullName: 'v', phone: '+18685550100', kind: 'individual', customerRole: 'buyer', legalName: 'v' });
    await pool.query(`INSERT INTO app.memberships (user_id, entity_id, role) VALUES ($1, $2, 'viewer')`, [viewer.userId, c.entityId]);
    const vu = await asUser(viewer.userId);
    await expect(requireMember(pool, vu, c.entityId, ['owner', 'admin', 'approver'])).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('reconciliation (NFR-08)', () => {
  it('stays balanced after all of the above, and flags an unmatched bank credit', async () => {
    const before = await reconciliation(pool);
    expect(before.assets.every((a) => a.trialBalanceMinor === 0)).toBe(true);
    expect(before.assets.every((a) => a.differenceMinor === 0)).toBe(true);
    await simulateBankCredit(pool, SECRET, { asset: 'TTD', amountMinor: 12_345, reference: `NOPE-${uniq()}`, senderName: 'Stranger' });
    await drainPartnerEvents(pool);
    const after = await reconciliation(pool);
    expect(after.assets.find((a) => a.asset === 'TTD')!.differenceMinor).toBe(12_345);
    expect(after.unmatchedStatementLines.some((l) => l.amountMinor === 12_345)).toBe(true);
  });
});

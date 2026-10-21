import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { enqueueJob, type Queryable, recordAudit, recordInbound, verifyHmacSignature } from '@transferhub/platform';
import { DomainError, invalid } from './errors';
import { type Asset, isAsset, toNumber } from './money';

/**
 * Fiat partner integration boundary (D06 is open, so the partner here is simulated).
 *
 * Inbound: the partner sends signed webhooks. We verify the signature, record the event exactly
 * once in the inbox, and process it in a background job. Outbound: payout instructions carry our
 * withdrawal reference, which the partner uses to refuse duplicates.
 *
 * The simulator below keeps its OWN bank record (sandbox.partner_statement), so reconciliation
 * compares two independent records exactly as it will with a real partner statement.
 */

export const PARTNER_SOURCE = 'fiat_partner';

export interface PartnerEvent {
  eventId: string;
  type: 'statement.credit' | 'payout.paid' | 'payout.returned';
  data: Record<string, unknown>;
}

export function signPartnerBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Webhook entry point (HTTP or in-process simulator). */
export async function ingestPartnerWebhook(
  pool: Pool,
  params: { secret: string; rawBody: string; timestamp: string; signature: string },
): Promise<{ outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; inboxId: string }> {
  const valid = verifyHmacSignature({
    secret: params.secret, rawBody: params.rawBody, timestamp: params.timestamp, signatureHex: params.signature,
  });
  let event: PartnerEvent;
  try {
    event = JSON.parse(params.rawBody) as PartnerEvent;
  } catch {
    throw invalid('Webhook body is not JSON.');
  }
  if (!event || typeof event.eventId !== 'string' || typeof event.type !== 'string') throw invalid('Webhook body is missing eventId or type.');

  return withTransaction(pool, async (tx) => {
    const r = await recordInbound(tx, {
      source: PARTNER_SOURCE, externalEventId: event.eventId, eventType: event.type, payload: event as unknown as Record<string, unknown>, signatureValid: valid,
    });
    if (r.kind === 'accepted') {
      await enqueueJob(tx, { type: 'partner.process_event', payload: { inboxId: r.id }, dedupeKey: `partner_event:${r.id}`, priority: 10 });
    }
    if (r.kind === 'conflict' || r.kind === 'rejected') {
      await recordAudit(tx, {
        actorType: 'service', actorId: 'partner-webhook', action: `partner.event_${r.kind}`, objectType: 'inbox_event', objectId: r.id,
        metadata: { eventId: event.eventId, type: event.type },
      });
    }
    return { outcome: r.kind, inboxId: r.id };
  });
}

// ------------------------------------------------------------------------------------------------
// Sandbox partner simulator
// ------------------------------------------------------------------------------------------------
async function deliver(pool: Pool, secret: string, event: PartnerEvent) {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return ingestPartnerWebhook(pool, { secret, rawBody, timestamp, signature: signPartnerBody(secret, timestamp, rawBody) });
}

/**
 * Simulates money arriving in the partner bank account. Re-sending the same reference + amount +
 * currency within 10 minutes re-delivers the SAME event (a duplicate statement line), which is how
 * duplicate-delivery handling (DEP-02, AT04) is demonstrated.
 */
export async function simulateBankCredit(
  pool: Pool,
  secret: string,
  raw: { asset?: unknown; amountMinor?: unknown; reference?: unknown; senderName?: unknown },
) {
  if (!isAsset(raw.asset)) throw invalid('Choose USD or TTD.');
  const amount = Number(raw.amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid('Enter an amount greater than zero.');
  const reference = String(raw.reference ?? '').trim().toUpperCase();
  const sender = String(raw.senderName ?? '').trim() || 'Unknown sender';

  const existing = await pool.query<{ external_event_id: string; occurred_at: Date }>(
    `SELECT external_event_id, occurred_at FROM sandbox.partner_statement
      WHERE asset = $1 AND amount_minor = $2 AND reference = $3 AND occurred_at > now() - interval '10 minutes'
      ORDER BY occurred_at DESC LIMIT 1`,
    [raw.asset, amount, reference],
  );
  let eventId = existing.rows[0]?.external_event_id;
  let occurredAt = existing.rows[0]?.occurred_at;
  if (!eventId) {
    eventId = `stmt_${randomUUID()}`;
    const { rows } = await pool.query<{ occurred_at: Date }>(
      `INSERT INTO sandbox.partner_statement (asset, amount_minor, description, reference, external_event_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING occurred_at`,
      [raw.asset, amount, `Incoming transfer from ${sender}`, reference || null, eventId],
    );
    occurredAt = rows[0]!.occurred_at;
  }
  const r = await deliver(pool, secret, {
    eventId,
    type: 'statement.credit',
    data: { statementLineId: eventId, asset: raw.asset, amountMinor: amount, reference, senderName: sender, occurredAt: occurredAt!.toISOString() },
  });
  return { eventId, outcome: existing.rows[0] ? `redelivered: ${r.outcome}` : r.outcome };
}

export class PartnerTimeoutError extends Error {
  constructor() {
    super('Partner did not respond in time; outcome unknown');
    this.name = 'PartnerTimeoutError';
  }
}

/**
 * Partner payout instruction. Idempotent on our client reference: sending the same instruction
 * twice returns the original payout instead of paying twice. Sandbox behaviours:
 *  - amount ending in .77: the partner accepts the instruction but the response is "lost" the
 *    first time (timeout) — exercising the status-unknown path (FX-03 / WDR-02).
 *  - amount ending in .99: the beneficiary bank later returns the payment.
 */
export async function partnerSubmitPayout(pool: Pool, input: { clientReference: string; asset: Asset; amountMinor: number }) {
  const { rows } = await pool.query<{ partner_reference: string; status: string; created: boolean }>(
    `WITH ins AS (
       INSERT INTO sandbox.partner_payouts (partner_reference, client_reference, asset, amount_minor, status)
       VALUES ($1, $2, $3, $4, 'accepted') ON CONFLICT (client_reference) DO NOTHING
       RETURNING partner_reference, status, true AS created)
     SELECT * FROM ins
     UNION ALL
     SELECT partner_reference, status, false FROM sandbox.partner_payouts WHERE client_reference = $2
     LIMIT 1`,
    [`PP-${randomUUID().slice(0, 8).toUpperCase()}`, input.clientReference, input.asset, input.amountMinor],
  );
  const p = rows[0]!;
  if (p.created) {
    await enqueueJob(pool, {
      type: 'sandbox.partner_complete_payout', payload: { partnerReference: p.partner_reference },
      dedupeKey: `sandbox_complete:${p.partner_reference}`, runAt: new Date(Date.now() + 4000),
    });
    if (input.amountMinor % 100 === 77) throw new PartnerTimeoutError();
  }
  return { partnerReference: p.partner_reference, status: p.status };
}

export async function partnerQueryPayout(db: Queryable, clientReference: string) {
  const { rows } = await db.query<{ partner_reference: string; status: string }>(
    'SELECT partner_reference, status FROM sandbox.partner_payouts WHERE client_reference = $1',
    [clientReference],
  );
  return rows[0] ? { partnerReference: rows[0].partner_reference, status: rows[0].status } : null;
}

/** Sandbox job: the partner finishes a payout and tells us via webhook. */
export async function partnerCompletePayout(pool: Pool, secret: string, partnerReference: string) {
  const { rows } = await pool.query<{ client_reference: string; asset: Asset; amount_minor: string; status: string }>(
    'SELECT client_reference, asset, amount_minor, status FROM sandbox.partner_payouts WHERE partner_reference = $1',
    [partnerReference],
  );
  const p = rows[0];
  if (!p || p.status !== 'accepted') return;
  const amount = toNumber(p.amount_minor);
  if (amount % 100 === 99) {
    await pool.query(`UPDATE sandbox.partner_payouts SET status = 'returned', completed_at = now() WHERE partner_reference = $1`, [partnerReference]);
    await deliver(pool, secret, {
      eventId: `payout_returned_${partnerReference}`,
      type: 'payout.returned',
      data: { partnerReference, clientReference: p.client_reference, reason: 'Returned by beneficiary bank: account closed' },
    });
    return;
  }
  const statementLineId = `stmt_${randomUUID()}`;
  await withTransaction(pool, async (tx) => {
    await tx.query(`UPDATE sandbox.partner_payouts SET status = 'paid', completed_at = now() WHERE partner_reference = $1`, [partnerReference]);
    await tx.query(
      `INSERT INTO sandbox.partner_statement (asset, amount_minor, description, reference, external_event_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.asset, -amount, `Outgoing payout ${partnerReference}`, p.client_reference, statementLineId],
    );
  });
  await deliver(pool, secret, {
    eventId: `payout_paid_${partnerReference}`,
    type: 'payout.paid',
    data: { partnerReference, clientReference: p.client_reference, statementLineId, asset: p.asset, amountMinor: amount },
  });
}

export function requireSandbox(appEnv: string): void {
  if (appEnv === 'production') throw new DomainError('permission_denied', 'The partner simulator is not available in production.', 403);
}

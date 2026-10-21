import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256OfJson } from './hash';
import type { Queryable } from './queryable';

export interface InboundEvent {
  /** Provider or channel, e.g. "fiat_partner". */
  source: string;
  /** The provider's own unique event id. Duplicates of this id are never processed twice. */
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Result of verifying the provider's signature before calling recordInbound. */
  signatureValid: boolean;
}

export type InboundOutcome =
  | { kind: 'accepted'; id: string }
  | { kind: 'rejected'; id: string }
  /** Same event delivered again with identical content: safe to acknowledge, nothing to do. */
  | { kind: 'duplicate'; id: string }
  /** Same event id delivered with DIFFERENT content: acknowledge nothing, alert security. */
  | { kind: 'conflict'; id: string };

/**
 * Records an authentic inbound event exactly once (NFR-03, DEP-02). Events with invalid signatures
 * are kept as evidence with status "rejected", can never be processed (the database enforces this)
 * and never block a later authentic event that carries the same id.
 */
export async function recordInbound(db: Queryable, event: InboundEvent): Promise<InboundOutcome> {
  const hash = sha256OfJson(event.payload);
  const values = [
    event.source,
    event.externalEventId,
    event.eventType,
    JSON.stringify(event.payload),
    hash,
  ];

  if (!event.signatureValid) {
    // Kept as evidence only. Does not reserve the event id, so it can never block the real event.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform.inbox
         (source, external_event_id, event_type, payload, payload_sha256, signature_valid, status)
       VALUES ($1, $2, $3, $4, $5, false, 'rejected')
       RETURNING id`,
      values,
    );
    return { kind: 'rejected', id: rows[0]!.id };
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO platform.inbox
       (source, external_event_id, event_type, payload, payload_sha256, signature_valid, status)
     VALUES ($1, $2, $3, $4, $5, true, 'received')
     ON CONFLICT (source, external_event_id) WHERE signature_valid DO NOTHING
     RETURNING id`,
    values,
  );
  if (inserted.rows[0]) return { kind: 'accepted', id: inserted.rows[0].id };

  const existing = await db.query<{ id: string; payload_sha256: Buffer }>(
    `SELECT id, payload_sha256 FROM platform.inbox
      WHERE source = $1 AND external_event_id = $2 AND signature_valid`,
    [event.source, event.externalEventId],
  );
  const row = existing.rows[0]!;
  if (row.payload_sha256.equals(hash)) return { kind: 'duplicate', id: row.id };

  await db.query(
    `UPDATE platform.inbox SET conflicting_redeliveries = conflicting_redeliveries + 1 WHERE id = $1`,
    [row.id],
  );
  return { kind: 'conflict', id: row.id };
}

/**
 * Verifies an HMAC-SHA256 webhook signature with a timestamp tolerance to block replays of old
 * captured requests. Each provider's actual scheme replaces this once a provider is contracted.
 */
export function verifyHmacSignature(params: {
  secret: string;
  rawBody: string;
  timestamp: string;
  signatureHex: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const ts = Number(params.timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - ts) > (params.toleranceSeconds ?? 300)) return false;

  const expected = createHmac('sha256', params.secret)
    .update(`${params.timestamp}.${params.rawBody}`)
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(params.signatureHex, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

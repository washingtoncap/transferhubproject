import type { Queryable } from './queryable';
import { redact } from './redact';

export type ActorType = 'customer' | 'staff' | 'service' | 'system';

export interface AuditEntry {
  actorType: ActorType;
  actorId: string;
  /** Customer entity (individual or business) the action concerns, if any. */
  entityId?: string | null;
  /** Dotted, lower-case verb, e.g. "membership.role_changed". */
  action: string;
  objectType: string;
  objectId?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  reason?: string | null;
  /** For maker/checker actions. The database rejects approver === actor. */
  approverId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  occurredAt: Date;
  rowHash: Buffer;
}

/**
 * Appends an audit record. Pass the same client used for the state change so both commit together:
 * an action that happened without its audit record, or vice versa, is not possible.
 * Before/after snapshots and metadata are redacted; audit records must not become a secret store.
 */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<AuditRecord> {
  const { rows } = await db.query<{ id: string; occurred_at: Date; row_hash: Buffer }>(
    `INSERT INTO platform.audit_log
       (actor_type, actor_id, entity_id, action, object_type, object_id, request_id,
        correlation_id, reason, approver_id, before_state, after_state, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, occurred_at, row_hash`,
    [
      entry.actorType,
      entry.actorId,
      entry.entityId ?? null,
      entry.action,
      entry.objectType,
      entry.objectId ?? null,
      entry.requestId ?? null,
      entry.correlationId ?? null,
      entry.reason ?? null,
      entry.approverId ?? null,
      entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      JSON.stringify(redact(entry.metadata ?? {})),
    ],
  );
  const row = rows[0]!;
  return { id: String(row.id), occurredAt: row.occurred_at, rowHash: row.row_hash };
}

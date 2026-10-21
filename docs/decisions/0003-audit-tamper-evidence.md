# ADR-0003: Audit log tamper evidence

- Status: Proposed — needs Security Lead decision
- Date: 2026-10-21

## Context

TH-REQ §6: "Retention and tamper resistance require Security approval." The foundation makes the
audit table append-only and stores a SHA-256 of each row's content, computed by the database.

## Options considered

1. **Append-only + per-row hash (implemented).** Detects edits to a row's content if hashes are
   compared against a copy held elsewhere. Does not, by itself, detect a deleted row by someone
   able to disable triggers.
2. **Hash chain inside Postgres.** Each row includes the previous row's hash. Requires serialising
   audit inserts and is fragile under concurrent transactions at different isolation levels.
   Rejected for now.
3. **Ship audit records to separate write-once storage** (e.g. object storage with retention lock,
   or the hosting provider's immutable log service) on a schedule, with periodic hash comparison.

## Recommendation

Keep (1) and add (3) before production, owned by Security, once hosting is selected (D08).

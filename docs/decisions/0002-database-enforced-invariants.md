# ADR-0002: Enforce financial invariants in the database

- Status: Proposed
- Date: 2026-10-21

## Context

TH-SEC §3–4 forbids direct balance edits, journal deletion and self-approval, and requires
duplicate-safe processing. Application checks alone can be bypassed by a bug, a script or an
operator with database access.

## Decision

Where Postgres can express a rule, it enforces it:

- Append-only tables (`audit_log`; no deletes on `outbox`, `inbox`) via triggers that fire for
  every role, including the table owner.
- `CHECK` constraints for maker ≠ checker, valid states and lease consistency.
- Unique constraints for idempotency keys, inbound event ids and job/outbox dedupe keys.
- Evidence columns on received events frozen by trigger.
- Applied migrations are checksummed; editing one stops the migrator.

## Consequences

- Mistakes fail loudly at the database instead of silently corrupting history.
- Corrections are made by new records (reversals, linked corrections), never edits. Bucket 3's
  ledger follows the same rule.
- A superuser can still disable triggers. Production access must be restricted and logged
  (TH-SEC §3); this is an operational control, not a code one.

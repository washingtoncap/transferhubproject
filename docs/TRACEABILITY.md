# Requirement traceability — Bucket 1

Maps requirement IDs from TH-REQ / TH-SEC to what this bucket implements and the tests that prove
it. Later buckets extend this table. "Foundation" means the mechanism exists and is tested; the
requirement is fully met only when the feature that uses it ships.

| Requirement                      | What bucket 1 provides                                                                                                                    | Evidence (tests)                                               | Status      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------- |
| TH-REQ §6 audit contract         | `platform.audit_log`: actor, entity, action, object, request/correlation id, before/after, reason, approver; append-only; maker ≠ checker | `packages/platform/src/audit.test.ts`                          | Foundation  |
| TH-REQ §6 idempotency            | `runIdempotent` + `@RequiresIdempotencyKey()`; same key + different body → 409                                                            | `platform/src/idempotency.test.ts`, `apps/api/src/app.test.ts` | Foundation  |
| TH-REQ §6 error contract         | Stable error codes, request id on every error, no internal detail leaked                                                                  | `apps/api/src/app.test.ts`                                     | Foundation  |
| NFR-03 outbox / inbox            | Transactional outbox; deduplicated inbox; signature verification helper                                                                   | `platform/src/inbox.test.ts`, `platform/src/jobs.test.ts`      | Foundation  |
| DEP-02 duplicate events          | One inbox row per provider event id; conflicting redelivery flagged                                                                       | `platform/src/inbox.test.ts`                                   | Foundation  |
| FX-03 / WDR-02 execute once      | Lease tokens; reclaimed jobs documented as "outcome unknown, query first"                                                                 | `platform/src/jobs.test.ts`, `runner.test.ts`                  | Foundation  |
| NFR-09 no secrets in logs        | Key- and pattern-based redaction on every log line and audit snapshot                                                                     | `platform/src/redact.test.ts`                                  | Foundation  |
| TH-SEC §6 environment separation | Config refuses prod DB outside production and local DB in production                                                                      | `packages/config/src/config.test.ts`                           | Implemented |
| TH-SEC §6 migration review       | Checksummed, ordered migrations; edited history blocks deploy                                                                             | `packages/db/src/migrate.test.ts`                              | Implemented |
| TH-SEC §2 web boundary           | Helmet headers, strict CORS allow-list, 256 KB body limit, CSP on web                                                                     | `apps/api/src/app.test.ts`                                     | Foundation  |
| NFR-07 accessibility             | Skip link, visible focus, labelled nav, status regions, reduced motion                                                                    | Manual review of web shell                                     | Partial     |
| TH-BRD tokens                    | Navy/purple/magenta/lavender tokens, Port of Spain time display                                                                           | Web shell                                                      | Implemented |

Not in bucket 1: `IAM-*`, `KYC-*`, `KYB-*`, `ACC-*`, `DEP-01`, `FX-01/02`, `SEL-*`, `WDR-01`, `BILL-*`,
`REP-*`, `NFR-01` (ledger), `NFR-02` (object-level authorisation), `NFR-05` (recovery evidence).

# Foundation architecture and extension boundaries

Web -> read-only server health proxy -> API -> PostgreSQL. API -> diagnostic queue -> worker -> same-database receipt. Shared schemas validate payloads; API returns a server-generated request ID. Internal data is held in the private platform schema. Public health has no customer data; diagnostics use a server/operator token.

Queue semantics: globally unique diagnostic idempotency keys; same key/different payload conflicts; FOR UPDATE SKIP LOCKED claim; expiring lease with unique fencing token; bounded attempts with exponential retry; stale final attempt dead-letters. Completion and diagnostic receipt occur atomically. This demonstrates reliable infrastructure, not exactly-once external payments. Handlers must be short relative to the lease; long tasks require lease renewal before introduction.

Readiness checks database/schema availability and any recent worker heartbeat. It does not yet check schema-version compatibility, provider status, queue latency or customer service health. Structured JSON logs expose only generated IDs, status and timings. Host log collection, alerts, backups and distributed tracing remain deployment work.

No ledger/identity schema is guessed in bucket 1. Subsequent buckets introduce tenant-aware audit, managed sessions, MFA, mandates and memberships before customer data, then a separate immutable financial core. This avoids treating a shared diagnostic key as financial authorisation.

References consulted: https://nextjs.org/docs/app/getting-started/installation ; https://docs.nestjs.com/first-steps ; https://node-postgres.com/features/transactions . Dependencies are exact-pinned with a committed lockfile; review updates and advisories before hosting. No infrastructure has been purchased.

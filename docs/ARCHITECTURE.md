# Architecture — platform foundation

Status: Bucket 1 implemented in sandbox. Proposed for review; not an approved production design.

## Shape

One repository, three deployable processes, one Postgres database.

```
 Browser ──HTTPS──▶ apps/web (Next.js) ──server-side fetch──▶ apps/api (NestJS) ──▶ Postgres
                                                                    ▲                 │
 Partner webhooks ──HTTPS──────────────────────────────────────────┘                 │
                                                                                      ▼
                                                           apps/worker ◀── jobs + outbox tables
                                                                │
                                                                └──▶ partner APIs (later buckets)
```

- **No microservices, no Kubernetes, no message broker.** Postgres holds the job queue and the
  outbox. This is enough for pilot volumes and removes an entire class of "the database committed
  but the message was lost" failures. Revisit only with measured need.
- **The browser never talks to the database.** All financial state lives in private schemas that
  only the API and worker reach, with server-only credentials.
- **Feature buckets are modules** inside the API and worker, not separate services, with
  replaceable provider adapters at their edges.

## How a money-moving command will work

Every financial endpoint in later buckets follows the pattern already exercised by the API tests:

1. Guard: authenticated actor, entity context, permission and an `Idempotency-Key` header.
2. Validate the request body.
3. Open **one database transaction** and, inside it:
   - claim the idempotency key (a concurrent duplicate waits here, then replays);
   - make the state change (ledger postings, reservations — bucket 3 onward);
   - write the audit record;
   - write an outbox event describing what happened.
4. Commit. The response is stored with the key.
5. The worker picks up the outbox event and performs any external call (e.g. instructing the
   partner), using the event id as the partner-side idempotency reference.

If step 3 fails, nothing happened — no half-written state, no orphan event, key free for retry.
If step 5 times out, the outcome is **unknown**, not failed: the follow-up job queries the partner
for the original reference before doing anything else (TH-SEC §4, FX-03, WDR-02).

## Inbound partner events

Webhook → verify signature → `recordInbound` (unique on source + event id) → job processes it.
Duplicates are acknowledged without reprocessing; a duplicate id with different content is
recorded as a conflict for security review; invalid signatures are stored as `rejected` and the
database forbids ever marking them processed.

## Background work

- `FOR UPDATE SKIP LOCKED` claiming: concurrent workers never take the same job.
- Each claim issues a fresh lease token; completion requires the current token, so a stalled
  worker cannot finish a job another worker has taken over.
- Retries use exponential backoff with jitter; after `max_attempts` the job is `dead` and waits
  for a person. Nothing is silently dropped.
- Handlers must be idempotent: delivery is at-least-once by design.

## Data and time

- All timestamps stored as `timestamptz` in UTC (each connection is pinned to UTC).
- Display defaults to America/Port_of_Spain with the zone named.
- Money amounts will use integer minor units per asset (bucket 3). No floating point.

## Not yet decided (and why the code doesn't pretend otherwise)

| Area                                                    | Status                  | Decision  |
| ------------------------------------------------------- | ----------------------- | --------- |
| Hosting (Render, Supabase or other)                     | Candidates only         | D06 / D08 |
| Identity provider for sign-in and MFA                   | Not selected            | Bucket 2  |
| KYC/KYB vendor                                          | Not selected            | D06       |
| Fiat partner and its API                                | Not contracted          | D06       |
| Data location and retention                             | Open                    | D08       |
| Audit log tamper evidence beyond append-only + row hash | Needs Security sign-off | ADR-0003  |

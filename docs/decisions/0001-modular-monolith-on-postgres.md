# ADR-0001: Modular monolith on Postgres

- Status: Proposed
- Date: 2026-10-21

## Context

Two developers, a tight budget and an 18-week fiat pilot plan (TH-MVP §6). The product needs
strong transactional guarantees between state changes, audit records and outbound work.

## Decision

One TypeScript repository with a Next.js web app, a NestJS API and a separate worker. One
Postgres database holds application state, the job queue and the transactional outbox. Feature
areas are modules, not services.

## Consequences

- State change + audit + outbox commit atomically; no distributed transactions.
- One database to back up, restore and reconcile.
- Postgres becomes the throughput ceiling for jobs. Acceptable for pilot volumes; a broker can be
  added later behind the existing outbox without changing callers.
- Developers need Postgres locally to run tests. This is deliberate: concurrency and constraint
  behaviour is tested against the real database, not a mock.

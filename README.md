# TransferHub platform foundation

Bucket 1 · v0.1.0 · Sandbox only

A local-first TypeScript monorepo with Next.js web, NestJS API, PostgreSQL migrations, a durable worker, shared schemas, OpenAPI, checks and CI. No live financial service is connected. No customer authentication, KYC, balances, exchange or withdrawals are implemented in this bucket.

## Requirements

Node.js 24, npm 11 and Docker Compose (for local PostgreSQL), or an existing PostgreSQL 17 database. This is a source code starter, not a deployed production service.

## Quick start

```sh
npm ci
npm run setup:env
docker compose up -d database
npm run db:migrate
npm run dev
```

Open http://localhost:3000. API liveness: http://127.0.0.1:4000/health/live. Readiness: http://127.0.0.1:4000/health/ready. Interactive API documentation: http://127.0.0.1:4000/docs.

`setup:env` generates a local-only diagnostic bearer secret in `.env` without overwriting an existing file. Replace the local database URL if using another server. Web uses its default local API URL; for another environment set API_INTERNAL_URL in `apps/web/.env.local` or the hosting environment (Next loads environment from its app directory, not the root `.env`). Do not publish any .env file.

In another terminal:

```sh
npm run job:enqueue
```

This enqueues `diagnostic.ping`. The worker records an atomic receipt and completion. Use the protected GET /v1/diagnostics/jobs/{id} endpoint from the docs or a secure operator client to inspect the returned job ID. Diagnostics are platform-only, not customer-facing endpoints. Do not put customer information in diagnostic payloads.

## Without Docker: ephemeral infrastructure demo

Run `npm ci` and `npm run setup:env`, then `npm run demo:embedded` in one terminal and `npm run dev -w @transferhub/web` in another. Run `npm run job:enqueue` in a third terminal. This mode uses PGlite in memory with API and worker in one process; it resets on every restart and is not a substitute for testing real PostgreSQL concurrency or separate-service deployment. It is development-only and contains no financial features. Do not run it alongside the normal API on port 4000.

## Checks

```sh
npm run check
npm run build
npm run openapi:generate
```

Default tests use PGlite, an embedded PostgreSQL engine, for schema/SQL and API integration without Docker. Also run real-server tests after migrations:

```sh
npm run test:postgres
```

This uses DATABASE_URL from .env or the current environment and exercises database migrations/idempotency/concurrent claiming; use only an isolated development/test database. CI provides an isolated PostgreSQL service. See docs/VERIFICATION.md for what was actually executed in the originating environment.

## Layout

- apps/web: responsive platform status workspace; no simulated financial balances.
- apps/api: liveness/readiness, sandbox declaration, protected diagnostic commands and standard errors.
- apps/worker: polling/heartbeat loop with graceful shutdown.
- packages/contracts: shared Zod schema and capability types.
- packages/database: pooled PostgreSQL access and checksum-verified migration runner.
- packages/jobs: idempotent enqueue, leases/fencing, retry/dead-letter and atomic diagnostic receipt.
- database/migrations: append-only migration files.
- docs: API contract, architecture/limits, deployment and verification evidence.

## Design boundaries

All financial routes are absent, not insecure mock implementations. PLATFORM_MODE accepts sandbox only. The diagnostic bearer secret is a temporary operator gate and is not user authentication/MFA. Never reuse it for future customer authorisation. Browser code has no database or diagnostic credentials. Structured logs omit request bodies, headers, tokens and diagnostic message text.

Keep applied migrations immutable. Never use floating point for future financial amounts. Never add arbitrary job kinds or external money handlers without explicit authorisation, provider idempotency and financial accounting tests. Preserve the project's buyer/seller and child-margin rules when starting subsequent buckets.

## Next bucket

Identity/access: managed identity provider decision, registration/MFA, actor/entity memberships, backend enforcement and audit. Production deployment, paid services, provider integrations and live funds each require their own readiness evidence. See docs/DEPLOYMENT.md.

Repository: https://github.com/washingtoncap/transferhubproject. Review the foundation on its feature branch/pull request; consult GitHub for current publication and CI status.

# TransferHub

Customer experience, workflow, ledger and reconciliation platform for partner-operated financial
services. Proprietary software of Transparent Transfers Technology. Not licensed for use outside
the company.

> **Status: working sandbox prototype of the fiat pilot.** Sign-in with MFA, individual and
> business onboarding with compliance review, double-entry ledger, deposits cleared from signed
> partner webhooks, USD/TTD exchange, seller network with parent margins, withdrawals with
> maker/checker, subscriptions, statements, finance dashboard, ledger explorer and daily
> reconciliation. The fiat partner, KYC vendor and bank are **simulated**; no real money moves.
> Every environment other than production shows a "no real money" banner.
>
> **Try it:** see [`docs/TESTING-GUIDE.md`](docs/TESTING-GUIDE.md) for every sign-in and a
> ten-minute tour. Password for all demo accounts: `Sandbox!2026`.

## What is in this repository

| Path                     | What it is                                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| `apps/web`               | Next.js customer web app (responsive). Currently: shell, overview, system status. |
| `apps/api`               | NestJS HTTP API. Currently: health/readiness, request ids, error handling.        |
| `apps/worker`            | Background worker: durable jobs and outbox dispatch.                              |
| `packages/config`        | Validated configuration with environment-separation guard rails.                  |
| `packages/db`            | Postgres pool, transactions and the versioned migration runner.                   |
| `packages/platform`      | Audit log, outbox, inbox, jobs, idempotency, redacted logging.                    |
| `packages/db/migrations` | Versioned SQL. Applied migrations are never edited; add a new one.                |
| `docs/`                  | Architecture, decision records and requirement traceability.                      |

## Run it locally

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
# 1. Databases (one for development, one that tests may wipe)
createuser -s th && psql -c "ALTER ROLE th PASSWORD 'th'"
createdb -O th transferhub_dev
createdb -O th transferhub_test

# 2. Install and configure
pnpm install
cp .env.example .env          # local values only; never commit .env

# 3. Build shared packages, migrate and load demo data
pnpm build:libs
pnpm db:migrate
pnpm db:seed

# Or do everything (build, migrate, seed, start all three) in one step:
scripts/sandbox.sh start

# 4. Start each app in its own terminal
pnpm dev:api                  # http://localhost:4000/health/ready
pnpm dev:worker
pnpm dev:web                  # http://localhost:3000
```

## Checks

```bash
pnpm check     # format, lint, build libraries, type check, tests
pnpm build     # production build of every package and app
```

Tests run against a real Postgres database (`TEST_DATABASE_URL`, name must end in `_test`), which
is rebuilt from migrations at the start of each run. CI (`.github/workflows/ci.yml`) runs the same
steps plus a dependency audit on every pull request.

## Rules this codebase enforces

These are in the database or the shared libraries, not left to convention:

- **Audit records cannot be edited or deleted**, by anyone, and an approver can never be the same
  person as the actor.
- **A financial command runs at most once per Idempotency-Key.** A retry replays the original
  response; the same key with a different request is rejected.
- **State changes, their audit record and their outbox event commit together** or not at all.
- **An inbound partner event is recorded once.** Redeliveries are recognised; a redelivery with
  different content is flagged; events with bad signatures are kept as evidence but can never be
  processed.
- **Two workers never run the same job**, and a worker that loses its lease cannot complete it.
- **Logs never contain passwords, codes, tokens or card numbers.**
- **A non-production process refuses to start against a production database.**

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit,
[`docs/DATABASE.md`](docs/DATABASE.md) for the schema and ledger, and
[`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for the requirement mapping.

## Environments

| `APP_ENV`    | Purpose                              | Data                       |
| ------------ | ------------------------------------ | -------------------------- |
| `local`      | Developer machines                   | Synthetic                  |
| `test`       | Automated tests and CI               | Wiped every run            |
| `sandbox`    | Shared demo with simulated partners  | Synthetic or masked        |
| `production` | Live service, after release approval | Real; separate credentials |

Secrets for sandbox and production live in the hosting provider's secret store, never in files.

## Working on this repository

- Branch from `main`; open a pull request; CI must pass before merge.
- Financial and security changes need review by someone other than the author.
- Commit migrations, configuration and code together so a release is reproducible.

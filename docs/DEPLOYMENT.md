# Deployment runbook — sandbox only

No cloud service has been created. No paid plan or live-finance deployment is authorised by this starter.

## Service topology

- Web: Next.js, build `npm ci && npm run build`, start `npm run start -w @transferhub/web`. Set server-only `API_INTERNAL_URL` to the API service URL. This is not a NEXT_PUBLIC variable.
- API: compiled NestJS, start `node dist/apps/api/src/main.js`. Bind `API_HOST=0.0.0.0`, set API_PORT to the host's port. Public health and schema documentation; diagnostic writes require a generated bearer token.
- Worker: start `node dist/apps/worker/src/main.js`. No inbound port; logs and database heartbeat are its monitoring hooks.
- Database: PostgreSQL 17 or compatible managed instance. Migration job runs before API/worker rollout, using a migration-owner credential. Runtime connection uses a restricted role granted only the platform schema/table operations needed; never expose it to web clients. The included local account owns its database and is not a production least-privilege role.

Use separate staging/production databases and credentials; this code deliberately accepts PLATFORM_MODE=sandbox only. NODE_ENV=production means a hosted sandbox build, not live financial readiness. It requires verified database TLS and an HTTPS web origin. Configure an authenticated hosting layer for team access and network/rate limits; do not expose the diagnostic token to a browser. The sample has no customer authentication or per-user authorisation yet.

## Release procedure

1. Provision an organisation-owned staging database and secret store after budget approval.
2. Set DATABASE_URL, DATABASE_SSL=true, NODE_ENV=production, PLATFORM_MODE=sandbox, API_HOST/API_PORT, API_ORIGIN and a generated DIAGNOSTICS_TOKEN. Provide the managed provider's CA through the host's supported trust configuration where required. Never set rejectUnauthorized=false.
3. Run check/build and generate the OpenAPI file. Run the migration against the target using the migration credential. Record commit and migration checksum.
4. Deploy worker and API; `/health/live` checks process only, `/health/ready` requires the schema and a worker heartbeat within 30 seconds. Configure worker poll below the heartbeat window (default 1 second).
5. Deploy web with API_INTERNAL_URL, then enqueue one harmless diagnostic from a secure operator client and inspect its result. Avoid personal information in its message.
6. Verify logs, restart/lease recovery and readiness outage behaviour. Test backup/restore before any later customer-data release.

## Rollback and limits

No destructive down migrations. Roll forward a failed schema change or restore a tested backup after impact review. Application rollback must remain compatible with applied migrations. This initial schema has only diagnostic jobs; no funds, financial ledger or customer identity data are implemented. Jobs are at-least-once delivery; the included same-database diagnostic side effect is atomic with completion. External side effects need their own provider idempotency and reconciliation design before adding handlers.

Container build configuration is provided, but Docker execution must be verified on the deployment host. No Render/Supabase account has been provisioned; provider-specific configuration follows access and budget approval.

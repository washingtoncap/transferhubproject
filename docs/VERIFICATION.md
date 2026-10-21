# Verification record

As of 21 October 2026. Initial platform foundation, sandbox only.

## Executed successfully

- `npm run lint` and server/web TypeScript checks.
- Eight automated tests covering configuration, duplicate/mismatched idempotency keys, worker completion and atomic receipt, lease recovery/stale-worker fencing, bounded retries/dead-letter, authenticated diagnostic API validation, absent financial routes and failed database readiness.
- `npm run build`: compiled server code and optimized Next.js production pages.
- OpenAPI generation and JSON parse validation.
- Compiled NestJS ESM runtime boot/close check.
- Local full-process smoke test: started the compiled Next.js web service and the development embedded API/worker harness; readiness returned ready; the web returned TransferHub HTML; a diagnostic was enqueued over HTTP, processed and read back as succeeded with one attempt; web health proxy returned API/ready true.

## Not verified in this environment

- Separate native PostgreSQL execution: Docker is unavailable and this host rejects the user/group switch required by native PostgreSQL. PGlite tests validate actual PostgreSQL SQL behaviour in an embedded engine but do not establish real-server multi-process concurrency. `npm run test:postgres` and the CI PostgreSQL service provide the remaining check; their success has not been observed here.
- Container execution, managed database TLS, hosted deployment, external log/alert delivery and backup/restore. Configuration/runbooks are supplied, not provisioned services.
- Browser rendering/screenshots: the browser binary was unavailable and its download failed. The web build and HTTP response were tested, but no visual/browser accessibility review is claimed.
- The initial Git transport push lacked credentials. The connected GitHub integration is used for publication; consult the repository/pull request for current remote commit and CI status. This record describes local verification only and does not assert a successful GitHub Actions run.
- No customer auth/MFA, financial ledger, KYC, bank/crypto/card integration or live funds functionality is implemented or verified.

## Local developer acceptance

Follow README quick start on a Docker-capable machine, run checks/build and real PostgreSQL integration tests, then `npm run job:enqueue`. Verify UI on desktop/mobile and keyboard navigation. Before hosting, review dependency advisories, generate deployment secrets, restrict runtime database privileges and follow DEPLOYMENT.md. No paid infrastructure has been created.

CREATE SCHEMA IF NOT EXISTS platform;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
CREATE TABLE platform.jobs (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind = 'diagnostic.ping'),
 payload jsonb NOT NULL,
 idempotency_key text NOT NULL UNIQUE,
 payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 result jsonb,
 last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_claim ON platform.jobs(status,available_at,lease_until) WHERE status IN ('queued','running');
-- Same-database side effect: job completion and this insert commit atomically.
CREATE TABLE platform.diagnostic_receipts (
 job_id uuid PRIMARY KEY REFERENCES platform.jobs(id),
 processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.worker_heartbeats (
 worker_id text PRIMARY KEY,
 seen_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;

-- 0001 Platform foundation
-- Shared infrastructure every later bucket depends on:
--   audit_log        append-only record of who did what (TH-REQ §6, TH-SEC §6)
--   outbox           events written in the same transaction as the state change (NFR-03)
--   inbox            deduplicated record of inbound provider events (NFR-03, DEP-02)
--   jobs             durable background work with leases and retries (TH-SEC §4)
--   idempotency_keys replay-safe financial commands (TH-REQ §6)
-- These tables live in a private schema that is never exposed to browsers.

CREATE SCHEMA platform;

-- Shared guard used to make tables append-only. It fires for every role, including table owners
-- and superusers, so a mistaken UPDATE or DELETE fails loudly instead of rewriting history.
CREATE FUNCTION platform.reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform.%: % is not permitted on an append-only table', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION platform.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE platform.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     text        NOT NULL CHECK (actor_type IN ('customer', 'staff', 'service', 'system')),
  actor_id       text        NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  -- The customer entity (individual or business) the action was performed for, when there is one.
  entity_id      uuid,
  action         text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  object_type    text        NOT NULL CHECK (length(object_type) BETWEEN 1 AND 100),
  object_id      text,
  request_id     text,
  correlation_id text,
  reason         text,
  approver_id    text,
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 over the row's content, computed by the database at insert time.
  row_hash       bytea       NOT NULL,
  -- A maker can never be their own checker.
  CONSTRAINT audit_approver_is_not_actor CHECK (approver_id IS NULL OR approver_id <> actor_id)
);

CREATE FUNCTION platform.audit_log_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_hash := sha256(convert_to(
    concat_ws('|',
      NEW.id, NEW.occurred_at, NEW.actor_type, NEW.actor_id, NEW.entity_id, NEW.action,
      NEW.object_type, NEW.object_id, NEW.request_id, NEW.correlation_id, NEW.reason,
      NEW.approver_id, NEW.before_state, NEW.after_state, NEW.metadata),
    'UTF8'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_hash BEFORE INSERT ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_log_hash();
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON platform.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_modification();

CREATE INDEX audit_log_entity_idx ON platform.audit_log (entity_id, occurred_at DESC)
  WHERE entity_id IS NOT NULL;
CREATE INDEX audit_log_object_idx ON platform.audit_log (object_type, object_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON platform.audit_log (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_log_correlation_idx ON platform.audit_log (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------
CREATE TABLE platform.outbox (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic            text        NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type   text,
  aggregate_id     text,
  payload          jsonb       NOT NULL,
  -- Optional: writing the same logical event twice (e.g. a retried command) keeps one row.
  dedupe_key       text        UNIQUE,
  correlation_id   text,
  status           text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'dispatching', 'dispatched', 'dead')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at     timestamptz NOT NULL DEFAULT now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_dispatched_has_time CHECK ((status = 'dispatched') = (dispatched_at IS NOT NULL))
);

CREATE INDEX outbox_ready_idx ON platform.outbox (available_at, created_at)
  WHERE status IN ('pending', 'dispatching');
CREATE TRIGGER outbox_touch BEFORE UPDATE ON platform.outbox
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
-- Outbox rows are history: they change status but are never deleted by the application.
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON platform.outbox
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();

-- ---------------------------------------------------------------------------
-- Inbox of external events (provider webhooks, statements, callbacks)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.inbox (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text        NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  external_event_id text        NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 300),
  event_type        text        NOT NULL,
  payload           jsonb       NOT NULL,
  payload_sha256    bytea       NOT NULL,
  -- Events that fail signature checks are kept as evidence but can never be processed.
  signature_valid   boolean     NOT NULL,
  status            text        NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'processing', 'processed', 'rejected', 'dead')),
  -- Set when the same event ID arrives again with different content: a security signal.
  conflicting_redeliveries integer NOT NULL DEFAULT 0,
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  last_error        text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_invalid_never_processed CHECK (signature_valid OR status IN ('rejected'))
);

-- Only authentic events reserve an event id. If forged events also reserved ids, an attacker who
-- guessed or replayed a real id first could make the genuine event look like a duplicate and block
-- it. Forged events are still stored (as evidence) but never reserve anything.
CREATE UNIQUE INDEX inbox_unique_authentic_event ON platform.inbox (source, external_event_id)
  WHERE signature_valid;
CREATE INDEX inbox_rejected_lookup_idx ON platform.inbox (source, external_event_id)
  WHERE NOT signature_valid;

CREATE INDEX inbox_ready_idx ON platform.inbox (received_at)
  WHERE status IN ('received', 'processing');
CREATE TRIGGER inbox_touch BEFORE UPDATE ON platform.inbox
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
CREATE TRIGGER inbox_no_delete BEFORE DELETE ON platform.inbox
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();

-- Payload and identity of a received event are evidence and must not be rewritten.
CREATE FUNCTION platform.inbox_freeze_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
     OR NEW.external_event_id IS DISTINCT FROM OLD.external_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'platform.inbox: received event evidence cannot be modified'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_freeze BEFORE UPDATE ON platform.inbox
  FOR EACH ROW EXECUTE FUNCTION platform.inbox_freeze_evidence();

-- ---------------------------------------------------------------------------
-- Background jobs
-- ---------------------------------------------------------------------------
CREATE TABLE platform.jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  queue            text        NOT NULL DEFAULT 'default' CHECK (queue ~ '^[a-z][a-z0-9_]*$'),
  type             text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Optional: enqueuing the same logical job twice keeps one row.
  dedupe_key       text        UNIQUE,
  correlation_id   text,
  status           text        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  priority         integer     NOT NULL DEFAULT 0,
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer     NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 1000),
  -- Each claim gets a fresh token; only the holder of the current token may finish the job.
  lease_token      uuid,
  lease_expires_at timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT jobs_running_has_lease CHECK (
    status <> 'running' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX jobs_ready_idx ON platform.jobs (queue, priority DESC, run_at)
  WHERE status = 'queued';
CREATE INDEX jobs_expired_lease_idx ON platform.jobs (queue, lease_expires_at)
  WHERE status = 'running';
CREATE TRIGGER jobs_touch BEFORE UPDATE ON platform.jobs
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Idempotency keys for commands
-- ---------------------------------------------------------------------------
CREATE TABLE platform.idempotency_keys (
  -- Scope = who and what, e.g. "customer:<id>:POST /v1/quotes". Keys never collide across scopes.
  scope           text        NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
  key             text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_\-:.]{8,128}$'),
  request_sha256  bytea       NOT NULL,
  response_status integer     NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body   jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_expiry_idx ON platform.idempotency_keys (expires_at);

-- A key is first written as a placeholder (status 102, "processing") inside the command's own
-- transaction, then filled in once with the real response. After that, the stored response is the
-- record of what the system promised and is never edited.
CREATE FUNCTION platform.idempotency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.response_status <> 102
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 THEN
    RAISE EXCEPTION 'platform.idempotency_keys: a completed response cannot be modified'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER idempotency_guard BEFORE UPDATE ON platform.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION platform.idempotency_guard();

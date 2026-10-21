-- 0002 Fiat pilot domain (sandbox prototype)
--   app      identity, customers, onboarding, plans, subscriptions, seller network, FX, deposits,
--            withdrawals
--   ledger   double-entry subledger: accounts, journals, postings, holds
--   sandbox  simulated fiat partner (bank statement and payout desk). Replaced by a real partner
--            adapter once D06 is closed; nothing here is used in production.
-- Amounts are integer minor units (cents). FX rates are integers in ten-thousandths of TTD per USD
-- (8.2200 → 82200), so no floating point ever touches money.

CREATE SCHEMA app;
CREATE SCHEMA ledger;
CREATE SCHEMA sandbox;

-- ===========================================================================
-- Identity and access (IAM-01..03)
-- ===========================================================================
CREATE TABLE app.users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name         text        NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  phone             text,
  password_hash     text        NOT NULL,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  -- Sandbox stores the TOTP secret directly; production uses the selected identity provider (D06).
  mfa_secret        text,
  mfa_enabled_at    timestamptz,
  is_staff          boolean     NOT NULL DEFAULT false,
  staff_roles       text[]      NOT NULL DEFAULT '{}'
                      CHECK (staff_roles <@ ARRAY['operations','compliance','finance','treasury','admin']),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  failed_logins     integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_staff_have_roles CHECK (NOT is_staff OR cardinality(staff_roles) > 0)
);
CREATE UNIQUE INDEX users_email_uq ON app.users (email);

CREATE TABLE app.sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES app.users(id),
  token_sha256    bytea       NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  mfa_verified_at timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  user_agent      text
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id) WHERE revoked_at IS NULL;

-- ===========================================================================
-- Customers: individuals and businesses (KYC-01, KYB-01)
-- ===========================================================================
CREATE TABLE app.entities (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text        NOT NULL CHECK (kind IN ('individual', 'business')),
  customer_role      text        NOT NULL CHECK (customer_role IN ('buyer', 'seller')),
  legal_name         text        NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  country            text        NOT NULL DEFAULT 'TT' CHECK (country ~ '^[A-Z]{2}$'),
  -- Short code customers put on bank transfers so deposits can be matched (DEP-02).
  reference_code     text        NOT NULL UNIQUE CHECK (reference_code ~ '^TH[A-Z0-9]{6}$'),
  onboarding_status  text        NOT NULL DEFAULT 'draft' CHECK (onboarding_status IN
                       ('draft','submitted','vendor_checks','needs_information','compliance_review',
                        'approved','rejected','restricted','closed')),
  profile            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  screening_result   text        CHECK (screening_result IN ('clear', 'possible_match')),
  risk_rating        text        CHECK (risk_rating IN ('low', 'medium', 'high')),
  reviewed_by        uuid        REFERENCES app.users(id),
  review_reason      text,
  submitted_at       timestamptz,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.memberships (
  user_id    uuid        NOT NULL REFERENCES app.users(id),
  entity_id  uuid        NOT NULL REFERENCES app.entities(id),
  role       text        NOT NULL CHECK (role IN ('owner', 'admin', 'approver', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_id)
);
CREATE INDEX memberships_entity_idx ON app.memberships (entity_id);

-- ===========================================================================
-- Commercial configuration (TH-MVP §4) — test hypotheses, not approved tariffs
-- ===========================================================================
CREATE TABLE app.plans (
  code                      text    PRIMARY KEY,
  audience                  text    NOT NULL CHECK (audience IN ('buyer', 'seller')),
  name                      text    NOT NULL,
  monthly_minor             bigint  NOT NULL CHECK (monthly_minor > 0),
  annual_minor              bigint  NOT NULL CHECK (annual_minor = monthly_minor * 10),
  usd_rate_e4               integer NOT NULL CHECK (usd_rate_e4 BETWEEN 50000 AND 120000),
  volume_allowance_usd_minor bigint NOT NULL CHECK (volume_allowance_usd_minor > 0),
  child_limit               integer NOT NULL DEFAULT 0 CHECK (child_limit >= 0),
  staff_seats               integer NOT NULL DEFAULT 1 CHECK (staff_seats >= 1),
  sort_order                integer NOT NULL DEFAULT 0
);

INSERT INTO app.plans (code, audience, name, monthly_minor, annual_minor, usd_rate_e4,
                       volume_allowance_usd_minor, child_limit, staff_seats, sort_order) VALUES
  ('buyer_essential',  'buyer',  'Essential',  4900,  49000, 83000,   250000,  0, 2,  1),
  ('buyer_plus',       'buyer',  'Plus',      14900, 149000, 82200,  1000000,  0, 5,  2),
  ('buyer_business',   'buyer',  'Business',  39900, 399000, 81500,  2500000,  0, 15, 3),
  ('seller_essential', 'seller', 'Essential',  9900,  99000, 75000,   500000,  3, 2,  1),
  ('seller_growth',    'seller', 'Growth',    29900, 299000, 77500,  2500000, 15, 5,  2),
  ('seller_network',   'seller', 'Network',   79900, 799000, 80000, 10000000, 50, 15, 3);

-- Single-row policy table, editable by treasury (every change audited).
CREATE TABLE app.rate_policy (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Rates for customers without a plan, or past their plan's monthly volume allowance.
  standard_buy_e4        integer NOT NULL CHECK (standard_buy_e4 BETWEEN 50000 AND 120000),
  standard_sell_e4       integer NOT NULL CHECK (standard_sell_e4 BETWEEN 50000 AND 120000),
  -- Provisional child floor from the blueprint; D04 is still open.
  child_floor_e4         integer NOT NULL CHECK (child_floor_e4 BETWEEN 50000 AND 120000),
  -- Contracted platform revenue per USD traded, paid by the principal (TH-FIN base scenario).
  platform_share_e4      integer NOT NULL CHECK (platform_share_e4 BETWEEN 0 AND 10000),
  quote_ttl_seconds      integer NOT NULL CHECK (quote_ttl_seconds BETWEEN 10 AND 600),
  -- Withdrawals at or above this USD-equivalent need two different staff approvers.
  dual_approval_usd_minor bigint NOT NULL CHECK (dual_approval_usd_minor > 0),
  updated_by             uuid REFERENCES app.users(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_policy_sane CHECK (standard_sell_e4 < standard_buy_e4)
);
INSERT INTO app.rate_policy (standard_buy_e4, standard_sell_e4, child_floor_e4, platform_share_e4,
                             quote_ttl_seconds, dual_approval_usd_minor)
VALUES (83500, 74000, 75000, 600, 90, 500000);

CREATE TABLE app.subscriptions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid        NOT NULL REFERENCES app.entities(id),
  plan_code            text        NOT NULL REFERENCES app.plans(code),
  billing_interval     text        NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  status               text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'cancel_at_period_end', 'cancelled')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL CHECK (current_period_end > current_period_start),
  created_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz
);
-- One live subscription per customer.
CREATE UNIQUE INDEX subscriptions_one_live ON app.subscriptions (entity_id)
  WHERE status IN ('active', 'cancel_at_period_end');

CREATE TABLE app.invoices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text        NOT NULL UNIQUE,
  entity_id       uuid        NOT NULL REFERENCES app.entities(id),
  subscription_id uuid        NOT NULL REFERENCES app.subscriptions(id),
  description     text        NOT NULL,
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        text        NOT NULL DEFAULT 'TTD' CHECK (currency = 'TTD'),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  status          text        NOT NULL CHECK (status IN ('paid', 'void')),
  journal_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE app.invoice_number_seq START 1001;

-- ===========================================================================
-- Seller network (SEL-01..04): one level, explicit child consent
-- ===========================================================================
CREATE TABLE app.seller_links (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_entity_id uuid        NOT NULL REFERENCES app.entities(id),
  child_entity_id  uuid        NOT NULL REFERENCES app.entities(id),
  child_rate_e4    integer     NOT NULL CHECK (child_rate_e4 BETWEEN 50000 AND 120000),
  status           text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'declined', 'detached')),
  consent_text     text,
  invited_by       uuid        NOT NULL REFERENCES app.users(id),
  invited_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  ended_at         timestamptz,
  CONSTRAINT seller_link_not_self CHECK (parent_entity_id <> child_entity_id),
  CONSTRAINT seller_link_active_consented CHECK (status <> 'active' OR (accepted_at IS NOT NULL AND consent_text IS NOT NULL))
);
-- A child belongs to at most one parent at a time.
CREATE UNIQUE INDEX seller_links_one_parent ON app.seller_links (child_entity_id)
  WHERE status IN ('invited', 'active');

-- No nested networks: a child cannot be a parent and a parent cannot be a child.
CREATE FUNCTION app.seller_links_one_level() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('invited', 'active') THEN
    IF EXISTS (SELECT 1 FROM app.seller_links
                WHERE status IN ('invited', 'active') AND id <> NEW.id
                  AND (parent_entity_id = NEW.child_entity_id OR child_entity_id = NEW.parent_entity_id)) THEN
      RAISE EXCEPTION 'seller networks are one level only' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER seller_links_one_level BEFORE INSERT OR UPDATE ON app.seller_links
  FOR EACH ROW EXECUTE FUNCTION app.seller_links_one_level();

-- ===========================================================================
-- Ledger (NFR-01): immutable double-entry journals, balanced per asset
-- ===========================================================================
CREATE TABLE ledger.accounts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text        NOT NULL UNIQUE,
  entity_id  uuid        REFERENCES app.entities(id),
  asset      text        NOT NULL CHECK (asset IN ('USD', 'TTD')),
  type       text        NOT NULL CHECK (type IN ('customer', 'provider_cash', 'fx_principal', 'platform_revenue')),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_customer_has_entity CHECK ((type = 'customer') = (entity_id IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_customer_asset_uq ON ledger.accounts (entity_id, asset) WHERE type = 'customer';

-- Signed amounts: positive = debit, negative = credit. Customer, principal and revenue accounts are
-- credit-normal (TransferHub owes the balance); provider cash is debit-normal (held at the partner).
CREATE TABLE ledger.journals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text        NOT NULL CHECK (kind IN ('opening_float', 'deposit_cleared', 'fx_trade',
                                    'allocation', 'subscription_charge', 'withdrawal_settled', 'reversal')),
  source_type         text        NOT NULL,
  source_id           text        NOT NULL,
  memo                text        NOT NULL,
  created_by          text        NOT NULL,
  reverses_journal_id uuid        REFERENCES ledger.journals(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- One posting per business event: a replayed event can never post twice.
  CONSTRAINT journals_one_per_source UNIQUE (kind, source_type, source_id)
);

CREATE TABLE ledger.postings (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id   uuid        NOT NULL REFERENCES ledger.journals(id),
  account_id   uuid        NOT NULL REFERENCES ledger.accounts(id),
  asset        text        NOT NULL CHECK (asset IN ('USD', 'TTD')),
  amount_minor bigint      NOT NULL CHECK (amount_minor <> 0),
  line_type    text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON ledger.postings (account_id, id);
CREATE INDEX postings_journal_idx ON ledger.postings (journal_id);

CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON ledger.journals
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON ledger.journals
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_modification();
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON ledger.postings
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_modification();

CREATE FUNCTION ledger.posting_asset_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset <> (SELECT asset FROM ledger.accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'posting asset % does not match account asset', NEW.asset
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postings_asset_matches BEFORE INSERT ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION ledger.posting_asset_matches();

-- Checked at COMMIT: every journal has at least two lines and balances to zero in every asset.
CREATE FUNCTION ledger.journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN jid := NEW.id; ELSE jid := NEW.journal_id; END IF;
  IF (SELECT count(*) FROM ledger.postings WHERE journal_id = jid) < 2 THEN
    RAISE EXCEPTION 'journal % has fewer than two postings', jid USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger.postings WHERE journal_id = jid
              GROUP BY asset HAVING sum(amount_minor) <> 0) THEN
    RAISE EXCEPTION 'journal % does not balance', jid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON ledger.journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.journal_balanced();
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON ledger.postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.journal_balanced();

-- Holds reserve part of a customer balance (pending withdrawal). Available = balance − active holds.
CREATE TABLE ledger.holds (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES ledger.accounts(id),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  reason       text        NOT NULL,
  source_type  text        NOT NULL,
  source_id    text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT holds_one_per_source UNIQUE (source_type, source_id),
  CONSTRAINT holds_resolved_time CHECK ((status = 'active') = (resolved_at IS NULL))
);
CREATE INDEX holds_active_idx ON ledger.holds (account_id) WHERE status = 'active';

-- A resolved hold is history.
CREATE FUNCTION ledger.holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'active' OR NEW.amount_minor <> OLD.amount_minor OR NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION 'a resolved hold cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER holds_guard BEFORE UPDATE ON ledger.holds
  FOR EACH ROW EXECUTE FUNCTION ledger.holds_guard();
CREATE TRIGGER holds_no_delete BEFORE DELETE ON ledger.holds
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();

CREATE VIEW ledger.balances AS
SELECT a.id AS account_id, a.code, a.entity_id, a.asset, a.type, a.name,
       COALESCE(p.debits_minus_credits, 0)::bigint AS debits_minus_credits,
       COALESCE(h.held, 0)::bigint AS held_minor
  FROM ledger.accounts a
  LEFT JOIN (SELECT account_id, sum(amount_minor) AS debits_minus_credits
               FROM ledger.postings GROUP BY account_id) p ON p.account_id = a.id
  LEFT JOIN (SELECT account_id, sum(amount_minor) AS held
               FROM ledger.holds WHERE status = 'active' GROUP BY account_id) h ON h.account_id = a.id;

-- System accounts. The fiat partner holds the cash; the principal account is the liquidity
-- provider's inventory; platform revenue is TransferHub's earned income (kept separate from
-- customer money and principal liquidity — TH-OM).
INSERT INTO ledger.accounts (code, asset, type, name) VALUES
  ('system:provider_cash:USD',    'USD', 'provider_cash',    'Cash at fiat partner (USD)'),
  ('system:provider_cash:TTD',    'TTD', 'provider_cash',    'Cash at fiat partner (TTD)'),
  ('system:fx_principal:USD',     'USD', 'fx_principal',     'FX principal inventory (USD)'),
  ('system:fx_principal:TTD',     'TTD', 'fx_principal',     'FX principal inventory (TTD)'),
  ('system:platform_revenue:USD', 'USD', 'platform_revenue', 'TransferHub revenue (USD)'),
  ('system:platform_revenue:TTD', 'TTD', 'platform_revenue', 'TransferHub revenue (TTD)');

-- ===========================================================================
-- FX quotes and trades (FX-01..03, SEL-02, SEL-03)
-- ===========================================================================
CREATE TABLE app.quotes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid        NOT NULL REFERENCES app.entities(id),
  side                text        NOT NULL CHECK (side IN ('buy_usd', 'sell_usd')),
  usd_minor           bigint      NOT NULL CHECK (usd_minor > 0),
  rate_e4             integer     NOT NULL,
  ttd_minor           bigint      NOT NULL CHECK (ttd_minor > 0),
  rate_source         text        NOT NULL,
  -- For a child seller: the parent's effective rate and the margin owed to the parent.
  parent_entity_id    uuid        REFERENCES app.entities(id),
  parent_rate_e4      integer,
  parent_margin_minor bigint      NOT NULL DEFAULT 0 CHECK (parent_margin_minor >= 0),
  platform_share_minor bigint     NOT NULL DEFAULT 0 CHECK (platform_share_minor >= 0),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'expired')),
  expires_at          timestamptz NOT NULL,
  created_by          uuid        NOT NULL REFERENCES app.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  journal_id          uuid        REFERENCES ledger.journals(id),
  CONSTRAINT quotes_child_rate_le_parent CHECK (parent_rate_e4 IS NULL OR rate_e4 <= parent_rate_e4),
  CONSTRAINT quotes_accepted_has_journal CHECK ((status = 'accepted') = (journal_id IS NOT NULL))
);
CREATE INDEX quotes_entity_idx ON app.quotes (entity_id, created_at DESC);

-- ===========================================================================
-- Deposits (DEP-01, DEP-02)
-- ===========================================================================
CREATE TABLE app.deposit_claims (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid        NOT NULL REFERENCES app.entities(id),
  asset            text        NOT NULL CHECK (asset IN ('USD', 'TTD')),
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  reference        text        NOT NULL UNIQUE,
  receipt_note     text,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cleared', 'rejected')),
  created_by       uuid        NOT NULL REFERENCES app.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  cleared_at       timestamptz,
  inbox_event_id   uuid        REFERENCES platform.inbox(id),
  journal_id       uuid        REFERENCES ledger.journals(id),
  rejection_reason text,
  CONSTRAINT deposits_cleared_has_evidence CHECK (
    (status = 'cleared') = (journal_id IS NOT NULL AND inbox_event_id IS NOT NULL AND cleared_at IS NOT NULL))
);
CREATE INDEX deposit_claims_entity_idx ON app.deposit_claims (entity_id, created_at DESC);

-- ===========================================================================
-- Withdrawals (WDR-01, WDR-02)
-- ===========================================================================
CREATE TABLE app.beneficiaries (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      uuid        NOT NULL REFERENCES app.entities(id),
  label          text        NOT NULL,
  bank_name      text        NOT NULL,
  account_holder text        NOT NULL,
  -- Only the last four digits are stored in the sandbox; the partner holds full details.
  account_last4  text        NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  currency       text        NOT NULL CHECK (currency IN ('USD', 'TTD')),
  verified_at    timestamptz,
  created_by     uuid        NOT NULL REFERENCES app.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.withdrawals (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text        NOT NULL UNIQUE,
  entity_id          uuid        NOT NULL REFERENCES app.entities(id),
  beneficiary_id     uuid        NOT NULL REFERENCES app.beneficiaries(id),
  asset              text        NOT NULL CHECK (asset IN ('USD', 'TTD')),
  amount_minor       bigint      NOT NULL CHECK (amount_minor > 0),
  status             text        NOT NULL DEFAULT 'pending_approval' CHECK (status IN
                       ('pending_approval', 'approved', 'submitted', 'settled', 'failed', 'rejected', 'status_unknown')),
  required_approvals integer     NOT NULL CHECK (required_approvals IN (1, 2)),
  hold_id            uuid        NOT NULL REFERENCES ledger.holds(id),
  requested_by       uuid        NOT NULL REFERENCES app.users(id),
  partner_reference  text,
  journal_id         uuid        REFERENCES ledger.journals(id),
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT withdrawals_settled_has_journal CHECK ((status = 'settled') = (journal_id IS NOT NULL))
);
CREATE INDEX withdrawals_entity_idx ON app.withdrawals (entity_id, created_at DESC);
CREATE TRIGGER withdrawals_touch BEFORE UPDATE ON app.withdrawals
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE app.withdrawal_approvals (
  withdrawal_id uuid        NOT NULL REFERENCES app.withdrawals(id),
  staff_user_id uuid        NOT NULL REFERENCES app.users(id),
  decision      text        NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (withdrawal_id, staff_user_id)
);
CREATE TRIGGER withdrawal_approvals_append_only BEFORE UPDATE OR DELETE ON app.withdrawal_approvals
  FOR EACH ROW EXECUTE FUNCTION platform.reject_modification();

-- ===========================================================================
-- Sandbox fiat partner: its own view of the bank account, independent of our ledger, so that
-- reconciliation compares two separate records (NFR-08).
-- ===========================================================================
CREATE TABLE sandbox.partner_statement (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset             text        NOT NULL CHECK (asset IN ('USD', 'TTD')),
  amount_minor      bigint      NOT NULL CHECK (amount_minor <> 0),
  description       text        NOT NULL,
  reference         text,
  external_event_id text        NOT NULL UNIQUE,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox.partner_payouts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_reference text        NOT NULL UNIQUE,
  -- Our withdrawal reference: the partner uses it to refuse duplicate instructions.
  client_reference  text        NOT NULL UNIQUE,
  asset             text        NOT NULL,
  amount_minor      bigint      NOT NULL,
  status            text        NOT NULL CHECK (status IN ('accepted', 'paid', 'returned')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

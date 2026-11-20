CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Users Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. Courses Table & Seed Data
-- -----------------------------------------------------------------------------
-- 1. Create Unified Products Table
CREATE TABLE IF NOT EXISTS courses (
  id VARCHAR(100) PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price_cents INT NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  type VARCHAR(20) NOT NULL DEFAULT 'COURSE', -- 'COURSE', 'SUBSCRIPTION'
  duration_days INT DEFAULT NULL,             -- NULL for courses, e.g. 30/365 for subs
  scope VARCHAR(50) DEFAULT NULL,             -- NULL for courses, 'ALL_ACCESS' for subs
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Seed All Sellable Products (Courses + Subscriptions)
INSERT INTO courses (id, slug, name, description, price_cents, currency, type, duration_days, scope) VALUES
  ('intro-to-sql',       'intro-to-sql',       'Intro to SQL',          'Queries, joins and indexes from zero.',      2000,  'USD', 'COURSE',       NULL, NULL),
  ('event-sourcing-101', 'event-sourcing-101', 'Event Sourcing 101',    'Ledgers, projections and replay.',           3500,  'USD', 'COURSE',       NULL, NULL),
  ('payments-in-depth',  'payments-in-depth',  'Payments in Depth',     'Webhooks, idempotency and reconciliation.',  5000,  'USD', 'COURSE',       NULL, NULL),('sub_monthly',        'sub_monthly',        'Monthly All-Access Pass','30-day access to all courses.',             2999,  'USD', 'SUBSCRIPTION', 30,   'ALL_ACCESS')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Cart Items Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id VARCHAR(100) NOT NULL REFERENCES courses(id) ON DELETE CASCADE, -- ✅ Points to products!
  quantity INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS ix_cart_items_user ON cart_items (user_id);

-- -----------------------------------------------------------------------------
-- 4. Unified Pricing Rules Table & Baseline Seed
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_rules (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    TEXT UNIQUE,                                    -- Upper-case promo code (e.g., SUMMER50), NULL for automatic identity rules
  rule_name               TEXT NOT NULL,                                  -- Human-readable description
  application_mode        TEXT NOT NULL CHECK (application_mode IN ('CODE_REQUIRED', 'AUTOMATIC_IDENTITY', 'GLOBAL_DEFAULT')),
  discount_type           TEXT NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED_DISCOUNT', 'OVERRIDE_PRICE')),
  value                   INTEGER NOT NULL CHECK (value >= 0),            -- Cents for FIXED/OVERRIDE or Percentage integer (1-100)
  applicable_product      TEXT NOT NULL CHECK (applicable_product IN ('ALL', 'SUBSCRIPTION_ONLY', 'COURSES_ONLY')),
  applicable_course_ids   TEXT[] NOT NULL DEFAULT '{"*"}',                -- '{"*"}' for all courses, or specific slugs e.g. '{"intro-to-sql"}'
  eligibility_targets     TEXT[] NOT NULL DEFAULT '{"*"}',                -- Array of emails, domains (e.g., '@acme.com'), or '*'
  start_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ,                                    -- NULL means no expiration
  duration_days           INTEGER DEFAULT 30,                             -- Subscription validity in days
  is_disabled             BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast promo code lookup
CREATE UNIQUE INDEX IF NOT EXISTS ix_pricing_rules_code ON pricing_rules (UPPER(code)) WHERE code IS NOT NULL;

-- Seed Global Subscription Baseline Default ($29.99 USD / 30 days)
INSERT INTO pricing_rules (
  rule_name,
  application_mode,
  discount_type,
  value,
  applicable_product,
  applicable_course_ids,
  eligibility_targets
) VALUES (
  'Global Baseline Subscription',
  'GLOBAL_DEFAULT',
  'OVERRIDE_PRICE',
  2999,
  'SUBSCRIPTION_ONLY',
  '{"*"}',
  '{"*"}'
) ON CONFLICT DO NOTHING;

-- 1. Create Orders Header Table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  subtotal_cents INT NOT NULL,
  discount_cents INT NOT NULL DEFAULT 0,
  final_payable_cents INT NOT NULL,
  applied_rule_id VARCHAR(50) DEFAULT NULL,
  provider VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Order Line Items Table
CREATE TABLE IF NOT EXISTS order_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL, -- 'COURSE', 'SUBSCRIPTION', 'BUNDLE'
  item_id VARCHAR(100) NOT NULL,   -- e.g. 'intro-to-sql', 'sub_monthly', 'sub_annual'
  unit_price_cents INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  duration_days INT DEFAULT NULL, -- e.g. 30, 365 (NULL for perpetual courses)
  scope VARCHAR(50) DEFAULT 'ALL_ACCESS', -- 'ALL_ACCESS', 'DATA_SCIENCE', etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast webhook joins
CREATE INDEX IF NOT EXISTS idx_order_line_items_order_id ON order_line_items(order_id);

-- What the customer actually paid for each line after order-level coupons
-- (sums exactly to orders.final_payable_cents). NULL on orders created before this column.
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS paid_cents INT;

-- -----------------------------------------------------------------------------
-- 6. Commerce Ledger Table (Append-Only Source of Truth)
-- -----------------------------------------------------------------------------
-- Note: product_id intentionally has no FK constraint to courses(slug)
-- so it can accept both course slugs and subscription plan IDs like 'sub_monthly'.
CREATE TABLE IF NOT EXISTS commerce_ledger (
  ledger_sequence_id BIGSERIAL PRIMARY KEY,
  event_id           TEXT        NOT NULL UNIQUE,
  event_type         TEXT        NOT NULL,
  user_id            UUID        NOT NULL REFERENCES users(id),
  product_id         TEXT        NOT NULL,
  quantity           INTEGER     NOT NULL CHECK (quantity > 0),
  amount             NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency           CHAR(3)     NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  reference_event_id TEXT        REFERENCES commerce_ledger(event_id),
  product_snapshot   JSONB       NOT NULL,
  payment_info       JSONB       NOT NULL DEFAULT '{}',
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M1: provider-neutral transaction model.
-- Written as ALTERs so re-running this file upgrades an existing database.
-- (ALTER TABLE does not fire the append-only row triggers below.)
ALTER TABLE commerce_ledger ADD COLUMN IF NOT EXISTS source      TEXT  NOT NULL DEFAULT 'PAYMENT';
ALTER TABLE commerce_ledger ADD COLUMN IF NOT EXISTS actor       TEXT;
ALTER TABLE commerce_ledger ADD COLUMN IF NOT EXISTS reason      TEXT;
ALTER TABLE commerce_ledger ADD COLUMN IF NOT EXISTS entitlement JSONB; -- {kind, scope, durationDays, expiresAt}

ALTER TABLE commerce_ledger DROP CONSTRAINT IF EXISTS commerce_ledger_event_type_check;
ALTER TABLE commerce_ledger ADD  CONSTRAINT commerce_ledger_event_type_check CHECK (event_type IN (
  'PURCHASE_SUCCEEDED','PURCHASE_FAILED','REFUND','CHARGEBACK',
  'MANUAL_GRANT','MANUAL_REVOKE',
  'SUBSCRIPTION_STARTED','SUBSCRIPTION_RENEWED','SUBSCRIPTION_CANCELLED',
  'SEAT_ASSIGNED','SEAT_UNASSIGNED','SEAT_POOL_PURCHASED'));

ALTER TABLE commerce_ledger DROP CONSTRAINT IF EXISTS commerce_ledger_source_check;
ALTER TABLE commerce_ledger ADD  CONSTRAINT commerce_ledger_source_check
  CHECK (source IN ('PAYMENT','ADMIN','SCHOLARSHIP','ORG_SEAT','SYSTEM','CUSTOMER'));

-- Reversals and cancellations must point at an earlier event; nothing else may.
ALTER TABLE commerce_ledger DROP CONSTRAINT IF EXISTS commerce_ledger_check;           -- old REFUND-only rule
ALTER TABLE commerce_ledger DROP CONSTRAINT IF EXISTS commerce_ledger_reference_check;
ALTER TABLE commerce_ledger ADD  CONSTRAINT commerce_ledger_reference_check CHECK (
  (event_type IN ('REFUND','CHARGEBACK','MANUAL_REVOKE','SEAT_UNASSIGNED','SUBSCRIPTION_CANCELLED'))
  = (reference_event_id IS NOT NULL));

-- At most one reversal (refund, chargeback, revoke, unassign) per event, enforced under concurrency
DROP INDEX IF EXISTS uq_one_refund_per_purchase;
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_reversal_per_event
  ON commerce_ledger (reference_event_id)
  WHERE event_type IN ('REFUND','CHARGEBACK','MANUAL_REVOKE','SEAT_UNASSIGNED');

CREATE INDEX IF NOT EXISTS ix_ledger_user_product
  ON commerce_ledger (user_id, product_id, ledger_sequence_id);

-- Prevent UPDATE / DELETE / TRUNCATE on commerce_ledger
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commerce_ledger is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_no_mod ON commerce_ledger;
CREATE TRIGGER trg_ledger_no_mod BEFORE UPDATE OR DELETE ON commerce_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON commerce_ledger;
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON commerce_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

-- -----------------------------------------------------------------------------
-- 7. Webhook Inbox Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT        NOT NULL,
  provider_event_id   TEXT        NOT NULL,
  raw_body            TEXT        NOT NULL,
  headers             JSONB       NOT NULL DEFAULT '{}',
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT        NOT NULL DEFAULT 'RECEIVED'
                      CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','IGNORED','FAILED')),
  failure_reason      TEXT,
  processed_at        TIMESTAMPTZ,
  ledger_event_id     TEXT        REFERENCES commerce_ledger(event_id),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS ix_inbox_status ON webhook_inbox (status) WHERE status IN ('RECEIVED','FAILED');
-- M2: retry bookkeeping. attempts = processing attempts so far; next_retry_at = when a
-- FAILED row is due again (backoff) or, while PROCESSING, when its lease expires.
-- DEAD = gave up after WEBHOOK_MAX_ATTEMPTS (reported by reconciliation, re-queued by an admin).
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS attempts      INT NOT NULL DEFAULT 0;
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE webhook_inbox DROP CONSTRAINT IF EXISTS webhook_inbox_status_check;
ALTER TABLE webhook_inbox ADD CONSTRAINT webhook_inbox_status_check
  CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','IGNORED','FAILED','DEAD'));
CREATE INDEX IF NOT EXISTS ix_inbox_retry_due ON webhook_inbox (next_retry_at)
  WHERE status IN ('FAILED','PROCESSING');

-- -----------------------------------------------------------------------------
-- 8. Reconciliation (M6)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recon_runs (
  id           BIGSERIAL PRIMARY KEY,
  trigger      TEXT        NOT NULL,              -- 'scheduled' | 'manual:<email>' | 'script'
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  since        TIMESTAMPTZ NOT NULL,              -- provider look-back window start
  summary      JSONB       NOT NULL DEFAULT '{}',
  error        TEXT
);

-- One row per discrepancy. AUTO_FIXED rows are the audit trail of repairs the
-- reconciler made itself; OPEN rows need an admin.
CREATE TABLE IF NOT EXISTS recon_issues (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT        NOT NULL,
  provider      TEXT,
  ref           TEXT        NOT NULL,             -- payment / refund / order / inbox id the issue is about
  order_id      UUID,
  details       JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','RESOLVED','AUTO_FIXED')),
  first_run_id  BIGINT      REFERENCES recon_runs(id),
  last_run_id   BIGINT      REFERENCES recon_runs(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  note          TEXT
);
-- An open issue is reported once and updated on later runs, not duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_issue_open ON recon_issues (kind, ref) WHERE status = 'OPEN';
-- A given repair is made (and logged) once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_issue_fixed ON recon_issues (kind, ref) WHERE status = 'AUTO_FIXED';

-- -----------------------------------------------------------------------------
-- 9. Enterprise seats and subscription lifecycle (M4)
-- -----------------------------------------------------------------------------
-- A subscription line bought while the customer already had an active pass of the same
-- scope is a renewal (SUBSCRIPTION_RENEWED, stacked after the current end). Decided at
-- checkout and stored here, so webhook retries / reconciliation replays record the same type.
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS renewal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_user_id UUID NOT NULL UNIQUE REFERENCES users(id),   -- the buyer manages the org (one org per user)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per seat pack bought: N seats of one course. Which seats are in use is NOT
-- stored here: it is counted from SEAT_ASSIGNED events (payment_info.poolId) that have
-- not been reversed by SEAT_UNASSIGNED.
CREATE TABLE IF NOT EXISTS org_seat_pools (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  course_id         VARCHAR(100) NOT NULL,
  seats             INT NOT NULL CHECK (seats > 0),
  order_id          UUID NOT NULL UNIQUE REFERENCES orders(id),
  purchase_event_id TEXT REFERENCES commerce_ledger(event_id),  -- SEAT_POOL_PURCHASED, set when paid
  status            TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                    CHECK (status IN ('PENDING_PAYMENT','ACTIVE','REVOKED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_seat_pools_org ON org_seat_pools (org_id);
CREATE INDEX IF NOT EXISTS ix_ledger_seat_pool ON commerce_ledger ((payment_info->>'poolId'))
  WHERE event_type IN ('SEAT_ASSIGNED','SEAT_POOL_PURCHASED');

-- -----------------------------------------------------------------------------
-- 10. Usage quotas (M5)
-- -----------------------------------------------------------------------------
-- One counter per (scope, feature, UTC day). scope_key is 'user:<uuid>' for a personal
-- quota or 'org:<uuid>' for a pool shared by an organization's seat holders. Units are
-- taken with one conditional upsert (used + n <= limit), so concurrent requests can never
-- push a counter past its limit.
CREATE TABLE IF NOT EXISTS usage_counters (
  scope_key    TEXT NOT NULL,
  feature      TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  used         INT NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, feature, period_start)
);

-- One row per accepted request (audit trail + idempotency). A retried request with the same
-- request_key is answered from this row instead of being counted again. A request whose work
-- failed afterwards is RELEASED and its units are given back to the counter.
CREATE TABLE IF NOT EXISTS usage_events (
  id           BIGSERIAL PRIMARY KEY,
  request_key  TEXT NOT NULL UNIQUE,
  scope_key    TEXT NOT NULL,
  feature      TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id),
  product_id   TEXT,
  units        INT NOT NULL CHECK (units > 0),
  limit_value  INT NOT NULL,
  used_after   INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'CONSUMED' CHECK (status IN ('CONSUMED','RELEASED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_usage_events_scope ON usage_events (scope_key, feature, period_start);

-- -----------------------------------------------------------------------------
-- 11. Agent-approved purchases (M7)
-- -----------------------------------------------------------------------------
-- An agent proposes a purchase; only the user can approve it. Approval issues a signed,
-- short-lived token carrying a one-time nonce; executing checks the token against this row
-- and flips APPROVED -> EXECUTED exactly once. Payment then runs through the normal order /
-- webhook flow, so the ledger never sees anything agent-specific (order_id is the only link).
CREATE TABLE IF NOT EXISTS purchase_intents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  agent_name   TEXT NOT NULL,
  item_type    TEXT NOT NULL DEFAULT 'COURSE' CHECK (item_type = 'COURSE'),
  item_id      TEXT NOT NULL,
  merchant     TEXT NOT NULL,
  amount_cents INT  NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('mock','razorpay')),
  status       TEXT NOT NULL DEFAULT 'PROPOSED'
               CHECK (status IN ('PROPOSED','APPROVED','EXECUTED','CANCELLED','FAILED')),
  nonce        TEXT,
  approved_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  executed_at  TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  order_id     UUID REFERENCES orders(id),
  failure_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_purchase_intents_user ON purchase_intents (user_id, created_at DESC);

-- M7 hardening -----------------------------------------------------------------------------
-- Agent keys: an agent's own credential (Authorization: Bearer lx_agent_...). Only the hash
-- is stored. Scopes are a subset of propose / read / execute: there is no scope (and no API
-- route) that can approve, so an agent can never approve its own request.
CREATE TABLE IF NOT EXISTS agent_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT[] NOT NULL DEFAULT '{propose,read,execute}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_agent_keys_user ON agent_keys (user_id);

ALTER TABLE purchase_intents ADD COLUMN IF NOT EXISTS agent_key_id    UUID REFERENCES agent_keys(id);
ALTER TABLE purchase_intents ADD COLUMN IF NOT EXISTS token_issued_at TIMESTAMPTZ; -- API agent picked up its token (once)
ALTER TABLE purchase_intents DROP CONSTRAINT IF EXISTS purchase_intents_status_check;
ALTER TABLE purchase_intents ADD  CONSTRAINT purchase_intents_status_check
  CHECK (status IN ('PROPOSED','APPROVED','EXECUTED','CANCELLED','FAILED','EXPIRED'));

-- Close stale / duplicate open requests before the one-open-request-per-course rule below.
UPDATE purchase_intents SET status='EXPIRED'
 WHERE (status='APPROVED' AND expires_at <= now())
    OR (status='PROPOSED' AND created_at <= now() - interval '24 hours');
UPDATE purchase_intents SET status='CANCELLED', cancelled_at=now()
 WHERE id IN (SELECT id FROM (
         SELECT id, row_number() OVER (PARTITION BY user_id, item_id ORDER BY created_at DESC) AS rn
           FROM purchase_intents WHERE status IN ('PROPOSED','APPROVED')) d WHERE rn > 1);
-- At most one open request per user and course (also under concurrent proposals).
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_intents_open
  ON purchase_intents (user_id, item_id) WHERE status IN ('PROPOSED','APPROVED');

-- Every step of a request, including rejected attempts (audit trail for M7 / M8).
-- intent_ref is text, not a foreign key: rejected calls may name an id that does not exist.
CREATE TABLE IF NOT EXISTS intent_events (
  id          BIGSERIAL PRIMARY KEY,
  intent_ref  TEXT NOT NULL,
  user_id     UUID,          -- caller (user or the user behind an agent key)
  actor       TEXT NOT NULL, -- 'user', 'agent:<name>', 'system'
  event       TEXT NOT NULL, -- PROPOSED, APPROVED, APPROVE_DENIED, CANCELLED, TOKEN_ISSUED, EXECUTED, REJECTED, FAILED, EXPIRED
  code        TEXT,          -- rejection / failure code
  detail      TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_intent_events_ref ON intent_events (intent_ref, id);
-- The provider's checkout link for an executed request that is paid on a checkout page
-- (Razorpay), so the purchase card can always show its Pay button.
ALTER TABLE purchase_intents ADD COLUMN IF NOT EXISTS pay_url TEXT;

-- -----------------------------------------------------------------------------
-- M7: LEARNX Assistant, an AI agent (Groq / Gemini) inside the app
-- -----------------------------------------------------------------------------
-- One chat thread per user. Each row is one message in the OpenAI chat format (user,
-- assistant with tool calls, or tool result), so the model gets its own history back.
-- Approval tokens are never stored here: the assistant's tools use them on the server.
CREATE TABLE IF NOT EXISTS assistant_messages (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  message    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_assistant_messages_user ON assistant_messages (user_id, id);

-- Assistant log (admin monitoring). One row per chat turn: what the user typed, the reply,
-- the tools used, which model answered, tokens, time taken and any error (including limit
-- errors and model failures, which are not kept in assistant_messages). Clear chat does not
-- touch it. Rows are never updated; they are deleted only by the retention purge
-- (ASSISTANT_LOG_DAYS), which sets learnx.assistant_log_purge for its own transaction.
CREATE TABLE IF NOT EXISTS assistant_log (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id),
  user_email        TEXT,
  ip                TEXT,
  status            TEXT NOT NULL CHECK (status IN ('OK','ERROR')),
  error_code        TEXT,
  error_message     TEXT,
  user_message      TEXT NOT NULL,
  reply             TEXT,
  raw_reply         TEXT,            -- the model's own text when the app replaced it
  tools             JSONB NOT NULL DEFAULT '[]',
  flags             TEXT[] NOT NULL DEFAULT '{}',
  provider          TEXT,
  model_calls       INT NOT NULL DEFAULT 0,
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  duration_ms       INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_assistant_log_created ON assistant_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_assistant_log_user ON assistant_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION assistant_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('learnx.assistant_log_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'assistant_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assistant_log_guard ON assistant_log;
CREATE TRIGGER trg_assistant_log_guard BEFORE UPDATE OR DELETE ON assistant_log
  FOR EACH ROW EXECUTE FUNCTION assistant_log_guard();
DROP TRIGGER IF EXISTS trg_assistant_log_no_truncate ON assistant_log;
CREATE TRIGGER trg_assistant_log_no_truncate BEFORE TRUNCATE ON assistant_log
  FOR EACH STATEMENT EXECUTE FUNCTION assistant_log_guard();

-- Subscription refunds (2026-11-20): which kind of pass refund claimed this order.
--   PASS_FULL      - Refund: every paid period of the current pass; when all are refunded the
--                    free (admin / scholarship) periods of the pass end too.
--   RENEWAL_CANCEL - Cancel renewal: a renewal paid in advance, refunded in full.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_scope TEXT;

-- One order per checkout click (2026-11-20): the cart / seat-pack form's one-time key and the
-- provider checkout link, so a repeated submit returns to the same checkout instead of creating
-- a second order (services/checkoutOnce.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_key TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_checkout_key ON orders (user_id, checkout_key) WHERE checkout_key IS NOT NULL;

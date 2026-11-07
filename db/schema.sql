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
CREATE TABLE IF NOT EXISTS courses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency    CHAR(3) NOT NULL DEFAULT 'USD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO courses (slug, title, description, price_cents) VALUES
  ('intro-to-sql',      'Intro to SQL',       'Queries, joins and indexes from zero.',      2000),
  ('event-sourcing-101','Event Sourcing 101', 'Ledgers, projections and replay.',           3500),
  ('payments-in-depth', 'Payments in Depth',  'Webhooks, idempotency and reconciliation.',  5000)
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Cart Items Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
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

-- -----------------------------------------------------------------------------
-- 5. Orders Table (Checkout Audit & Pricing Trail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents      INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  final_payable_cents INTEGER NOT NULL CHECK (final_payable_cents >= 0),
  applied_rule_id     UUID REFERENCES pricing_rules(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('mock', 'razorpay')),
  status              TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_orders_user ON orders (user_id);

-- -----------------------------------------------------------------------------
-- 6. Commerce Ledger Table (Append-Only Source of Truth)
-- -----------------------------------------------------------------------------
-- Note: product_id intentionally has no FK constraint to courses(slug)
-- so it can accept both course slugs and subscription plan IDs like 'sub_monthly'.
CREATE TABLE IF NOT EXISTS commerce_ledger (
  ledger_sequence_id BIGSERIAL PRIMARY KEY,
  event_id           TEXT        NOT NULL UNIQUE,
  event_type         TEXT        NOT NULL CHECK (event_type IN ('PURCHASE_SUCCEEDED','PURCHASE_FAILED','REFUND')),
  user_id            UUID        NOT NULL REFERENCES users(id),
  product_id         TEXT        NOT NULL,
  quantity           INTEGER     NOT NULL CHECK (quantity > 0),
  amount             NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency           CHAR(3)     NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  reference_event_id TEXT        REFERENCES commerce_ledger(event_id),
  product_snapshot   JSONB       NOT NULL,
  payment_info       JSONB       NOT NULL DEFAULT '{}',
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((event_type = 'REFUND') = (reference_event_id IS NOT NULL))
);

-- At most one refund per purchase, enforced under concurrency
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_refund_per_purchase
  ON commerce_ledger (reference_event_id) WHERE event_type = 'REFUND';

CREATE INDEX IF NOT EXISTS ix_ledger_user_product
  ON commerce_ledger (user_id, product_id, ledger_sequence_id);

-- Prevent UPDATE / DELETE / TRUNCATE on commerce_ledger
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
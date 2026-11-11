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
  'SEAT_ASSIGNED','SEAT_UNASSIGNED'));

ALTER TABLE commerce_ledger DROP CONSTRAINT IF EXISTS commerce_ledger_source_check;
ALTER TABLE commerce_ledger ADD  CONSTRAINT commerce_ledger_source_check
  CHECK (source IN ('PAYMENT','ADMIN','SCHOLARSHIP','ORG_SEAT','SYSTEM'));

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
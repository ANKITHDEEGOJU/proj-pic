CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Purchasable assets. Money is integer minor units (cents) + currency. Never floats.
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

-- Commerce ledger: append-only source of truth
CREATE TABLE IF NOT EXISTS commerce_ledger (
  ledger_sequence_id BIGSERIAL PRIMARY KEY,                       -- L2: monotonic order (gaps possible)
  event_id           TEXT        NOT NULL UNIQUE,                 -- L3: idempotency key
  event_type         TEXT        NOT NULL CHECK (event_type IN ('PURCHASE_SUCCEEDED','PURCHASE_FAILED','REFUND')), -- E3
  user_id            UUID        NOT NULL REFERENCES users(id),   -- E2
  product_id         TEXT        NOT NULL REFERENCES courses(slug),-- E2
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

-- At most one refund per purchase, enforced under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_refund_per_purchase
  ON commerce_ledger (reference_event_id) WHERE event_type = 'REFUND';
CREATE INDEX IF NOT EXISTS ix_ledger_user_product ON commerce_ledger (user_id, product_id, ledger_sequence_id);

-- L1: the database itself rejects UPDATE / DELETE / TRUNCATE.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'commerce_ledger is append-only (L1)'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ledger_no_mod ON commerce_ledger;
CREATE TRIGGER trg_ledger_no_mod BEFORE UPDATE OR DELETE ON commerce_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON commerce_ledger;
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON commerce_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
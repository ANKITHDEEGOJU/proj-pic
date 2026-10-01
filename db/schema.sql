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

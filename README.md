# Learnx

A course storefront built with Node.js, Express and PostgreSQL. Users can browse courses, add them to a cart, apply coupons, and pay through Razorpay (test mode) or a bundled mock payment provider. Course access is tracked in an append-only commerce ledger driven by payment webhooks.

## Features

- Email/password auth (JWT in a cookie)
- Course catalog, cart with multi-course checkout, and global subscriptions
- Coupons and pricing rules
- Payments via Razorpay test mode or a local mock provider
- Webhook handling with an inbox table for tracking deliveries, plus purchase and refund events
- Admin panel: manage pricing rules and grant or revoke course access for users

## Requirements

- Node.js 18+
- PostgreSQL

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values
createdb learnx       # or create the database another way
npm run db:init           # applies db/schema.sql
```

Main variables in `.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret for signing auth tokens (required) |
| `ADMIN_EMAIL` | Email that gets admin access (default `admin@learnx.com`) |
| `MOCK_WEBHOOK_SECRET`, `MOCK_PROVIDER_URL`, `MOCK_PROVIDER_PORT` | Mock payment provider |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay test credentials |

## Running

```bash
npm start                          # app on http://localhost:3000
cd mock-provider && npm start      # optional mock payment provider on :3001
```

Then open http://localhost:3000/login, register an account, and visit `/courses`. Admin pages are at `/admin`.

## Webhook retries and reconciliation

- **Retries (M2):** every webhook is stored in `webhook_inbox` before processing. Failed rows are retried in the background with exponential backoff (30 s, 60 s, … capped at 1 h) and become `DEAD` after 8 attempts. A refund that arrives before its purchase gets HTTP 503 so the provider re-sends it.
- **Reconciliation (M6):** every 15 minutes (and on demand at `/admin/reconciliation`) the app compares Razorpay's payments and refunds with the ledger. Lost payment/refund webhooks and stuck `REFUND_PENDING` orders are repaired by replaying the missing provider event through the normal webhook pipeline; amount mismatches, partial refunds, unknown payments, failed refunds and dead webhooks are listed for an admin. The mock provider only gets the database-side checks.

Settings are in `.env.example` (all optional).

## Project structure

```
db/schema.sql        Database schema
mock-provider/       Standalone fake payment provider that sends webhooks
src/server.js        App entry point
src/routes/          HTTP routes (auth, courses, cart, checkout, admin, webhooks)
src/domain/          Commerce ledger, projection and catalog logic
src/payment/         Payment adapters (mock, Razorpay) and webhook processing
src/services/        Cart and pricing engine
src/views.js         HTML templates
```

## Verification

```bash
npm run verify       # ledger checks + webhook retry / reconciliation checks against Postgres
```

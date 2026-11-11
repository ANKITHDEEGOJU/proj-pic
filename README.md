# Learnx

A course storefront built with Node.js, Express and PostgreSQL. Users can browse courses, add them to a cart, apply coupons, and pay through Razorpay (test mode) or a bundled mock payment provider. Course access is tracked in an append-only commerce ledger driven by payment webhooks.

## Features

- Email/password auth (JWT in a cookie)
- Course catalog, cart with multi-course checkout, and global subscriptions
- Coupons and pricing rules
- Payments via Razorpay test mode or a local mock provider
- Webhook handling with an inbox table for tracking deliveries, plus purchase and refund events
- Admin panel: manage pricing rules and grant or revoke course access for users
- Organizations with seat packs, and subscription renew / cancel

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

## Commercial rules

**Cart and coupons**
- A cart holds either individual courses or one All-Access pass, never both: adding a pass empties the cart, and adding a course removes a pass.
- One coupon per order. The discount is split across the order's lines, so per-item ledger amounts add up to what was charged. An applied coupon is remembered across page loads and re-checked at checkout.
- Coupons don't apply to seat packs.

**Courses vs the All-Access pass**
- A course can be held several ways at once (bought, admin grant, org seat, pass). Losing one of them (refund, revoke, seat unassigned, pass expired) keeps any other.
- A pass gives every course while it is active. Courses bought separately stay after the pass ends.

**Subscriptions (manual renewal)**
- *Renew* pays for another 30 days through the normal checkout. Bought while a pass is active, it is recorded as `SUBSCRIPTION_RENEWED` and starts when the current period ends.
- *Cancel renewal* records `SUBSCRIPTION_CANCELLED`. Access continues until the paid-up end date and the renewal reminder (last 7 days) stops. Paying again turns renewal back on.
- A refund removes only the period it refunds.

**Enterprise seats**
- The buyer of a seat pack owns the organization (one per user) and manages it at `/org`. Platform admins see all organizations at `/admin/orgs`.
- A seat pack is N seats of one course, priced N × course price. Buying it gives the buyer no access by itself.
- Seats are assigned by the member's email (they need a LearnX account). One seat per member per pack, never more than N in use. Usage is counted from the ledger.
- Unassign takes the seat back; reassign moves it to another member in one step.
- Refunding or charging back a pack unassigns every seat. Refunds wait for the provider's webhook, like course refunds.

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
npm run verify       # ledger, webhook retry / reconciliation and M4 (seats, subscriptions) checks against Postgres
```

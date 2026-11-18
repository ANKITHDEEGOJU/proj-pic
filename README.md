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
- Usage quotas on a premium feature (sandbox "AI summary"), per user or pooled per organization
- Agent-approved purchases: an agent proposes, the user approves, a signed one-time approval executes it

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
- **Reconciliation (M6):** every 15 minutes (and on demand at `/admin/reconciliation`) the app compares Razorpay's payments and refunds with the ledger. Lost payment/refund webhooks and stuck `REFUND_PENDING` orders are repaired by replaying the missing provider event through the normal webhook pipeline; amount mismatches, partial refunds, unknown payments, failed refunds and dead webhooks are listed for an admin. The mock provider is checked the same way (it keeps its own payment and refund records in `mock-provider/data.json`).

Settings are in `.env.example` (all optional).

## Demo walkthrough (browser)

A step-by-step demo of everything the project does, using the mock payment provider.

**Before you start**
- In `.env`, point both servers at each other on localhost: `STREAMFLIX_URL=http://localhost:3000` and `MOCK_PROVIDER_URL=http://localhost:3001`.
- Optional, so reconciliation fixes fresh events straight away: `RECON_GRACE_SECONDS=0`.
- Start both servers (see **Running**). Keep two tabs open: the app (`http://localhost:3000`) and the mock admin page (`http://localhost:3001/admin`).
- Register two users, for example `alice@demo.local` and `bob@demo.local`. Log in as `admin@learnx.com` (or your `ADMIN_EMAIL`) in a private window for the admin steps.

**1. One-time purchase**
1. As Alice, open **Courses**, click **Add to Cart** on a course, go to **Cart**, and check out with the mock provider.
2. On the MockPay page click **Pay**. You come back to Courses and the course shows **Owned**.
3. Click **Access**: it says *Allowed · ACTIVE_PURCHASE*. **Activity** shows the `PURCHASE_SUCCEEDED` ledger event.

**2. Refund**
1. On the same course click **Refund**. The card shows *Refund pending* for a moment, then **Refunded**.
2. **Access** now says *Denied · PURCHASE_REFUNDED*. **Activity** shows a `REFUND` event pointing at the purchase.

**3. Subscription and expiry**
1. As Alice, buy the **All-Access pass** the same way. Every course now opens (*ACTIVE_SUBSCRIPTION_PASS*).
2. The pass card shows the end date, **Renew** (adds another period after the current one) and **Cancel renewal** (access stays until the end date).
3. Expiry: when the end date passes, every course closes again and shows **Expired**. *A pass lasts 30 days, so a short demo pass setting is still to be added to show this live.*

**4. Enterprise seats**
1. As Alice, open **Organization**, give the organization a name, choose a course and 2 seats, and click **Buy seats →**. Pay on MockPay.
2. Alice gets no access from buying seats. Assign a seat to `bob@demo.local`.
3. As Bob, the course shows *Seat from your organization*. As Alice, **Unassign** the seat: Bob loses access. **Reassign** moves a seat to another member in one step.

**5. Duplicate events**
1. On the mock admin page choose **Duplicate webhooks** for 1 call and click **Apply**.
2. As Bob, buy a course and pay. The mock admin page shows 3 copies sent; the app records the purchase **once** (check **Activity**).

**6. Lost events and reconciliation**
1. On the mock admin page choose **Drop webhooks** for 1 call and **Apply**.
2. As Bob, buy another course and pay. The mock shows the webhook as *DROPPED*; the course is **not** owned.
3. As admin, open `/admin/reconciliation` and click **Run**. It reports a fixed `MISSING_PURCHASE`, and Bob now owns the course. Running it again changes nothing.
4. Optional: try **Reorder** (then **Refund at provider** on the mock admin page) and **Refund API returns HTTP 500** (then click **Refund** in the app). See the table below for what to expect.

**7. Usage quota**
1. As Bob, on an owned course click **AI summary**, then **Generate summary** until the credits run out: you get *Quota used up* with the reset time.

**8. Agent-approved purchase (optional)**
1. As Bob, open **Agent**. In **Simulated agent** pick a course Bob doesn't own, choose *Mock provider*, and click **Agent: propose purchase**.
2. You see the request: item, merchant `LEARNX` and the catalog price. Click **Approve this purchase**.
3. The next page shows the token the agent received. Change one character and click **Agent: execute purchase**: *Rejected: TAMPERED*. Undo the change and execute again: *Purchase completed*, and the course is now owned.
4. Click **Agent: execute purchase** once more: *Rejected: REPLAYED*. Also try **Cancel** on another approved request, then executing it: *Rejected: CANCELLED*.
5. With *Razorpay test mode* instead, executing takes you to Razorpay checkout for exactly the approved amount (test card `5267 3181 8797 5449`, any OTP).

## Failure switches (mock provider)

The mock provider's admin page (`http://localhost:3001/admin`) has a **Failure switch** to make it misbehave on purpose, so you can see the app still ends up correct.

Pick a switch, choose for how many calls (0 = until you turn it off), and click **Apply**.

| Switch | What the mock does | What you should see in the app |
|---|---|---|
| Duplicate webhooks | Sends each webhook 3 times | Bought once; the extra copies are ignored |
| Delay webhooks | Sends the webhook N seconds late | No access at first, then access appears |
| Reorder | Holds the payment webhook. Click **Refund at provider**: the refund is sent first, then the payment | Refund is refused (HTTP 503) until the payment arrives, then both are applied once |
| Drop webhooks | Never sends the webhook | No access (or refund stays pending) until reconciliation runs (`/admin/reconciliation` → Run); then it's fixed |
| Refund API returns HTTP 500 | The refund request fails | "Refund failed" message; access kept; you can try again |

The admin page also lists the payments the provider has, webhooks it is holding (**Release** sends one now), and every webhook it sent (copies, retries, dropped ones). Like Razorpay, the mock re-sends a webhook that got a 5xx or no answer (after 5 s, 15 s, 45 s).

Automatic check (needs both servers running on localhost): `npm run verify:failures`. See the top of `mock-provider/verify-failure-switches.js` for the settings it needs.

## Usage quotas

Each course you can open has an **AI summary** button. Every click uses 1 credit. Credits reset every day at 00:00 UTC.

This is a demo: no real AI is called. The summary is made from the course details.

**How many credits you get per day**

| How you got the course | Credits per day | Setting |
|---|---|---|
| Bought it, or an admin gave it to you | 5 (just for you) | `QUOTA_AI_SUMMARY_USER` |
| All-Access pass | 20 (just for you) | `QUOTA_AI_SUMMARY_SUBSCRIBER` |
| Seat from your organization | 10 per seat, shared by the whole organization | `QUOTA_AI_SUMMARY_PER_SEAT` |

Example: an organization with 3 seats shares 30 credits a day between all its members.

**What happens when**
- **Credits run out:** you see "Quota used up" and the server answers HTTP 429 with a `Retry-After` header (seconds until the reset).
- **Many clicks at the same time:** the limit is never crossed. The database checks and adds in one step.
- **Double click or retry:** each button has its own request id, so the same request is counted only once.
- **The summary fails:** the credit is given back. To test this, set `AI_SUMMARY_FAIL_RATE` (0 = never fail, 1 = always fail).

Credits are stored in `usage_counters` (one row per user or organization, per day). Every accepted request is logged in `usage_events`.

## Agent-approved purchase (M7)

An AI agent can **suggest** a purchase, but only the user can **approve** it. The approval is locked to the exact item, seller and price, works once, and expires after 5 minutes.

Open **Agent** in the menu (`/agent`).

**Which agent?** The app doesn't depend on any particular agent. Anything that calls the agent API (below) acts as "the agent". The app includes a **Simulated agent** form, so no AI model or API key is needed. In this sandbox the agent uses the user's login; a real agent would get its own credential that can propose and execute but never approve. Optionally, a small real agent could be added later using Claude (model `claude-opus-5-5`, through the official `@anthropic-ai/sdk` package). It would get three tools: *list courses*, *propose purchase* and *execute purchase*. It can never approve: approval happens only in the user's browser. All the safety checks are done by the server, so they hold no matter which agent or model is used.

**How it works**
1. **The agent proposes:** `POST /agent/intents` with a course. The server fills in the item, seller (`LEARNX`) and current price from the catalog (the agent can't choose the amount) and saves a `purchase_intents` row with status `PROPOSED`.
2. **The user approves:** the page `/agent/intents/:id` shows item, seller and amount with **Approve** and **Cancel** buttons. Approve creates a signed token (JWT) holding the intent id, user, item, seller, amount, currency and a one-time nonce, valid for 5 minutes.
3. **The agent executes:** `POST /agent/intents/:id/execute` with the token. The server rejects it if:
   - the signature is wrong (token was **tampered** with),
   - it is **expired** (older than 5 minutes),
   - the item, seller or amount differ from the approved intent, or the catalog price changed since approval,
   - the intent was **cancelled**,
   - it was already used (**replay**): only one `APPROVED -> EXECUTED` update can win.
4. **Payment** goes through the normal provider flow, so the ledger records an ordinary `PURCHASE_SUCCEEDED`. The ledger never knows an agent was involved; the only link is `purchase_intents.order_id`.

**Payment per provider**
| | Mock provider | Razorpay (test mode) |
|---|---|---|
| After a valid execute | The server charges the payment directly; the agent finishes the purchase on its own | A Razorpay order is created for the approved amount; the user pays it on Razorpay checkout (test card `5267 3181 8797 5449`, any OTP) |
| Can the amount change? | No - taken from the approved intent | No - fixed in the Razorpay order on the server; reconciliation flags any `AMOUNT_MISMATCH` |
| Access | Normal webhook -> `PURCHASE_SUCCEEDED` | Normal webhook -> `PURCHASE_SUCCEEDED` |

Razorpay can't be charged by our server without the customer: card details and OTP are typed on Razorpay's checkout page. Charging without the customer would need Razorpay recurring tokens or server-side card payments, which must be enabled on the account (possible later work).

**Agent API (JSON)** for a real agent: `POST /agent/api/intents` with `{ productId, provider }` returns the intent and an `approvalUrl` for the user; `POST /agent/api/intents/:id/execute` with `{ token }` returns `PAID` (mock) or `CHECKOUT` with a `redirectUrl` (Razorpay). Rejections come back as HTTP 409 with a code: `TAMPERED`, `EXPIRED`, `WRONG_INTENT`, `WRONG_USER`, `MISMATCH`, `PRICE_CHANGED`, `CANCELLED`, `NOT_APPROVED`, `REPLAYED`.

**Settings (optional):** `AGENT_APPROVAL_TTL_SECONDS` (default 300), `AGENT_APPROVAL_SECRET` (default: derived from `JWT_SECRET`), `MERCHANT_ID` (default `LEARNX`).

**Code:** table `purchase_intents`, `src/services/agentPurchase.js`, `src/routes/agent.js`, the mock provider's `/api/charge` endpoint, checks in `npm run verify:m7`. The ledger, access decisions, webhook processing and reconciliation were not changed.

## Project structure

```
db/schema.sql        Database schema
mock-provider/       Standalone fake payment provider that sends webhooks
src/server.js        App entry point
src/routes/          HTTP routes (auth, courses, cart, checkout, admin, webhooks)
src/domain/          Commerce ledger, projection and catalog logic
src/payment/         Payment adapters (mock, Razorpay) and webhook processing
src/services/        Cart, pricing, seats, subscriptions, usage quotas and agent purchases
src/views.js         HTML templates
```

## Verification

```bash
npm run verify       # ledger, webhook retry / reconciliation, M4 (seats, subscriptions), M5 (quotas) and M7 (agent purchases) checks against Postgres
```

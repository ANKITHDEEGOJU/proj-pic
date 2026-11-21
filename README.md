# Learnx

**CS5903 project 7, group 46** · Provider-neutral payments, subscriptions, entitlements and agent-mediated commerce ·
Report: [`docs/Project_Report.pdf`](docs/Project_Report.pdf) · Decisions: [`docs/Architecture_Decision_Records.md`](docs/Architecture_Decision_Records.md) ·
Evaluation: [`evaluation/`](evaluation/) · Tests: [`test/`](test/) · E2E evidence: [`docs/E2E-TESTS.md`](docs/E2E-TESTS.md)

A course storefront built with Node.js, Express and PostgreSQL. Users can browse courses, add them to a cart, apply coupons, and pay through Razorpay (test mode) or a bundled mock payment provider. Course access is tracked in an append-only commerce ledger driven by payment webhooks.

## Features

- Email/password auth (JWT in a cookie)
- Course catalog, cart with multi-course checkout, and global subscriptions
- Coupons and pricing rules
- Payments via Razorpay test mode or a local mock provider
- Webhook handling with an inbox table for tracking deliveries, plus purchase and refund events
- Admin panel: manage pricing rules and grant or revoke course access for users
- Organizations with seat packs, and subscription renew / cancel (one renewal at a time; Refund refunds the whole pass)
- Usage quotas on a premium feature (sandbox "AI summary"), per user or pooled per organization
- Agent-approved purchases with **LEARNX Assistant**, an AI agent (Groq): it proposes, you approve with a button, a signed one-time approval lets it complete the purchase
- **Course guides**: one document per course, published by the admin; a learner can open it only while they have access (purchase, pass, seat, grant), and it closes on refund or when the pass ends
- Admin **Assistant Log**: every assistant chat turn (message, reply, tools, model, tokens, errors), admin only, kept even when a user clears their chat

## Status

| Milestone | Status | Evidence |
|---|---|---|
| M1 Transaction model | Completed | `test/verify-domain-memory.js`, `test/verify-domain-pg.js` |
| M2 Adapter + idempotency | Completed | `test/verify-m2-m6.js`, `test/verify-failure-switches.js`, evaluation S1–S2 |
| M3 Entitlement ledger | Completed | `test/verify-domain-pg.js`, `test/verify-content.js` |
| M4 Commercial rules (coupons, seats, pass) | Completed, one known defect: 10 or more simultaneous seat assignments to one pack can freeze the app (ADR-031) | `test/verify-m4.js`, `test/verify-idempotency.js`, evaluation S6 |
| M5 Usage quotas | Completed | `test/verify-m5.js`, evaluation S5 |
| M6 Refund + reconciliation | Completed | `test/verify-m2-m6.js`, evaluation S3–S4 |
| M7 Agent-mediated purchase (AP2-inspired) | Completed (full AP2 not adopted, see ADR-012) | `test/verify-m7.js`, `test/verify-assistant.js`, `test/verify-agent-coupons.js`, evaluation S7 |
| M8 Audit + failure validation | Completed | `test/verify-failure-switches.js`, `docs/E2E-TESTS.md` |
| Automatic pass renewal (recurring payments) | Not implemented (Razorpay test account has no card mandates, ADR-014) | — |
| Running several app instances | Not supported (in-memory projection and counters) | — |

## Requirements

- Node.js 18 or newer (tested with 24.21)
- PostgreSQL 14 or newer (tested with 17.10)
- Exact package versions are pinned by `package-lock.json` (`npm ci` installs exactly those)
- Optional: a Razorpay **test-mode** account (free) and ngrok for Razorpay webhooks; a free Groq API key for the assistant. Everything else (mock provider, tests, evaluation) runs without accounts.

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values
createdb learnx       # or create the database another way
npm run db:init           # applies db/schema.sql
```

`db/schema.sql` can be run again at any time: it only adds what is missing. Run `npm run db:init` again **after every update** (the 2026-11-20 changes add the `assistant_log`, `course_docs` and `course_doc_events` tables and the `orders.refund_scope`, `checkout_key` and `checkout_url` columns).

Main variables in `.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret for signing auth tokens (required) |
| `ADMIN_EMAIL` | Email that gets admin access (default `admin@learnx.com`) |
| `MOCK_WEBHOOK_SECRET`, `MOCK_PROVIDER_URL`, `MOCK_PROVIDER_PORT` | Mock payment provider |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay test credentials |
| `GROQ_API_KEY` (optional `GEMINI_API_KEY`) | LEARNX Assistant model (see *LEARNX Assistant*) |
| `SUB_DURATION_MINUTES` | Demo only: every pass period lasts N minutes instead of 30 days |
| `RENEW_PENDING_MINUTES` | How long an unpaid renewal checkout blocks another Renew (default 30) |
| `ASSISTANT_LOG_DAYS` | Days the admin assistant log is kept (default 90; 0 = forever) |

## Running

```bash
npm start                          # app on http://localhost:3000
cd mock-provider && npm start      # optional mock payment provider on :3001
```

Then open http://localhost:3000/login, register an account, and visit `/courses`. Admin pages are at `/admin`.

**Secrets:** `JWT_SECRET` and `MOCK_WEBHOOK_SECRET` must be your own random values, never the ones in `.env.example` (anyone who knows them can sign an admin session or forge a mock payment). Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The app warns at startup when a secret still equals the example value, and refuses to start with `NODE_ENV=production`. The mock provider reads the same `.env`, so restart both after changing `MOCK_WEBHOOK_SECRET`. `POST /api/dev/events` (write ledger events directly) exists only with `ENABLE_DEV_EVENTS=1`, for the admin.

**Limits on password guessing** (in memory, per app instance; every attempt is counted before the password is checked, so parallel requests get no extra tries, and a successful login clears the count): `LOGIN_MAX_FAILS` (5) attempts per email from one IP, `LOGIN_MAX_PER_EMAIL` (50) per email from any IP (so a stranger can't cheaply lock your account) and `LOGIN_MAX_PER_IP` (30) per IP, per `LOGIN_WINDOW_MINUTES` (15); `REGISTER_MAX_PER_IP` (10) sign-ups per IP per hour; `STEPUP_MAX_FAILS` (5) wrong approval passwords per user per window. A blocked attempt is refused before the password is checked, with *Too many attempts. Try again in …*. Errors never show internal details to the browser: the page gets *Server error (ref abc12345)* and the log has the full error under that reference. Behind a tunnel or proxy on the same machine (ngrok) the visitor's real address is used (`TRUST_PROXY`, default `loopback`; only a local proxy is trusted, so a remote client can't fake its IP). The `ADMIN_EMAIL` address can't be claimed by signing up (set `ADMIN_ALLOW_REGISTER=1` once to create it). Payments must match the order: the amount and the currency (paying the right number in another currency grants nothing). Checks: `npm run verify:security`.

Set `LOG_REQUESTS=1` to log every POST request with its form fields while debugging (passwords and tokens are redacted); it is off by default.

Run **one** app instance at a time. If `npm start` fails with `EADDRINUSE` (port 3000 in use), another instance is still running: find it with `ss -ltnp | grep :3000` (or `lsof -i :3000`) and stop it (`kill <pid>`), then start again. The same applies to the mock provider on port 3001. After changing code in `mock-provider/`, restart the mock provider too.

## Example: input and expected output

| Do this | Expected |
|---|---|
| `npm run verify` | 11 lines ending in `… CHECKS PASSED`, exit code 0 |
| `node evaluation/run-evaluation.js` | Prints one line per workload, e.g. `S2 … errors/run naive 10, careful 10, LEARNX 0`, and writes `evaluation/results/RESULTS.md` |
| Register, add **Intro to SQL** to the cart, checkout with **Mock**, press **Pay** | Back on Courses; the card says **Owned**; **Access** shows `Allowed · ACTIVE_PURCHASE`; **Open guide** appears once the admin has published the guides |
| Click **Refund** on that course | "Refund pending" briefly, then **Refunded**; **Access** shows `Denied · PURCHASE_REFUNDED`; the guide answers "…refunded, so its guide is closed." |
| On `/agent` type "Buy Intro to SQL with coupon code DEMO" (needs `GROQ_API_KEY` and the DEMO coupon) | A card ~~20.00 USD~~ 19.00 USD with Approve; after Approve and Pay: "Payment received: Intro to SQL is now in your library" |

## Operations

- **Start:** `npm start` (app, port 3000) and `cd mock-provider && node server.js` (mock, port 3001). For Razorpay webhooks, expose port 3000 with ngrok and set the webhook URL in the Razorpay test dashboard to `https://<tunnel>/webhooks/razorpay`.
- **Stop:** Ctrl+C in each terminal. If port 3000 is busy: `ss -ltnp | grep :3000`, then `kill <pid>`.
- **Reset / update the database:** `npm run db:init` (safe to re-run). Test users (`*@test.local`) stay in the ledger by design.
- **Logs:** both servers log to their terminal. An error page shows `Server error (ref abc12345)`; search the app log for that reference. Set `LOG_REQUESTS=1` to log every POST (passwords redacted).
- **Common problems:** mock payments stay pending → the mock still has an old `MOCK_WEBHOOK_SECRET`: restart it after any `.env` change. Mock checkout page doesn't open → `MOCK_PROVIDER_URL` points at an offline tunnel: start the app with `MOCK_PROVIDER_URL=http://localhost:3001`. The assistant says it reached its limit → Groq free-tier rate limit: wait, or add `GEMINI_API_KEY`.
- **External services and costs:** Razorpay test mode (free, test cards only, no real money), Groq (free tier, rate-limited), ngrok (free tier). None are needed for the tests or the evaluation.

## Commercial rules

**Cart and coupons**
- A cart holds either individual courses or one All-Access pass, never both: adding a pass empties the cart, and adding a course removes a pass.
- One coupon per order. The discount is split across the order's lines, so per-item ledger amounts add up to what was charged. An applied coupon is remembered across page loads and re-checked at checkout.
- **One order per click.** The cart and seat-pack forms carry a one-time `checkoutKey`: sending the same form again (double click, back button, retry) returns to the same checkout page instead of creating a second order (`orders.checkout_key` / `checkout_url`, unique per user). The buttons are also disabled while the request runs. Admin grants work the same way: the grant form's one-time `grantKey` is the ledger event id, so a double-submitted grant is recorded once.
- Coupons don't apply to seat packs.

**Courses vs the All-Access pass**
- A course can be held several ways at once (bought, admin grant, org seat, pass). Losing one of them (refund, revoke, seat unassigned, pass expired) keeps any other.
- A pass gives every course while it is active. Courses bought separately stay after the pass ends.

**Subscriptions (manual renewal)**
- *Renew* pays for another 30 days through the normal checkout. Bought while a pass is active, it is recorded as `SUBSCRIPTION_RENEWED` and starts when the current period ends.
- **One renewal at a time.** Once a renewal is paid (or its payment is still open, up to `RENEW_PENDING_MINUTES`, default 30), the card shows no **Renew**, only **Cancel renewal** and **Refund**. The server refuses a second renewal too (Renew, cart checkout and direct checkout). Renew comes back when the paid-in-advance period has started, or after the renewal is cancelled.
- *Cancel renewal* records `SUBSCRIPTION_CANCELLED` (renewal reminder off, card says *Not renewing*). If a renewal was already paid, that renewal is **refunded in full** (it has not been used) and access goes back to the end of the current period. Without one, access simply continues to the paid-up end date. Paying again turns renewal back on.
- **Refund refunds the whole pass**: every paid period that has not ended yet (the one running now and any renewal), one provider refund per payment (they can be at different providers). Orders are marked `refund_scope = PASS_FULL`; the card shows *Refund pending* until every provider has confirmed by webhook, and the page reloads when it finishes. When all are refunded, the pass's admin / scholarship periods end too (`MANUAL_REVOKE`, source `SYSTEM`). If a provider refuses one payment, that order reopens, the others are still refunded and free periods are kept; the card says which part failed. Courses bought separately are never touched.

**Enterprise seats**
- The buyer of a seat pack owns the organization (one per user) and manages it at `/org`. Platform admins see all organizations at `/admin/orgs`.
- A seat pack is N seats of one course, priced N × course price. Buying it gives the buyer no access by itself.
- Seats are assigned by the member's email (they need a LearnX account). One seat per member per pack, never more than N in use. Usage is counted from the ledger.
- Unassign takes the seat back; reassign moves it to another member in one step.
- Refunding or charging back a pack unassigns every seat. Refunds wait for the provider's webhook, like course refunds.
- A seat pack whose checkout was cancelled, failed or not paid in time is shown as a short notice (*Payment cancelled. Nothing was charged.*) that fades out after a few seconds (`ORG_NOTICE_FADE_MS`, default 6000), like the checkout result note; after `ORG_UNPAID_SHOW_SECONDS` (default 120) it is no longer listed at all, so failed attempts don't pile up. The pack row is kept: if the provider still confirms the payment later, the pack becomes active and shows normally.
- After paying for seats (mock or Razorpay) you return to **`/org`** with *Payment received*; *Simulate Failure* or closing / cancelling the checkout also returns there (*Payment failed* / *Payment cancelled. Nothing was charged.*). The checkout pages only accept the return targets `agent` and `org`.

## Course guides (paid content)

Each course has one guide, shipped as a file in `content/<course id>.md` (`intro-to-sql.md`, `event-sourcing-101.md`, `payments-in-depth.md`).

- **The admin can preview** any published guide (*admin preview*) without owning the course.
- **The admin publishes it.** **Admin → Course content** (`/admin/content`) lists every course with its file: **Add to course**, **Update from file** (after editing the file), **Remove**, **View**. Adding twice changes nothing. Every add / update / remove is kept in an append-only history with the admin's email. Until a guide is added, learners see nothing.
- **Access is checked on every request.** `/courses/<course>/doc` asks the same access decision as everything else, each time it is opened: purchase, All-Access Pass, organization seat or admin / scholarship grant all open it. Nothing like "has access to the guide" is stored, so:
  - a purchase opens it as soon as the payment webhook arrives (the course card shows **Open guide**);
  - a confirmed refund, chargeback, revoke or unassigned seat closes it;
  - an All-Access Pass closes it the moment the pass ends (no event needed).
- **An open guide closes itself.** The page re-checks every 30 seconds; when access has ended it reloads and shows why (*Your purchase of this course was refunded…*, *Your All-Access Pass has ended…*).
- Without access the page answers 403 with the reason; the course card says *Includes the course guide (opens once you have access)*.
- Documents are shown with a small built-in Markdown renderer that escapes everything first (headings, paragraphs, lists, code, bold), so a file can't inject HTML.
- Tables `course_docs`, `course_doc_events`; code in `src/services/courseDocs.js`, `src/services/markdown.js`, `src/routes/content.js`; checks in `npm run verify:content`.

## Webhook retries and reconciliation

- **Retries (M2):** every webhook is stored in `webhook_inbox` before processing. Failed rows are retried in the background with exponential backoff (30 s, 60 s, … capped at 1 h) and become `DEAD` after 8 attempts. A refund that arrives before its purchase gets HTTP 503 so the provider re-sends it.
- **Reconciliation (M6):** every 15 minutes (and on demand at `/admin/reconciliation`) the app compares Razorpay's payments and refunds with the ledger. Lost payment/refund webhooks and stuck `REFUND_PENDING` orders are repaired by replaying the missing provider event through the normal webhook pipeline; amount mismatches, partial refunds, unknown payments, failed refunds and dead webhooks are listed for an admin. The mock provider is checked the same way (it keeps its own payment and refund records in `mock-provider/data.json`).
- **Resolved stays resolved:** when an admin resolves an issue and reconciliation finds the same issue again, it is counted as *acknowledged* instead of being reopened (any open copy is closed with `recon:auto`).
- **Old unpaid orders:** `PENDING` orders older than `ORDER_PENDING_EXPIRY_MINUTES` (default 60, 0 = off) are marked `EXPIRED` by reconciliation. A payment that still arrives later for an `EXPIRED`, `CANCELLED` or `FAILED` order completes it normally.
- **Refused payments:** a payment that is less than the order total, in another currency, or not for an order of that user grants nothing (order `UNDERPAID` / `NO_MATCHING_ORDER`); when reconciliation replays such a payment it is escalated as `PAYMENT_REFUSED` (never counted as fixed).
- **Admin page:** `/admin/reconciliation` shows open issues, fixed issues, the webhook inbox and past runs, 20 rows at a time with **Show more**.
- **Order states from checkout:** *Cancel* on the provider's page marks the order `CANCELLED` and puts its items back in the cart; a failed payment marks it `FAILED` (it used to stay `PENDING`).
- **No double purchase:** *Add to Cart* refuses a course you already own (e.g. from an old tab), and checkout checks again: owned items are removed from the cart and nothing is charged.

Settings are in `.env.example` (all optional).

## Demo walkthrough (browser)

A step-by-step demo of everything the project does, using the mock payment provider.

**Before you start**
- In `.env`, point both servers at each other on localhost: `STREAMFLIX_URL=http://localhost:3000` and `MOCK_PROVIDER_URL=http://localhost:3001`.
- Optional, so reconciliation fixes fresh events straight away: `RECON_GRACE_SECONDS=0`.
- Start both servers (see **Running**). Keep two tabs open: the app (`http://localhost:3000`) and the mock admin page (`http://localhost:3001/admin`).
- Register two users, for example `alice@demo.local` and `bob@demo.local`. Log in as `admin@learnx.com` (or your `ADMIN_EMAIL`) in a private window for the admin steps. The admin lands on the dashboard, and the navbar shows only the admin pages (Dashboard, Users, Pricing, Reconciliation, Organizations, Guides, Assistant log). The admin account doesn't shop: the shop pages send it back to the dashboard, and purchases are refused (ADR-033); access is given with grants under **Users**.

**1. One-time purchase**
1. As Alice, open **Courses**, click **Add to Cart** on a course, go to **Cart**, and check out with the mock provider.
2. On the MockPay page click **Pay**. You come back to Courses and the course shows **Owned**.
3. Click **Access**: it says *Allowed · ACTIVE_PURCHASE*. **Activity** shows the `PURCHASE_SUCCEEDED` ledger event.

**2. Refund**
1. On the same course click **Refund**. The card shows *Refund pending* for a moment, then **Refunded**.
2. **Access** now says *Denied · PURCHASE_REFUNDED*. **Activity** shows a `REFUND` event pointing at the purchase.

**3. Subscription and expiry**
1. As Alice, buy the **All-Access pass** the same way. Every course now opens (*ACTIVE_SUBSCRIPTION_PASS*).
2. The pass card shows the end date, **Renew** (adds another period after the current one), **Cancel renewal** and **Refund Subscription**.
   - Click **Renew** and pay: Renew disappears (one renewal at a time) and the card says *Renewed*.
   - **Cancel renewal (refund it)** refunds that renewal in full; the end date goes back to the current period, the card says *Not renewing* and Renew is offered again.
   - Renew again, then **Refund Subscription (all 2 payments)**: both payments are refunded (each at its own provider), the card shows *Refund pending* until the providers confirm, then the page reloads and every course closes. An admin or scholarship month on the pass ends too.
3. Expiry: when the end date passes, every course closes again and shows **Expired**; **Access** says *Denied · SUBSCRIPTION_EXPIRED*. No ledger event is needed: access is calculated from the period's end time.
4. To see expiry live, start the app with a short demo pass: `SUB_DURATION_MINUTES=5 npm start` (or set it in `.env`). Every pass period then lasts 5 minutes instead of 30 days (the pass card says *5 min (demo)* and shows the end time). Buy the pass, wait 5 minutes, reload **Courses**: access is gone. **Renew** adds another 5 minutes.
   *Demo only:* the setting changes how long **every** period is when access is calculated, including passes bought earlier, and nothing in the ledger. Remove it and restart to go back to 30 days. `npm run verify` ignores it.

**4. Enterprise seats**
1. As Alice, open **Organization**, give the organization a name, choose a course and 2 seats, and click **Buy seats →**. Pay on MockPay: you come back to **Organization** with *Payment received* and the new seat pack (cancelling or a failed payment also returns there, with *Nothing was charged*).
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

**8. Agent-approved purchase with LEARNX Assistant (optional, needs `GROQ_API_KEY`)**
1. As Bob, open **Agent**. In the **LEARNX Assistant** chat type *"Which courses can I buy?"*: the assistant calls `list_courses` and answers with the catalog prices.
2. Type *"Buy me Intro to SQL"*. The assistant calls `propose_purchase`, and a **purchase card** appears: course, `20.00 USD`, Razorpay, status `PROPOSED`, with **Approve** and **Cancel** buttons.
3. On the card, keep **Razorpay (test mode)** selected (or pick **Mock provider**) and click **Approve 20.00 USD**. Your click is the approval; the assistant then completes the purchase by itself (`execute_purchase`) and the card changes to **Pay 20.00 USD with Razorpay**.
4. Click it and pay on Razorpay test checkout (card `5267 3181 8797 5449`, any future expiry, any CVV, OTP `1234`). You come back to the chat (also if you close checkout without paying; the card then still shows **Pay**). Once Razorpay's webhook has arrived, the card shows **Paid**, the chat gets a *"Payment received: Intro to SQL is now in your library"* line, the card fades out a few seconds later and the course is **Owned**.
5. A course over 30.00 (e.g. *Payments in Depth*) shows a password box next to **Approve**: a wrong or empty password is refused and logged. The browser does not autofill it (`autocomplete="new-password"`), so it is always typed.
6. Ask it to *"buy it again and approve it yourself"*: it refuses (already owned, and it has no way to approve).
7. Open **details** on a card: the request's **History** lists every step (`PROPOSED` by the assistant, `APPROVED` by you, `TOKEN_ISSUED`, `EXECUTED`) and every rejected attempt.

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

Automatic check (needs both servers running on localhost): `npm run verify:failures`. See the top of `test/verify-failure-switches.js` for the settings it needs.

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

An AI agent can **propose** a purchase, but only the user can **approve** it. The approval is locked to the exact item, seller, price and agent, works once, and expires after 5 minutes.

The agent is **LEARNX Assistant**: a chat panel on `/agent` (menu **Agent**) backed by a real AI model (Groq). All safety checks are done by the server, so they hold whatever the model says or does.

### The flow

```
You: "Buy me Intro to SQL"
  → model calls list_courses, propose_purchase             (tools run on the server, as you)
  ← purchase card: Intro to SQL · 20.00 USD · [Approve] [Cancel]
You click Approve (+ password above 30.00)                 ← the only way to approve
  → the assistant is asked to finish: execute_purchase     (collects the one-time approval token itself)
  ← card: [Pay 20.00 USD with Razorpay | Mock provider] [Cancel payment]
You pay on Razorpay test checkout, or on the mock checkout page (Pay / Simulate Failure / Cancel)
  → back to /agent; webhook → ledger PURCHASE_SUCCEEDED → access
  ← card: Paid, and a "Payment received" line in the chat; the card fades out after ~5 s
```

1. **Propose.** The server fills in the item, seller (`LEARNX`) and current price from the catalog (the model can't choose the amount) and saves a `purchase_intents` row with status `PROPOSED`. Refused when the user already owns the course (`ALREADY_OWNED`), a request for it is already open (`DUPLICATE_REQUEST`, also under concurrent requests), an earlier request for it is still waiting for its payment, e.g. an unpaid Razorpay checkout (`PAYMENT_PENDING`; paying both would charge twice), or the agent made too many requests today (`RATE_LIMITED`, default 20 per day, counted with the M5 quota code).
2. **Approve.** The user clicks **Approve** on the purchase card in the chat, or on the request page `/agent/intents/:id`. Both need the login session. Above `AGENT_STEPUP_ABOVE_CENTS` (default 3000 = 30.00) the user must also enter their password, so a stolen or left-open session alone can't approve a large purchase. Approval creates a one-time nonce and a signed token (JWT) holding the request, user, agent, item, seller, amount and currency, valid for 5 minutes. The token is **never shown in the browser** and never sent to the model.
3. **Execute.** The assistant's `execute_purchase` tool collects the token (once, and only for the agent that proposed the request) and executes. The server rejects an execution when:
   - the signature is wrong (`TAMPERED`) or it is too old (`EXPIRED`),
   - it belongs to another request, user or agent (`WRONG_INTENT`, `WRONG_USER`, `WRONG_AGENT`),
   - item, seller or amount differ (`MISMATCH`) or the catalog price changed since approval (`PRICE_CHANGED`),
   - the request was cancelled (`CANCELLED`) or never approved (`NOT_APPROVED`),
   - the user got the course another way since approving (`ALREADY_OWNED`; nothing is bought twice),
   - it was already used (`REPLAYED`): only one `APPROVED -> EXECUTED` update can win, even when sent several times at once.
4. **Payment** goes through the normal provider flow, so the ledger records an ordinary `PURCHASE_SUCCEEDED`. The ledger never knows an agent was involved; the only link is `purchase_intents.order_id`. The request shows the payment outcome read from that order: `PENDING`, `PAID`, `REFUNDED`, `CHARGED_BACK`, `FAILED`.
5. **Clean-up (every minute):** proposals nobody approved within 24 h and approvals not used in time become `EXPIRED`; a request whose payment was not completed within 30 min (abandoned checkout, or the server stopped before the payment started) becomes `FAILED`. The order itself is left alone: if the money arrives later, the normal webhook or reconciliation still records it and the request shows `PAID`.

**History:** every step (proposed, approved, token collected, executed, expired, failed) and every rejected attempt, with its code and IP, is stored in `intent_events` and shown on the request page (**details** on a card).

**Payment per provider**
| | Razorpay (default) | Mock provider |
|---|---|---|
| After a valid execute | A Razorpay order for the approved amount; the card shows **Pay with Razorpay** (test card `5267 3181 8797 5449`, any OTP) | A mock checkout page for the approved amount; the card shows **Pay with Mock provider** (Pay / Simulate Failure / Cancel) |
| Can the amount change? | No - fixed in the Razorpay order | No - taken from the approved request |
| Paid less, or in another currency? | Nothing is granted: the order becomes `UNDERPAID` and reconciliation escalates it | Same (e.g. an amount edited on the mock form) |
| Access | Normal webhook -> `PURCHASE_SUCCEEDED` | Normal webhook -> `PURCHASE_SUCCEEDED` |

**Choosing the provider:** if you say how to pay (*"buy it with the mock provider"*), the assistant proposes with that provider. If you don't, it leaves the choice to you: the card shows **Pay with: Razorpay (test mode) / Mock provider** next to **Approve**, preselected to `AGENT_DEFAULT_PROVIDER` (Razorpay when test keys are set). Your choice is applied when you click Approve; it can only change while the request is waiting for approval, and the change is logged (`PROVIDER_CHANGED`). The price and the approval rules don't depend on the provider. A Razorpay payment with no checkout at all (saved card / card mandate) is not offered: it was built and tried on 2026-11-19, but card mandates are not enabled on the Razorpay test account (see plan.txt), so it was removed.

### LEARNX Assistant

**Setup:** get a free key at <https://console.groq.com/keys>, put `GROQ_API_KEY=...` in `.env`, restart the app. The default model is `openai/gpt-oss-120b` (`llama-3.3-70b-versatile` has been retired on Groq); `GROQ_MODEL` changes it. Optional: `GEMINI_API_KEY` as a fallback when Groq is rate-limited or down (`GEMINI_MODEL`), `LLM_PROVIDER` to choose which to try first, or `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` for any other OpenAI-compatible API (for example Ollama on `http://localhost:11434/v1`). Without a key the panel says so and the rest of the app works as before. In `.env`, put comments on their own `#` line: `GROQ_MODEL=x   (comment)` is read as the whole line (the app ignores everything after the first space in the model and key settings, but other settings would be silently ignored).

**What you see in the chat**
- Your messages and the assistant's replies (simple tables and **bold** are rendered).
- Tool calls are not shown (they happen on the server; the request's **details** page has the full history).
- A **purchase card** for every request the assistant proposed, in its own area **below all messages** (just above the input box), so the buttons are always at the bottom: messages first, then the cards. A new card is added there, and approving or paying updates it in place. The card is drawn by the server from the request's current state in the database, never from the model's text, so the model can't fake a button or a price:

| Request state | Card shows |
|---|---|
| `PROPOSED` | Price (with ~~list price~~ and the coupon when one is applied), a **coupon field** (Apply / Remove), **Pay with: Razorpay / Mock** choice, **Approve** (with a password box above 30.00) and **Cancel** |
| `APPROVED` | **Complete purchase** (asks the assistant again, e.g. if the model was busy) and **Cancel** |
| `EXECUTED`, waiting for payment | **Cancel payment** (same as closing checkout), and **Pay with Razorpay / Mock provider** (`/assistant/pay/:id`: the checkout link stored on the request when it was executed, `purchase_intents.pay_url`; for an older request without one, the unpaid Razorpay order is found by its receipt, our order id) |
| paid | Paid, with a link to Courses |
| payment failed / cancelled at checkout / not paid in time | that message, "Nothing was charged", no buttons |
| paid less than the price (`UNDERPAID`) | "The payment did not match the price, so the course was not unlocked", no buttons |

Clicking **Approve** approves (your click) and then sends the assistant *"I approved purchase request …"* (shown as *"Approved Intro to SQL"*), so it completes the purchase without you typing anything. After Razorpay checkout you return to `/agent`. While a payment is pending its card refreshes itself every few seconds, so **Paid**, **Payment failed** (a declined payment: Razorpay's `payment.failed` webhook marks the order `FAILED`) or **Payment cancelled at checkout** appears without a reload; in those last two cases the card says nothing was charged, shows no Pay button, and you can ask the assistant again. Closing the Razorpay checkout without paying cancels that payment (order `CANCELLED`, request `FAILED`) and never puts the course in your cart; if Razorpay still takes the money later, the webhook completes the order and the card shows Paid. When a request is finished (paid, payment failed, cancelled at checkout, not paid in time, request cancelled), the app (not the model) adds one outcome line to the chat, e.g. *"Payment received: … is now in your library"* (green) or *"Payment for … was cancelled at checkout. Nothing was charged."* (red). The card shows its final state for about 5 seconds (`ASSISTANT_CARD_DONE_MS`, default 5000), then fades and collapses smoothly and is removed; after a reload finished requests have no card, only their line (their details stay under *Your purchase requests*). Replies are cleaned before they are shown: if the model degenerates into invisible characters or runs of "…", those are removed (and an unreadable reply is replaced by a plain sentence about what the tools did). The assistant is told not to use emoji or symbols. Purchases through the assistant start on `/agent` only (the course pages have just **Add to Cart**).

**Assistant log (admin only).** Every chat turn, answered or failed, is written to the append-only `assistant_log` table: the user's message, the reply (and the model's own text if the app replaced it), the tools used and their results, flags (`CLEANED`, `CORRECTED`, `LIMIT_REACHED`, `REQUEST_WITHDRAWN`, `FALLBACK groq: MODEL_BUSY`, …), the model, tokens, time taken, IP and any error (including Groq limits and the daily message limit, which are not kept in the chat itself). **Clear chat** only clears the user's chat (`assistant_messages`); the log stays. The admin (`ADMIN_EMAIL`) sees it at **Admin → Assistant Log** (`/admin/assistant`): last-24-hour totals, search by email, user id, message, reply or error code, an *Errors only* / *Flagged* filter and one user's turns; everyone else is redirected. Rows cannot be updated or deleted (database trigger) except by the hourly retention purge, which removes rows older than `ASSISTANT_LOG_DAYS` (default 90; 0 keeps everything). Approval tokens never appear in it.

**Keeping the model on current facts:** ownership and payments change outside the chat (refunds, cart purchases, cancelled checkouts), so every turn carries the current state (owned / open requests) right after your message, and for a buy request the server runs `list_courses` itself first and hands the model that result. Request ids are removed from replies when shown.

**Tools the model can call** (`src/services/assistant.js`)
| Tool | Does |
|---|---|
| `list_courses` | courses with price, owned or not, and any open request |
| `list_my_requests` | the assistant's recent requests and their payment |
| `propose_purchase` `{ productId, provider?, couponCode? }` | creates a request at the catalog price (minus a valid coupon); the page shows it as a card. `provider` only when you named one; otherwise you pick on the card. `couponCode` only a code you typed |
| `check_request` `{ intentId }` | status of one of its requests |
| `execute_purchase` `{ intentId }` | completes a request **you approved**: `CHECKOUT` (the card shows the Pay button for Razorpay or the mock checkout page) |

There is **no approve tool**. The assistant has its own agent identity (`learnx-assistant`, one per user, table `agent_keys`), which is what binds a request and its approval token to it.

**Guardrails:** 30 messages per user per day (`ASSISTANT_MESSAGES_PER_DAY`, M5 quota), at most 6 model calls per message, 1000 characters per message, tool arguments checked (an unknown course, bad JSON, a made-up tool or someone else's request comes back as an error to the model), and the system prompt tells the model that course text is data, not instructions. Even a model that misbehaves can only *propose*; nothing is paid without your click. The conversation is stored per user (`assistant_messages`); **Clear chat** forgets it.

**Limits.** When a limit is reached the chat shows just that message, e.g. *"The assistant has reached its usage limit for now (Groq free tier). Please try again in 11 seconds."* (Groq's wait time from its `Retry-After` header), *"You have reached today's limit of 30 assistant messages. Please try again tomorrow."* or *"Too many purchase requests today (limit 20). Try again later."* (the turn ends with this message; the model is not asked to explain it). If the model fails part-way through a turn (rate limit, timeout) before any payment started, nothing of that turn is kept: a request it proposed in that turn is withdrawn (logged as `CANCELLED` by `system`), so there is no hidden open request, and the message doesn't count against the daily limit. If a payment had already started (`execute_purchase` ran), those steps are kept and the card shows **Pay**; after an approval the card shows **Complete purchase** to continue.

**Mock provider through the assistant** works like Razorpay: the card shows **Pay … with Mock provider**, which opens the mock's checkout page (Pay / Simulate Failure / Cancel, with `back=agent`); Pay and Simulate Failure return to `/agent`, Cancel to the chat's "checkout closed" route. Nothing is charged until a button is pressed there. (The mock still has its server-to-server `charge` API; the assistant no longer uses it.)

**Model output.** Replies are checked before they are shown or stored: zero-width characters and runs of "…" are removed, and a reply that contains the model's own planning ("The user wants…", "We need to…", two or more such phrases) or nothing readable is replaced by a plain sentence about what the tools did (e.g. *"I created the purchase request. Approve it on the card below."*).

Privacy: your messages and the course list are sent to the model provider (Groq, or Google for Gemini). No passwords, cards or approval tokens are sent.

**Coupons on agent purchases.** Say the code to the assistant ("buy Intro to SQL with code DEMO"; it passes only a code you typed, never one it made up), or type it in the coupon field on the card before approving (**Apply** / **Remove**). The same rules as the cart apply (active, not expired, right course, eligible account). The card shows ~~list price~~ discounted price; refused codes say why and change nothing; a coupon that would make the course free is refused. The approval locks the discounted amount, list price and coupon; at payment the coupon is checked again, and if it was disabled or changed meanwhile the purchase stops with *Coupon … is no longer valid*, nothing charged. **Approve** also carries the price the card showed: if a coupon was applied or removed in another tab, approving is refused with *The price changed*. The order stores subtotal, discount and the coupon rule, so the ledger records what was really paid. Checks: `npm run verify:coupons`.

**Settings (optional):** `AGENT_APPROVAL_TTL_SECONDS` (300), `AGENT_STEPUP_ABOVE_CENTS` (3000), `AGENT_PROPOSALS_PER_DAY` (20), `AGENT_PROPOSAL_TTL_HOURS` (24), `AGENT_UNPAID_MINUTES` (30), `AGENT_SWEEP_INTERVAL_MS` (60000, 0 = off), `AGENT_APPROVAL_SECRET` (derived from `JWT_SECRET`), `MERCHANT_ID` (`LEARNX`), `AGENT_DEFAULT_PROVIDER` (`razorpay` with test keys, else `mock`), `ASSISTANT_MESSAGES_PER_DAY` (30), `ASSISTANT_CARD_DONE_MS` (5000), `ASSISTANT_LOG_DAYS` (90), `GROQ_API_KEY`, `GROQ_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `LLM_PROVIDER`, `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`.

**Removed (2026-11-19):** the *Simulated agent* panel (buttons that proposed without AI, and the page that showed the approval token for tampering demos), *Agent keys* for outside agents, the `/agent/api/*` JSON API and `scripts/agent-client.js`. Tampering, replay, expiry and wrong-agent cases are still checked by `npm run verify:m7` against the purchase service.

**Code:** tables `purchase_intents`, `agent_keys`, `intent_events`, `assistant_messages`, `assistant_log` (admin log); `src/services/assistant.js` (model, tools, chat), `src/services/agentPurchase.js` (propose / approve / execute rules), `src/services/agentKeys.js` (agent identity), `src/routes/agent.js` (chat, cards, request page); checks in `npm run verify:m7` and `npm run verify:assistant` (with a fake model, no key needed). The ledger and access decisions were not changed.

## Recent changes (2026-11-20)

- **LEARNX Assistant chat:** purchase cards leave the chat a few seconds after the payment finishes; each payment keeps a one-line result. Mock purchases go through the mock checkout page like Razorpay. Limits (Groq, daily messages, purchase requests) show just their message. Broken or leaked model text is replaced by a plain sentence.
- **Admin Assistant Log** at `/admin/assistant` (admin only): every chat turn with message, reply, tools, model, tokens, time and errors; search, *Errors only* / *Flagged* filters, per-user view. Append-only; kept `ASSISTANT_LOG_DAYS`.
- **Pass:** one renewal at a time; Cancel renewal refunds a paid renewal in full; Refund refunds every payment of the current pass and then ends its free (admin / scholarship) time.
- **Seats:** after the seat checkout you return to `/org` with the result.
- **Coupons on agent purchases** (tell the assistant the code or enter it on the card), **payment checks** (paying less than the order, or a payment message without a matching order of that user, grants nothing), **login / sign-up / approval-password limits**, generic error messages, new secrets required.
- **One order / one grant per click:** cart and seat checkouts and admin grants are idempotent (`npm run verify:idempotency`).
- **Course guides:** one guide per course (`content/`), published from **Admin → Course content**, opened only with access; refund or pass expiry closes it, even while it is open.
- **Organization page:** failed or cancelled seat checkouts are short notices that fade out instead of piling up.
- **Code clean-up:** one place creates orders (`src/services/orders.js`) and one requests refunds (`src/services/refunds.js`); shared display helpers; tests moved to `test/`; dead code removed; request logging only with `LOG_REQUESTS=1`. Behaviour unchanged.
- After updating: `npm run db:init`, restart the app and the mock provider.

## Project overview and decisions

`docs/LEARNX-COMPLETE-DOCUMENTATION.md`: everything in one place (plan, architecture, products, all decisions ADR-000 to ADR-030, security, test evidence, defects, operations).

`docs/PROJECT-OVERVIEW.md`: the whole project end to end (milestones, architecture diagrams, every component and table, key flows, security model, tests, configuration) and the decision log from ADR-015 on; ADR-000 to ADR-014 are in `docs/Architecture_Decision_Records.md`.

## End-to-end test report

`docs/E2E-TESTS.md`: the manual end-to-end runs (assistant chat, cart, refunds, webhook failure switches, reconciliation, admin assistant log, pass renew / refund rules, seat checkout return, course guides, security attacks, agent coupons, review fixes) with the mock provider and Razorpay test mode, results and the defects found.

## Project structure

```
db/schema.sql          Database schema (safe to re-run: npm run db:init)
content/               Course guides (one Markdown file per course, published from Admin -> Course content)
docs/                  End-to-end test report, architecture decision records
mock-provider/         Standalone fake payment provider that sends webhooks
src/server.js          App entry point (middleware, routes, background jobs)
src/errorHandler.js    Last middleware: generic error + reference, details only in the log
src/routes/            HTTP routes: parse the request, call a service, render (auth, courses, cart,
                       checkout, org, subscription, agent, content, admin, webhooks)
src/domain/            Ledger, entitlement projection, access decisions, catalog (no provider / agent code)
src/payment/           Provider adapters (mock, Razorpay), webhook processor, reconciliation, retries
src/services/          Use cases shared by routes:
                         orders.js         the only place orders + line items are created
                         refunds.js        the only place a provider refund is requested
                         checkoutOnce.js   one order per checkout click
                         subscriptions.js  pass lifecycle (renew, cancel, full refund)
                         seats.js, quotas.js, pricingEngine.js, agentPurchase.js, assistant.js,
                         courseDocs.js, markdown.js, rateLimit.js, ...
src/views.js           HTML templates
test/                  npm run verify suites (verify-*.js) and test fixtures; they run against
                       DATABASE_URL and remove their own rows (ledger rows stay: append-only)
```

## Verification

```bash
npm run verify       # ledger, webhook retry / reconciliation, M4 (seats, subscriptions), M5 (quotas), M7 (agent purchases), assistant (fake model), idempotency (one order / grant per click), course guide (access-checked content), agent coupon and security (limits, forged sessions, dev route, error text) checks against Postgres
npm run verify:failures   # live: mock failure switches end to end (both servers running, settings at the top of the script)
npm run evaluate          # two baselines vs LEARNX on 8 workloads -> evaluation/results/ (see evaluation/README.md)
```

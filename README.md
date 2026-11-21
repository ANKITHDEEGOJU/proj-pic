# Learnx

**CS5903 project 7, group 46** · Provider-neutral payments, subscriptions, entitlements and agent-mediated commerce ·
Report: [`docs/Project_Report.pdf`](docs/Project_Report.pdf) · Decisions: [`docs/Architecture_Decision_Records.md`](docs/Architecture_Decision_Records.md) ·
Evaluation: [`evaluation/`](evaluation/) · Tests: [`test/`](test/) · E2E evidence: [`docs/E2E-TESTS.md`](docs/E2E-TESTS.md) · Demo video: [https://youtu.be/8UcpYaqJXaA](https://youtu.be/8UcpYaqJXaA)

A course storefront built with Node.js, Express and PostgreSQL. Users can browse courses, add them to a cart, apply coupons, and pay through Razorpay (test mode) or a bundled mock payment provider. Course access is tracked in an append-only commerce ledger driven by payment webhooks.

## Features

- Email/password auth (JWT in a cookie)
- Course catalog, cart with multi-course checkout, and global subscriptions
- Coupons and pricing rules
- Payments via Razorpay test mode or a local mock provider
- Webhook handling with an inbox table for tracking deliveries, plus purchase and refund events
- Admin panel: manage pricing rules and grant or revoke course access for users
- Organizations requested by a learner and approved by the admin, run by their manager (seat packs assigned to members), and subscription renew / cancel (one renewal at a time; Refund refunds the whole pass)
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
| M4 Commercial rules (coupons, seats, pass) | Completed, one known defect: 10 or more simultaneous seat assignments to one pack can freeze the app (ADR-020) | `test/verify-m4.js`, `test/verify-idempotency.js`, evaluation S6 |
| M5 Usage quotas | Completed | `test/verify-m5.js`, evaluation S5 |
| M6 Refund + reconciliation | Completed | `test/verify-m2-m6.js`, evaluation S3–S4 |
| M7 Agent-mediated purchase (AP2-inspired) | Completed (full AP2 not adopted, see ADR-011) | `test/verify-m7.js`, `test/verify-assistant.js`, `test/verify-agent-coupons.js`, evaluation S7 |
| M8 Audit + failure validation | Completed | `test/verify-failure-switches.js`, `docs/E2E-TESTS.md` |
| Automatic pass renewal (recurring payments) | Not implemented (Razorpay test account has no card mandates, ADR-013) | — |
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

After every update, run `npm run db:init` again.

Main variables in `.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret for signing auth tokens (required) |
| `ADMIN_EMAIL` | Email that gets admin access (default `admin@learnx.com`) |
| `MOCK_WEBHOOK_SECRET`, `MOCK_PROVIDER_URL`, `MOCK_PROVIDER_PORT` | Mock payment provider |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay test credentials |
| `GROQ_API_KEY` | LEARNX Assistant model (see *LEARNX Assistant*) |
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

**Security limits:** login, sign-up and approval-password attempts are limited, and error pages show only a reference (`Server error (ref …)`); the details are in the server log. Checks: `npm run verify:security`.

**One instance:** run one app at a time. If port 3000 (or 3001 for the mock) is busy, stop the old process (`ss -ltnp | grep :3000`, then `kill <pid>`).

### Razorpay test mode (optional)

Razorpay sends its webhooks to a public address, so the app must be reachable through ngrok and the webhook must be registered in Razorpay:

1. Put your test keys in `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) and choose a webhook secret (`RAZORPAY_WEBHOOK_SECRET`).
2. Start the app, then in another terminal: `ngrok http 3000`.
3. In the Razorpay Dashboard (**Test Mode**) → **Settings → Webhooks → Add New Webhook**: URL `https://<your-ngrok-address>/webhooks/razorpay`, the same secret as `RAZORPAY_WEBHOOK_SECRET`, and the events `payment.captured`, `payment.failed`, `refund.created`, `refund.processed`, `refund.failed` and `payment.dispute.lost`.
4. The free ngrok address changes every time ngrok restarts: update the webhook URL in Razorpay each time.

Test card: `5267 3181 8797 5449`, any future expiry, any CVV, OTP `1234`.

## Example: input and expected output

| Do this | Expected |
|---|---|
| `npm run verify` | 11 lines ending in `… CHECKS PASSED`, exit code 0 |
| `node evaluation/run-evaluation.js` | Prints one line per workload, e.g. `S2 … errors/run naive 10, careful 10, LEARNX 0`, and writes `evaluation/results/RESULTS.md` |
| Register, add **Intro to SQL** to the cart, checkout with **Mock**, press **Pay** | Back on Courses; the card says **Owned**; **Access** shows `Allowed · ACTIVE_PURCHASE`; **Open guide** appears once the admin has published the guides |
| Click **Refund** on that course | "Refund pending" briefly, then **Refunded**; **Access** shows `Denied · PURCHASE_REFUNDED`; the guide answers "…refunded, so its guide is closed." |
| On `/agent` type "Buy Intro to SQL with coupon code DEMO" (needs `GROQ_API_KEY`) | A purchase card at 19.00 USD; approve and pay, and the course is **Owned** |

## Operations

- **Start:** `npm start` (app, port 3000) and `cd mock-provider && node server.js` (mock, port 3001). For Razorpay, see *Razorpay test mode* above (ngrok and the webhook URL).
- **Stop:** Ctrl+C in each terminal. If port 3000 is busy: `ss -ltnp | grep :3000`, then `kill <pid>`.
- **Reset / update the database:** `npm run db:init` (safe to re-run). Test users (`*@test.local`) stay in the ledger by design.
- **Logs:** both servers log to their terminal. An error page shows `Server error (ref abc12345)`; search the app log for that reference. Set `LOG_REQUESTS=1` to log every POST (passwords redacted).
- **Common problems:** mock payments stay pending → the mock still has an old `MOCK_WEBHOOK_SECRET`: restart it after any `.env` change. Mock checkout page doesn't open → `MOCK_PROVIDER_URL` points at an offline tunnel: start the app with `MOCK_PROVIDER_URL=http://localhost:3001`. The assistant says it reached its limit → Groq free-tier rate limit: wait a minute and try again.
- **External services and costs:** Razorpay test mode (free, test cards only, no real money), Groq (free tier, rate-limited), ngrok (free tier). None are needed for the tests or the evaluation.

## Commercial rules

**Cart and coupons**
- A cart holds either individual courses or one All-Access pass, never both: adding a pass empties the cart, and adding a course removes a pass.
- One coupon per order. The discount is split across the order's lines, so per-item ledger amounts add up to what was charged. An applied coupon is remembered across page loads and re-checked at checkout.
- **One order per click:** sending a checkout or admin grant form twice (double click, back button) still creates only one order or grant.
- Coupons don't apply to seat packs.

**Courses vs the All-Access pass**
- A course can be held several ways at once (bought, admin grant, org seat, pass). Losing one of them (refund, revoke, seat unassigned, pass expired) keeps any other.
- A pass gives every course while it is active. Courses bought separately stay after the pass ends.

**Subscriptions (manual renewal)**
- *Renew* pays for another 30 days through the normal checkout. Bought while a pass is active, it is recorded as `SUBSCRIPTION_RENEWED` and starts when the current period ends.
- **One renewal at a time:** while a renewal is paid or being paid, the card offers only **Cancel renewal** and **Refund**.
- **Cancel renewal** stops renewing and refunds a renewal that was already paid, in full.
- **Refund** refunds every paid period of the pass; access ends when the provider confirms, and any admin or scholarship time on the pass ends too.

**Enterprise seats**
- **A learner requests an organization; the admin approves it** (ADR-023). On **Organization** (`/org`) a learner sends *Request an organization* with a name (one open request at a time, names must be free) and sees *Waiting for approval*. The admin sees waiting requests on **Organizations** (`/admin/orgs`, also counted on the dashboard) and clicks **Approve** (the organization is created with the requester as its **manager**) or **Reject** (optional reason, shown to the learner, who can ask again). That is the admin's whole part: afterwards the admin can only look at the organization (read-only).
- **Managers** run their organization at `/org`: they buy seat packs and assign, unassign, reassign and refund. The admin never buys and can't be a manager.
- **Seat holders** see *Your organization seats* at `/org` (organization, course, since), read from the ledger, and nothing to manage; otherwise they are normal learners.
- A seat pack is N seats of one course, priced N × course price. Buying it gives the manager no access by itself.
- Seats are assigned by the member's email (they need a LearnX account). One seat per member per pack, never more than N in use. Usage is counted from the ledger.
- Unassign takes the seat back; reassign moves it to another member in one step.
- Refunding or charging back a pack unassigns every seat. Refunds wait for the provider's webhook, like course refunds.
- After paying for seats you return to **Organization** with the result (*Payment received*, or *Nothing was charged*).

## Course guides (paid content)

Each course has one guide, shipped as a file in `content/<course id>.md` (`intro-to-sql.md`, `event-sourcing-101.md`, `payments-in-depth.md`).

- **The admin can preview** any published guide (*admin preview*) without owning the course.
- **The admin publishes it.** **Admin → Course content** (`/admin/content`) lists every course with its file: **Add to course**, **Update from file** (after editing the file), **Remove**, **View**. Adding twice changes nothing. Every add / update / remove is kept in an append-only history with the admin's email. Until a guide is added, learners see nothing.
- **Access is checked on every request.** `/courses/<course>/doc` asks the same access decision as everything else, each time it is opened: purchase, All-Access Pass, organization seat or admin / scholarship grant all open it. Nothing like "has access to the guide" is stored, so:
  - a purchase opens it as soon as the payment webhook arrives (the course card shows **Open guide**);
  - a confirmed refund, chargeback, revoke or unassigned seat closes it;
  - an All-Access Pass closes it the moment the pass ends (no event needed).
- **An open guide closes itself.** The page re-checks every 5 seconds and whenever its tab is shown again; when access has ended it reloads and shows why (*Your purchase of this course was refunded…*, *Your All-Access Pass has ended…*).
- **An open Courses page updates itself too.** It sends a short fingerprint of what the user can open every 5 seconds (and when the tab is shown again); when an admin revokes or grants access, a refund or payment arrives or a pass ends, the page reloads, so a revoked course no longer shows *Owned* / *Open guide*.
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
- Register two users, for example `alice@demo.local` and `bob@demo.local`. Log in as `admin@learnx.com` (or your `ADMIN_EMAIL`) in a private window for the admin steps. The admin lands on the dashboard, and the navbar shows only the admin pages (Dashboard, Users, Pricing, Reconciliation, Organizations, Guides, Assistant log). The admin account doesn't shop: the shop pages send it back to the dashboard, and purchases are refused (ADR-022); access is given with grants under **Users**. **Users** counts and lists real accounts; the `@test.local` accounts made by `npm run verify` and the evaluation stay in the database (their ledger rows are append-only) but are hidden from the list (*Show them*, or search for one).

**1. One-time purchase**
1. As Alice, open **Courses**, click **Add to Cart** on a course, go to **Cart**, and check out with the mock provider.
2. On the MockPay page click **Pay**. You come back to Courses and the course shows **Owned**.
3. Click **Access**: it says *Allowed · ACTIVE_PURCHASE*. **Activity** shows the `PURCHASE_SUCCEEDED` ledger event.

**2. Refund**
1. On the same course click **Refund**. The card shows *Refund pending* for a moment, then **Refunded**. (Refunds end access when the provider confirms. If its refund webhook is late, as Razorpay test mode sometimes is, the app asks the provider directly after 90 s, so *Refund pending* lasts about 2 minutes at most instead of waiting for the 15-minute reconciliation; `REFUND_CHECK_AFTER_SECONDS`, `REFUND_CHECK_INTERVAL_MS`.)
2. **Access** now says *Denied · PURCHASE_REFUNDED*. **Activity** shows a `REFUND` event pointing at the purchase.

**3. Subscription and expiry**
1. As Alice, buy the **All-Access pass** the same way. Every course now opens (*ACTIVE_SUBSCRIPTION_PASS*).
2. The pass card shows the end date, **Renew** (adds another period after the current one), **Cancel renewal** and **Refund Subscription**.
   - Click **Renew** and pay: Renew disappears (one renewal at a time) and the card says *Renewed*.
   - **Cancel renewal (refund it)** refunds that renewal in full; the end date goes back to the current period, the card says *Not renewing* and Renew is offered again.
   - Renew again, then **Refund Subscription (all 2 payments)**: both payments are refunded (each at its own provider), the card shows *Refund pending* until the providers confirm, then the page reloads and every course closes. An admin or scholarship month on the pass ends too.
3. Expiry: when the end date passes, every course closes again and shows **Expired**; **Access** says *Denied · SUBSCRIPTION_EXPIRED*. No ledger event is needed: access is calculated from the period's end time.
4. To see expiry live, start the app with `SUB_DURATION_MINUTES=5 npm start`: every pass period then lasts 5 minutes instead of 30 days (demo only; remove it to go back).

**4. Enterprise seats**
1. As Alice, open **Organization**, enter a name (for example *Acme Data Team*) under *Request an organization* and click **Send request**: it shows *Waiting for approval*. As the admin, open **Organizations** and click **Approve**. As Alice, reload **Organization**: Alice is now its manager. Choose a course and 2 seats and click **Buy seats →**. Pay on MockPay: you come back to **Organization** with *Payment received* and the new seat pack (cancelling or a failed payment also returns there, with *Nothing was charged*).
2. Alice gets no access from buying seats. Assign a seat to `bob@demo.local`.
3. As Bob, the course shows *Seat from your organization*, and **Organization** shows *Your organization seats* (Acme Data Team, the course) with nothing to manage. As Alice, **Unassign** the seat: Bob loses access. **Reassign** moves a seat to another member in one step.

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
4. Click it and pay with the Razorpay test card (`5267 3181 8797 5449`, OTP `1234`). Back in the chat the card shows **Paid** and the course is **Owned**.
5. Above 30.00 (e.g. *Payments in Depth*) you must also type your password to approve.
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

An AI agent can **propose** a purchase, but only the user can **approve** it. The agent is **LEARNX Assistant**, a chat on `/agent` backed by Groq; every safety check runs on the server.
1. **Propose:** the server sets the item and the price from the catalog; the model can't choose the amount.
2. **Approve:** only your click (plus your password above 30.00) approves. It creates a signed, one-time token valid for 5 minutes, never shown to the browser or the model.
3. **Execute and pay:** a tampered, expired, replayed or changed request is refused; payment then goes through the normal checkout and webhook, so the ledger records an ordinary purchase. Every step is kept in the request's history.

**Payment per provider**
| | Razorpay (default) | Mock provider |
|---|---|---|
| After a valid execute | A Razorpay order for the approved amount; the card shows **Pay with Razorpay** (test card `5267 3181 8797 5449`, any OTP) | A mock checkout page for the approved amount; the card shows **Pay with Mock provider** (Pay / Simulate Failure / Cancel) |
| Can the amount change? | No - fixed in the Razorpay order | No - taken from the approved request |
| Paid less, or in another currency? | Nothing is granted: the order becomes `UNDERPAID` and reconciliation escalates it | Same (e.g. an amount edited on the mock form) |
| Access | Normal webhook -> `PURCHASE_SUCCEEDED` | Normal webhook -> `PURCHASE_SUCCEEDED` |

**Choosing the provider:** say it in your message (*"buy it with the mock provider"*) or pick **Razorpay** or **Mock** on the card before approving.
Saved-card payments aren't offered: the Razorpay test account has no card mandates (ADR-013).

### LEARNX Assistant

**Setup:** get a free key at <https://console.groq.com/keys>, put `GROQ_API_KEY=...` in `.env` and restart the app (model `openai/gpt-oss-120b`; change it with `GROQ_MODEL`). Without a key the chat says so and the rest of the app works.

**In the chat**
- Your messages and the assistant's replies.
- A **purchase card** for each request, drawn by the server (never by the model): price, optional coupon, **Approve** / **Cancel**, then **Pay**.
- While a payment is pending the card updates by itself; when it finishes, a short result line is added (*Payment received …* or *Nothing was charged*).
- Closing the checkout without paying cancels the payment; nothing is charged.

**Assistant log (admin only):** every chat turn is kept in an append-only log at **Admin → Assistant Log** (`/admin/assistant`), even after *Clear chat*, for 90 days (`ASSISTANT_LOG_DAYS`).

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

- **Limits:** 30 messages and 20 purchase requests per user per day; when a limit (or Groq's free-tier limit) is reached, the chat says so and nothing is left half-done.
- **Coupons:** say the code (*"with code DEMO"*) or type it on the card; the approval fixes the discounted price (`npm run verify:coupons`).
- **Privacy:** your messages and the course list are sent to Groq; never passwords, cards or approval tokens.
- **Code:** `src/services/assistant.js`, `src/services/agentPurchase.js`, `src/routes/agent.js`; checks: `npm run verify:m7`, `npm run verify:assistant` (fake model, no key needed).

## Documentation

- `docs/Project_Report.pdf`: the final report.
- `docs/Architecture_Decision_Records.md`: the design decisions (ADR-000 to ADR-024).
- `docs/E2E-TESTS.md`: the end-to-end test runs and the defects found.
- `docs/LEARNX-COMPLETE-DOCUMENTATION.md` and `docs/PROJECT-OVERVIEW.md`: the whole project in detail.

## Project structure

```
db/schema.sql     database schema (npm run db:init)
content/          course guides (Markdown, published from the admin pages)
docs/             report, decision records, test report
evaluation/       the two baselines, workloads and results
mock-provider/    fake payment provider with failure switches
src/domain/       ledger, projection, access decisions
src/payment/      provider adapters, webhooks, retries, reconciliation
src/services/     business rules (orders, refunds, pass, seats, quotas, agent purchases, assistant)
src/routes/       pages and HTTP endpoints
test/             the npm run verify suites
```

## Verification

```bash
npm run verify       # ledger, webhook retry / reconciliation, M4 (seats, subscriptions), M5 (quotas), M7 (agent purchases), assistant (fake model), idempotency (one order / grant per click), course guide (access-checked content), agent coupon and security (limits, forged sessions, dev route, error text) checks against Postgres
npm run verify:failures   # live: mock failure switches end to end (both servers running, settings at the top of the script)
npm run evaluate          # two baselines vs LEARNX on 8 workloads -> evaluation/results/ (see evaluation/README.md)
```

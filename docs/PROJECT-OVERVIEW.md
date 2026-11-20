# LEARNX (streamflix): end-to-end project overview and decision log

*Written 2026-11-20. Covers the whole project from Phase 0 (1 October 2026) to the latest uncommitted
changes, with the work of the most recent sessions described in detail. Decisions ADR-000 to ADR-014 are
in [Architecture_Decision_Records.md](Architecture_Decision_Records.md); this document summarises them and
continues the log with ADR-015 to ADR-030. Test evidence is in [E2E-TESTS.md](E2E-TESTS.md).*

## Contents

1. [What the project is](#1-what-the-project-is)
2. [Milestones and where each is met](#2-milestones-and-where-each-is-met)
3. [Timeline: earlier sessions compared with this one](#3-timeline-earlier-sessions-compared-with-this-one)
4. [Architecture](#4-architecture)
5. [Components in detail](#5-components-in-detail)
6. [Data model](#6-data-model)
7. [Key flows](#7-key-flows)
8. [Decision log (ADR-015 onwards)](#8-decision-log-adr-015-onwards)
9. [Security model](#9-security-model)
10. [Testing and evidence](#10-testing-and-evidence)
11. [Configuration](#11-configuration)
12. [Known limits and what was deliberately not done](#12-known-limits-and-what-was-deliberately-not-done)

---

## 1. What the project is

LEARNX is a course storefront built to answer one brief: *a provider-neutral payments, subscriptions,
entitlements and agent-mediated commerce platform*. It sells single courses, an All-Access pass, enterprise
seat packs and free (admin or scholarship) access. Payments come from Razorpay in test mode or from a local
mock provider. The central idea is that **access is never stored as a flag**: every purchase, refund,
chargeback, grant, seat and subscription period is an event in an append-only ledger, and "can this user open
this course right now?" is computed from that history at the moment it is asked.

Around that core sit the parts the brief asks for. Payment adapters hide provider differences. A webhook inbox
makes unreliable provider messages safe to process. Reconciliation compares provider records with the ledger
and repairs or escalates gaps. Commercial rules cover coupons, seats and the pass lifecycle; usage quotas
protect an expensive feature. Finally, an AI purchase assistant can buy on the user's behalf only after an
explicit, signed, one-time approval.

The stack is deliberately plain: Node.js and Express, PostgreSQL, server-rendered HTML with htmx, no front-end
build step. Everything runs locally; ngrok is used only to receive Razorpay webhooks.

## 2. Milestones and where each is met

| Milestone | Requirement (short) | How it is met | Main code | Proven by |
|---|---|---|---|---|
| **M1** Transaction model | Purchase, subscription, seat, grant, refund, chargeback, expiry independent of provider payloads | 12 ledger event types with source, actor, reason; reversals must reference the event they undo; expiry computed from period end | `src/domain/*` | `verify-domain-memory`, `verify-domain-pg` |
| **M2** Adapter + idempotency | Sandbox provider drives the flow; duplicate, late, reordered webhooks change nothing twice | Adapter contract; inbox keyed by provider event id; unique ledger event ids; retries with backoff; refund-before-purchase answered 503 and retried | `src/payment/*`, `routes/webhooks.js` | `verify-m2-m6`, `verify-failure-switches` |
| **M3** Entitlement ledger | Access from auditable history, not flags | Projection rebuilt from the ledger at startup; database triggers block UPDATE/DELETE/TRUNCATE | `domain/projection.js`, `decision.js` | `verify-domain-pg` |
| **M4** Commercial rules | Coupons, seats, subscription lifecycle with clear conflict and expiry rules | One coupon per order, discount split across lines; seat packs counted from the ledger; stacked pass periods, one renewal at a time, full-pass refund | `services/pricingEngine.js`, `seats.js`, `subscriptions.js` | `verify-m4`, `verify-idempotency` |
| **M5** Usage quotas | Per-user or pooled limits, safe under concurrency | One atomic upsert per request; request keys make retries free; credits returned on failure | `services/quotas.js` | `verify-m5` |
| **M6** Refund + reconciliation | Detect provider/ledger disagreement, repair or escalate | Webhook-driven refunds; scheduled reconciliation replays missing events through the normal pipeline; refused or suspicious cases escalated | `payment/reconcile.js` | `verify-m2-m6` |
| **M7** Agent purchase | Propose, explicit authorisation, preserve item/merchant/amount, reject tampered/replayed/expired/cancelled | Purchase requests with signed one-time approval (JWT + nonce); LEARNX Assistant (Groq) with no approve tool; coupons pinned in the approval | `services/agentPurchase.js`, `assistant.js`, `routes/agent.js` | `verify-m7`, `verify-assistant`, `verify-agent-coupons` |
| **M8** Audit + failure validation | Full history inspectable; injected failures converge | Activity page, request history, reconciliation page, assistant log; mock failure switches (duplicate, delay, reorder, drop, refund 500) | `mock-provider/`, admin pages | `verify-failure-switches` (6/6), E2E sections 4, 11 |

The brief's "done when" is covered end to end in the browser runs recorded in `E2E-TESTS.md`:
- one-time, subscription and seat flows;
- access removed on refund and on expiry (watched live with 2-minute demo passes);
- lost and duplicate events reconciled;
- an agent-authorised purchase that never touches the ledger directly.

## 3. Timeline: earlier sessions compared with this one

| Period | Commits | What was built | State at the end |
|---|---|---|---|
| 1–3 Oct (Phase 0–1) | `2a1f4c3` → `7e58a48` | Ledger → projection → decision engine; ledger moved to PostgreSQL; mock checkout and webhook inbox | Core event-sourced access working |
| 27 Oct – 11 Nov | `a3504b5` → `4175692` | Razorpay test mode, cart, admin panel, coupons, global subscription, multi-item orders, admin grants | A usable store |
| 12–14 Nov (earlier chats) | `b020c80` → `7d1b6d3` | M1 refinement, webhook-driven refunds, retries (M2), reconciliation (M6), seats + renew/cancel (M4), quotas (M5), failure switches (M8) | All non-agent milestones done |
| 15–19 Nov (earlier chats) | `7dd197d` | M7 v1: a *simulated* agent, review page, signed approval, agent keys, JSON API, step-up password; saved-card mandates tried and removed | Agent flow driven by buttons, not AI |
| 19–20 Nov (this session) | `4cc86c0` (assistant, assistant log, pass rules, seat return, idempotency), `1c53ec8` (guides, payment matching, security, rate limits, agent coupons), + uncommitted (clean-up, org notices, docs) | Everything in the next table | Real AI agent, hardened payments, paid content, cleaner code |

**What changed in this session, compared with where the earlier chats left off:**

| Area | Before (end of earlier chats) | Now |
|---|---|---|
| Agent | Simulated agent with buttons; agent keys and `/agent/api/*` | LEARNX Assistant on Groq (Gemini fallback); purchase cards in the chat with Approve / Pay / Cancel; simulated agent and API removed |
| Chat UX | n/a | Finished cards fade out after 5 s; each payment keeps a one-line result; no tool chatter; model text cleaned (zero-width characters, leaked planning) |
| Mock via agent | Server-side instant charge | Real mock checkout page, back to `/agent` |
| Monitoring | Assistant chat only | Append-only **assistant log** with admin page (tokens, errors, flags) |
| Pass rules | Renew any time; refund only the latest period | One renewal at a time; Cancel renewal refunds a paid renewal; Refund refunds every payment of the pass and ends free periods |
| Seat checkout | Returned to `/courses` | Returns to `/org` with a result note; failed attempts fade and stop stacking |
| Paid content | None (Access only showed a status) | One **course guide** per course, published by the admin, opened only with access, closed live on refund or pass end |
| Idempotency | Webhooks and ledger only | Also one order per checkout click and one grant per admin form |
| Payment safety | Provider amount trusted | Paid amount **and currency** must match the order; purchase must name an order of that user |
| Secrets & auth | Example secrets in `.env`; no limits | Secrets rotated; login, sign-up and approval-password limits; HS256 pinned; generic errors |
| Coupons | Cart only | Also on agent purchases, pinned in the signed approval |
| Code | Duplicated helpers, tests inside `src/` | Shared `orders.js`, `refunds.js`, display helpers; tests in `test/`; dead files removed |
| Test suites | 7 | 11 in `npm run verify` (+ live failure-switch run) |

## 4. Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Pages + htmx<br/>courses, cart, org, agent, admin]
  end
  subgraph App["Node / Express app (single instance)"]
    R[routes/*<br/>parse, call service, render]
    S[services/*<br/>orders, refunds, subscriptions,<br/>seats, quotas, agentPurchase,<br/>assistant, courseDocs, rateLimit]
    D[domain/*<br/>ledger, projection,<br/>decision, catalog]
    P[payment/*<br/>adapters, webhook processor,<br/>reconciliation, retries]
    J[(background jobs<br/>retry 30s, recon 15m,<br/>agent sweep 1m, log purge 1h)]
  end
  DB[(PostgreSQL<br/>21 tables)]
  RZ[Razorpay test mode]
  MK[Mock provider :3001]
  LLM[Groq / Gemini]
  UI --> R --> S --> D
  S --> P
  D --> DB
  S --> DB
  P --> DB
  P <-->|create payment, refund,<br/>list for reconciliation| RZ
  P <--> MK
  RZ -->|webhooks via ngrok| R
  MK -->|webhooks| R
  S -->|chat completions| LLM
  J --> P
```

**Layers and rules.**
- **`domain`** knows nothing about providers, agents or HTTP. It turns events into access decisions.
- **`payment`** turns provider messages into domain events and is the only code that talks to providers.
- **`services`** hold the use cases shared by several routes.
- **`routes`** read the request, call a service and render HTML.

A check during the clean-up confirmed there are no import cycles between these modules.

**Single instance.** The projection, the course-guide list and the rate-limit counters live in memory, and the
background jobs run inside the web process so their ledger writes reach that projection. The README states that
only one app instance should run.

## 5. Components in detail

### 5.1 Domain (`src/domain`)

| File | Role |
|---|---|
| `ledger.js` | Validates and appends events (unique id, valid type, required references, catalog product); returns `DUPLICATE_EVENT` / `EVENT_ID_CONFLICT` instead of failing on repeats |
| `stores/pgLedgerStore.js`, `memoryLedgerStore.js` | Same interface, PostgreSQL for the app, memory for a fast test |
| `projection.js` | Keeps current entitlements per user: course grants, and pass periods laid end to end |
| `decision.js` | `evaluateAccess(user, product)`: allowed or a reason (`PURCHASE_REFUNDED`, `SUBSCRIPTION_EXPIRED`, `SEAT_UNASSIGNED`, …) computed at request time |
| `catalog.js`, `catalogLoader.js` | Products from the `courses` table; `get()` finds by id or slug |

### 5.2 Payments (`src/payment`)

| File | Role |
|---|---|
| `adapter.js`, `registry.js` | The provider contract and the list of providers |
| `adapters/razorpay.js` | Orders, HMAC-verified webhooks, refunds, reconciliation reads |
| `adapters/mock.js` | Same contract for the mock; shared secret compared in constant time; no built-in default |
| `service.js` | `initiatePayment`, `initiateRefund` for any provider |
| `webhookProcessor.js` | Inbox row → normalised event → per-line ledger events; refuses purchases that are underpaid, in the wrong currency, or not for an order of that user |
| `retryWorker.js` | Exponential backoff, DEAD after 8 attempts |
| `reconcile.js` | Provider ↔ ledger comparison; replays lost events; escalates mismatches, refused payments, DEAD rows |

### 5.3 Services (`src/services`)

| Service | Responsibility |
|---|---|
| `orders.js` | The only place an order and its lines are written; checks line amounts add up |
| `refunds.js` | The only place a provider refund is requested (claim → ask → reopen if refused) |
| `checkoutOnce.js` | One order per checkout click (form key, advisory lock, stored checkout link) |
| `subscriptions.js` | Pass state, one renewal at a time, Cancel renewal, full-pass refund, ending free periods |
| `seats.js` | Organizations, seat packs, assign/unassign/reassign under an advisory lock |
| `pricingEngine.js` | Coupons and identity pricing; discount allocation across lines |
| `quotas.js`, `aiSummary.js` | Daily credits (user or organization pool) for the demo AI summary |
| `agentPurchase.js` | Purchase requests: propose, coupon quote, approve (signed token), execute, sweep, history |
| `assistant.js` | Groq/Gemini chat loop, tools, reply cleaning, outcome lines, assistant log |
| `courseDocs.js`, `markdown.js` | Course guides (publish/remove with history) and a safe Markdown renderer |
| `rateLimit.js` | Login, sign-up and step-up limits, counted before the password check |
| `cartSession.js`, `refundStatus.js`, `agentKeys.js` | Coupon cookie, "refund pending" check, the assistant's own agent identity |

### 5.4 Routes and pages (`src/routes`, 71 handlers)

| Route file | Pages / endpoints |
|---|---|
| `auth.js` | Login, register (admin email reserved), logout |
| `courses.js` | Course list, cards, pass banner, Access, Activity (user's ledger) |
| `cart.js` | Cart, coupons, checkout, cancelled checkout |
| `checkout.js` | Single checkout, course and pass refunds, Razorpay checkout page |
| `subscription.js` | Renew, Cancel renewal |
| `org.js` | Organization page, seat checkout, assign/unassign/reassign, pack refund |
| `ai.js` | Quota-limited AI summary |
| `agent.js` | Assistant chat, purchase cards, coupon field, approve/pay/cancel, request page |
| `content.js` | Admin Course content; learner course guide (access-checked) |
| `admin.js` | Dashboard, users and grants, pricing rules, reconciliation, assistant log |
| `webhooks.js` | Provider webhooks (raw body, verified, into the inbox) |
| `commerce.js` | Access/ledger JSON; dev-only event route (off by default) |

### 5.5 Mock provider (`mock-provider/server.js`)

A small Express app with a checkout page (Pay / Simulate Failure / Cancel), signed webhooks with re-sends,
refunds, records in `data.json` for reconciliation, failure switches, and an allow-list of return targets
(`agent`, `org`).

## 6. Data model

| Group | Tables | Notes |
|---|---|---|
| Catalog & users | `users`, `courses`, `pricing_rules` | Courses, the pass and coupons |
| Shopping | `cart_items`, `orders`, `order_line_items` | Orders carry subtotal, discount, final amount, applied rule, `refund_scope`, `checkout_key`, `checkout_url` |
| Ledger | `commerce_ledger` | Append-only (triggers); one reversal per event |
| Webhooks & recon | `webhook_inbox`, `recon_runs`, `recon_issues` | Inbox unique per provider event id |
| Organizations | `organizations`, `org_seat_pools` | Pack status; seats themselves are ledger events |
| Quotas | `usage_counters`, `usage_events` | Atomic counters + per-request audit |
| Agent | `purchase_intents`, `intent_events`, `agent_keys` | Requests (with list price, discount, coupon), full history |
| Assistant | `assistant_messages`, `assistant_log` | Chat memory (user can clear) vs. append-only admin log |
| Content | `course_docs`, `course_doc_events` | Published guides and their append-only history |

```mermaid
stateDiagram-v2
  [*] --> PENDING: order created
  PENDING --> COMPLETED: payment webhook (amount + currency match)
  PENDING --> UNDERPAID: paid less / other currency
  PENDING --> FAILED: payment failed
  PENDING --> CANCELLED: checkout closed
  PENDING --> EXPIRED: not paid in 60 min
  UNDERPAID --> COMPLETED: full payment later
  CANCELLED --> COMPLETED: late payment
  COMPLETED --> REFUND_PENDING: refund requested
  REFUND_PENDING --> REFUNDED: refund webhook
  REFUND_PENDING --> COMPLETED: provider refused
  COMPLETED --> CHARGED_BACK: chargeback webhook
```

## 7. Key flows

### 7.1 Purchase and refund (any provider)

```mermaid
sequenceDiagram
  participant U as User
  participant A as App
  participant P as Provider
  U->>A: Checkout (form key)
  A->>A: createOrder (PENDING) once per key
  A->>P: create payment
  U->>P: pay on checkout page
  P-->>A: webhook (signed)
  A->>A: inbox row → amount/currency/order check → ledger PURCHASE
  U->>A: open course guide → access decided now → allowed
  U->>A: Refund → requestRefund (REFUND_PENDING)
  A->>P: refund
  P-->>A: refund webhook → ledger REFUND → access ends
```

### 7.2 Agent purchase with coupon

```mermaid
sequenceDiagram
  participant U as User
  participant M as Model (Groq)
  participant A as App
  U->>M: "Buy Intro to SQL with code DEMO"
  M->>A: propose_purchase(productId, couponCode)
  A->>A: quote (cart rules) → request 19.00 (list 20.00)
  A-->>U: card: ~~20.00~~ 19.00, Apply/Remove, Approve 19.00
  U->>A: Approve (amount seen = 1900, password if > 30.00)
  A->>A: signed one-time token pins amount, list, coupon
  M->>A: execute_purchase
  A->>A: re-check coupon → createOrder(discount) → checkout
  U->>A: Pay → webhook → ledger 19.00 → "Payment received"
```

The model never sees the approval token and has no tool that approves. Everything it proposes is
re-checked on the server.

## 8. Decision log (ADR-015 onwards)

ADR-000 to ADR-014 (adapter contract, append-only ledger, PostgreSQL, inbox, retries, webhook-driven
refunds, reconciliation by replay, sandbox providers, stacked pass periods, seats from the ledger, atomic
quotas, AP2-inspired approval, the assistant as an untrusted agent, checkout instead of mandates) are in
`Architecture_Decision_Records.md`. The decisions below were made in this session; each record lists
context, the choice and its trade-off.

| ADR | Decision | Context and alternatives | Trade-off | Milestone |
|---|---|---|---|---|
| 015 | **Purchase cards leave the chat; each payment keeps a one-line result** | Finished cards piled up; deleting them lost the record | Lines are written once (atomic insert), shown in every open tab | M7 |
| 016 | **Mock purchases through the assistant use the mock checkout page** | The instant server charge hid the real flow and differed from Razorpay | One more click; same path as Razorpay | M7, M2 |
| 017 | **Model failures withdraw the half-made request; limits show only their message** | A Groq limit after propose left a hidden open request | User re-asks; nothing half-done remains | M7 |
| 018 | **Append-only assistant log, admin only** | Chat history is user-clearable and drops failed turns | More storage (90-day purge) | M8 |
| 019 | **One renewal at a time; Cancel renewal refunds a paid renewal; Refund refunds the whole pass and ends free periods** | Refund removed only the latest period ("partial"); renewals could stack | Several provider refunds per pass; access stays until all confirm | M4, M6 |
| 020 | **Seat checkout returns to `/org`; failed attempts are short notices** | Users landed on `/courses`; failed attempts stacked forever | Pack rows kept (late payments still activate) | M4 |
| 021 | **One order per checkout click; one grant per admin form** | Double clicks created two orders / two scholarship periods | Form keys and a stored checkout link | M2, M4 |
| 022 | **Course guides published by the admin and opened only with access, checked per request** | Access had nothing behind it; storing "has access" flags would break M3 | Polling every 30 s to close open guides; no caching | M3, M8 |
| 023 | **A payment grants only if amount and currency match an order of that user** | Paying 0.01 on the mock form opened content; forged messages could name any product | A legitimate partial payment is refused and escalated | M2, M6 |
| 024 | **Reconciliation escalates refused replays (PAYMENT_REFUSED)** | Refused replays were counted as "fixed" | More issues for the admin, none hidden | M6 |
| 025 | **Rotate secrets; warn or refuse on example values; dev event route off by default** | Example secrets allowed forged admin sessions and payments | Everyone signed out once; mock must be restarted | Brief constraint |
| 026 | **Limit password guessing (counted before the check), trust only a local proxy** | Unlimited guesses; parallel requests slipped past; ngrok made every visitor 127.0.0.1 | In-memory counters (single instance) | Security |
| 027 | **Coupons on agent purchases, pinned in the signed approval** | Agents always paid list price; a coupon must not change the approved amount | Coupon re-checked at payment; stale cards refused | M4, M7 |
| 028 | **Approve requires the amount the user saw and re-checks the password rule in the same update** | Removing a coupon during approval could skip the password | Old forms must be reloaded | M7 |
| 029 | **Generic error messages with a reference** | SQL and provider errors reached the browser | Details only in the server log | Security |
| 030 | **Light clean-up instead of a full restructure** | Review proposed config module, splits, ORM-free repositories, CI | Shared `orders.js`/`refunds.js`, helpers, tests in `test/`, dead code removed; bigger refactor declined by the owner | All |

**Superseded or reversed decisions.**
- The simulated agent and agent-key API (M7 v1) were replaced by the assistant (ADR-013); tamper and replay tests still run against the service.
- Refunding only the latest pass period was replaced by ADR-019.
- The mock's direct charge was replaced by ADR-016.
- Saved-card mandates were removed (ADR-014).
- AP2 was evaluated but not adopted: our approval is AP2-like inside one app. Signing with the user's own key (passkey/ES256) would be the step toward real AP2 mandates.

## 9. Security model

| Threat | Control |
|---|---|
| Forged session / admin | Random `JWT_SECRET`, HS256 pinned, admin email reserved at sign-up |
| Forged or altered payment | Razorpay HMAC; mock shared secret (no default, constant-time); amount, currency and order owner checked; dev route off |
| Duplicates and races | Inbox and ledger unique ids; conditional updates; advisory locks; one order per click; atomic approval |
| Password guessing | Limits per email+IP, per email, per IP; step-up limit per user |
| Agent misuse / prompt injection | No approve tool; server sets price; token never reaches the model; coupons validated; history of every attempt |
| Content leakage | Access decided per request; `no-store`; no title without access; escaped Markdown |
| Information leaks | Generic errors with reference; passwords never logged; request log off by default |

A 30-case attack script plus two independent read-only reviews found the gaps that ADR-023 to ADR-029 close.
After the fixes, the live re-run found 0 leaks.

## 10. Testing and evidence

| Suite (`test/`) | Covers |
|---|---|
| `verify-domain-memory`, `verify-domain-pg` | Ledger rules, projection, reversals, restart, append-only triggers |
| `verify-m2-m6` | Retries, backoff, DEAD, concurrent deliveries, reconciliation repairs and escalations |
| `verify-m4` | Seats, pass lifecycle, full-pass refund, underpaid / wrong-currency / no-order payments |
| `verify-m5` | Quotas under concurrency, pooled limits, release |
| `verify-m7` | Approval tampering, replay, expiry, cancel, wrong agent, step-up, price changes |
| `verify-assistant` | Tools with a fake model, cards, limits, model failures, assistant log, admin page |
| `verify-idempotency` | One order / pack / grant per click, org notices |
| `verify-content` | Guides: publish, access, refund, pass end, admin preview, escaping |
| `verify-agent-coupons` | Every coupon edge case, stale cards, step-up race, assistant passing codes |
| `verify-security` | Rate limits (incl. parallel and proxied), forged sessions, dev route, errors, mock secret |
| `verify-failure-switches` (live) | Duplicate, delay, drop payment, drop refund, reorder, refund API 500 |

`npm run verify` runs the 11 database suites. The browser runs (`E2E-TESTS.md` sections 1–15) cover:
- Razorpay test cards, ngrok webhooks and live pass expiry;
- guides closing within 30 s of a refund;
- coupon purchases with the real model;
- every fix above.

## 11. Configuration

| Setting | Purpose (default) |
|---|---|
| `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL` | Database, session signing, admin account |
| `RAZORPAY_*`, `MOCK_WEBHOOK_SECRET`, `MOCK_PROVIDER_URL`, `STREAMFLIX_URL` | Providers (test mode only) |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | Assistant model and fallback |
| `SUB_DURATION_MINUTES` | Demo: pass periods in minutes |
| `RECON_*`, `WEBHOOK_RETRY_INTERVAL_MS`, `AGENT_*` | Reconciliation, retries, agent rules |
| `ASSISTANT_LOG_DAYS`, `ASSISTANT_CARD_DONE_MS` | Log retention (90), card fade (5000) |
| `RENEW_PENDING_MINUTES` | Unpaid renewal blocks Renew (30) |
| `LOGIN_*`, `REGISTER_MAX_PER_IP`, `STEPUP_MAX_FAILS`, `TRUST_PROXY` | Guessing limits, proxy trust (`loopback`) |
| `ORG_NOTICE_FADE_MS`, `ORG_UNPAID_SHOW_SECONDS` | Org notices (6000 ms, 120 s) |
| `CONTENT_DIR`, `ENABLE_DEV_EVENTS`, `ADMIN_ALLOW_REGISTER`, `LOG_REQUESTS` | Guides folder; dev-only switches |

After pulling changes: run `npm run db:init` (it is safe to re-run), then restart the app **and** the mock provider.

## 12. Known limits and what was deliberately not done

- **Single instance:** in-memory projection, guide list and rate limits.
- **Test database:** the suites run against the dev database and clean up after themselves; there is no separate test database or CI.
- **Mock provider:** its admin pages have no login (local tool only).
- **Unverified emails:** domain-targeted coupons and identity pricing trust the registered address; coupons have no redemption limits.
- **No refund window** (buy, read, refund is possible).
- **Not adopted:** AP2 with user-held keys, saved-card mandates (need Razorpay support), and the larger restructuring (config module, splitting `admin.js`/`views.js`, lint, `node:test`). The owner decided the larger restructuring wasn't needed.

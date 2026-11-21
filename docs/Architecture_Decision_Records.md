# Architecture Decision Records — LEARNX (streamflix)

Project: provider-neutral payments, subscriptions, entitlements and agent-mediated commerce platform (CS5903).
Log written on **2026-11-20**. Decision dates come from the commit that introduced each decision; where the work is not committed yet, this is stated. Records are never deleted: a replaced decision is marked *Superseded* and points to its successor.

| ADR | Title | Status | Milestones |
|---|---|---|---|
| [ADR-000](#adr-000--methodology-reaffirmation-9-october-2026) | Methodology reaffirmation (9 October 2026) | Reaffirmed | All |
| [ADR-001](#adr-001--isolate-payment-providers-behind-an-adapter-contract) | Isolate payment providers behind an adapter contract | Accepted | M1, M2 |
| [ADR-002](#adr-002--append-only-ledger-as-the-source-of-truth-for-access) | Append-only ledger as the source of truth for access | Accepted | M1, M3 |
| [ADR-003](#adr-003--move-the-ledger-from-memory-to-postgresql) | Move the ledger from memory to PostgreSQL | Accepted (supersedes the in-memory store) | M3 |
| [ADR-004](#adr-004--webhook-inbox-with-provider-event-id-deduplication) | Webhook inbox with provider-event-id deduplication | Accepted | M2 |
| [ADR-005](#adr-005--background-retries-with-exponential-backoff-and-dead-state) | Background retries with exponential backoff and DEAD state | Accepted | M2, M8 |
| [ADR-006](#adr-006--refunds-change-access-only-on-the-providers-webhook) | Refunds change access only on the provider's webhook | Accepted | M1, M6 |
| [ADR-007](#adr-007--reconciliation-repairs-by-replaying-through-the-webhook-pipeline) | Reconciliation repairs by replaying through the webhook pipeline | Accepted | M6 |
| [ADR-008](#adr-008--sandbox-providers-razorpay-test-mode-plus-a-mock-with-failure-switches) | Sandbox providers: Razorpay test mode plus a mock with failure switches | Accepted | M2, M8 |
| [ADR-009](#adr-009--subscriptions-as-stacked-paid-periods-with-manual-renewal) | Subscriptions as stacked paid periods with manual renewal | Accepted | M4 |
| [ADR-010](#adr-010--enterprise-seats-counted-from-the-ledger) | Enterprise seats counted from the ledger | Accepted | M4 |
| [ADR-011](#adr-011--usage-quotas-with-one-atomic-database-update-and-request-keys) | Usage quotas with one atomic database update and request keys | Accepted | M5 |
| [ADR-012](#adr-012--ap2-inspired-signed-one-time-approval-instead-of-full-ap2) | AP2-inspired signed one-time approval instead of full AP2 | Accepted | M7 |
| [ADR-013](#adr-013--llm-assistant-as-an-untrusted-agent-groq-no-approve-tool) | LLM assistant as an untrusted agent (Groq, no approve tool) | Accepted | M7 |
| [ADR-014](#adr-014--agent-pays-through-checkout-saved-card-mandates-removed) | Agent pays through checkout; saved-card mandates removed | Accepted (reverses a same-day experiment) | M7 |
| [ADR-015](#adr-015--finished-purchase-cards-leave-the-chat-each-payment-keeps-a-one-line-result) | Finished purchase cards leave the chat; each payment keeps a one-line result | Accepted | M7 |
| [ADR-016](#adr-016--mock-purchases-through-the-assistant-use-the-mock-checkout-page) | Mock purchases through the assistant use the mock checkout page | Accepted | M7, M2 |
| [ADR-017](#adr-017--a-failed-model-turn-withdraws-its-half-made-request-limits-show-only-their-message) | A failed model turn withdraws its half-made request; limits show only their message | Accepted | M7 |
| [ADR-018](#adr-018--append-only-assistant-log-for-admins) | Append-only assistant log for admins | Accepted | M8 |
| [ADR-019](#adr-019--one-renewal-at-a-time-cancel-renewal-refunds-a-paid-renewal-refund-covers-the-whole-pass) | One renewal at a time; Cancel renewal refunds a paid renewal; Refund covers the whole pass | Accepted (revises ADR-009) | M4, M6 |
| [ADR-020](#adr-020--seat-checkout-returns-to-the-organization-page-failed-attempts-are-short-notices) | Seat checkout returns to the organization page; failed attempts are short notices | Accepted | M4 |
| [ADR-021](#adr-021--one-order-per-checkout-click-one-grant-per-admin-form) | One order per checkout click; one grant per admin form | Accepted | M2, M4 |
| [ADR-022](#adr-022--course-guides-published-by-the-admin-and-opened-only-with-access-checked-per-request) | Course guides published by the admin and opened only with access, checked per request | Accepted | M3, M8 |
| [ADR-023](#adr-023--a-payment-grants-only-if-amount-and-currency-match-an-order-of-that-user) | A payment grants only if amount and currency match an order of that user | Accepted | M2, M6 |
| [ADR-024](#adr-024--reconciliation-escalates-refused-replays-as-payment_refused) | Reconciliation escalates refused replays as PAYMENT_REFUSED | Accepted | M6 |
| [ADR-025](#adr-025--rotate-secrets-refuse-example-values-keep-dev-only-routes-off-by-default) | Rotate secrets, refuse example values, keep dev-only routes off by default | Accepted | Security |
| [ADR-026](#adr-026--limit-password-guessing-counted-before-the-check-trust-only-a-local-proxy) | Limit password guessing, counted before the check; trust only a local proxy | Accepted | Security |
| [ADR-027](#adr-027--coupons-on-agent-purchases-pinned-in-the-signed-approval) | Coupons on agent purchases, pinned in the signed approval | Accepted | M4, M7 |
| [ADR-028](#adr-028--approving-requires-the-amount-the-user-saw-and-re-checks-the-password-rule-atomically) | Approving requires the amount the user saw and re-checks the password rule atomically | Accepted | M7 |
| [ADR-029](#adr-029--generic-error-messages-with-a-reference) | Generic error messages with a reference | Accepted | Security |
| [ADR-030](#adr-030--a-light-clean-up-instead-of-a-full-restructure) | A light clean-up instead of a full restructure | Accepted | All |
| [ADR-031](#adr-031--bound-concurrent-seat-lock-holders-to-avoid-exhausting-the-connection-pool) | Bound concurrent seat-lock holders to avoid exhausting the connection pool | Proposed (not implemented) | M4 |
| [ADR-032](#adr-032--evaluate-against-two-baselines-naive-and-careful) | Evaluate against two baselines: naive and careful | Accepted | Evaluation |

---

## ADR-000 — Methodology reaffirmation (9 October 2026)

- **Date, status & scope:** documented 2026-11-20 (not backdated). Status: **Reaffirmed** by 9 October 2026: the approach was not changed. Scope: whole project, M1–M8. No mentor approval was needed (no fundamental change), and no scored mentor feedback asked for a change.
- **Context & decision drivers:** the brief asks for payments, subscriptions and entitlements that stay correct whatever the provider does (duplicate, late, reordered or lost events), with access explainable from history and agent purchases kept outside the core. Mentor guidance was to **go slowly, break the system into components and understand the flow of the application** before adding features.
- **Options considered:** (1) access flags updated directly by each webhook (simple; no history, unsafe under duplicates and races); (2) a payment-orchestration product (e.g. Hyperswitch) in front of the providers plus flags (provider-neutral, but heavy to run and still no entitlements); (3) **an own provider-neutral core: orders, an append-only ledger, a projection and a decision engine**, with providers behind adapters.
- **Decision & rationale:** option 3, on **Node.js (Express)**, **PostgreSQL** and **server-rendered HTML with htmx** (no front-end build step). Provider neutrality and access derived from history are what the brief asks for (M1–M3), so they had to be the core rather than an add-on. PostgreSQL enforces idempotency and append-only rules in the database itself (ADR-003); htmx gives in-place updates with plain HTML. In line with the mentor's guidance, the work followed the flow one component at a time: ledger → projection → decision, then provider adapters and webhooks, then commercial rules, reconciliation and finally agent purchases (M1 → M8).
- **Consequences & trade-offs:** + every later milestone plugged into the same core (adapters feed the ledger; seats, passes, refunds and agent purchases are events; access is always computed), so the core never had to be rewritten; − more code than option 1, and a single app instance (in-memory projection, see §8 of the report).
- **Evidence & validation:** before 9 Oct: Phase 0 setup (2a1f4c3, 1 Oct); ledger → projection → entitlement engine with mock checkout and refund (f379e0d, 2 Oct); ledger moved to PostgreSQL (e50d72d, 2 Oct, ADR-003); mock webhooks with `webhook_inbox` (7e58a48, 3 Oct). After 9 Oct the same architecture was extended, not replaced: Razorpay test mode through the existing adapter contract (a3504b5, 27 Oct), then M2/M4/M5/M6/M7 (12–20 Nov). The baseline comparison (`evaluation/`, ADR-032) measures option 1 against option 3: a naive version of option 1 was wrong in 7 of 7 failure workloads, a careful version in 2 (out-of-order and lost events), option 3 in none.
- **Revisit trigger:** a requirement the event model can't express (for example usage-based billing with millions of events per user), or a need to run several instances that the in-memory projection can't support.
---

## ADR-001 — Isolate payment providers behind an adapter contract

- **Date, status & scope:** 2026-10-03 (first adapter, 7e58a48); contract extended for reconciliation in M6 (de14f79, 2026-11-12). Accepted. Components: `src/payment/`, `src/routes/webhooks.js`.
- **Context & drivers:** the brief requires that the core entitlement system must not depend on any single payment provider. Providers differ in payload shape, signature scheme, event names and refund APIs. Drivers: provider independence, testability with a mock, the ability to add a provider without touching access logic.
- **Options considered:**
  1. Call the provider SDK directly from routes and handlers (fastest, but couples business logic to one provider).
  2. Use a payment-orchestration product (e.g. Hyperswitch) (provider-neutral, but heavy to run and still needs custom entitlements).
  3. **Own adapter contract** that normalises every provider into an internal `CommerceEvent`.
- **Decision & rationale:** option 3. `src/payment/adapter.js` defines `createPayment`, `verifyWebhook(rawBody, headers)`, `extractEventId`, `normalize`, `refund` and the reconciliation reads (`listTransactions`, `fetchPayment`, `listRefunds`, `fetchRefunds`, `recoveryEvent`). The domain never imports an adapter. *Measured:* Razorpay was added later (a3504b5) without changing `src/domain`. *Judgment:* the contract is small enough for a course project.
- **Consequences & trade-offs:** + a new provider means one new file; + the mock exercises the same path as Razorpay. − Features without a common equivalent (e.g. Razorpay card mandates, ADR-014) do not fit the contract. − Two adapters to keep in step.
- **Evidence & validation:** `src/payment/adapters/razorpay.js`, `mock.js`; `src/domain/*` has no provider imports; E2E runs pass on both providers (`docs/E2E-TESTS.md` RC1–RS2, C1–C7).
- **Revisit trigger:** a third provider whose events cannot be expressed as a `CommerceEvent` without adding provider-specific fields to the domain.

## ADR-002 — Append-only ledger as the source of truth for access

- **Date, status & scope:** 2026-10-02 (f379e0d). Accepted. Components: `src/domain/ledger.js`, `projection.js`, `decision.js`, table `commerce_ledger`.
- **Context & drivers:** M3 requires access to be derived from auditable history, not toggled flags. Refunds, chargebacks, revokes, seats and expiry must be explainable ("why does this user have access?").
- **Options considered:**
  1. Mutable `has_access` flags per user and course (simple, but no history and easy to corrupt with duplicate or reordered events).
  2. Flags plus a separate audit table (history exists but can drift from the flags).
  3. **Event-sourced ledger + projection**: append events, compute access from them.
- **Decision & rationale:** option 3. Event types: PURCHASE, SUBSCRIPTION_STARTED/RENEWED/CANCELLED, MANUAL_GRANT/REVOKE, REFUND, CHARGEBACK, SEAT_ASSIGNED/UNASSIGNED, each with source, actor and reason. A reversal must reference the event it undoes, at most once (code check + unique index `uq_one_reversal_per_event`). The database blocks UPDATE/DELETE with a trigger. The decision function returns a reason code (e.g. `ACTIVE_PURCHASE`, `PURCHASE_REFUNDED`, `SUBSCRIPTION_EXPIRED`).
- **Consequences & trade-offs:** + full audit trail; + expiry needs no event (computed from period end); + rebuilding the projection is deterministic. − Mistakes cannot be edited away, only reversed. − Test users stay in the ledger. − The projection is rebuilt at startup, which will be slow on a very large ledger.
- **Evidence & validation:** `npm run verify` suites `verify.js` (9 checks) and `verify-pg.js` (16 checks); Access/Activity views in the demo walkthrough.
- **Revisit trigger:** startup projection rebuild exceeding an acceptable time (for example, more than 10 s), which would call for snapshots.

## ADR-003 — Move the ledger from memory to PostgreSQL

- **Date, status & scope:** 2026-10-02 (e50d72d). Accepted; supersedes the in-memory store as the runtime store (`memoryLedgerStore.js` kept for the fast in-memory test). Component: `src/domain/stores/`.
- **Context & drivers:** an in-memory ledger loses all history on restart and cannot enforce uniqueness across concurrent requests.
- **Options considered:** keep in memory (fast, no persistence); a document store (flexible, weaker constraints); **PostgreSQL** (transactions, unique indexes, triggers).
- **Decision & rationale:** PostgreSQL behind a store interface, so the same domain code runs on both stores. Constraints (unique event id, one reversal per event, append-only trigger) are enforced in the database as well as in code.
- **Consequences & trade-offs:** + durability and database-level guarantees; + two stores keep a quick test path. − Requires a running Postgres for most checks; `db/schema.sql` must be re-applied after updates (`npm run db:init`).
- **Evidence & validation:** `test/verify-domain-memory.js` (memory) and `test/verify-domain-pg.js` (Postgres) both pass.
- **Revisit trigger:** a deployment target where PostgreSQL is not available.

## ADR-004 — Webhook inbox with provider-event-id deduplication

- **Date, status & scope:** 2026-10-03 (7e58a48). Accepted. Components: `src/routes/webhooks.js`, `src/payment/webhookProcessor.js`, table `webhook_inbox`.
- **Context & drivers:** providers deliver webhooks at least once, late and possibly out of order (M2). Processing a delivery twice must not duplicate money or access changes.
- **Options considered:**
  1. Process each delivery directly and rely on application checks (race-prone under concurrent duplicates).
  2. In-memory dedup cache (lost on restart).
  3. **Persist every delivery first, keyed by `(provider, provider_event_id)`**, then process.
- **Decision & rationale:** option 3. The signature is verified on the raw body before parsing; the row is inserted with a unique key; a duplicate insert is ignored; the ledger's unique `event_id` is a second guard. A refund that arrives before its purchase gets HTTP 503 so the provider re-sends it.
- **Consequences & trade-offs:** + exactly-once effect on top of at-least-once delivery; + every delivery is inspectable on `/admin/reconciliation`. − The inbox grows without bound (no retention yet).
- **Evidence & validation:** E2E W1 (3 copies sent, 1 ledger row); `verify-m2-m6.js` (refund before purchase applied once).
- **Revisit trigger:** inbox size affecting query time on the admin page, or a provider without stable event ids.

## ADR-005 — Background retries with exponential backoff and DEAD state

- **Date, status & scope:** 2026-11-12 (de14f79). Accepted. Component: `src/payment/retryWorker.js`.
- **Context & drivers:** a webhook can fail for transient reasons (database hiccup, purchase not there yet). Relying only on provider re-delivery gives no control or visibility.
- **Options considered:** provider re-delivery only; fixed-interval retry; **exponential backoff with a cap and a terminal state**.
- **Decision & rationale:** failed inbox rows are retried at 30 s, 60 s, 120 s … capped at 1 h, and marked `DEAD` after 8 attempts; an admin can retry a row by hand; DEAD rows are escalated by reconciliation.
- **Consequences & trade-offs:** + transient failures heal without intervention; + permanent failures become visible instead of looping. − Assumes one app instance runs the worker.
- **Evidence & validation:** `verify-m2-m6.js` ("backoff 30s, 60s, 120s, 240s, 480s, 960s, 1920s, DEAD after 8 attempts").
- **Revisit trigger:** running more than one app instance (needs row locking or leader election).

## ADR-006 — Refunds change access only on the provider's webhook

- **Date, status & scope:** 2026-11-12 (b020c80). Accepted. Components: refund routes, `webhookProcessor.js`, `src/services/refunds.js` (the one place a refund is requested), `src/services/refundStatus.js`.
- **Context & drivers:** a refund request can be accepted by the provider and still fail later (`refund.failed`). Removing access at request time could leave a user without access and without money back.
- **Options considered:** remove access when the refund API call succeeds (immediate, but wrong if the refund later fails); **keep access until the provider confirms by webhook** ("Refund pending").
- **Decision & rationale:** the second option. The order is marked `REFUND_PENDING`; the ledger `REFUND` is appended only when the provider's refund webhook arrives; a later `refund.failed` marks the order `REFUND_FAILED` for admin review. A refund covers the whole order for the amount actually paid (after coupons).
- **Consequences & trade-offs:** + money state and access state agree; + a lost refund webhook is repaired by reconciliation (ADR-007). − Access continues for a few seconds after the request (about 3–33 s observed with Razorpay).
- **Evidence & validation:** E2E R1, RC2, RS2, P6; `verify-m2-m6.js`.
- **Revisit trigger:** a business requirement to revoke access immediately on request (e.g. abuse), which would need a separate revoke event.

## ADR-007 — Reconciliation repairs by replaying through the webhook pipeline

- **Date, status & scope:** 2026-11-12 (de14f79); auto-acknowledge and pending-order expiry added 2026-11-19 (4cc86c0); `PAYMENT_REFUSED` escalation added 2026-11-20 (1c53ec8). Accepted. Component: `src/payment/reconcile.js`, tables `recon_runs`, `recon_issues`.
- **Context & drivers:** M6 requires detecting disagreement between provider-side and internal state, then repairing or escalating it safely. Webhooks can be lost entirely.
- **Options considered:**
  1. Write directly to the ledger when a mismatch is found (a second write path with its own bugs).
  2. Report only and let an admin fix everything by hand.
  3. **Replay the missing provider event through the normal webhook pipeline**, and escalate only what cannot be repaired automatically.
- **Decision & rationale:** option 3. Every 15 minutes (and on demand) the app compares each provider's payments and refunds with the ledger, after a 120 s grace period. Lost payment and refund webhooks and stuck `REFUND_PENDING` orders are replayed; amount mismatches, unknown payments, failed refunds and DEAD webhooks are opened as issues (one open issue per kind and reference). A resolved issue stays resolved.
- **Consequences & trade-offs:** + one write path, so repairs inherit all idempotency guarantees; + running twice changes nothing. − Depends on provider list APIs (the mock keeps its own records in `mock-provider/data.json` for this).
- **Evidence & validation:** E2E W2 (dropped webhook fixed as `MISSING_PURCHASE`); final reconciliation 35 mock + 19 Razorpay payments, 0 open issues; `verify-m2-m6.js`.
- **Revisit trigger:** a provider without list or fetch APIs, or reconciliation runs taking longer than their interval.

## ADR-008 — Sandbox providers: Razorpay test mode plus a mock with failure switches

- **Date, status & scope:** mock 2026-10-03 (7e58a48); Razorpay test mode 2026-10-27 (a3504b5); failure switches 2026-11-14. Accepted. Components: `mock-provider/`, `src/payment/adapters/`.
- **Context & drivers:** the brief allows sandboxes or local mocks only, with no real money. M8 requires injecting provider failures, which a real sandbox does not let you do on demand.
- **Options considered:** Razorpay test mode only (realistic, but failures cannot be injected); a mock only (full control, but unrealistic); Stripe test mode (similar capabilities; not used: the author could not get a Stripe account to start testing at no cost, while Razorpay gives a free, self-serve test-mode account immediately, with test cards and webhooks, so the app could be tested end to end without any cost); **both Razorpay test mode and a mock**.
- **Decision & rationale:** both. Razorpay proves the adapter against a real sandbox (signatures, retries, refunds). The mock has switches for duplicate, delay, reorder, drop and refund-HTTP-500, re-sends after 5xx (5 s, 15 s, 45 s), and keeps provider-side records for reconciliation.
- **Consequences & trade-offs:** + every failure mode in M2/M8 is reproducible; + no credentials are needed for the main demo. − The mock is extra code to maintain; − Razorpay test mode accepts only domestic test cards (5267 3181 8797 5449) and does not support card mandates (ADR-014).
- **Evidence & validation:** README "Failure switches"; E2E W1–W4, A20; `npm run verify:failures` (duplicate and delay automated).
- **Revisit trigger:** adding a provider whose sandbox supports failure injection, making the mock unnecessary.

## ADR-009 — Subscriptions as stacked paid periods with manual renewal

- **Date, status & scope:** 2026-11-12 (03c9938); refund and renewal rules revised 2026-11-20 (4cc86c0, see ADR-019 in PROJECT-OVERVIEW.md). Accepted. Component: `src/services/subscriptions.js`.
- **Context & drivers:** M4 needs a subscription lifecycle with clear conflict and expiry semantics. Automatic recurring debit is not available in the sandbox (ADR-014).
- **Options considered:** a single subscription row with a mutable end date (simple, but no history and refunds are ambiguous); provider-managed subscriptions (needs mandates, not available); **each paid period is its own ledger-backed period, stacked after the current one; renewal is a normal checkout**.
- **Decision & rationale:** stacked periods. Renew while active starts the next period at the current end (`SUBSCRIPTION_RENEWED`); one renewal at a time; Cancel renewal refunds a renewal already paid in advance; Refund refunds every live paid period (one provider refund per payment) and then ends the admin/scholarship periods of that pass (`MANUAL_REVOKE`, source `SYSTEM`). Expiry is computed from the period end time.
- **Consequences & trade-offs:** + every period is auditable and individually refundable; + expiry needs no scheduled job. − The user must renew by hand (no auto-debit). − `SUB_DURATION_MINUTES` (demo only) shortens every period, including old ones, when access is calculated.
- **Evidence & validation:** `verify-m4.js` (15 checks); E2E S1–S7, P1–P7, RS1–RS2.
- **Revisit trigger:** a provider or sandbox that supports recurring mandates.

## ADR-010 — Enterprise seats counted from the ledger

- **Date, status & scope:** 2026-11-12 (03c9938). Accepted. Components: `src/services/seats.js`, `src/routes/org.js`, tables `organizations`, `org_seat_pools`.
- **Context & drivers:** M4 requires seat allocation and reassignment without ever exceeding the purchased number, including under concurrent assignment.
- **Options considered:** a `seats_used` counter column (fast, but can drift from who actually has access); **count seats in use from `SEAT_ASSIGNED` / `SEAT_UNASSIGNED` ledger events inside a transaction**.
- **Decision & rationale:** count from the ledger, in a database transaction, so the count and the access decisions come from the same history. Reassign is a single step (unassign + assign). Refunding or charging back a pack unassigns every seat. The buyer gets no access from buying seats alone.
- **Consequences & trade-offs:** + no drift between seats and access; + two people cannot take the last seat at once. − One organization per user (the buyer owns it).
- **Evidence & validation:** `verify-m4.js`; E2E O1–O3; README walkthrough step 4.
- **Revisit trigger:** a requirement for several organizations per user or seat packs covering several courses.

## ADR-011 — Usage quotas with one atomic database update and request keys

- **Date, status & scope:** 2026-11-14 (7d1b6d3). Accepted. Components: `src/services/quotas.js`, `src/routes/ai.js`, tables `usage_counters`, `usage_events`.
- **Context & drivers:** M5 requires per-user or pooled limits on a premium feature that hold under concurrent requests; retries must not consume credits twice.
- **Options considered:** read-then-write in application code (races under concurrency); an in-memory rate limiter (lost on restart, not shared); Redis (an extra service); **a conditional atomic UPDATE in PostgreSQL plus a unique request key**.
- **Decision & rationale:** the last option. One row per user or organization per day; the increment succeeds only while under the limit; each request carries a unique `request_key`, so a retry is counted once; a failed operation gives its credit back once. Limits: 5/day (purchase or grant), 20/day (pass), 10 per seat pooled per organization; HTTP 429 with `Retry-After`. The same code limits the assistant (30 messages/day) and agent proposals (20/day).
- **Consequences & trade-offs:** + correct under concurrency without new infrastructure; + reused for assistant limits. − Daily windows only (reset 00:00 UTC); no admin view of usage yet.
- **Evidence & validation:** `verify-m5.js` (7 checks); README "Usage quotas"; E2E L5.
- **Revisit trigger:** a need for sliding windows or limits per second, where a dedicated rate limiter fits better.

## ADR-012 — AP2-inspired signed one-time approval instead of full AP2

- **Date, status & scope:** 2026-11-15 (first version), hardened 2026-11-19 (7dd197d, 4cc86c0); coupons pinned in the approval 2026-11-20 (1c53ec8). Accepted. Components: `src/services/agentPurchase.js`, `src/services/agentKeys.js`, tables `purchase_intents`, `intent_events`, `agent_keys`.
- **Context & drivers:** M7 requires a sandbox flow where an agent proposes, the user explicitly approves, the approved item/merchant/amount is preserved, and tampered, replayed, expired or cancelled authorizations are rejected. The brief makes an adapter "such as AP2" optional and forbids coupling the core ledger to it.
- **Options considered:**
  1. Full AP2 (mandates as verifiable credentials): closest to the emerging standard, but needs a compatible wallet and payment network that is not available in a sandbox.
  2. Trust the agent's request (no explicit approval): fails M7.
  3. **AP2-inspired: the server fixes item, merchant and price from the catalog; the user approves; the server issues a signed, short-lived, one-time token bound to the request.**
- **Decision & rationale:** option 3. The token is a JWT (HMAC, secret derived from `JWT_SECRET` unless `AGENT_APPROVAL_SECRET` is set) containing request, user, agent, item, merchant, amount, currency and a nonce, valid for 5 minutes. It is never shown in the browser or sent to the model. Execution is rejected for `TAMPERED`, `EXPIRED`, `WRONG_INTENT/USER/AGENT`, `MISMATCH`, `PRICE_CHANGED`, `CANCELLED`, `NOT_APPROVED`, `ALREADY_OWNED` and `REPLAYED` (only one `APPROVED → EXECUTED` update can win). Above 30.00 the user must also re-enter their password. Payment goes through the normal checkout and webhook, so the ledger records an ordinary purchase; the only link is `purchase_intents.order_id`.
- **Consequences & trade-offs:** + all M7 properties with no new infrastructure; + the ledger stays agent-agnostic. − Not interoperable with AP2 agents; − HMAC signing means only this server can verify approvals (a third party would need asymmetric keys such as ES256); − browser password autofill can weaken the step-up.
- **Evidence & validation:** `verify-m7.js` (22 checks, including 3 concurrent replays with exactly one winner); E2E A1–A42.
- **Revisit trigger:** AP2 tooling becoming usable in a sandbox, or a third party needing to verify approvals.

## ADR-013 — LLM assistant as an untrusted agent (Groq, no approve tool)

- **Date, status & scope:** 2026-11-19 (4cc86c0). Accepted. Components: `src/services/assistant.js`, `src/routes/agent.js`, tables `assistant_messages`, `assistant_log`.
- **Context & drivers:** the agent flow needs a real agent for the demo, but a language model can be wrong, rate-limited or prompt-injected.
- **Options considered:** a scripted "simulated agent" (deterministic, but not a real agent; built first, then removed 2026-11-19); a hosted model with full API access (convenient, unsafe); **a hosted model limited to a small set of server-side tools, with every safety rule enforced by the server**.
- **Decision & rationale:** the last option. Groq's OpenAI-compatible API (`openai/gpt-oss-120b`; Gemini or any compatible endpoint as fallback). Tools: `list_courses`, `list_my_requests`, `propose_purchase`, `check_request`, `execute_purchase`; **there is no approve tool**. Purchase cards are drawn by the server from the database state, not from model text. Guardrails: 30 messages per user per day, 6 model calls per message, 1000 characters, argument validation, and course text treated as data. Every turn is written to the append-only `assistant_log`.
- **Consequences & trade-offs:** + a misbehaving model can at most propose; + full audit of every turn. − Depends on an external API with free-tier rate limits; − user messages and the course list are sent to the model provider; − model output sometimes needs cleaning (zero-width characters, leaked planning).
- **Evidence & validation:** `verify-assistant.js` (25 checks, fake model); E2E A5 (prompt injection refused), A13/A35/A36 (rate limits), D9/D13.
- **Revisit trigger:** a change in the provider's rate limits or terms, or a requirement to keep chat data on-premises (use a local model through `LLM_BASE_URL`).

## ADR-014 — Agent pays through checkout; saved-card mandates removed

- **Date, status & scope:** tried and removed 2026-11-19 (the removal is part of 4cc86c0). Accepted. Component: agent payment step.
- **Context & drivers:** for a fully agent-completed purchase, the agent would ideally charge a saved card with no checkout page.
- **Options considered:** **Razorpay card mandate** (registration link + server-side recurring payment): built; **checkout per purchase** for the approved amount: the existing path.
- **Decision & rationale:** checkout per purchase. The mandate path was built and removed the same day because card mandates do not work on the Razorpay test account (the domestic recurring test card failed with `SERVER_ERROR`, international cards are disabled, and the standard test card is not eligible for recurring). The approved amount is fixed in the Razorpay order, so the user still cannot pay a different price.
- **Consequences & trade-offs:** + works in the sandbox; − the user must complete a checkout, so the purchase is not fully autonomous. Unused tables and columns remain (`saved_payment_methods`, `purchase_intents.pay_method`, …) as technical debt.
- **Evidence & validation:** `plan.txt` ("M7 Razorpay saved card … TRIED, REMOVED"); README "Choosing the provider".
- **Revisit trigger:** Razorpay enabling card mandates on the test account.

---

## ADR-015 — Finished purchase cards leave the chat; each payment keeps a one-line result

- **Date, status & scope:** 2026-11-20 (4cc86c0). Accepted. M7. Components: `src/routes/agent.js` (cards, page script), `src/services/assistant.js` (`noteOutcomes`, `outcomeNote`).
- **Context & decision drivers:** purchase cards stayed under the chat after the payment finished and piled up; removing them must not lose the record of what happened. Updates arrive by htmx polling, possibly in several open tabs.
- **Options considered:** (1) keep every card (cluttered); (2) delete finished cards (no record); (3) **fade finished cards out and keep one result line per payment**.
- **Decision & rationale:** option 3. A finished card shows its final state for `ASSISTANT_CARD_DONE_MS` (5000), then fades and is removed; the app writes one line per payment ("Payment received…", or a red failed/cancelled line) with an atomic `INSERT … WHERE NOT EXISTS`, and every tab that sees the card finish gets the line.
- **Consequences & trade-offs:** + clean chat with a permanent outcome history; − a small page script; two htmx timing details had to be handled (class set after the swap; out-of-band content applied before the main content).
- **Evidence & validation:** `test/verify-assistant.js`; E2E A23–A26, A38–A42 (box 198 → 114 → 0 px, line kept), defects D7, D8, D14.
- **Revisit trigger:** users asking to see finished cards again (e.g. a history panel), or a move away from htmx.

## ADR-016 — Mock purchases through the assistant use the mock checkout page

- **Date, status & scope:** 2026-11-20 (4cc86c0). Accepted; supersedes the mock's server-side instant charge. M7, M2. Components: `src/routes/agent.js` (`paymentStarter`), `mock-provider/server.js` (`back=agent`).
- **Context & decision drivers:** the mock charged agent purchases instantly on the server, hiding the payment step and behaving differently from Razorpay.
- **Options considered:** (1) keep the instant charge (fewer clicks); (2) **open the mock checkout page like Razorpay**.
- **Decision & rationale:** option 2: one payment path for both providers; the mock page returns to `/agent` (Pay / Simulate Failure) or to the "checkout closed" route (Cancel), with return targets from a fixed allow-list.
- **Consequences & trade-offs:** + the demo shows the real flow and failure buttons; − one more click.
- **Evidence & validation:** E2E A31–A34, D11; `test/verify-assistant.js` (mock goes through the checkout page).
- **Revisit trigger:** a need for fully autonomous agent payments in the demo (would require mandates, see ADR-014).

## ADR-017 — A failed model turn withdraws its half-made request; limits show only their message

- **Date, status & scope:** 2026-11-20 (4cc86c0). Accepted. M7. Component: `src/services/assistant.js` (`chat`).
- **Context & decision drivers:** a Groq rate limit right after `propose_purchase` left an open request the user never saw; asking again then said "you already have an open request".
- **Options considered:** (1) keep partial results always; (2) discard everything always (loses a started payment); (3) **discard and withdraw if no payment started; keep the steps if one did**.
- **Decision & rationale:** option 3. Without a started payment the turn stores nothing, releases the message quota and cancels its proposal (actor `system`); after `execute_purchase` the steps are kept so the card still offers Pay. Limit messages are shown as-is, with the provider's wait time.
- **Consequences & trade-offs:** + nothing hidden or half-done; − the user re-asks after a limit.
- **Evidence & validation:** `test/verify-assistant.js` (model fails part-way); E2E A35, A36, D12.
- **Revisit trigger:** a model provider without rate limits, or streaming replies that make partial turns visible.

## ADR-018 — Append-only assistant log for admins

- **Date, status & scope:** 2026-11-20 (4cc86c0). Accepted. M8. Components: table `assistant_log`, `src/services/assistant.js`, `/admin/assistant` in `src/routes/admin.js`.
- **Context & decision drivers:** the chat history is the model's memory: users can clear it and failed turns are not stored, so nothing remained for monitoring errors, limits, cost or misbehaviour.
- **Options considered:** (1) reuse the chat table; (2) plain server logs (not searchable, not per user); (3) **a separate append-only table with an admin page**.
- **Decision & rationale:** option 3: one row per turn (message, reply, replaced model text, tools, flags, model, tokens, duration, IP, error); a trigger blocks UPDATE/DELETE except the hourly purge after `ASSISTANT_LOG_DAYS` (90); admin page with 24-hour totals, search, filters and a per-user view.
- **Consequences & trade-offs:** + full monitoring, survives Clear chat; − stores personal messages (admin-only, bounded retention).
- **Evidence & validation:** `test/verify-assistant.js` (log rows, purge, admin-only page); E2E section 9 (L1–L9).
- **Revisit trigger:** privacy requirements (shorter retention or redaction) or log volume affecting the admin page.

## ADR-019 — One renewal at a time; Cancel renewal refunds a paid renewal; Refund covers the whole pass

- **Date, status & scope:** 2026-11-20 (4cc86c0). Accepted; revises ADR-009. M4, M6. Components: `src/services/subscriptions.js`, refund route, pass card, `orders.refund_scope`.
- **Context & decision drivers:** users could stack several renewals; Refund removed only the latest period, which the owner considered a "partial refund".
- **Options considered:** for a renewal already paid when renewal is cancelled: (A) **refund it in full** or (B) keep it as a flag only; for Refund: refund the latest period only, or **every paid period of the current pass**.
- **Decision & rationale:** owner chose A and the full refund. Renew is hidden and refused (all paths) while a renewal is queued, being paid (`RENEW_PENDING_MINUTES`) or refunded. Refund requests one provider refund per payment (`PASS_FULL`); after all are confirmed the pass's admin/scholarship periods end (`MANUAL_REVOKE`, source SYSTEM).
- **Consequences & trade-offs:** + no stacked renewals, no partial surprises; − several provider refunds per pass; access stays until the last confirms; a refused part leaves the rest refunded and free time kept.
- **Evidence & validation:** `test/verify-m4.js` (cancel-renewal refund, full refund, refused part, scholarship ended); E2E section 10 (P1–P7) and X1.
- **Revisit trigger:** automatic recurring billing becoming available (mandates), or a pro-rata refund policy.

## ADR-020 — Seat checkout returns to the organization page; failed attempts are short notices

- **Date, status & scope:** 2026-11-20 (4cc86c0; notices f7dcab5). Accepted. M4. Components: `src/routes/org.js`, `src/routes/checkout.js` (Razorpay page), `mock-provider/server.js` (`back=org`).
- **Context & decision drivers:** after buying seats users landed on `/courses`; later, failed or cancelled seat checkouts stayed on `/org` forever as "Waiting for payment … paid $100".
- **Options considered:** (1) keep the default return; (2) **return to `/org` with the result**; for failed attempts: list them forever, delete the rows, or **show a short fading notice and keep the rows**.
- **Decision & rationale:** `back=org` accepted from a fixed allow-list by both providers; `/org?checkout=paid|failed|cancelled` note; unpaid packs fade after `ORG_NOTICE_FADE_MS` and are listed only for `ORG_UNPAID_SHOW_SECONDS` after they ended.
- **Consequences & trade-offs:** + clear feedback, no pile-up; rows kept so a late payment still activates the pack.
- **Evidence & validation:** `test/verify-idempotency.js` (notice, hidden later, row kept); E2E O1–O3, X2, D18.
- **Revisit trigger:** users needing a history of failed seat purchases.

## ADR-021 — One order per checkout click; one grant per admin form

- **Date, status & scope:** 2026-11-20 (4cc86c0; refactored into `orders.js` in f7dcab5). Accepted. M2, M4. Components: `src/services/checkoutOnce.js`, cart and seat checkout, admin grant form.
- **Context & decision drivers:** checking the brief's "all state-changing operations idempotent" found two gaps: a double click created two pending orders, and a double-submitted scholarship grant gave two pass periods.
- **Options considered:** (1) disable buttons only (client-side, not reliable); (2) reuse any open pending order of the user (wrong across carts); (3) **one-time form keys checked on the server**.
- **Decision & rationale:** option 3 (plus disabled buttons). Checkout: an advisory lock per key, the key stored on the order, repeats redirected to the stored checkout link; grants: the form key is the ledger event id, so a repeat is a `DUPLICATE_EVENT`.
- **Consequences & trade-offs:** + exactly one effect per click; − small form plumbing.
- **Evidence & validation:** `test/verify-idempotency.js` (3 simultaneous + 1 late submit → one order / one pack / one grant).
- **Revisit trigger:** a public API for checkout (would need a client-supplied idempotency key header).

## ADR-022 — Course guides published by the admin and opened only with access, checked per request

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. M3, M8. Components: `content/*.md`, `src/services/courseDocs.js`, `src/services/markdown.js`, `src/routes/content.js`, tables `course_docs`, `course_doc_events`.
- **Context & decision drivers:** access was computed correctly but nothing was behind it. Owner asked for the simplest version: exactly one guide per course, added from the admin page, opened only when paid.
- **Options considered:** (1) store "can read" flags at purchase (contradicts M3); (2) check once at purchase; (3) **ask the access decision on every request**.
- **Decision & rationale:** option 3, with a 30 s re-check on open pages, `Cache-Control: no-store`, no title on refused pages, an escaped Markdown renderer and an append-only publishing history.
- **Consequences & trade-offs:** + refund, revoke and pass expiry close the guide on time with no extra event; − polling traffic while a guide is open.
- **Evidence & validation:** `test/verify-content.js`; E2E section 12 (guide closed within 30 s of a refund and at the exact pass end) and section 13 (30 attacks, 0 leaks).
- **Revisit trigger:** large media content (would need signed, short-lived URLs).

## ADR-023 — A payment grants only if amount and currency match an order of that user

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. M2, M6. Component: `src/payment/webhookProcessor.js` (`#underpaid`, `#orderMismatch`).
- **Context & decision drivers:** the security test showed paying 0.01 instead of 50.00 on the mock form opened the guide (and the ledger even recorded 50.00); a forged message could name products without any order; the review then showed currency was not compared.
- **Options considered:** (1) trust the provider amount and let reconciliation report mismatches later; (2) **refuse at the source**.
- **Decision & rationale:** option 2: the purchase must name one of our orders, owned by the same user, with paid amount ≥ total and the order's currency; otherwise `UNDERPAID` / `NO_MATCHING_ORDER`, nothing granted; a later full payment completes the order.
- **Consequences & trade-offs:** + no access without full payment; − a genuine partial payment is refused and escalated instead of granted.
- **Evidence & validation:** `test/verify-m4.js` (0.01, JPY, no order, another user's order); `evaluation/` S4 (naive baseline 10 wrongly granted per run; careful baseline, which also checks amount and currency, and LEARNX 0).
- **Revisit trigger:** multi-currency pricing or instalment payments.

## ADR-024 — Reconciliation escalates refused replays as PAYMENT_REFUSED

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. M6. Component: `src/payment/reconcile.js`.
- **Context & decision drivers:** after ADR-023, a replayed payment that the processor refused was still counted as "fixed".
- **Options considered:** (1) keep counting it fixed; (2) **open an issue for the admin**.
- **Decision & rationale:** option 2: a refused replay (now or earlier) becomes an open `PAYMENT_REFUSED` issue; nothing is hidden.
- **Consequences & trade-offs:** + honest repair statistics; − more items for the admin.
- **Evidence & validation:** `test/verify-m2-m6.js` (54.00 paid for 55.00: refused, `AMOUNT_MISMATCH` + `PAYMENT_REFUSED`, no access).
- **Revisit trigger:** an automatic partial-refund flow for underpayments.

## ADR-025 — Rotate secrets, refuse example values, keep dev-only routes off by default

- **Date, status & scope:** 2026-11-20 (1c53ec8; secrets rotated in the local `.env`, never committed). Accepted. Security. Components: `src/server.js`, `src/payment/adapters/mock.js`, `src/routes/commerce.js`.
- **Context & decision drivers:** `JWT_SECRET` and `MOCK_WEBHOOK_SECRET` equalled the public `.env.example` values (forge an admin session, forge a payment); `/api/dev/events` let any user write purchases; the mock adapter had a built-in default secret.
- **Options considered:** (1) document the risk only; (2) **rotate, warn/refuse at startup, remove defaults, gate the dev route**.
- **Decision & rationale:** option 2 (owner approved): new 64-hex secrets; startup warns (refuses with `NODE_ENV=production`) on example or short secrets; no default mock secret (constant-time compare); dev route only with `ENABLE_DEV_EVENTS=1` and admin.
- **Consequences & trade-offs:** + forged sessions and webhooks rejected; − everyone signed out once; the mock must be restarted after `.env` changes.
- **Evidence & validation:** `test/verify-security.js`; E2E section 13 (S8–S10) and section 15 (re-run: 401 / 302).
- **Revisit trigger:** a deployment with a secrets manager.

## ADR-026 — Limit password guessing, counted before the check; trust only a local proxy

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. Security. Components: `src/services/rateLimit.js`, `src/routes/auth.js`, step-up in `src/routes/agent.js`, `trust proxy` in `src/server.js`.
- **Context & decision drivers:** no limits on login, sign-up or the approval password; the review then showed parallel guesses slipped past counts taken after bcrypt, and behind ngrok all visitors share 127.0.0.1.
- **Options considered:** (1) a library such as express-rate-limit (new dependency, same in-memory limits); (2) Redis-backed limits (new service); (3) **a small in-memory limiter**.
- **Decision & rationale:** option 3: per email+IP (5), per email from any IP (50), per IP (30) per 15 minutes; sign-up 10 per IP per hour; approval password 5 per user; counted before the password check and cleared on success; `TRUST_PROXY=loopback`; admin email cannot be registered.
- **Consequences & trade-offs:** + guessing and parallel bursts limited, no new dependency; − counters reset on restart and assume one instance.
- **Evidence & validation:** `test/verify-security.js` (10 parallel guesses → at most 3 checked; per-visitor IPs; admin email reserved).
- **Revisit trigger:** running more than one instance (move counters to the database or Redis).

## ADR-027 — Coupons on agent purchases, pinned in the signed approval

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. M4, M7. Components: `src/services/agentPurchase.js` (`quote`, `setCoupon`), assistant tool `couponCode`, card coupon field; columns `list_amount_cents`, `discount_cents`, `coupon_code`, `coupon_rule_id`.
- **Context & decision drivers:** agents always paid the list price; the owner asked for coupons. A coupon must never change the amount the user approved.
- **Options considered:** (1) apply coupons only at checkout (amount differs from the approval); (2) **validate when proposing or on the card, and pin the result in the approval**.
- **Decision & rationale:** option 2: the cart's rules (`validateCoupon`); only codes the user typed; owner-only Apply/Remove while PROPOSED; the token pins list price and coupon; execute re-checks the coupon; free results refused; the order records discount and rule.
- **Consequences & trade-offs:** + the user always pays exactly what was approved; − a coupon that expires between approval and payment fails the purchase (`COUPON_INVALID`).
- **Evidence & validation:** `test/verify-agent-coupons.js`; E2E section 14 (20.00 → 19.00 with Groq; ledger 19.00).
- **Revisit trigger:** coupon redemption limits (would need reservation at approval time).

## ADR-028 — Approving requires the amount the user saw and re-checks the password rule atomically

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. M7. Components: `approve()` in `src/services/agentPurchase.js`, approve forms in `src/routes/agent.js`.
- **Context & decision drivers:** with coupons the price can change while a request waits; the review found a race (remove the coupon while approving without a password → a higher amount approved without the password).
- **Options considered:** (1) re-read the request before approving (still racy); (2) **put both conditions into the single approving UPDATE**.
- **Decision & rationale:** option 2: every Approve form carries the shown amount (missing = "out of date"); the UPDATE requires `amount_cents = shown` and, when no password was entered, `amount_cents ≤ threshold` (`STEP_UP_REQUIRED`).
- **Consequences & trade-offs:** + no approval of an amount the user didn't see; − an old open form must be reloaded.
- **Evidence & validation:** `test/verify-agent-coupons.js` (stale card, step-up race), `test/verify-m7.js` (form without amount refused).
- **Revisit trigger:** a different approval UI (e.g. a mobile app) — it must send the shown amount too.

## ADR-029 — Generic error messages with a reference

- **Date, status & scope:** 2026-11-20 (1c53ec8). Accepted. Security. Component: `src/errorHandler.js`, checkout error paths.
- **Context & decision drivers:** SQL and provider error text could reach the browser.
- **Options considered:** (1) show raw errors (helpful in development, leaks internals); (2) **generic message + reference, details only in the log**.
- **Decision & rationale:** option 2: "Server error (ref abc12345)"; checkout failures say "Checkout failed. Nothing was charged."; domain errors with user-meaningful text are still shown.
- **Consequences & trade-offs:** + no internal details leaked; − debugging needs the server log.
- **Evidence & validation:** `test/verify-security.js` (no internal text, reference present).
- **Revisit trigger:** a central log/monitoring service (the reference would link to it).

## ADR-030 — A light clean-up instead of a full restructure

- **Date, status & scope:** 2026-11-20 (f7dcab5). Accepted. All milestones (code quality). Components: `src/services/orders.js`, `src/services/refunds.js`, `src/views.js` helpers, `test/`.
- **Context & decision drivers:** an independent structure review found a well-designed core, but routes doing too much, order creation written 4×, the refund flow 2×, a lookup helper 4×, settings read in 17 files and tests inside `src/`.
- **Options considered:** (1) **targeted de-duplication**; (2) full restructure (config module, repositories, split `admin.js`/`views.js`, error types, lint, `node:test`, CI); (3) leave as is.
- **Decision & rationale:** option 1; the owner declined option 2 as unnecessary for the submission. A formatter (Prettier) was set up and then removed at the owner's request.
- **Consequences & trade-offs:** + one place each for orders and refunds, tests separated, dead code gone, behaviour unchanged (11 suites passed after every step); − the largest files remain large.
- **Evidence & validation:** commit f7dcab5; `npm run verify` 11/11; no import cycles (checked).
- **Revisit trigger:** more contributors, or a feature that needs a third copy of an existing flow.

## ADR-031 — Bound concurrent seat-lock holders to avoid exhausting the connection pool

- **Date, status & scope:** 2026-11-20 (found by the evaluation). **Proposed, not implemented.** The fix was written and tested, then left out of the final revision on purpose: the final phase was limited to documentation, and the defect needs a burst of 10 or more simultaneous assignments to one pack. M4. Component: `withPoolLock` in `src/services/seats.js`.
- **Context & decision drivers:** a first version of evaluation workload S6 (10 simultaneous assignments to one pack) froze the whole app. Each assignment holds a pooled connection while it waits on the pack's advisory lock, and the holder needs further connections (pack read, ledger write) that are all taken (pool of 10). Correctness is not affected (never more seats than bought); availability is.
- **Options considered:** (1) a bigger pool (only moves the threshold); (2) pass one client through the ledger store (larger change to the domain store API); (3) queue seat operations in memory and let at most N hold a connection, reading the pack on the same connection; (4) **keep the current code, document the defect and track it as an issue**.
- **Decision & rationale:** option 4 for this submission (judgment: no code changes in the final documentation phase; the trigger needs an unusual burst). Option 3 is the intended fix: a prototype (N = 4) passed 12 simultaneous assignments with exactly 1 seat taken, and the test hung with the queue disabled (measured 2026-11-20).
- **Consequences & trade-offs:** + the submitted code is the code that was tested end to end; − 10 or more simultaneous seat assignments can freeze the app until it is restarted. The evaluation runs S6 with 6 parallel assignments (below the pool size) and reports the freeze separately.
- **Evidence & validation:** the freeze observed in the first S6 run; `evaluation/README.md` ("Known defect"); prototype results above. Tracked as a GitHub issue (report §9, task 1).
- **Revisit trigger:** organizations assigning seats in bulk, or any other code path that holds a pooled connection while waiting on a lock.

## ADR-032 — Evaluate against two baselines: naive and careful

- **Date, status & scope:** 2026-11-21. Accepted. Methodology (report §4–§5); `evaluation/`.
- **Context & decision drivers:** the guide asks for a baseline comparison with declared workloads and metrics. The first evaluation compared LEARNX with one naive baseline (webhooks flip access flags, no protections). Reviewing it, the author judged it too easy to win: its error counts follow directly from the inputs, and a sensible developer would add deduplication and locks anyway. A comparison that only beats a strawman is weak evidence.
- **Options considered:** (1) keep the naive baseline only; (2) replace it with a stronger one; (3) **keep the naive baseline and add a careful one** that follows the usual webhook advice (deduplicate by payment id, match amount and currency to the order, race-safe quota/seat/approval updates) but has no event history, retry or reconciliation; (4) compare with an existing product (Lago, Kill Bill): heavy to run, and not a like-for-like design.
- **Decision & rationale:** option 3. The naive baseline shows what goes wrong with no care at all; the careful one isolates what LEARNX's design adds beyond ordinary care (judgment). The measurement: the careful baseline fails only S2 (refund before purchase) and S3 (lost webhooks).
- **Consequences & trade-offs:** + the claim is narrower and defensible ("ordering and recovery", not "7 of 7"); − the careful baseline's S2 result depends on its choice to ignore an unknown refund (stated in the report); the workloads stay small and deterministic, and webhooks skip the HTTP route (covered by the test suites instead).
- **Evidence & validation:** `evaluation/baseline.js`, `evaluation/baseline-careful.js`, `evaluation/run-evaluation.js`; `evaluation/results/` (seed 42, 5 runs).
- **Revisit trigger:** a new failure mode in production that the careful baseline would also handle (then LEARNX's design needs a new justification), or a move to load testing.


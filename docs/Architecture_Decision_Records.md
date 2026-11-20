# Architecture Decision Records — LEARNX (streamflix)

Project: provider-neutral payments, subscriptions, entitlements and agent-mediated commerce platform (CS5903).
Log written on **2026-11-20**. Decision dates come from the commit that introduced each decision; where the work is not committed yet, this is stated. Records are never deleted: a replaced decision is marked *Superseded* and points to its successor.

| ADR | Title | Status | Milestones |
|---|---|---|---|
| [ADR-000](#adr-000--methodology-reaffirmation-9-october-2026) | Methodology reaffirmation (9 October 2026) | **To be completed by the author** | All |
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

---

## ADR-000 — Methodology reaffirmation (9 October 2026)

- **Date, status & scope:** documented 2026-11-20 (not backdated). Status: **to be completed by the author**. Scope: whole project, M1–M8.
- **What must be stated here (author):** whether the approach was *reaffirmed* or *changed* by 9 October 2026, 11:59 PM IST, and any mentor approval reference.
- **Evidence available from the repository** (for the author to confirm or correct):
  - Before 9 Oct: Phase 0 setup (2a1f4c3, 1 Oct); ledger → projection → entitlement engine with mock checkout and refund (f379e0d, 2 Oct); ledger moved to PostgreSQL (e50d72d, 2 Oct, ADR-003); mock webhooks with `webhook_inbox` (7e58a48, 3 Oct, ADR-004).
  - After 9 Oct the same architecture was extended, not replaced: Razorpay test mode added through the existing adapter contract (a3504b5, 27 Oct), then M2/M4/M5/M6/M7 (12–19 Nov).
- **If changed,** fill in: old approach → new evidence → alternatives → selected approach → impact on milestones/tests → revised plan.

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
- **Evidence & validation:** `src/domain/verify.js` (memory) and `verify-pg.js` (Postgres) both pass.
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

- **Date, status & scope:** 2026-11-12 (b020c80). Accepted. Components: refund routes, `webhookProcessor.js`, `src/services/refundStatus.js`.
- **Context & drivers:** a refund request can be accepted by the provider and still fail later (`refund.failed`). Removing access at request time could leave a user without access and without money back.
- **Options considered:** remove access when the refund API call succeeds (immediate, but wrong if the refund later fails); **keep access until the provider confirms by webhook** ("Refund pending").
- **Decision & rationale:** the second option. The order is marked `REFUND_PENDING`; the ledger `REFUND` is appended only when the provider's refund webhook arrives; a later `refund.failed` marks the order `REFUND_FAILED` for admin review. A refund covers the whole order for the amount actually paid (after coupons).
- **Consequences & trade-offs:** + money state and access state agree; + a lost refund webhook is repaired by reconciliation (ADR-007). − Access continues for a few seconds after the request (about 3–33 s observed with Razorpay).
- **Evidence & validation:** E2E R1, RC2, RS2, P6; `verify-m2-m6.js`.
- **Revisit trigger:** a business requirement to revoke access immediately on request (e.g. abuse), which would need a separate revoke event.

## ADR-007 — Reconciliation repairs by replaying through the webhook pipeline

- **Date, status & scope:** 2026-11-12 (de14f79); auto-acknowledge and pending-order expiry added 2026-11-19 (uncommitted). Accepted. Component: `src/payment/reconcile.js`, tables `recon_runs`, `recon_issues`.
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
- **Options considered:** Razorpay test mode only (realistic, but failures cannot be injected); a mock only (full control, but unrealistic); Stripe test mode (similar capabilities; not used — *author: add the reason Razorpay was preferred*); **both Razorpay test mode and a mock**.
- **Decision & rationale:** both. Razorpay proves the adapter against a real sandbox (signatures, retries, refunds). The mock has switches for duplicate, delay, reorder, drop and refund-HTTP-500, re-sends after 5xx (5 s, 15 s, 45 s), and keeps provider-side records for reconciliation.
- **Consequences & trade-offs:** + every failure mode in M2/M8 is reproducible; + no credentials are needed for the main demo. − The mock is extra code to maintain; − Razorpay test mode accepts only domestic test cards (5267 3181 8797 5449) and does not support card mandates (ADR-014).
- **Evidence & validation:** README "Failure switches"; E2E W1–W4, A20; `npm run verify:failures` (duplicate and delay automated).
- **Revisit trigger:** adding a provider whose sandbox supports failure injection, making the mock unnecessary.

## ADR-009 — Subscriptions as stacked paid periods with manual renewal

- **Date, status & scope:** 2026-11-12 (03c9938); refund and renewal rules revised 2026-11-20 (uncommitted). Accepted. Component: `src/services/subscriptions.js`.
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

- **Date, status & scope:** 2026-11-15 (first version), hardened 2026-11-19 (7dd197d and uncommitted). Accepted. Components: `src/services/agentPurchase.js`, `src/services/agentKeys.js`, tables `purchase_intents`, `intent_events`, `agent_keys`.
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

- **Date, status & scope:** 2026-11-19 (uncommitted at the time of writing). Accepted. Components: `src/services/assistant.js`, `src/routes/agent.js`, tables `assistant_messages`, `assistant_log`.
- **Context & drivers:** the agent flow needs a real agent for the demo, but a language model can be wrong, rate-limited or prompt-injected.
- **Options considered:** a scripted "simulated agent" (deterministic, but not a real agent; built first, then removed 2026-11-19); a hosted model with full API access (convenient, unsafe); **a hosted model limited to a small set of server-side tools, with every safety rule enforced by the server**.
- **Decision & rationale:** the last option. Groq's OpenAI-compatible API (`openai/gpt-oss-120b`; Gemini or any compatible endpoint as fallback). Tools: `list_courses`, `list_my_requests`, `propose_purchase`, `check_request`, `execute_purchase`; **there is no approve tool**. Purchase cards are drawn by the server from the database state, not from model text. Guardrails: 30 messages per user per day, 6 model calls per message, 1000 characters, argument validation, and course text treated as data. Every turn is written to the append-only `assistant_log`.
- **Consequences & trade-offs:** + a misbehaving model can at most propose; + full audit of every turn. − Depends on an external API with free-tier rate limits; − user messages and the course list are sent to the model provider; − model output sometimes needs cleaning (zero-width characters, leaked planning).
- **Evidence & validation:** `verify-assistant.js` (25 checks, fake model); E2E A5 (prompt injection refused), A13/A35/A36 (rate limits), D9/D13.
- **Revisit trigger:** a change in the provider's rate limits or terms, or a requirement to keep chat data on-premises (use a local model through `LLM_BASE_URL`).

## ADR-014 — Agent pays through checkout; saved-card mandates removed

- **Date, status & scope:** tried and removed 2026-11-19 (not committed). Accepted. Component: agent payment step.
- **Context & drivers:** for a fully agent-completed purchase, the agent would ideally charge a saved card with no checkout page.
- **Options considered:** **Razorpay card mandate** (registration link + server-side recurring payment): built; **checkout per purchase** for the approved amount: the existing path.
- **Decision & rationale:** checkout per purchase. The mandate path was built and removed the same day because card mandates do not work on the Razorpay test account (the domestic recurring test card failed with `SERVER_ERROR`, international cards are disabled, and the standard test card is not eligible for recurring). The approved amount is fixed in the Razorpay order, so the user still cannot pay a different price.
- **Consequences & trade-offs:** + works in the sandbox; − the user must complete a checkout, so the purchase is not fully autonomous. Unused tables and columns remain (`saved_payment_methods`, `purchase_intents.pay_method`, …) as technical debt.
- **Evidence & validation:** `plan.txt` ("M7 Razorpay saved card … TRIED, REMOVED"); README "Choosing the provider".
- **Revisit trigger:** Razorpay enabling card mandates on the test account.

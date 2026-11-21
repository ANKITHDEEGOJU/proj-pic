# Architecture Decision Records

**LEARNX** - provider-neutral payments, subscriptions, entitlements and agent-mediated commerce
CS5903 - Project 7 - Group 46 - Ankith Deegoju

> **About this log.** One record per important design or methodology decision, in the template of the
> submission guide (Section 3). The work ran from 1 October to 21 November 2026. **Started** is when work
> on the component first began and **Decided** is when the recorded decision was made, both taken from the
> commits. Log written 2026-11-20, restructured 2026-11-21 (routine code edits removed, related decisions
> merged; a merged decision appears as a dated **Revised** note inside the record that absorbed it).
>
> **How to read a record.** The small table under each title is the template's *Date, status & scope* (Started, Decided, Status, Scope);
> then come *Context & decision drivers*, *Options considered*, *Decision & rationale*, *Consequences &
> trade-offs*, *Evidence & validation* and *Revisit trigger*. In the rationale, *measured* marks a
> result from a test or run, and *judgment* marks a choice.

## Index

| ADR | Decision | Started | Status | Milestones |
|---|---|---|---|---|
| **Methodology** | | | | |
| [000](#adr-000---methodology-reaffirmation-9-october-2026) | Methodology reaffirmation (9 October 2026) | 2026-10-01 | Reaffirmed | All |
| [021](#adr-021---evaluate-against-two-baselines-naive-and-careful) | Evaluate against two baselines: naive and careful | 2026-11-20 | Accepted | Evaluation |
| **Core architecture** | | | | |
| [001](#adr-001---payment-providers-behind-an-adapter-contract) | Payment providers behind an adapter contract | 2026-10-03 | Accepted | M1, M2 |
| [002](#adr-002---an-append-only-ledger-in-postgresql-is-the-source-of-truth-for-access) | An append-only ledger in PostgreSQL is the source of truth for access | 2026-10-02 | Accepted | M1, M3 |
| [007](#adr-007---sandbox-providers-razorpay-test-mode-and-a-mock-with-failure-switches) | Sandbox providers: Razorpay test mode and a mock with failure switches | 2026-10-03 | Accepted | M2, M8 |
| **Webhooks, refunds and reconciliation** | | | | |
| [003](#adr-003---webhook-inbox-deduplicated-by-provider-event-id) | Webhook inbox, deduplicated by provider event id | 2026-10-03 | Accepted | M2 |
| [004](#adr-004---background-retries-with-backoff-and-a-dead-state) | Background retries with backoff and a DEAD state | 2026-10-03 | Accepted | M2, M8 |
| [005](#adr-005---a-refund-ends-access-only-when-the-provider-confirms-it) | A refund ends access only when the provider confirms it | 2026-10-02 | Accepted | M1, M6 |
| [006](#adr-006---reconciliation-repairs-by-replaying-through-the-webhook-pipeline) | Reconciliation repairs by replaying through the webhook pipeline | 2026-10-03 | Accepted | M6 |
| [017](#adr-017---a-payment-grants-access-only-if-it-matches-an-order-of-that-user) | A payment grants access only if it matches an order of that user | 2026-11-11 | Accepted | M2, M6 |
| [024](#adr-024---a-refund-whose-webhook-is-late-is-confirmed-with-the-provider) | A refund whose webhook is late is confirmed with the provider | 2026-11-12 | Accepted | M2, M6 |
| **Commercial rules** | | | | |
| [008](#adr-008---the-pass-is-a-stack-of-paid-periods-renewed-by-hand) | The pass is a stack of paid periods, renewed by hand | 2026-11-07 | Accepted | M4, M6 |
| [009](#adr-009---enterprise-seats-are-counted-from-the-ledger) | Enterprise seats are counted from the ledger | 2026-11-11 | Accepted | M4 |
| [010](#adr-010---usage-quotas-with-one-atomic-update-and-request-keys) | Usage quotas with one atomic update and request keys | 2026-11-14 | Accepted | M5 |
| [015](#adr-015---one-order-per-checkout-click-one-grant-per-admin-form) | One order per checkout click; one grant per admin form | 2026-11-07 | Accepted | M2, M4 |
| [020](#adr-020---limit-how-many-seat-requests-hold-a-database-connection) | Limit how many seat requests hold a database connection | 2026-11-12 | **Proposed** | M4 |
| [023](#adr-023---organizations-are-requested-by-a-learner-and-approved-by-the-admin) | Organizations are requested by a learner and approved by the admin | 2026-11-12 | Accepted | M3, M4 |
| **Agent purchases** | | | | |
| [011](#adr-011---ap2-inspired-signed-one-time-approval) | AP2-inspired signed one-time approval | 2026-11-15 | Accepted | M7 |
| [012](#adr-012---the-llm-assistant-is-an-untrusted-agent-with-no-approve-tool) | The LLM assistant is an untrusted agent with no approve tool | 2026-11-19 | Accepted | M7 |
| [013](#adr-013---the-agent-pays-through-checkout-not-a-saved-card) | The agent pays through checkout, not a saved card | 2026-11-19 | Accepted | M7 |
| [014](#adr-014---an-append-only-assistant-log-for-the-admin) | An append-only assistant log for the admin | 2026-11-19 | Accepted | M8 |
| [019](#adr-019---coupons-on-agent-purchases-are-fixed-in-the-approval) | Coupons on agent purchases are fixed in the approval | 2026-11-07 | Accepted | M4, M7 |
| **Access, content and security** | | | | |
| [016](#adr-016---course-guides-open-only-with-access-checked-on-every-request) | Course guides open only with access, checked on every request | 2026-10-02 | Accepted | M3, M8 |
| [018](#adr-018---security-hardening-secrets-password-limits-and-generic-errors) | Security hardening: secrets, password limits and generic errors | 2026-11-07 | Accepted | Security |
| [022](#adr-022---the-admin-uses-only-the-admin-pages-and-does-not-shop) | The admin uses only the admin pages and does not shop | 2026-11-07 | Accepted | M3, security |

Statuses: **Reaffirmed** (methodology kept), **Accepted** (in the code), **Proposed** (written and tested,
not in the submitted code).

---

# Records

## ADR-000 - Methodology reaffirmation (9 October 2026)

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-01 (2a1f4c3, Phase 0) | 2026-10-01 (2a1f4c3); reaffirmed by 9 Oct 2026; documented 2026-11-20 (not backdated) | **Reaffirmed** (not changed) | Whole project, M1–M8 |

**Context & decision drivers.** The brief asks for payments, subscriptions and entitlements that stay
correct whatever the provider does (duplicate, late, reordered or lost events), with access explainable
from history and agent purchases kept outside the core. The mentor's guidance was to go slowly, break
the system into components and understand the flow of the application before adding features.

**Options considered.**
1. Access flags updated directly by each webhook: simple, but no history and unsafe under duplicates and races.
2. A payment-orchestration product (e.g. Hyperswitch) in front of the providers, plus flags: provider-neutral, but heavy to run and still no entitlements.
3. **Our own provider-neutral core: orders, an append-only ledger, a projection and a decision engine**, with providers behind adapters.

**Decision & rationale.** Option 3, on Node.js (Express), PostgreSQL and server-rendered HTML with htmx
(no front-end build step). Provider neutrality and access from history are what the brief asks for
(M1–M3), so they had to be the core, not an add-on. PostgreSQL enforces idempotency and append-only rules
in the database itself (ADR-002). Following the mentor's advice, the work went one component at a time:
ledger → projection → decision, then adapters and webhooks, then commercial rules, reconciliation and
finally agent purchases (M1 → M8).

**Consequences & trade-offs.**
- **Gains:** every later milestone plugged into the same core (adapters feed the ledger; seats, passes, refunds and agent purchases are events; access is always computed), so the core was never rewritten.
- **Costs:** more code than option 1; one app instance only (in-memory projection).

**Evidence & validation.** Before 9 Oct: Phase 0 setup (2a1f4c3, 1 Oct); ledger → projection →
entitlement engine with mock checkout and refund (f379e0d, 2 Oct); ledger in PostgreSQL (e50d72d, 2 Oct);
mock webhooks with `webhook_inbox` (7e58a48, 3 Oct). After 9 Oct the same architecture was extended, not
replaced: Razorpay test mode through the existing adapter contract (a3504b5, 27 Oct), then M2–M7
(12–20 Nov). The baseline comparison (ADR-021) measures option 1 against option 3: a naive version of
option 1 was wrong in 7 of 7 failure workloads, a careful version in 2, option 3 in none.

**Revisit trigger.** A requirement the event model can't express (e.g. usage-based billing with millions
of events per user), or a need for several instances that the in-memory projection can't support.

---

## ADR-001 - Payment providers behind an adapter contract

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-03 (7e58a48) | 2026-10-03 (7e58a48); extended for reconciliation 2026-11-12 (de14f79) | Accepted | M1, M2 - `src/payment/`, `src/routes/webhooks.js` |

**Context & decision drivers.** The brief requires that the core must not depend on any one payment
provider. Providers differ in payloads, signatures, event names and refund APIs. Drivers: provider
independence, testing with a mock, adding a provider without touching access logic.

**Options considered.**
1. Call the provider SDK directly from routes: fastest, but ties business logic to one provider.
2. A payment-orchestration product (e.g. Hyperswitch): provider-neutral, but heavy and still needs custom entitlements.
3. **Our own adapter contract** that turns every provider's events into one internal `CommerceEvent`.

**Decision & rationale.** Option 3. `src/payment/adapter.js` defines `createPayment`,
`verifyWebhook(rawBody, headers)`, `extractEventId`, `normalize`, `refund` and the reads used by
reconciliation (`listTransactions`, `fetchPayment`, `listRefunds`, `fetchRefunds`, `recoveryEvent`).
The domain never imports an adapter. *Measured:* Razorpay was added later (a3504b5) without changing
`src/domain`. *Judgment:* the contract is small enough for this project.

**Consequences & trade-offs.**
- **Gains:** a new provider is one new file; the mock runs the same path as Razorpay.
- **Costs:** features without a common equivalent (e.g. card mandates, ADR-013) don't fit; two adapters to keep in step.

**Evidence & validation.** `src/payment/adapters/razorpay.js`, `mock.js`; no provider imports in
`src/domain/`; end-to-end runs on both providers (`docs/E2E-TESTS.md`).

**Revisit trigger.** A provider whose events can't be expressed as a `CommerceEvent` without
provider-specific fields in the domain.

---

## ADR-002 - An append-only ledger in PostgreSQL is the source of truth for access

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-02 (f379e0d) | 2026-10-02 (f379e0d; PostgreSQL e50d72d) | Accepted | M1, M3 - `src/domain/`, `commerce_ledger` |

**Context & decision drivers.** M3 requires access to come from auditable history, not toggled flags.
Refunds, chargebacks, revokes, seats and expiry must be explainable ("why does this user have access?").
The history must survive restarts and stay unique under concurrent requests.

**Options considered.**
1. Mutable `has_access` flags: simple, but no history and easy to corrupt with duplicate or reordered events.
2. Flags plus an audit table: history exists but can drift from the flags.
3. **An event ledger and a projection**: append events, compute access from them. Store: in memory (fast, lost on restart), a document store (weaker constraints) or **PostgreSQL** (transactions, unique indexes, triggers).

**Decision & rationale.** Option 3 in PostgreSQL, behind a store interface so the same domain code also
runs in memory for a quick test. Events: PURCHASE, SUBSCRIPTION_STARTED/RENEWED/CANCELLED,
MANUAL_GRANT/REVOKE, REFUND, CHARGEBACK, SEAT_ASSIGNED/UNASSIGNED, each with source, actor and reason. A
reversal must name the event it undoes, at most once (code check and a unique index). A trigger blocks
UPDATE and DELETE. The decision function returns a reason code (`ACTIVE_PURCHASE`, `PURCHASE_REFUNDED`,
`SUBSCRIPTION_EXPIRED`, …).

> **Revised 2026-10-02:** the first version kept the ledger in memory; it moved to PostgreSQL the same
> day (e50d72d). The in-memory store remains only for the fast test.

**Consequences & trade-offs.**
- **Gains:** a full audit trail; expiry needs no event; the projection rebuilds the same way every time; uniqueness is enforced by the database too.
- **Costs:** mistakes can only be reversed, not edited; test users stay in the ledger; the projection is rebuilt at startup, which gets slow on a very large ledger.

**Evidence & validation.** `test/verify-domain-memory.js` and `test/verify-domain-pg.js` (concurrent
duplicate ids, one reversal under a refund/chargeback race, append-only triggers); Access and Activity
pages.

**Revisit trigger.** Startup rebuild taking more than about 10 s (would call for snapshots), or a
deployment without PostgreSQL.

---

## ADR-003 - Webhook inbox, deduplicated by provider event id

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-03 (7e58a48) | 2026-10-03 (7e58a48) | Accepted | M2 - `src/routes/webhooks.js`, `src/payment/webhookProcessor.js`, `webhook_inbox` |

**Context & decision drivers.** Providers deliver webhooks at least once, late and possibly out of order
(M2). Handling a delivery twice must not duplicate money or access.

**Options considered.**
1. Process each delivery directly and rely on application checks: races under concurrent duplicates.
2. An in-memory dedup cache: lost on restart.
3. **Save every delivery first, keyed by `(provider, provider_event_id)`, then process it.**

**Decision & rationale.** Option 3. The signature is checked on the raw body before parsing; the row is
inserted with a unique key; a duplicate is ignored; the ledger's unique event id is a second guard. A
refund that arrives before its purchase gets HTTP 503, so the provider sends it again.

**Consequences & trade-offs.**
- **Gains:** exactly-once effect on at-least-once delivery; every delivery is visible on `/admin/reconciliation`.
- **Costs:** the inbox grows without limit (no retention yet).

**Evidence & validation.** E2E W1 (3 copies sent, 1 ledger row); `test/verify-m2-m6.js` (refund before
purchase applied once); evaluation S1.

**Revisit trigger.** Inbox size slowing the admin page, or a provider without stable event ids.

---

## ADR-004 - Background retries with backoff and a DEAD state

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-03 (7e58a48, inbox) | 2026-11-12 (de14f79) | Accepted | M2, M8 - `src/payment/retryWorker.js` |

**Context & decision drivers.** A webhook can fail for a passing reason (database hiccup, purchase not
there yet). Relying only on the provider re-sending gives no control or visibility.

**Options considered.**
1. Provider re-delivery only.
2. Retry at a fixed interval.
3. **Exponential backoff with a cap and a final state.**

**Decision & rationale.** Option 3. Failed inbox rows are retried at 30 s, 60 s, 120 s … up to 1 h, and
marked `DEAD` after 8 attempts; an admin can retry a row by hand; DEAD rows are escalated by
reconciliation.

**Consequences & trade-offs.**
- **Gains:** passing failures heal on their own; permanent ones become visible instead of looping.
- **Costs:** assumes one app instance runs the worker.

**Evidence & validation.** `test/verify-m2-m6.js` (backoff 30 s … 1920 s, DEAD after 8 attempts).

**Revisit trigger.** Running more than one instance (needs row locking or a leader).

---

## ADR-005 - A refund ends access only when the provider confirms it

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-02 (f379e0d, mock refund) | 2026-11-12 (b020c80) | Accepted | M1, M6 - refund routes, `webhookProcessor.js`, `src/services/refunds.js` |

**Context & decision drivers.** A refund request can be accepted by the provider and still fail later
(`refund.failed`). Removing access at request time could leave a user with neither access nor money.

**Options considered.**
1. Remove access when the refund API call succeeds: immediate, but wrong if the refund later fails.
2. **Keep access until the provider confirms by webhook** ("Refund pending").

**Decision & rationale.** Option 2. The order becomes `REFUND_PENDING`; the ledger `REFUND` is appended
only when the refund webhook arrives; a later `refund.failed` marks the order `REFUND_FAILED` for the
admin. A refund covers the whole order for the amount actually paid (after coupons). All refunds are
requested in one place (`refunds.js`).

**Consequences & trade-offs.**
- **Gains:** money and access always agree; a lost refund webhook is repaired (ADR-006, ADR-024).
- **Costs:** access continues for a short time after the request (usually 3–76 s with Razorpay).

**Evidence & validation.** `test/verify-m2-m6.js`; E2E section 3 and R1, RC2, RS2, P6.

**Revisit trigger.** A need to end access at once on request (e.g. abuse), which would need a separate
revoke event.

---

## ADR-006 - Reconciliation repairs by replaying through the webhook pipeline

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-03 (7e58a48, inbox) | 2026-11-12 (de14f79); revised 2026-11-19 (4cc86c0) and 2026-11-20 (1c53ec8) | Accepted | M6 - `src/payment/reconcile.js`, `recon_runs`, `recon_issues` |

**Context & decision drivers.** M6 requires finding disagreements between the provider and our records,
then repairing or escalating them safely. Webhooks can be lost entirely.

**Options considered.**
1. Write to the ledger directly when a mismatch is found: a second write path with its own bugs.
2. Report only, and let an admin fix everything by hand.
3. **Replay the missing provider event through the normal webhook pipeline**, and escalate only what can't be repaired.

**Decision & rationale.** Option 3. Every 15 minutes (and on demand) each provider's payments and refunds
are compared with the ledger, after a 120 s grace period. Lost payment and refund webhooks and stuck
`REFUND_PENDING` orders are replayed; amount mismatches, unknown payments, failed refunds and DEAD
webhooks become issues (one open issue per kind and reference). A resolved issue stays resolved.

> **Revised 2026-11-19:** issues that disappear are acknowledged automatically, and old pending orders
> expire. **Revised 2026-11-20:** after ADR-017, a replayed payment that the processor refuses was still
> counted as "fixed"; it now opens a `PAYMENT_REFUSED` issue instead, so nothing is hidden.

**Consequences & trade-offs.**
- **Gains:** one write path, so repairs keep every idempotency guarantee; running twice changes nothing; honest repair counts.
- **Costs:** depends on the providers' list APIs (the mock keeps its own records for this); more items for the admin.

**Evidence & validation.** E2E W2 (dropped webhook fixed as `MISSING_PURCHASE`, rerun changes nothing);
final reconciliation of 57 mock and 22 Razorpay payments with 0 open issues; `test/verify-m2-m6.js`
(54.00 paid for 55.00: `AMOUNT_MISMATCH` + `PAYMENT_REFUSED`, no access); evaluation S3.

**Revisit trigger.** A provider without list or fetch APIs, or runs taking longer than their interval.

---

## ADR-007 - Sandbox providers: Razorpay test mode and a mock with failure switches

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-03 (7e58a48) | Mock 2026-10-03 (7e58a48); Razorpay 2026-10-27 (a3504b5); failure switches 2026-11-14 | Accepted | M2, M8 - `mock-provider/`, `src/payment/adapters/` |

**Context & decision drivers.** The brief allows only sandboxes or local mocks (no real money). M8 needs
provider failures on demand, which a real sandbox can't do.

**Options considered.**
1. Razorpay test mode only: realistic, but failures can't be injected.
2. A mock only: full control, but not realistic.
3. Stripe test mode: similar, but no Stripe account could be started at no cost, while Razorpay gave a free test account at once.
4. **Razorpay test mode and a mock.**

**Decision & rationale.** Option 4. Razorpay proves the adapter against a real sandbox (signatures,
retries, refunds). The mock has switches for duplicate, delay, reorder, drop and refund-API-500,
re-sends after a 5xx (5 s, 15 s, 45 s), and keeps its own payment records for reconciliation.

**Consequences & trade-offs.**
- **Gains:** every failure mode in M2 and M8 can be reproduced; the main demo needs no account.
- **Costs:** the mock is extra code; Razorpay test mode accepts only domestic test cards and has no card mandates (ADR-013).

**Evidence & validation.** README "Failure switches"; `npm run verify:failures` (duplicate, delay, drop
payment, drop refund, reorder, refund-500: 6/6); E2E section 4.

**Revisit trigger.** A provider whose sandbox can inject failures, making the mock unnecessary.

---

## ADR-008 - The pass is a stack of paid periods, renewed by hand

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-07 (d721958, first pass) | 2026-11-12 (03c9938); revised 2026-11-20 (4cc86c0) | Accepted | M4, M6 - `src/services/subscriptions.js` |

**Context & decision drivers.** M4 needs a subscription lifecycle with clear rules for conflicts and
expiry. Automatic recurring debit isn't available in the sandbox (ADR-013).

**Options considered.**
1. One subscription row with a changing end date: simple, but no history and refunds are unclear.
2. Provider-managed subscriptions: need card mandates, not available.
3. **Each paid period is its own ledger-backed period, stacked after the current one; renewal is a normal checkout.**

**Decision & rationale.** Option 3. Renewing while active starts the next period at the current end
(`SUBSCRIPTION_RENEWED`). Expiry is computed from the period's end, so no scheduled job is needed.

> **Revised 2026-11-20:** users could stack several renewals, and Refund removed only the latest period.
> Now there is one renewal at a time (Renew is hidden and refused while one is queued, being paid or
> refunded); **Cancel renewal** refunds a renewal already paid in full; **Refund** refunds every paid
> period of the pass (one provider refund per payment) and, once all are confirmed, ends the pass's
> admin or scholarship periods (`MANUAL_REVOKE`, source SYSTEM). Chosen by the owner over refunding only
> the latest period.

**Consequences & trade-offs.**
- **Gains:** every period can be audited and refunded; no stacked renewals and no partial-refund surprises.
- **Costs:** renewal is manual; a full refund means several provider refunds, and access stays until the last is confirmed.

**Evidence & validation.** `test/verify-m4.js` (renew, cancel-renewal refund, full refund, a refused
part, scholarship ended); E2E section 10 (P1–P7).

**Revisit trigger.** A sandbox with recurring mandates, or a pro-rata refund policy.

---

## ADR-009 - Enterprise seats are counted from the ledger

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-11 (4175692, schema) | 2026-11-12 (03c9938) | Accepted | M4 - `src/services/seats.js`, `src/routes/org.js`, `org_seat_pools` |

**Context & decision drivers.** M4 requires assigning and reassigning seats without ever going over the
number bought, also when two people assign at once.

**Options considered.**
1. A `seats_used` counter column: fast, but can drift from who actually has access.
2. **Count seats in use from `SEAT_ASSIGNED` / `SEAT_UNASSIGNED` ledger events, inside a transaction under a lock.**

**Decision & rationale.** Option 2, so the count and the access decisions come from the same history.
Reassign is one step (unassign + assign). Refunding or charging back a pack unassigns every seat. Buying
seats gives the buyer no access by itself. Who may buy and assign is decided in ADR-023.

**Consequences & trade-offs.**
- **Gains:** seats and access never drift; two people can't take the last seat at once.
- **Costs:** each assignment waits for the pack's lock (see ADR-020 for the limit this hits).

**Evidence & validation.** `test/verify-m4.js` (concurrent last seat, reassign, pack refund); evaluation
S6 (naive baseline put 6 members in a 1-seat pack; LEARNX exactly 1).

**Revisit trigger.** Seat packs that cover several courses.

---

## ADR-010 - Usage quotas with one atomic update and request keys

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-14 (7d1b6d3) | 2026-11-14 (7d1b6d3) | Accepted | M5 - `src/services/quotas.js`, `usage_counters`, `usage_events` |

**Context & decision drivers.** M5 requires per-user or pooled limits on a premium feature that hold
under concurrent requests; a retry must not use a credit twice.

**Options considered.**
1. Read, then write, in application code: races.
2. An in-memory rate limiter: lost on restart.
3. Redis: an extra service.
4. **One conditional atomic UPDATE in PostgreSQL plus a unique request key.**

**Decision & rationale.** Option 4. One row per user or organization per day; the increment succeeds only
while under the limit; each request has a unique key, so a retry counts once; a failed operation gives
its credit back once. HTTP 429 with `Retry-After`. The same code limits assistant messages and agent
proposals.

**Consequences & trade-offs.**
- **Gains:** correct under concurrency with no new infrastructure; reused for the assistant.
- **Costs:** daily windows only (reset 00:00 UTC); no admin view of usage yet.

**Evidence & validation.** `test/verify-m5.js` (25 parallel requests against a limit of 7 → exactly 7);
evaluation S5.

**Revisit trigger.** A need for sliding windows or per-second limits.

---

## ADR-011 - AP2-inspired signed one-time approval

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-15 | 2026-11-15; hardened 2026-11-19 (7dd197d, 4cc86c0); revised 2026-11-20 (1c53ec8) | Accepted | M7 - `src/services/agentPurchase.js`, `purchase_intents`, `intent_events`, `agent_keys` |

**Context & decision drivers.** M7 requires a sandbox flow where an agent proposes, the user explicitly
approves, the approved item, merchant and amount are kept, and tampered, replayed, expired or cancelled
approvals are refused. The brief makes an AP2-style adapter optional and forbids tying the ledger to it.

**Options considered.**
1. Full AP2 (mandates as verifiable credentials): closest to the standard, but needs a wallet and payment network that don't exist in a sandbox.
2. Trust the agent's request with no approval: fails M7.
3. **AP2-inspired: the server fixes item, merchant and price from the catalog; the user approves; the server issues a signed, short-lived, one-time token.**

**Decision & rationale.** Option 3. The token (HMAC-signed JWT) holds request, user, agent, item,
merchant, amount, currency and a nonce, and is valid for 5 minutes. It is never shown in the browser or
sent to the model. Execution is refused for `TAMPERED`, `EXPIRED`, `WRONG_INTENT/USER/AGENT`, `MISMATCH`,
`PRICE_CHANGED`, `CANCELLED`, `NOT_APPROVED`, `ALREADY_OWNED` and `REPLAYED` (only one
`APPROVED → EXECUTED` update can win). Above 30.00 the user re-enters their password. Payment then goes
through the normal checkout, so the ledger records an ordinary purchase.

> **Revised 2026-11-20:** with coupons (ADR-019) the price can change while a request waits, and a race
> let a higher amount be approved without the password. Now every Approve form sends the amount the
> user saw, and one UPDATE checks both that amount and the password rule.

**Consequences & trade-offs.**
- **Gains:** every M7 property with no new infrastructure; the ledger knows nothing about agents.
- **Costs:** not interoperable with AP2; only this server can verify approvals (HMAC); browser password autofill can weaken the password step; an old open form must be reloaded.

**Evidence & validation.** `test/verify-m7.js` (3 replays at once → exactly one wins);
`test/verify-agent-coupons.js` (stale card, password race); evaluation S7.

**Revisit trigger.** AP2 tooling usable in a sandbox, or a third party needing to verify approvals
(user-held keys).

---

## ADR-012 - The LLM assistant is an untrusted agent with no approve tool

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-19 (7dd197d) | 2026-11-19 (4cc86c0) | Accepted | M7 - `src/services/assistant.js`, `src/routes/agent.js` |

**Context & decision drivers.** The agent flow needs a real agent, but a language model can be wrong,
rate-limited or prompt-injected.

**Options considered.**
1. A scripted "simulated agent": predictable, but not a real agent (built first, removed 2026-11-19).
2. A hosted model with full API access: convenient, unsafe.
3. **A hosted model limited to a few server-side tools, with every safety rule enforced by the server.**

**Decision & rationale.** Option 3, on Groq (`openai/gpt-oss-120b`). Tools: `list_courses`,
`list_my_requests`, `propose_purchase`, `check_request`, `execute_purchase`; **there is no approve
tool**. Purchase cards are drawn by the server from the database, not from model text. Limits: 30
messages per user per day, 6 model calls per message, 1000 characters; course text is treated as data. A
turn that fails before a payment starts stores nothing and withdraws its half-made request.

**Consequences & trade-offs.**
- **Gains:** a misbehaving model can at most propose; every turn is logged (ADR-014).
- **Costs:** depends on Groq's free-tier limits; messages and the course list go to Groq; model output sometimes needs cleaning.

**Evidence & validation.** `test/verify-assistant.js` (fake model: tools, limits, failures, cleaning);
E2E A5 (prompt injection refused) and section 14 (coupon purchase with the real model).

**Revisit trigger.** A change in Groq's limits or terms, or a need to keep chat data on our own servers.

---

## ADR-013 - The agent pays through checkout, not a saved card

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-19 (7dd197d) | Tried and removed 2026-11-19 (4cc86c0) | Accepted | M7 - agent payment step |

**Context & decision drivers.** A fully agent-completed purchase would charge a saved card with no
checkout page.

**Options considered.**
1. Razorpay card mandate (registration link + server-side recurring charge): built.
2. **A checkout for each purchase, for the approved amount.**

**Decision & rationale.** Option 2. The mandate path was built and removed the same day: card mandates
don't work on the Razorpay test account (the recurring test card failed with `SERVER_ERROR`;
international cards are disabled). The approved amount is fixed in the Razorpay order, so the user still
can't pay a different price.

**Consequences & trade-offs.**
- **Gains:** works in the sandbox.
- **Costs:** the user completes a checkout, so the purchase is not fully autonomous. The unused table and columns it left were dropped on 2026-11-21 (`db/schema.sql`).

**Evidence & validation.** `plan.txt` ("M7 Razorpay saved card … tried, removed"); README "Choosing the
provider".

**Revisit trigger.** Razorpay enabling card mandates on the test account.

---

## ADR-014 - An append-only assistant log for the admin

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-19 (7dd197d, agent audit) | 2026-11-20 (4cc86c0) | Accepted | M8 - `assistant_log`, `/admin/assistant` |

**Context & decision drivers.** The chat history is the model's memory: users can clear it, and failed
turns aren't stored, so nothing was left for checking errors, limits, cost or misbehaviour.

**Options considered.**
1. Reuse the chat table.
2. Plain server logs: not searchable, not per user.
3. **A separate append-only table with an admin page.**

**Decision & rationale.** Option 3. One row per turn (message, reply, replaced model text, tools, flags,
model, tokens, duration, error). A trigger blocks UPDATE and DELETE except the hourly purge after
`ASSISTANT_LOG_DAYS` (90). The admin page has 24-hour totals, search, filters and a per-user view.

**Consequences & trade-offs.**
- **Gains:** full monitoring that survives *Clear chat*.
- **Costs:** stores personal messages (admin-only, 90-day limit).

**Evidence & validation.** `test/verify-assistant.js` (log rows, purge, admin-only page); E2E section 9.

**Revisit trigger.** Privacy rules (shorter retention or redaction) or log volume slowing the page.

---

## ADR-015 - One order per checkout click; one grant per admin form

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-07 (d721958, cart) | 2026-11-20 (4cc86c0, f7dcab5) | Accepted | M2, M4 - `src/services/checkoutOnce.js`, checkout, admin grant form |

**Context & decision drivers.** Checking the brief's "all state-changing operations are idempotent" found
two gaps: a double click made two pending orders, and a double-submitted scholarship grant gave two pass
periods.

**Options considered.**
1. Disable the buttons only: client-side, not reliable.
2. Reuse any open pending order of the user: wrong across different carts.
3. **One-time form keys checked on the server.**

**Decision & rationale.** Option 3 (buttons are disabled too). Checkout takes a lock per key, stores the
key on the order and sends a repeat to the stored checkout link. For grants the form key is the ledger
event id, so a repeat is a `DUPLICATE_EVENT`.

**Consequences & trade-offs.**
- **Gains:** exactly one effect per click.
- **Costs:** a hidden key in each form.

**Evidence & validation.** `test/verify-idempotency.js` (3 at once + 1 late → one order, one pack, one
grant).

**Revisit trigger.** A public checkout API (would need an idempotency-key header).

---

## ADR-016 - Course guides open only with access, checked on every request

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-10-02 (f379e0d, access engine) | 2026-11-20 (1c53ec8); revised 2026-11-21 | Accepted | M3, M8 - `src/services/courseDocs.js`, `src/routes/content.js`, `course_docs` |

**Context & decision drivers.** Access was computed correctly, but there was nothing behind it. The owner
asked for the simplest version: one guide per course, added on an admin page, opened only when paid.

**Options considered.**
1. Store "can read" flags at purchase: contradicts M3.
2. Check once at purchase.
3. **Ask the access decision on every request.**

**Decision & rationale.** Option 3, with `Cache-Control: no-store`, no title on refused pages, an escaped
Markdown renderer and an append-only publishing history. An open guide re-checks access and reloads
with the reason when it ends.

> **Revised 2026-11-21:** an admin revoke stayed on screen until a reload. Open guides now re-check every
> 5 s (was 30 s) and when the tab is shown again, and the Courses page re-checks too.

**Consequences & trade-offs.**
- **Gains:** refund, revoke and pass expiry close the guide in time with no extra event.
- **Costs:** a small request every 5 s while a guide or the Courses page is open.

**Evidence & validation.** `test/verify-content.js`; E2E section 12 (closed after a refund and at the
exact pass end), section 13 (30 attacks, 0 leaks), sections 20–21 (revoke with pages open: reload
within 5 s).

**Revisit trigger.** Large media content (would need signed, short-lived URLs), or push updates replacing
the polling.

---

## ADR-017 - A payment grants access only if it matches an order of that user

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-11 (4175692, orders) | 2026-11-20 (1c53ec8) | Accepted | M2, M6 - `src/payment/webhookProcessor.js` |

**Context & decision drivers.** A security test showed that paying 0.01 instead of 50.00 on the mock form
opened the guide (and the ledger even recorded 50.00); a forged message could name products with no
order; a review then showed the currency wasn't compared.

**Options considered.**
1. Trust the provider's amount and let reconciliation report mismatches later.
2. **Refuse at the source.**

**Decision & rationale.** Option 2. A purchase must name one of our orders, owned by the same user, paid
in full and in the order's currency. Otherwise the order is `UNDERPAID` (or `NO_MATCHING_ORDER`) and
nothing is granted; a later full payment completes it.

**Consequences & trade-offs.**
- **Gains:** no access without full payment.
- **Costs:** a genuine partial payment is refused and escalated instead of granted.

**Evidence & validation.** `test/verify-m4.js` (0.01, JPY, no order, another user's order); evaluation S4
(naive baseline wrongly granted 10 per run; careful baseline and LEARNX 0).

**Revisit trigger.** Multi-currency prices or instalment payments.

---

## ADR-018 - Security hardening: secrets, password limits and generic errors

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-07 (d721958, admin routes) | 2026-11-20 (1c53ec8) | Accepted | Security - `src/server.js`, `src/services/rateLimit.js`, `src/errorHandler.js`, `src/routes/commerce.js` |

**Context & decision drivers.** A security test and an independent review found:
- `JWT_SECRET` and `MOCK_WEBHOOK_SECRET` equal to the public example values (forged admin sessions and payments), a default mock secret in the code, and a dev route that let any user write purchases;
- no limits on login, sign-up or the approval password; parallel guesses slipped past counts taken after the password check; behind ngrok every visitor shared one IP;
- SQL and provider error text reaching the browser.

**Options considered.**
1. Document the risks only.
2. Use libraries or services (express-rate-limit, Redis): new dependencies for the same result.
3. **Fix each in the app: rotate and check secrets, a small in-memory limiter, generic errors.**

**Decision & rationale.** Option 3 (owner approved).
- **Secrets:** new 64-hex secrets; startup warns (refuses in production) on example or short secrets; no default mock secret, constant-time compare; dev route only with `ENABLE_DEV_EVENTS=1` and an admin.
- **Password guessing:** limits per email+IP, per email and per IP, counted *before* the password check and cleared on success; only a local proxy is trusted for the client IP; the admin email can't be registered.
- **Errors:** "Server error (ref abc12345)", details only in the server log; checkout failures say "Nothing was charged".

**Consequences & trade-offs.**
- **Gains:** forged sessions and webhooks are refused; guessing and parallel bursts are limited; no internal details leak.
- **Costs:** everyone was signed out once; limiter counters reset on restart and assume one instance; debugging needs the server log.

**Evidence & validation.** `test/verify-security.js` (forged sessions, dev route, mock secret, 10 parallel
guesses → at most 3 checked, generic errors); E2E sections 13 and 15.

**Revisit trigger.** More than one instance (move counters to the database), or a secrets manager and
central logging.

---

## ADR-019 - Coupons on agent purchases are fixed in the approval

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-07 (d721958, coupons) | 2026-11-20 (1c53ec8) | Accepted | M4, M7 - `src/services/agentPurchase.js` (`quote`, `setCoupon`) |

**Context & decision drivers.** Agents always paid the list price; the owner asked for coupons. A coupon
must never change the amount the user approved.

**Options considered.**
1. Apply coupons only at checkout: the paid amount would differ from the approval.
2. **Check the coupon when proposing or on the card, and fix the result in the approval.**

**Decision & rationale.** Option 2, with the cart's coupon rules. Only codes the user typed count; only
the owner can apply or remove one, while the request is still a proposal. The token fixes the list price
and the coupon; execution checks the coupon again; the order records the discount and the rule.

**Consequences & trade-offs.**
- **Gains:** the user always pays exactly what they approved.
- **Costs:** a coupon that ends between approval and payment fails the purchase (`COUPON_INVALID`).

**Evidence & validation.** `test/verify-agent-coupons.js`; E2E section 14 (20.00 → 19.00 with Groq;
ledger 19.00).

**Revisit trigger.** Coupon redemption limits (would need a reservation at approval time).

---

## ADR-020 - Limit how many seat requests hold a database connection

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-12 (03c9938, seats) | 2026-11-20 (found by the evaluation) | **Proposed, not implemented** | M4 - `withPoolLock` in `src/services/seats.js` |

**Context & decision drivers.** A first run of evaluation workload S6 (10 assignments to one pack at once)
froze the whole app. Each assignment holds a database connection while it waits for the pack's lock, and
the one holding the lock needs more connections, which are all taken (pool of 10). The seat count stays
correct; availability does not.

**Options considered.**
1. A bigger pool: only moves the limit.
2. Pass one database client through the ledger store: a larger change to the store API.
3. Queue seat operations in memory and let at most N hold a connection.
4. **Keep the code, document the defect and track it as an issue.**

**Decision & rationale.** Option 4 for this submission (judgment: the final phase allowed no code
changes, and the defect needs an unusual burst). Option 3 is the intended fix: a prototype (N = 4) passed
12 simultaneous assignments with exactly 1 seat taken, and the same test hung without the queue
(measured 2026-11-20).

**Consequences & trade-offs.**
- **Gains:** the submitted code is the code that was tested end to end.
- **Costs:** 10 or more simultaneous assignments to one pack can freeze the app until it is restarted; the evaluation runs S6 with 6.

**Evidence & validation.** The freeze in the first S6 run; `evaluation/README.md` ("Known defect"); the
prototype results above. Tracked as GitHub issue 1 (report Section 9).

**Revisit trigger.** Organizations assigning seats in bulk, or any code that holds a connection while
waiting on a lock.

---

## ADR-021 - Evaluate against two baselines: naive and careful

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-20 | 2026-11-21 | Accepted | Methodology (report Sections 4–5); `evaluation/` |

**Context & decision drivers.** The guide asks for a baseline comparison on declared workloads and
metrics. The first evaluation compared LEARNX with one naive baseline (webhooks flip access flags, no
protections). On review it was too easy to win: its error counts follow directly from the inputs, and a
sensible developer would add deduplication and locks anyway.

**Options considered.**
1. Keep the naive baseline only.
2. Replace it with a stronger one.
3. **Keep the naive baseline and add a careful one** that follows the usual webhook advice (deduplicate by payment id, match amount and currency, race-safe quota, seat and approval updates) but has no event history, retry or reconciliation.
4. Compare with an existing product (Lago, Kill Bill): heavy to run, and not a like-for-like design.

**Decision & rationale.** Option 3. The naive baseline shows what goes wrong with no care at all; the
careful one isolates what LEARNX adds beyond ordinary care (judgment). Measured: the careful baseline
fails only S2 (refund before purchase) and S3 (lost webhooks).

**Consequences & trade-offs.**
- **Gains:** a narrower, defensible claim (ordering and recovery, not "7 of 7").
- **Costs:** the careful baseline's S2 result depends on its choice to ignore an unknown refund (stated in the report); workloads are small and deterministic, and webhooks skip the HTTP route (covered by the test suites instead).

**Evidence & validation.** `evaluation/baseline.js`, `evaluation/baseline-careful.js`,
`evaluation/run-evaluation.js`; `evaluation/results/` (seed 42, 5 runs).

**Revisit trigger.** A new failure mode that the careful baseline also handles (LEARNX's design would
need a new justification), or a move to load testing.

---

## ADR-022 - The admin uses only the admin pages and does not shop

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-07 (d721958, admin panel) | 2026-11-21 | Accepted | M3, security - `src/auth.js`, `src/views.js`, `src/routes/auth.js` |

**Context & decision drivers.** The admin saw the learner's navbar, landed on the course list and could
buy like a learner. An admin purchase puts the admin into the ledger as a customer and muddles the audit
trail; the admin's job is to give access (grants), set prices, reconcile and review the assistant log.

**Options considered.**
1. Keep as is.
2. A separate admin navbar and login to `/admin`, shop links only hidden.
3. **Option 2, plus closing the shop pages to the admin.**
4. A fully separate admin area with its own layout and a per-user access view.

**Decision & rationale.** Option 3. Hidden links (2) still leave the shop reachable by typing an address;
(4) is larger than needed now. The admin navbar lists Dashboard, Users, Pricing, Reconciliation,
Organizations, Guides and Assistant log; login leads to `/admin`; shop pages send the admin back to
`/admin`, and shop actions are refused with 403.

**Consequences & trade-offs.**
- **Gains:** the admin never appears as a customer; a clear admin workspace.
- **Costs:** the admin can't try the shop with that account; a new shop page must be added to the list in `src/auth.js`.

**Evidence & validation.** `test/verify-security.js` ("admin: own navbar … shopper pages → /admin, shopper
actions 403; learners unchanged"), which fails with the check removed.

**Revisit trigger.** A second admin role (e.g. support staff who buy for a user), or the separate admin
area of option 4.

---

## ADR-023 - Organizations are requested by a learner and approved by the admin

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-12 (03c9938, seats) | 2026-11-21 | Accepted (revised the same day) | M3, M4 - `org_requests`, `org_managers`, `src/services/seats.js`, `src/routes/org.js` |

**Context & decision drivers.** Any learner could become the owner of an organization just by buying a
seat pack (one per user, only that buyer could manage it), and a seat holder couldn't see which
organization gave them a course. The owner asked that the admin only approves who may run an
organization; the approved manager gives courses to member emails; members see only the organization
that gave them a course.

**Options considered.**
1. The admin creates each organization and types in its manager emails.
2. **A learner requests an organization; the admin approves or rejects it; the requester becomes its manager.**
3. Keep self-service creation.

For giving courses: seat packs paid by the manager, or free assignment. For members: a normal learner
account, or an organization-only account.

**Decision & rationale.** Option 2, with paid seat packs and members as normal learners (owner's choice).
- **Learner:** sends *Request an organization* with a free name (one open request at a time); sees *Waiting for approval*, or the admin's reason if rejected.
- **Admin:** approves or rejects on **Organizations** (`/admin/orgs`); approval creates the organization with the requester as manager in one transaction (two clicks create one). After that the admin only looks: no seat actions or refunds.
- **Manager:** buys seat packs and assigns, unassigns, reassigns and refunds.
- **Seat holder:** sees *Your organization seats* (organization, course, since), read from the ledger, and nothing to manage.

Decided requests stay in `org_requests` (who, when, reason) as the audit trail; older organizations keep
their buyer as manager.

> **Revised 2026-11-21:** option 1 was built first and replaced the same day, because it made the admin
> run organizations, which the owner did not want.

**Consequences & trade-offs.**
- **Gains:** organizations exist only after approval; the admin's work is one click per team; seat holders know where their access comes from.
- **Costs:** a team waits for approval before buying; no co-managers yet, and the admin can't take an organization back.

**Evidence & validation.** `test/verify-m4.js` (request rules, approve, reject with reason, two approvals
at once → one organization, seat holder from the ledger); `test/verify-security.js` (only the admin
approves; fails if that check is removed); live run in E2E sections 19 and 21.

**Revisit trigger.** Co-managers or handing an organization over; withdrawing an approval.

---

## ADR-024 - A refund whose webhook is late is confirmed with the provider

| Started | Decided | Status | Scope |
|---|---|---|---|
| 2026-11-12 (b020c80, refund webhooks) | 2026-11-21 | Accepted | M2, M6 - `src/payment/reconcile.js` (`confirmPendingRefunds`), `src/server.js` |

**Context & decision drivers.** Razorpay refunds kept showing *Refund pending* for a long time. The
refunds were made at Razorpay at once (status `processed`), and the refund webhook usually came about
76 s later (12 refunds on 19–20 Nov), but on 21 Nov it took 15.5 and 5.5 minutes. The ngrok inspector
showed payment webhooks arriving normally: the delay was on Razorpay's side. Because access ends only
when the provider confirms (ADR-005), the customer waited for the late webhook or the next
15-minute reconciliation.

**Options considered.**
1. Keep waiting (up to 15 minutes).
2. Trust the refund API's answer and end access at request time.
3. Run full reconciliation more often.
4. **Check only the pending refunds: after 90 s, ask the provider and, if the refund is there, replay it through the webhook pipeline.**

**Decision & rationale.** Option 4. It keeps the rule that the provider confirms (option 2 ends access
on a request that may still fail, which ADR-005 rejected); option 3 would list every payment of 7 days
every few seconds. The check runs every 30 s (`REFUND_CHECK_INTERVAL_MS`) on orders pending for more than
90 s (`REFUND_CHECK_AFTER_SECONDS`, just after Razorpay's usual 76 s, so a normal webhook still arrives
first). The replay uses the same ids as reconciliation, so the real webhook later is a duplicate. If the
provider has no refund yet, nothing is done.

**Consequences & trade-offs.**
- **Gains:** *Refund pending* lasts about 2 minutes at most when the webhook is late; nothing changes when it is on time.
- **Costs:** one provider call per pending refund every 30 s while it waits.

**Evidence & validation.** `test/verify-m2-m6.js` ("late refund webhook"); live run with the refund
webhook dropped at the mock: order `REFUNDED` after 100 s as `REFUND_CONFIRMED` (E2E sections 18, 21).

**Revisit trigger.** Provider rate limits on refund lookups, or a provider whose refunds stay `pending`
for days.


"use strict";
// M2 (webhook retry) + M6 (reconciliation) checks against Postgres.
// Uses a fake provider ("recontest") built on the Razorpay adapter's normalizer, with
// in-memory provider records: no network calls, and only this script's own users/orders
// are touched. Leaves test rows behind (the ledger is append-only by design).
require("dotenv").config();
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const pool = require("../db");
const { createEngine } = require("../domain");
const { loadProducts } = require("../domain/catalogLoader");
const { PgLedgerStore } = require("../domain/stores/pgLedgerStore");
const { registry } = require("./registry");
const { RazorpayPaymentAdapter } = require("./adapters/razorpay");
const { WebhookProcessor, RETRY } = require("./webhookProcessor");
const { retryDueWebhooks } = require("./retryWorker");
const { Reconciler } = require("./reconcile");

const PROVIDER = "recontest";
const quiet = { log() {}, error: console.error };
const unix = (msAgo = 0) => Math.floor((Date.now() - msAgo) / 1000);
const rid = (p) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

// ---- fake provider -------------------------------------------------------------------
const provider = { payments: new Map(), refunds: new Map() }; // paymentId -> raw, paymentId -> [raw]
class FakeProvider extends RazorpayPaymentAdapter {
  get name() { return PROVIDER; }
  #txn(p) {
    return {
      providerPaymentId: p.id, amount: p.amount / 100, amountMinor: p.amount, currency: p.currency,
      status: p.status, paid: ["captured", "refunded"].includes(p.status), amountRefundedMinor: p.amount_refunded || 0,
      orderRef: p.notes?.orderId || null, occurredAt: new Date(p.created_at * 1000).toISOString(), raw: p,
    };
  }
  // Like Razorpay: the payment LIST is stale about refunds (still "captured", nothing refunded);
  // the refund list and single-payment fetch are current.
  async listTransactions({ since }) {
    return [...provider.payments.values()]
      .filter((p) => p.created_at * 1000 >= new Date(since).getTime())
      .map((p) => this.#txn(p.status === "refunded" ? { ...p, status: "captured", amount_refunded: 0 } : p));
  }
  async listRefunds({ since }) {
    return [...provider.refunds.values()].flat()
      .filter((r) => r.created_at * 1000 >= new Date(since).getTime())
      .map((r) => ({ providerRefundId: r.id, providerPaymentId: r.payment_id, amountMinor: r.amount, status: r.status, raw: r }));
  }
  async fetchPayment(id) { const p = provider.payments.get(id); return p ? this.#txn(p) : null; }
  async fetchRefunds(id) {
    return (provider.refunds.get(id) || []).map((r) => ({ providerRefundId: r.id, amountMinor: r.amount, status: r.status, raw: r }));
  }
}
const fake = new FakeProvider();

// Removes this script's fake-provider rows from the operational tables so they do not show
// up on /admin/reconciliation (ledger rows stay: the ledger is append-only by design).
async function cleanup() {
  await pool.query("DELETE FROM recon_issues WHERE provider=$1 OR last_run_id IN (SELECT id FROM recon_runs WHERE trigger='verify')", [PROVIDER]);
  await pool.query("DELETE FROM recon_runs WHERE trigger='verify'");
  await pool.query("DELETE FROM webhook_inbox WHERE provider=$1", [PROVIDER]);
}
registry[PROVIDER] = fake; // so the retry worker can resolve inbox rows of this provider

(async () => {
  const products = (await loadProducts()).filter((x) => (x.type || "COURSE") === "COURSE");
  const [p1, p2] = products;
  const cents = (p) => Math.round(p.price * 100);
  const engine = createEngine({ products: await loadProducts(), store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { ledger, decisions } = engine;
  const processor = new WebhookProcessor({ ledger });

  const user = (
    await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id", [
      `recon_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])
  ).rows[0].id;

  // An order for p1 + p2 (as the cart creates it) and the provider-side payment for it.
  const newOrder = async ({ status = "PENDING", amountMinor = null, ageMs = 10 * 60e3 } = {}) => {
    const total = cents(p1) + cents(p2);
    const { rows } = await pool.query(
      `INSERT INTO orders (user_id, subtotal_cents, discount_cents, final_payable_cents, provider, status)
       VALUES ($1,$2,0,$2,$3,$4) RETURNING id`,
      [user, total, PROVIDER, status]
    );
    const orderId = rows[0].id;
    for (const p of [p1, p2]) {
      await pool.query(
        `INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, paid_cents)
         VALUES ($1,'COURSE',$2,$3,1,$3)`,
        [orderId, p.id, cents(p)]
      );
    }
    const pay = {
      id: rid("pay"), entity: "payment", amount: amountMinor ?? total, currency: "USD", status: "captured",
      captured: true, amount_refunded: 0, order_id: rid("order"), created_at: unix(ageMs),
      notes: { orderId, orderRef: orderId, userId: user, productId: `${p1.id},${p2.id}` },
    };
    return { orderId, pay };
  };
  const refundOf = (pay, ageMs = 5 * 60e3) => ({
    id: rid("rfnd"), entity: "refund", amount: pay.amount, currency: pay.currency, payment_id: pay.id,
    notes: {}, status: "processed", created_at: unix(ageMs),
  });
  const atProvider = (pay, refund = null) => {
    provider.payments.set(pay.id, pay);
    if (refund) {
      pay.status = "refunded";
      pay.amount_refunded = refund.amount;
      provider.refunds.set(pay.id, [refund]);
    }
  };
  // Stores a webhook in the inbox the way the webhook route does and returns the row.
  const inbox = async (payload, key) =>
    (
      await pool.query(
        `INSERT INTO webhook_inbox (provider, provider_event_id, raw_body) VALUES ($1,$2,$3) RETURNING *`,
        [PROVIDER, key, typeof payload === "string" ? payload : JSON.stringify(payload)]
      )
    ).rows[0];
  const captured = (pay) => ({ event: "payment.captured", payload: { payment: { entity: pay } } });
  const refunded = (pay, r) => ({ event: "refund.created", payload: { refund: { entity: r }, payment: { entity: pay } } });
  const row = async (id) => (await pool.query("SELECT * FROM webhook_inbox WHERE id=$1", [id])).rows[0];
  const orderStatus = async (id) => (await pool.query("SELECT status FROM orders WHERE id=$1", [id])).rows[0].status;
  const access = (pid) => decisions.evaluateAccess(user, pid).reason;
  const due = (id) => pool.query("UPDATE webhook_inbox SET next_retry_at = now() - interval '1 second' WHERE id=$1", [id]);

  // ===================================================================== M2
  {
    // Refund webhook arrives BEFORE the purchase webhook.
    const { orderId, pay } = await newOrder();
    const r = refundOf(pay);
    const early = await inbox(refunded(pay, r), `refund.created:${r.id}`);
    const res1 = await processor.process(early, fake);
    assert.equal(res1.outcome, "FAILED");
    assert.equal(res1.retryable, true, "refund-before-purchase must be retryable (provider gets non-2xx)");
    let st = await row(early.id);
    assert.equal(st.status, "FAILED");
    assert.equal(st.attempts, 1);
    const delay = (new Date(st.next_retry_at) - Date.now()) / 1000;
    assert.ok(delay > RETRY.BASE_SECONDS - 5 && delay <= RETRY.BASE_SECONDS + 1, `first retry after ~${RETRY.BASE_SECONDS}s (got ${delay})`);

    // Not due yet: the worker leaves it alone.
    assert.equal((await retryDueWebhooks({ ledger, ids: [early.id], log: quiet })).length, 0);

    // Purchase arrives, then the worker retries the refund once it is due.
    const buy = await processor.process(await inbox(captured(pay), `payment.captured:${pay.id}`), fake);
    assert.equal(buy.outcome, "APPENDED");
    assert.equal(access(p1.id), "ACTIVE_PURCHASE");
    await due(early.id);
    const [retry] = await retryDueWebhooks({ ledger, ids: [early.id], log: quiet });
    assert.equal(retry.outcome, "APPENDED");
    st = await row(early.id);
    assert.equal(st.status, "PROCESSED");
    assert.equal(st.attempts, 2);
    assert.equal(st.next_retry_at, null);
    assert.equal(st.failure_reason, null);
    assert.equal(await orderStatus(orderId), "REFUNDED");
    assert.equal(access(p1.id), "PURCHASE_REFUNDED");
    assert.equal(access(p2.id), "PURCHASE_REFUNDED");
    console.log("[ok] M2 refund webhook before its purchase: retryable FAILED, retried after backoff, applied once purchase exists");
  }
  {
    // Permanent failure: backoff doubles, then DEAD after MAX_ATTEMPTS.
    const bad = await inbox("{not json", `bad:${randomUUID()}`);
    const delays = [];
    for (let i = 1; i <= RETRY.MAX_ATTEMPTS; i++) {
      const r = await processor.process(await row(bad.id), fake);
      assert.equal(r.outcome, "FAILED");
      assert.equal(r.retryable, false);
      const st = await row(bad.id);
      assert.equal(st.attempts, i);
      if (i < RETRY.MAX_ATTEMPTS) {
        assert.equal(st.status, "FAILED");
        delays.push(Math.round((new Date(st.next_retry_at) - Date.now()) / 1000));
        await due(bad.id);
      } else {
        assert.equal(st.status, "DEAD");
        assert.equal(st.next_retry_at, null);
      }
    }
    for (let i = 1; i < delays.length; i++) {
      const expected = Math.min(RETRY.BASE_SECONDS * 2 ** i, RETRY.MAX_DELAY_SECONDS);
      assert.ok(Math.abs(delays[i] - expected) <= 2, `delay ${i + 1} ≈ ${expected}s (got ${delays[i]})`);
    }
    // DEAD rows are not retried by the worker.
    assert.equal((await retryDueWebhooks({ ledger, ids: [bad.id], log: quiet })).length, 0);
    console.log(`[ok] M2 permanent failure: backoff ${delays.join("s, ")}s, DEAD after ${RETRY.MAX_ATTEMPTS} attempts, not retried`);
    globalThis.deadRowId = bad.id;
  }
  {
    // Two deliveries of the same row at once: only one processes it.
    const { pay } = await newOrder();
    const r0 = await inbox(captured(pay), `payment.captured:${pay.id}`);
    const outs = await Promise.all([processor.process(r0, fake), processor.process(r0, fake)]);
    const outcomes = outs.map((o) => o.outcome).sort();
    assert.equal(outcomes.filter((o) => o === "APPENDED").length, 1, `exactly one attempt appends (${outcomes})`);
    const { rows } = await pool.query("SELECT count(*)::int n FROM commerce_ledger WHERE payment_info->>'providerPaymentId'=$1", [pay.id]);
    assert.equal(rows[0].n, 2);

    // A crashed attempt (PROCESSING, lease expired) is picked up again by the worker.
    const { pay: pay2 } = await newOrder();
    const r1 = await inbox(captured(pay2), `payment.captured:${pay2.id}`);
    await pool.query("UPDATE webhook_inbox SET status='PROCESSING', attempts=1, next_retry_at=now() + interval '1 hour' WHERE id=$1", [r1.id]);
    assert.equal((await processor.process(await row(r1.id), fake)).outcome, "IN_PROGRESS", "live lease blocks a second attempt");
    await due(r1.id);
    const [again] = await retryDueWebhooks({ ledger, ids: [r1.id], log: quiet });
    assert.equal(again.outcome, "APPENDED");
    console.log("[ok] M2 concurrent deliveries process once; an expired PROCESSING lease is retried");
  }

  // ===================================================================== M6
  const recon = new Reconciler({
    ledger, adapters: { [PROVIDER]: fake }, graceSeconds: 0, stuckMinutes: 15, lookbackDays: 7, log: quiet,
  });
  const issuesFor = async (ref, status = "OPEN") =>
    (await pool.query("SELECT kind FROM recon_issues WHERE ref=$1 AND status=$2 ORDER BY kind", [ref, status])).rows.map((r) => r.kind);

  // A: paid at provider, payment webhook lost.
  const A = await newOrder();
  atProvider(A.pay);
  // B: purchase recorded, refund made at provider, refund webhook lost.
  const B = await newOrder();
  const Br = refundOf(B.pay);
  await processor.process(await inbox(captured(B.pay), `payment.captured:${B.pay.id}`), fake);
  atProvider(B.pay, Br);
  // C: provider charged a different amount than the order total (and webhook lost).
  const C = await newOrder({ amountMinor: cents(p1) + cents(p2) - 100 });
  atProvider(C.pay);
  // D: stuck REFUND_PENDING, provider has no refund (refund request never reached it).
  const D = await newOrder();
  await processor.process(await inbox(captured(D.pay), `payment.captured:${D.pay.id}`), fake);
  atProvider(D.pay);
  await pool.query("UPDATE orders SET status='REFUND_PENDING', updated_at=now() - interval '1 hour' WHERE id=$1", [D.orderId]);
  // E: stuck REFUND_PENDING on an old payment (outside the window), provider HAS the refund.
  const E = await newOrder({ ageMs: 30 * 86400e3 });
  const Er = refundOf(E.pay, 8 * 86400e3); // refund also outside the window: only the stuck-order check can find it
  await processor.process(await inbox(captured(E.pay), `payment.captured:${E.pay.id}`), fake);
  atProvider(E.pay, Er);
  await pool.query("UPDATE orders SET status='REFUND_PENDING', updated_at=now() - interval '1 hour' WHERE id=$1", [E.orderId]);
  // K: payment older than the window, refunded inside it, refund webhook lost.
  const K = await newOrder({ ageMs: 30 * 86400e3 });
  const Kr = refundOf(K.pay, 10 * 60e3);
  await processor.process(await inbox(captured(K.pay), `payment.captured:${K.pay.id}`), fake);
  atProvider(K.pay, Kr);
  // F: ledger granted access for a payment the provider shows as failed.
  const F = await newOrder();
  await processor.process(await inbox(captured(F.pay), `payment.captured:${F.pay.id}`), fake);
  atProvider({ ...F.pay, status: "failed", captured: false });
  // G: ledger says refunded (recorded directly), provider has no refund.
  const G = await newOrder();
  await processor.process(await inbox(captured(G.pay), `payment.captured:${G.pay.id}`), fake);
  atProvider(G.pay);
  await ledger.appendEvent({
    eventId: `ref_${randomUUID()}`, eventType: "REFUND", userId: user, productId: p1.id, quantity: 1, amount: p1.price,
    currency: "USD", occurredAt: new Date().toISOString(), referenceeventId: `razorpay:${G.pay.id}:${p1.id}`,
    source: "PAYMENT", actor: "test",
  }, { method: "DIRECT_REFUND" });
  // H: payment for an order we do not have.
  const H = { ...(await newOrder()).pay, id: rid("pay"), notes: { orderId: randomUUID() } };
  atProvider(H);
  // I: refund failed after access was removed.
  const I = await newOrder({ status: "REFUND_FAILED" });

  const run1 = await recon.run({ trigger: "verify" });
  assert.equal(run1.error, null);

  assert.deepEqual(await issuesFor(A.pay.id, "AUTO_FIXED"), ["MISSING_PURCHASE"]);
  assert.equal(await orderStatus(A.orderId), "COMPLETED");
  // (A's purchase replay granted p1/p2 to the same user; check its ledger rows directly.)
  const { rows: aRows } = await pool.query("SELECT event_type FROM commerce_ledger WHERE payment_info->>'providerPaymentId'=$1", [A.pay.id]);
  assert.deepEqual(aRows.map((r) => r.event_type), ["PURCHASE_SUCCEEDED", "PURCHASE_SUCCEEDED"]);

  assert.deepEqual(await issuesFor(Br.id, "AUTO_FIXED"), ["MISSING_REFUND"]);
  assert.equal(await orderStatus(B.orderId), "REFUNDED");

  assert.deepEqual(await issuesFor(Kr.id, "AUTO_FIXED"), ["MISSING_REFUND"], "old payment refunded inside the window");
  assert.equal(await orderStatus(K.orderId), "REFUNDED");

  assert.deepEqual(await issuesFor(C.pay.id), ["AMOUNT_MISMATCH"]);
  assert.deepEqual(await issuesFor(C.pay.id, "AUTO_FIXED"), ["MISSING_PURCHASE"]);

  assert.equal(await orderStatus(D.orderId), "COMPLETED", "stuck pending with no provider refund is reopened");
  assert.equal(run1.fixed.filter((f) => f.kind === "STUCK_REFUND_REOPENED" && f.orderId === D.orderId).length, 1);

  assert.deepEqual(await issuesFor(E.orderId, "AUTO_FIXED"), ["STUCK_REFUND_FINALIZED"]);
  assert.equal(await orderStatus(E.orderId), "REFUNDED");

  assert.deepEqual(await issuesFor(F.pay.id), ["LEDGER_PAYMENT_NOT_AT_PROVIDER"]);
  assert.deepEqual(await issuesFor(G.pay.id), ["REFUNDED_NOT_AT_PROVIDER"]);
  assert.deepEqual(await issuesFor(H.id), ["UNKNOWN_PAYMENT"]);
  assert.deepEqual(await issuesFor(I.orderId), ["REFUND_FAILED"]);
  assert.deepEqual(await issuesFor(String(globalThis.deadRowId)), ["WEBHOOK_DEAD"]);
  console.log("[ok] M6 lost payment + lost refund webhooks replayed (even with a stale payment list, and for old payments refunded in the window); stuck REFUND_PENDING finalized / reopened");
  console.log("[ok] M6 amount mismatch, failed-at-provider purchase, refund-not-at-provider, unknown payment, REFUND_FAILED, DEAD webhook escalated");

  // The real (late) webhook after a replay is a duplicate.
  const late = await processor.process(await inbox(refunded(B.pay, Br), `refund.created:${Br.id}`), fake);
  assert.equal(late.outcome, "DUPLICATE");
  console.log("[ok] M6 the provider's late webhook after a replay is a duplicate");

  // Second run: nothing new is fixed, open issues are updated not duplicated.
  const run2 = await recon.run({ trigger: "verify" });
  assert.equal(run2.fixed.length, 0, `second run fixes nothing (${run2.fixed.map((f) => f.kind)})`);
  const { rows: dup } = await pool.query(
    `SELECT kind, ref, count(*)::int n FROM recon_issues WHERE status='OPEN' AND provider=$1 GROUP BY 1,2 HAVING count(*) > 1`,
    [PROVIDER]
  );
  assert.equal(dup.length, 0);
  console.log("[ok] M6 re-running is idempotent: no new fixes, no duplicate issues");

  // Self-resolving: once the order is no longer REFUND_FAILED, the issue closes itself.
  await pool.query("UPDATE orders SET status='REFUNDED' WHERE id=$1", [I.orderId]);
  await recon.run({ trigger: "verify" });
  assert.deepEqual(await issuesFor(I.orderId), []);
  assert.deepEqual(await issuesFor(I.orderId, "RESOLVED"), ["REFUND_FAILED"]);
  console.log("[ok] M6 an issue that disappears (REFUND_FAILED fixed) is auto-resolved");

  console.log("\nM2/M6 CHECKS PASSED");
  await cleanup();
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

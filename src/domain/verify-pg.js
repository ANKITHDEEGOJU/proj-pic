"use strict";
// Run: npm run verify:pg   (needs DATABASE_URL with schema applied). Leaves test rows behind: the ledger is immutable by design.
require("dotenv").config();
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const pool = require("../db");
const { createEngine } = require("./index");
const { loadProducts } = require("./catalogLoader");
const { PgLedgerStore } = require("./stores/pgLedgerStore");

(async () => {
  const products = await loadProducts(),
    p = products.find((x) => (x.type || "COURSE") === "COURSE"),
    pid = p.id,
    sub = products.find((x) => x.type === "SUBSCRIPTION");
  const newUser = async () =>
    (
      await pool.query(
        `INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id`,
        [`t_${Date.now()}_${randomUUID().slice(0, 8)}@test.local`],
      )
    ).rows[0];
  const u = await newUser();
  const make = () => createEngine({ products, store: new PgLedgerStore(pool) });
  const ev = (o) => ({
    eventId: `evt_${randomUUID()}`,
    eventType: "PURCHASE_SUCCEEDED",
    userId: u.id,
    productId: pid,
    quantity: 1,
    amount: p.price,
    currency: p.currency,
    occurredAt: new Date().toISOString(),
    referenceeventId: null,
    ...o,
  });
  const e1 = make();
  await e1.projection.rebuildFromLedger();
  assert.equal(
    e1.decisions.evaluateAccess(u.id, pid).reason,
    "NO_PURCHASE_RECORD",
  );

  const buy = ev();
  assert.equal(
    (await e1.ledger.appendEvent(buy, { method: "MOCK" })).appended,
    true,
  );
  console.log(
    "[ok] purchase persisted:",
    e1.decisions.evaluateAccess(u.id, pid).reason,
  );
  assert.equal(
    (await e1.ledger.appendEvent(buy, {})).reason,
    "DUPLICATE_EVENT",
  );
  assert.equal(
    (await e1.ledger.appendEvent({ ...buy, amount: 1 }, {})).reason,
    "EVENT_ID_CONFLICT",
  );
  console.log(
    "[ok] duplicate -> no-op, changed payload -> conflict (DB UNIQUE + ON CONFLICT)",
  );
  const [a, b] = await Promise.all([
    e1.ledger.appendEvent(ev({ eventId: "evt_race_" + u.id }), {}),
    e1.ledger.appendEvent(ev({ eventId: "evt_race_" + u.id }), {}),
  ]);
  assert.equal([a, b].filter((x) => x.appended).length, 1);
  console.log("[ok] concurrent same eventId -> exactly one row");

  const refund = ev({ eventType: "REFUND", referenceeventId: buy.eventId });
  await e1.ledger.appendEvent(refund, {});
  await assert.rejects(
    () =>
      e1.ledger.appendEvent(
        ev({ eventType: "REFUND", referenceeventId: buy.eventId }),
        {},
      ),
    { code: "E1_ALREADY_REVERSED" },
  );
  console.log("[ok] second refund of same purchase rejected");

  const e2 = make();
  await e2.projection.rebuildFromLedger(); // simulated restart
  const d = e2.decisions.evaluateAccess(u.id, pid);
  assert.deepEqual(d, {
    allowed: false,
    reason: "PURCHASE_REFUNDED",
    sourceEventIds: [refund.eventId],
  });
  console.log("[ok] restart: projection rebuilt from DB ->", JSON.stringify(d));


  // ---------------- M1: provider-neutral transaction model ----------------
  const ev2 = (user, o) => ev({ userId: user.id, ...o });

  // Chargeback revokes access with its own reason.
  {
    const u2 = await newUser();
    const b = ev2(u2, {});
    await e1.ledger.appendEvent(b, {});
    await e1.ledger.appendEvent(ev2(u2, { eventType: "CHARGEBACK", referenceeventId: b.eventId }), {});
    assert.equal(e1.decisions.evaluateAccess(u2.id, pid).reason, "PURCHASE_CHARGED_BACK");
    await assert.rejects(
      () => e1.ledger.appendEvent(ev2(u2, { eventType: "REFUND", referenceeventId: b.eventId }), {}),
      { code: "E1_ALREADY_REVERSED" },
    );
    console.log("[ok] M1 chargeback -> PURCHASE_CHARGED_BACK; refund after chargeback rejected");
  }

  // Refund and chargeback racing on the same purchase: the DB lets only one through.
  {
    const u3 = await newUser();
    const b = ev2(u3, {});
    await e1.ledger.appendEvent(b, {});
    const results = await Promise.allSettled([
      e1.ledger.appendEvent(ev2(u3, { eventType: "REFUND", referenceeventId: b.eventId }), {}),
      e1.ledger.appendEvent(ev2(u3, { eventType: "CHARGEBACK", referenceeventId: b.eventId }), {}),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.appended).length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "E1_ALREADY_REVERSED");
    console.log("[ok] M1 concurrent refund + chargeback -> exactly one reversal");
  }

  // Manual grant: free, can't be refunded, can be revoked; actor + reason are kept.
  {
    const u4 = await newUser();
    const g = ev2(u4, {
      eventType: "MANUAL_GRANT", amount: 0, source: "SCHOLARSHIP",
      actor: "admin@test.local", reason: "2026 scholarship",
      entitlement: { kind: "COURSE" },
    });
    await e1.ledger.appendEvent(g, {});
    assert.equal(e1.decisions.evaluateAccess(u4.id, pid).allowed, true);
    await assert.rejects(
      () => e1.ledger.appendEvent(ev2(u4, { eventType: "REFUND", referenceeventId: g.eventId }), {}),
      { code: "E1_INVALID_REFERENCE" },
    );
    const rv = ev2(u4, { eventType: "MANUAL_REVOKE", amount: 0, source: "ADMIN", actor: "admin@test.local", referenceeventId: g.eventId });
    await e1.ledger.appendEvent(rv, {});
    assert.equal(e1.decisions.evaluateAccess(u4.id, pid).reason, "ACCESS_REVOKED");
    const stored = await e1.ledger.getByEventId(g.eventId);
    assert.equal(stored.event.source, "SCHOLARSHIP");
    assert.equal(stored.event.actor, "admin@test.local");
    assert.equal(stored.event.reason, "2026 scholarship");
    console.log("[ok] M1 manual grant: refund rejected, MANUAL_REVOKE -> ACCESS_REVOKED, audit fields stored");
  }

  // Subscription: cancel keeps access until expiry; an expired one gives no access.
  if (sub) {
    const u5 = await newUser();
    const s1 = ev2(u5, {
      eventType: "SUBSCRIPTION_STARTED", productId: sub.id, amount: sub.price,
      entitlement: { kind: "SUBSCRIPTION", scope: "ALL_ACCESS", durationDays: 30 },
    });
    await e1.ledger.appendEvent(s1, {});
    await e1.ledger.appendEvent(
      ev2(u5, { eventType: "SUBSCRIPTION_CANCELLED", productId: sub.id, amount: 0, referenceeventId: s1.eventId }), {});
    const d5 = e1.decisions.evaluateAccess(u5.id, pid);
    assert.equal(d5.allowed, true);
    assert.equal(d5.reason, "ACTIVE_SUBSCRIPTION_PASS");
    assert.ok(e1.projection.getSubscription(u5.id).cancelledAt);

    const u6 = await newUser();
    await e1.ledger.appendEvent(ev2(u6, {
      eventType: "SUBSCRIPTION_STARTED", productId: sub.id, amount: sub.price,
      occurredAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      entitlement: { kind: "SUBSCRIPTION", scope: "ALL_ACCESS", durationDays: 30 },
    }), {});
    assert.equal(e1.decisions.evaluateAccess(u6.id, pid).allowed, false);
    assert.equal(e1.decisions.evaluateAccess(u6.id, pid).reason, "SUBSCRIPTION_EXPIRED");
    console.log("[ok] M1 cancelled subscription still active until expiry; 40-day-old 30-day sub denied");
  }

  // Stacked subscription: a refund removes only the period it references.
  if (sub) {
    const subEv = (user, o) => ev2(user, {
      eventType: "SUBSCRIPTION_STARTED", productId: sub.id, amount: sub.price,
      entitlement: { kind: "SUBSCRIPTION", scope: "ALL_ACCESS", durationDays: 30 }, ...o,
    });
    const day = 86400000;
    // Refund the SECOND month: first month stays.
    const u7 = await newUser();
    const m1 = subEv(u7, {}), m2 = subEv(u7, {});
    await e1.ledger.appendEvent(m1, {}); await e1.ledger.appendEvent(m2, {});
    const before = Date.parse(e1.projection.getSubscription(u7.id).expiresAt);
    await e1.ledger.appendEvent(ev2(u7, { eventType: "REFUND", productId: sub.id, amount: sub.price, referenceeventId: m2.eventId }), {});
    const after = e1.projection.getSubscription(u7.id);
    assert.equal(e1.decisions.evaluateAccess(u7.id, pid).allowed, true);
    assert.equal(after.periods.length, 1);
    assert.ok(Math.abs(before - Date.parse(after.expiresAt) - 30 * day) < 5000, "expiry shortened by exactly 30 days");
    // Refund the FIRST month instead: second month moves up, still 30 days left.
    const u8 = await newUser();
    const n1 = subEv(u8, {}), n2 = subEv(u8, {});
    await e1.ledger.appendEvent(n1, {}); await e1.ledger.appendEvent(n2, {});
    await e1.ledger.appendEvent(ev2(u8, { eventType: "REFUND", productId: sub.id, amount: sub.price, referenceeventId: n1.eventId }), {});
    const left = Date.parse(e1.projection.getSubscription(u8.id).expiresAt) - Date.now();
    assert.ok(left > 29 * day && left <= 30 * day, "remaining period re-laid to ~30 days");
    // Refund both: revoked.
    await e1.ledger.appendEvent(ev2(u8, { eventType: "REFUND", productId: sub.id, amount: sub.price, referenceeventId: n2.eventId }), {});
    assert.equal(e1.projection.getSubscription(u8.id).status, "REVOKED");
    console.log("[ok] M1 stacked subscription: refunding one month removes only that month");

    // Expired subscription says so.
    const u9 = await newUser();
    await e1.ledger.appendEvent(subEv(u9, { occurredAt: new Date(Date.now() - 40 * day).toISOString() }), {});
    const d9 = e1.decisions.evaluateAccess(u9.id, pid);
    assert.equal(d9.reason, "SUBSCRIPTION_EXPIRED");
    assert.ok(d9.expiresAt);
    console.log("[ok] M1 expired subscription -> SUBSCRIPTION_EXPIRED with expiresAt");
  }

  // Coupon split always adds up to what was paid.
  {
    const { allocatePaidCents } = require("../services/pricingEngine");
    for (const [lines, fin] of [[[2000, 3500], 5225], [[2000, 3500, 5000], 10000], [[1, 1, 1], 100], [[2999], 2999], [[0, 0], 0]]) {
      const parts = allocatePaidCents(lines, fin);
      assert.equal(parts.reduce((a, b) => a + b, 0), fin);
    }
    assert.deepEqual(allocatePaidCents([2000, 3500], 5225), [1900, 3325]);
    console.log("[ok] coupon allocation: per-item paid amounts always sum to the order total");
  }

  // Missing reference is rejected by the domain and by the database.
  await assert.rejects(
    () => e1.ledger.appendEvent(ev({ eventType: "CHARGEBACK" }), {}),
    { code: "E1_MISSING_REFERENCE" },
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO commerce_ledger (event_id,event_type,user_id,product_id,quantity,amount,currency,occurred_at,product_snapshot)
       VALUES ($1,'CHARGEBACK',$2,$3,1,0,'USD',now(),'{}')`,
      [`evt_${randomUUID()}`, u.id, pid]),
    /commerce_ledger_reference_check/,
  );
  await assert.rejects(
    () => e1.ledger.appendEvent(ev({ source: "BANANA" }), {}),
    { code: "E1_INVALID_SOURCE" },
  );
  console.log("[ok] M1 revoke without reference rejected (domain + DB CHECK); unknown source rejected");

  // Everything above (and all pre-M1 rows) replays to the same answers after a restart.
  const e3 = make();
  await e3.projection.rebuildFromLedger();
  assert.equal(e3.decisions.evaluateAccess(u.id, pid).reason, "PURCHASE_REFUNDED");
  console.log("[ok] M1 full ledger (old + new rows) rebuilds after restart");

  for (const sql of [
    "UPDATE commerce_ledger SET amount = 0",
    "DELETE FROM commerce_ledger",
    "TRUNCATE commerce_ledger",
  ])
    // TRUNCATE hits the self-referencing FK check before the trigger; either way it is refused.
    await assert.rejects(() => pool.query(sql), /append-only|cannot truncate/);
  console.log("[ok] UPDATE / DELETE / TRUNCATE rejected by DB triggers (L1)");
  console.log("\nPG CHECKS PASSED");
  await pool.end();
})().catch((e) => {
  console.error("\nFAILED:", e);
  process.exit(1);
});

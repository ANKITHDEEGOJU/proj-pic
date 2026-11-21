"use strict";
// M5 checks against Postgres: per-user and pooled (organization) usage quotas, the limit under
// concurrent requests, idempotent retries, giving units back when the work fails, and the
// daily reset. Uses only this script's own users; counters, usage rows, orgs and packs it made
// are removed at the end (ledger rows stay: append-only by design).
require("dotenv").config();
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const pool = require("../src/db");
const { createEngine } = require("../src/domain");
const { loadProducts } = require("../src/domain/catalogLoader");
const { PgLedgerStore } = require("../src/domain/stores/pgLedgerStore");
const { RazorpayPaymentAdapter } = require("../src/payment/adapters/razorpay");
const { WebhookProcessor } = require("../src/payment/webhookProcessor");
const seats = require("../src/services/seats");
const quotas = require("../src/services/quotas");

process.env.QUOTA_AI_SUMMARY_USER = "3";
process.env.QUOTA_AI_SUMMARY_SUBSCRIBER = "7";
process.env.QUOTA_AI_SUMMARY_PER_SEAT = "4";
const FEATURE = "AI_SUMMARY";
const PROVIDER = "m5test";
class FakeProvider extends RazorpayPaymentAdapter { get name() { return PROVIDER; } }
const fake = new FakeProvider();
const userIds = [];
const orgIds = [];

async function cleanup() {
  await pool.query("DELETE FROM webhook_inbox WHERE provider=$1", [PROVIDER]);
  if (userIds.length) {
    await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [userIds.map((u) => `user:${u}`)]);
  }
  if (orgIds.length) {
    await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [orgIds.map((o) => `org:${o}`)]);
    await pool.query("DELETE FROM org_seat_pools WHERE org_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
  }
}

(async () => {
  const products = await loadProducts();
  const course = products.find((x) => (x.type || "COURSE") === "COURSE");
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { ledger, decisions } = engine;
  const processor = new WebhookProcessor({ ledger });

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `m5_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const key = () => `${FEATURE}:test:${randomUUID()}`;
  const use = (u, quota, opts = {}) =>
    quotas.consume({ requestKey: key(), quota, feature: FEATURE, userId: u.id, productId: course.id, ...opts });
  const paid = { allowed: true, reason: "ACTIVE_PURCHASE", grantedVia: "PURCHASE_SUCCEEDED", sourceEventIds: ["x"] };
  const subscribed = { allowed: true, reason: "ACTIVE_SUBSCRIPTION_PASS", sourceEventIds: ["x"] };

  // ------------------------------------------------------------ which quota applies
  const u1 = await newUser("u1");
  const q1 = await quotas.resolveQuota({ userId: u1.id, feature: FEATURE, decision: paid });
  assert.deepEqual([q1.kind, q1.limit, q1.scopeKey], ["USER", 3, `user:${u1.id}`]);
  const qs = await quotas.resolveQuota({ userId: u1.id, feature: FEATURE, decision: subscribed });
  assert.deepEqual([qs.kind, qs.limit], ["SUBSCRIBER", 7]);
  await assert.rejects(
    quotas.resolveQuota({ userId: u1.id, feature: FEATURE, decision: { allowed: false, reason: "NO_PURCHASE_RECORD", sourceEventIds: [] } }),
    (e) => e.code === "NO_ACCESS"
  );
  console.log("[ok] M5 quota chosen from access: purchase -> user limit, All-Access -> subscriber limit, no access -> refused");

  // ------------------------------------------------------------ per-user limit
  for (let i = 1; i <= 3; i++) {
    const r = await use(u1, q1);
    assert.equal(r.ok, true);
    assert.equal(r.used, i);
  }
  const over = await use(u1, q1);
  assert.equal(over.ok, false);
  assert.equal(over.used, 3);
  assert.ok(over.retryAfterSec > 0 && over.retryAfterSec <= 86400);
  assert.equal(await quotas.usage(q1.scopeKey, FEATURE), 3);
  const events = (await pool.query("SELECT count(*)::int n FROM usage_events WHERE user_id=$1", [u1.id])).rows[0].n;
  assert.equal(events, 3, "a rejected request leaves no usage row");
  console.log("[ok] M5 per-user limit: 3 accepted, 4th refused with Retry-After until the UTC day ends");

  // ------------------------------------------------------------ concurrency
  const u2 = await newUser("u2");
  const q2 = await quotas.resolveQuota({ userId: u2.id, feature: FEATURE, decision: subscribed });
  const burst = await Promise.all(Array.from({ length: 25 }, () => use(u2, q2)));
  assert.equal(burst.filter((r) => r.ok).length, 7, "exactly the limit is accepted");
  assert.equal(await quotas.usage(q2.scopeKey, FEATURE), 7, "counter never passes the limit");
  console.log("[ok] M5 25 concurrent requests against a limit of 7: exactly 7 accepted, counter = 7");

  // ------------------------------------------------------------ idempotent retries
  const u3 = await newUser("u3");
  const q3 = await quotas.resolveQuota({ userId: u3.id, feature: FEATURE, decision: paid });
  const k = key();
  const same = await Promise.all(Array.from({ length: 5 }, () => use(u3, q3, { requestKey: k })));
  assert.equal(same.filter((r) => r.ok && !r.duplicate).length, 1);
  assert.ok(same.every((r) => r.ok));
  assert.equal(await quotas.usage(q3.scopeKey, FEATURE), 1, "one request key counts once");
  await assert.rejects(use(u1, q1, { requestKey: k }), (e) => e.code === "KEY_CONFLICT");
  console.log("[ok] M5 the same request sent 5 times at once is counted once; another user cannot reuse its key");

  // ------------------------------------------------------------ release on failure
  const k2 = key();
  assert.equal((await use(u3, q3, { requestKey: k2 })).used, 2);
  assert.equal(await quotas.release(k2), true);
  assert.equal(await quotas.release(k2), false, "second release is a no-op");
  assert.equal(await quotas.usage(q3.scopeKey, FEATURE), 1);
  const retried = await use(u3, q3, { requestKey: k2 });
  assert.equal(retried.ok, false, "a released key is not silently re-run");
  assert.equal(retried.status, "RELEASED");
  console.log("[ok] M5 failed work gives its credit back once; the released request is reported, not re-counted");

  // ------------------------------------------------------------ daily reset
  const tomorrow = new Date(Date.now() + 86_400_000);
  const next = await use(u1, q1, { now: tomorrow });
  assert.equal(next.ok, true);
  assert.equal(next.used, 1, "new UTC day starts a new counter");
  console.log("[ok] M5 quota resets with the UTC day");

  // ------------------------------------------------------------ pooled org quota
  const deliver = async (payload, eventKey) => {
    const row = (await pool.query(
      "INSERT INTO webhook_inbox (provider, provider_event_id, raw_body) VALUES ($1,$2,$3) RETURNING *",
      [PROVIDER, eventKey, JSON.stringify(payload)]
    )).rows[0];
    return processor.process(row, fake);
  };
  const owner = await newUser("owner");
  const [a, b] = [await newUser("a"), await newUser("b")];
  const org = await seats.createOrg({ name: `M5 Test Org ${randomUUID().slice(0, 6)}`, managerEmails: owner.email, actor: "test:m5" });
  orgIds.push(org.id);
  const pack = await seats.createSeatPackOrder({ userId: owner.id, orgId: org.id, course, seats: 2, provider: PROVIDER });
  const pay = {
    id: `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`, entity: "payment", amount: Math.round(course.price * 200),
    currency: "USD", status: "captured", created_at: Math.floor(Date.now() / 1000),
    notes: { orderId: pack.orderId, orderRef: pack.orderId, userId: owner.id, productId: course.id },
  };
  assert.equal((await deliver({ event: "payment.captured", payload: { payment: { entity: pay } } }, `pc:${pay.id}`)).outcome, "APPENDED");
  const actor = `user:${owner.id}`;
  await seats.assignSeat({ ledger, poolId: pack.pool.id, email: a.email, actor });
  await seats.assignSeat({ ledger, poolId: pack.pool.id, email: b.email, actor });

  const qa = await quotas.resolveQuota({ userId: a.id, feature: FEATURE, decision: decisions.evaluateAccess(a.id, course.id) });
  const qb = await quotas.resolveQuota({ userId: b.id, feature: FEATURE, decision: decisions.evaluateAccess(b.id, course.id) });
  assert.equal(qa.kind, "ORG_POOL");
  assert.equal(qa.scopeKey, `org:${pack.org.id}`);
  assert.equal(qa.scopeKey, qb.scopeKey, "seat holders share one pool");
  assert.equal(qa.limit, 2 * 4, "pool = seats x per-seat allowance");
  const mixed = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? use(a, qa) : use(b, qb))));
  assert.equal(mixed.filter((r) => r.ok).length, 8);
  assert.equal(await quotas.usage(qa.scopeKey, FEATURE), 8);
  assert.equal(await quotas.usage(`user:${a.id}`, FEATURE), 0, "seat use does not touch the member's own quota");
  console.log("[ok] M5 pooled org quota: 2 members, 12 concurrent requests, pool of 8 -> exactly 8 accepted");

  console.log("\nM5 CHECKS PASSED");
  await cleanup();
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

"use strict";
// M4 checks against Postgres: enterprise seats (buy, assign, overfill, unassign, reassign,
// refund), subscription renew / cancel, and the coupon cookie. Uses a fake provider built on
// the Razorpay normalizer (no network) and only this script's own users. Ledger rows stay
// (append-only by design); organizations, packs and inbox rows it made are removed at the end.
require("dotenv").config();
delete process.env.SUB_DURATION_MINUTES; // demo switch off: checks expect real 30-day periods
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const pool = require("../db");
const { createEngine } = require("../domain");
const { loadProducts } = require("../domain/catalogLoader");
const { PgLedgerStore } = require("../domain/stores/pgLedgerStore");
const { RazorpayPaymentAdapter } = require("../payment/adapters/razorpay");
const { WebhookProcessor } = require("../payment/webhookProcessor");
const seats = require("./seats");
const subs = require("./subscriptions");
const cartSession = require("./cartSession");

const PROVIDER = "m4test";
class FakeProvider extends RazorpayPaymentAdapter { get name() { return PROVIDER; } }
const fake = new FakeProvider();
const rid = (p) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
const now = () => Math.floor(Date.now() / 1000);
const orgIds = [];

async function cleanup() {
  await pool.query("DELETE FROM webhook_inbox WHERE provider=$1", [PROVIDER]);
  if (orgIds.length) {
    await pool.query("DELETE FROM org_seat_pools WHERE org_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
  }
}

(async () => {
  const products = await loadProducts();
  const course = products.find((x) => (x.type || "COURSE") === "COURSE");
  const subProduct = products.find((x) => x.type === "SUBSCRIPTION");
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { ledger, decisions, projection, catalog } = engine;
  const processor = new WebhookProcessor({ ledger });

  const newUser = async (tag) =>
    (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `m4_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
  const access = (u, pid = course.id) => decisions.evaluateAccess(u.id, pid);
  const paymentFor = (orderId, user, amountMinor) => ({
    id: rid("pay"), entity: "payment", amount: amountMinor, currency: "USD", status: "captured",
    created_at: now(), notes: { orderId, orderRef: orderId, userId: user.id, productId: course.id },
  });
  const deliver = async (payload, key) => {
    const row = (await pool.query(
      "INSERT INTO webhook_inbox (provider, provider_event_id, raw_body) VALUES ($1,$2,$3) RETURNING *",
      [PROVIDER, key, JSON.stringify(payload)]
    )).rows[0];
    return processor.process(row, fake);
  };
  const captured = (pay) => deliver({ event: "payment.captured", payload: { payment: { entity: pay } } }, `payment.captured:${pay.id}:${randomUUID()}`);
  const refunded = (pay) => {
    const r = { id: rid("rfnd"), entity: "refund", amount: pay.amount, currency: "USD", payment_id: pay.id, notes: {}, created_at: now() };
    return deliver({ event: "refund.created", payload: { refund: { entity: r }, payment: { entity: pay } } }, `refund.created:${r.id}`);
  };
  const orderStatus = async (id) => (await pool.query("SELECT status FROM orders WHERE id=$1", [id])).rows[0].status;
  const poolRow = async (id) => (await pool.query("SELECT * FROM org_seat_pools WHERE id=$1", [id])).rows[0];
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));

  // =============================================================== seats
  const owner = await newUser("owner");
  const [a, b, c, d] = [await newUser("a"), await newUser("b"), await newUser("c"), await newUser("d")];
  const actor = `user:${owner.id}`;

  const pack = await seats.createSeatPackOrder({ userId: owner.id, orgName: "M4 Test Org", course, seats: 2, provider: PROVIDER });
  orgIds.push(pack.org.id);
  const poolId = pack.pool.id;
  assert.equal(pack.amount, course.price * 2, "price = seats x course price");
  await rejects(seats.assignSeat({ ledger, poolId, email: a.email, actor }), "POOL_NOT_ACTIVE");

  const pay = paymentFor(pack.orderId, owner, Math.round(course.price * 200));
  assert.equal((await captured(pay)).outcome, "APPENDED");
  const pr = await poolRow(poolId);
  assert.equal(pr.status, "ACTIVE");
  const purchase = await ledger.getByEventId(pr.purchase_event_id);
  assert.equal(purchase.event.eventType, "SEAT_POOL_PURCHASED");
  assert.equal(purchase.event.quantity, 2);
  assert.equal(access(owner).allowed, false, "buying seats gives the buyer no access by itself");
  console.log("[ok] M4 seat pack: paid via webhook -> SEAT_POOL_PURCHASED, pack ACTIVE, buyer gets no access");

  await seats.assignSeat({ ledger, poolId, email: a.email, actor });
  await seats.assignSeat({ ledger, poolId, email: b.email.toUpperCase(), actor }); // email match is case-insensitive
  assert.equal(access(a).grantedVia, "SEAT_ASSIGNED");
  assert.equal(access(b).allowed, true);
  await rejects(seats.assignSeat({ ledger, poolId, email: c.email, actor }), "POOL_FULL");
  await rejects(seats.assignSeat({ ledger, poolId, email: a.email, actor }), "ALREADY_ASSIGNED");
  await rejects(seats.assignSeat({ ledger, poolId, email: "nobody@nowhere.test", actor }), "NO_USER");
  assert.equal((await seats.activeSeats(poolId)).length, 2, "seat usage counted from the ledger");
  console.log("[ok] M4 assign: seats give access; full pack, duplicate member and unknown email are refused");

  // Two owners clicking at once on the last seat: exactly one wins.
  const pack1 = await seats.createSeatPackOrder({ userId: owner.id, course, seats: 1, provider: PROVIDER });
  await captured(paymentFor(pack1.orderId, owner, Math.round(course.price * 100)));
  const race = await Promise.allSettled([
    seats.assignSeat({ ledger, poolId: pack1.pool.id, email: c.email, actor }),
    seats.assignSeat({ ledger, poolId: pack1.pool.id, email: d.email, actor }),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.code, "POOL_FULL");
  assert.equal((await seats.activeSeats(pack1.pool.id)).length, 1);
  console.log("[ok] M4 concurrent assignment of the last seat: exactly one succeeds (advisory lock)");

  // Unassign B, then move A's seat to D.
  const seatOf = async (u) => (await seats.activeSeats(poolId)).find((s) => s.user_id === u.id);
  await seats.unassignSeat({ ledger, poolId, assignmentEventId: (await seatOf(b)).event_id, actor });
  assert.equal(access(b).reason, "SEAT_UNASSIGNED");
  const dHadSeat = (await seats.activeSeats(pack1.pool.id)).some((s) => s.user_id === d.id);
  const target = dHadSeat ? c : d; // whoever did not win the race above
  await seats.reassignSeat({ ledger, poolId, assignmentEventId: (await seatOf(a)).event_id, email: target.email, actor });
  assert.equal(access(a).reason, "SEAT_UNASSIGNED");
  assert.equal(access(target).allowed, true);
  assert.equal((await seats.activeSeats(poolId)).length, 1);
  await rejects(
    seats.reassignSeat({ ledger, poolId, assignmentEventId: (await seatOf(target)).event_id, email: target.email, actor }),
    "SAME_MEMBER"
  );
  console.log("[ok] M4 unassign removes access; reassign moves the seat in one step");

  // A member who also bought the course keeps it when their seat goes.
  await seats.assignSeat({ ledger, poolId, email: b.email, actor });
  await ledger.appendEvent({
    eventId: `evt_${randomUUID()}`, eventType: "PURCHASE_SUCCEEDED", userId: b.id, productId: course.id, quantity: 1,
    amount: course.price, currency: "USD", occurredAt: new Date().toISOString(), referenceeventId: null,
    entitlement: { kind: "COURSE" },
  }, {});
  await seats.unassignSeat({ ledger, poolId, assignmentEventId: (await seatOf(b)).event_id, actor });
  assert.equal(access(b).allowed, true);
  assert.equal(access(b).grantedVia, "PURCHASE_SUCCEEDED");
  console.log("[ok] M4 seat holder who also bought the course keeps access after unassignment");

  // Refunding the pack (provider webhook) unassigns every seat and closes the pack.
  const seatHolders = (await seats.activeSeats(poolId)).map((s) => s.user_id);
  assert.ok(seatHolders.length > 0);
  assert.equal((await refunded(pay)).outcome, "APPENDED");
  assert.equal(await orderStatus(pack.orderId), "REFUNDED");
  assert.equal((await poolRow(poolId)).status, "REVOKED");
  assert.equal((await seats.activeSeats(poolId)).length, 0);
  for (const uid of seatHolders) assert.equal(decisions.evaluateAccess(uid, course.id).reason, "SEAT_UNASSIGNED");
  assert.equal(access(b).allowed, true, "B's own purchase is untouched by the pack refund");
  await rejects(seats.assignSeat({ ledger, poolId, email: a.email, actor }), "POOL_NOT_ACTIVE");
  const again = await deliver({ event: "refund.created", payload: { refund: { entity: { id: "rfnd_dup", amount: pay.amount, currency: "USD", payment_id: pay.id, notes: {}, created_at: now() } }, payment: { entity: pay } } }, `refund.created:${randomUUID()}`);
  assert.notEqual(again.outcome, "FAILED");
  console.log("[ok] M4 seat pack refund (webhook): all seats unassigned, pack REVOKED, members' own purchases kept");

  // =============================================================== subscriptions
  const s = await newUser("sub");
  const subOrder = async (renewal) => {
    const orderId = (await pool.query(
      `INSERT INTO orders (user_id, subtotal_cents, final_payable_cents, provider, status) VALUES ($1,$2,$2,$3,'PENDING') RETURNING id`,
      [s.id, Math.round(subProduct.price * 100), PROVIDER]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents, renewal)
       VALUES ($1,'SUBSCRIPTION',$2,$3,1,30,'ALL_ACCESS',$3,$4)`,
      [orderId, subProduct.id, Math.round(subProduct.price * 100), renewal]
    );
    return orderId;
  };
  const subPay = (orderId) => ({ ...paymentFor(orderId, s, Math.round(subProduct.price * 100)), notes: { orderId, userId: s.id, productId: subProduct.id } });
  const typesFor = async (pid) => (await pool.query(
    "SELECT event_type FROM commerce_ledger WHERE payment_info->>'providerPaymentId'=$1", [pid])).rows.map((r) => r.event_type);

  assert.equal(subs.isRenewal(projection, s.id, "ALL_ACCESS"), false);
  const p1 = subPay(await subOrder(subs.isRenewal(projection, s.id, "ALL_ACCESS")));
  await captured(p1);
  assert.deepEqual(await typesFor(p1.id), ["SUBSCRIPTION_STARTED"]);
  const end1 = Date.parse(subs.activePass(projection, s.id).expiresAt);

  assert.equal(subs.isRenewal(projection, s.id, "ALL_ACCESS"), true, "active pass -> next purchase is a renewal");
  const p2 = subPay(await subOrder(subs.isRenewal(projection, s.id, "ALL_ACCESS")));
  await captured(p2);
  assert.deepEqual(await typesFor(p2.id), ["SUBSCRIPTION_RENEWED"]);
  const end2 = Date.parse(subs.activePass(projection, s.id).expiresAt);
  assert.ok(Math.abs(end2 - end1 - 30 * 86400e3) < 5000, "renewal stacks 30 days after the current end");
  // A replay of the renewal webhook (retry / reconciliation) records nothing new and no conflict.
  assert.equal((await captured(p2)).outcome, "DUPLICATE");
  console.log("[ok] M4 renew: second purchase is SUBSCRIPTION_RENEWED, stacked after the current end; replay is a duplicate");

  // ---- one renewal at a time
  let st = await subs.passState({ ledger, projection, userId: s.id });
  assert.equal(st.queued.length, 1, "the renewal is a period paid in advance");
  assert.equal(st.canRenew, false, "no Renew while a renewal is already paid");
  assert.match(await subs.renewBlocked({ ledger, projection, userId: s.id }), /already renewed/);
  console.log("[ok] M4 one renewal at a time: with a renewal paid in advance, Renew is hidden and refused");

  // Provider refunds are stubbed here; the refund webhook is delivered by the test, as in production.
  const { PaymentService } = require("../payment/service");
  const realRefund = PaymentService.prototype.initiateRefund;
  const refundCalls = [];
  let refuse = null;
  PaymentService.prototype.initiateRefund = async function (a) {
    refundCalls.push(a);
    if (refuse && refuse(a)) throw new Error("provider said no");
    return { providerRefundId: rid("rfnd") };
  };
  const refundHook = (pay) => deliver({ event: "refund.created", payload: { refund: { entity: { id: rid("rfnd"), entity: "refund", amount: pay.amount, currency: "USD", payment_id: pay.id, notes: {}, created_at: now() } }, payment: { entity: pay } } }, `refund.created:${randomUUID()}`);
  const orderOf = (pay) => pay.notes.orderId;
  const orderRow = async (id) => (await pool.query("SELECT status, refund_scope FROM orders WHERE id=$1", [id])).rows[0];

  // ---- Cancel renewal with a renewal paid in advance: that renewal is refunded in full (option A)
  const c1 = await subs.cancelRenewal({ ledger, projection, catalog, user: s });
  assert.equal(c1.ok, true);
  assert.deepEqual(refundCalls.map((c) => c.orderId), [orderOf(p2)], "only the queued renewal is refunded");
  assert.equal(refundCalls[0].amount, subProduct.price, "in full");
  assert.deepEqual(await orderRow(orderOf(p2)), { status: "REFUND_PENDING", refund_scope: "RENEWAL_CANCEL" });
  assert.ok(subs.activePass(projection, s.id).cancelledAt, "Not renewing");
  st = await subs.passState({ ledger, projection, userId: s.id });
  assert.equal(st.refundPending, true);
  assert.equal(await subs.renewBlocked({ ledger, projection, userId: s.id }), "A refund of your pass is in progress.");
  assert.equal((await refundHook(p2)).outcome, "APPENDED");
  assert.equal((await orderRow(orderOf(p2))).status, "REFUNDED");
  const afterCancel = subs.activePass(projection, s.id);
  assert.equal(Date.parse(afterCancel.expiresAt), end1, "back to the end of the current period");
  assert.equal(decisions.evaluateAccess(s.id, course.id).reason, "ACTIVE_SUBSCRIPTION_PASS", "current period kept");
  assert.equal(subs.renewalReminder(afterCancel), null, "no renewal reminder once cancelled");
  assert.equal((await subs.cancelRenewal({ ledger, projection, catalog, user: s })).already, true, "second cancel is a no-op");
  assert.equal(refundCalls.length, 1, "and refunds nothing more");
  const { rows: cancels } = await pool.query("SELECT source, reason FROM commerce_ledger WHERE user_id=$1 AND event_type='SUBSCRIPTION_CANCELLED'", [s.id]);
  assert.deepEqual(cancels.map((r) => r.source), ["CUSTOMER"]);
  assert.match(cancels[0].reason, /renewal refunded/);
  st = await subs.passState({ ledger, projection, userId: s.id });
  assert.equal(st.canRenew, true, "Renew is offered again after the renewal was cancelled");
  console.log("[ok] M4 cancel renewal with a paid renewal: that renewal refunded in full, current period kept, Not renewing, Renew offered again");

  // Without a renewal paid in advance Cancel renewal is only the flag (no refund).
  const sf = await newUser("subflag");
  const pf = { ...paymentFor(null, sf, Math.round(subProduct.price * 100)) };
  {
    const oid = (await pool.query(`INSERT INTO orders (user_id, subtotal_cents, final_payable_cents, provider, status) VALUES ($1,$2,$2,$3,'PENDING') RETURNING id`, [sf.id, Math.round(subProduct.price * 100), PROVIDER])).rows[0].id;
    await pool.query(`INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents, renewal) VALUES ($1,'SUBSCRIPTION',$2,$3,1,30,'ALL_ACCESS',$3,false)`, [oid, subProduct.id, Math.round(subProduct.price * 100)]);
    pf.notes = { orderId: oid, orderRef: oid, userId: sf.id, productId: subProduct.id };
    await captured(pf);
  }
  const before = refundCalls.length;
  const cf = await subs.cancelRenewal({ ledger, projection, catalog, user: sf });
  assert.equal(cf.ok, true);
  assert.equal(refundCalls.length, before, "no renewal paid in advance -> nothing refunded");
  assert.ok(subs.activePass(projection, sf.id).cancelledAt);
  console.log("[ok] M4 cancel renewal without a paid renewal: only stops renewing, access to the end date");

  // ---- Paying again turns renewal back on; then a full Refund refunds every payment of the pass
  const p3 = subPay(await subOrder(subs.isRenewal(projection, s.id, "ALL_ACCESS")));
  await captured(p3);
  assert.equal(subs.activePass(projection, s.id).cancelledAt, null, "paying again turns renewal back on");
  // A scholarship month stacked on the pass (free): ends with a full refund.
  await ledger.appendEvent({
    eventId: `admin_grant_${randomUUID()}`, eventType: "MANUAL_GRANT", userId: s.id, productId: subProduct.id, quantity: 1, amount: 0,
    currency: "USD", occurredAt: new Date().toISOString(), source: "SCHOLARSHIP", actor: "m4test", reason: "test",
    entitlement: { kind: "SUBSCRIPTION", scope: "ALL_ACCESS", durationDays: 30, expiresAt: null },
  }, { method: "ADMIN_MANUAL_GRANT" });
  assert.equal(subs.activePass(projection, s.id).periods.filter((x) => Date.parse(x.endsAt) > Date.now()).length, 3);

  // A provider that refuses one payment: the other is still refunded; nothing free ends.
  refuse = (a) => a.orderId === orderOf(p3);
  const r0 = await subs.refundPass({ ledger, projection, catalog, user: s });
  assert.equal(r0.ok, true);
  assert.equal(r0.failed.length, 1);
  assert.equal((await orderRow(orderOf(p3))).status, "COMPLETED", "a refused refund reopens its order");
  assert.equal((await orderRow(orderOf(p1))).status, "REFUND_PENDING");
  await refundHook(p1);
  assert.ok(subs.activePass(projection, s.id), "pass still active: the renewal was not refunded");
  assert.equal(subs.activePass(projection, s.id).periods.filter((x) => x.grantedVia === "MANUAL_GRANT" && Date.parse(x.endsAt) > Date.now()).length, 1, "scholarship kept while a payment is still unrefunded");
  console.log("[ok] M4 full refund, one payment refused: the other is refunded, the refused order reopens, free time stays");

  refuse = null;
  const callsBefore = refundCalls.length;
  const r1 = await subs.refundPass({ ledger, projection, catalog, user: s });
  assert.equal(r1.ok, true);
  assert.deepEqual(refundCalls.slice(callsBefore).map((c) => c.orderId), [orderOf(p3)], "the rest of the pass");
  assert.deepEqual(await orderRow(orderOf(p3)), { status: "REFUND_PENDING", refund_scope: "PASS_FULL" });
  assert.ok(subs.activePass(projection, s.id), "access kept until the provider confirms");
  await refundHook(p3);
  assert.equal(subs.activePass(projection, s.id), null, "no paid or free time left");
  assert.equal(decisions.evaluateAccess(s.id, course.id).allowed, false, "every course of the pass is gone");
  const ended = (await pool.query("SELECT source, reason FROM commerce_ledger WHERE user_id=$1 AND event_type='MANUAL_REVOKE'", [s.id])).rows;
  assert.equal(ended.length, 1);
  assert.equal(ended[0].source, "SYSTEM");
  assert.match(ended[0].reason, /scholarship period ended/);
  assert.equal((await refundHook(p3)).outcome, "DUPLICATE", "a replayed refund webhook changes nothing");
  console.log("[ok] M4 full refund: every payment of the pass refunded (one provider refund each); when all are confirmed the scholarship time ends too");

  // Both at once from the start: original + renewal in one Refund click.
  const s2 = await newUser("sub2");
  const mk = async (renewal) => {
    const oid = (await pool.query(`INSERT INTO orders (user_id, subtotal_cents, final_payable_cents, provider, status) VALUES ($1,$2,$2,$3,'PENDING') RETURNING id`, [s2.id, Math.round(subProduct.price * 100), PROVIDER])).rows[0].id;
    await pool.query(`INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents, renewal) VALUES ($1,'SUBSCRIPTION',$2,$3,1,30,'ALL_ACCESS',$3,$4)`, [oid, subProduct.id, Math.round(subProduct.price * 100), renewal]);
    const pay = paymentFor(oid, s2, Math.round(subProduct.price * 100));
    pay.notes = { orderId: oid, orderRef: oid, userId: s2.id, productId: subProduct.id };
    await captured(pay);
    return pay;
  };
  const q1 = await mk(false);
  const q2 = await mk(true);
  const c0 = refundCalls.length;
  const r2 = await subs.refundPass({ ledger, projection, catalog, user: s2 });
  assert.deepEqual(r2.failed, []);
  assert.deepEqual(refundCalls.slice(c0).map((c) => c.orderId).sort(), [orderOf(q1), orderOf(q2)].sort(), "both payments in one click");
  await refundHook(q2);
  assert.ok(subs.activePass(projection, s2.id), "still active until the last part is confirmed");
  await refundHook(q1);
  assert.equal(subs.activePass(projection, s2.id), null);
  console.log("[ok] M4 Refund with original + renewal: both refunded in one click, access ends when the last is confirmed");
  PaymentService.prototype.initiateRefund = realRefund;

  const fakeEnt = { cancelledAt: null, expiresAt: new Date(Date.now() + 3 * 86400e3).toISOString() };
  assert.equal(subs.renewalReminder(fakeEnt), 3);
  assert.equal(subs.renewalReminder({ ...fakeEnt, expiresAt: new Date(Date.now() + 20 * 86400e3).toISOString() }), null);
  console.log(`[ok] M4 renewal reminder shows only in the last ${subs.REMINDER_DAYS} days`);

  // =============================================================== coupon cookie
  const cookies = {};
  const res = { headersSent: false, cookie: (k, v) => (cookies[k] = v), clearCookie: (k) => (cookies[k] = null) };
  const req1 = { cookies: {} };
  cartSession(req1, res, () => {});
  req1.session.couponCode = "DEMO";
  assert.equal(cookies.cart_coupon, "DEMO");
  const req2 = { cookies: { cart_coupon: "DEMO" } };
  cartSession(req2, res, () => {});
  assert.equal(req2.session.couponCode, "DEMO", "coupon survives the next request");
  delete req2.session.couponCode;
  assert.equal(cookies.cart_coupon, null);
  console.log("[ok] M4 applied coupon is kept across page loads (cookie) and cleared on remove");

  console.log("\nM4 CHECKS PASSED");
  await cleanup();
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

"use strict";
// M7 checks against Postgres: agent-proposed purchases need the user's approval; the approval
// token is rejected when tampered, signed with another key, for another intent, expired,
// cancelled, replayed (also concurrently) or when the price changed; a valid one creates
// exactly one normal order. Payment is stubbed (no provider needed). Removes its own intents
// and orders at the end; its @test.local users stay.
require("dotenv").config();
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { createEngine } = require("../domain");
const { loadProducts } = require("../domain/catalogLoader");
const { PgLedgerStore } = require("../domain/stores/pgLedgerStore");
const agent = require("./agentPurchase");

const userIds = [];
async function cleanup() {
  if (!userIds.length) return;
  const { rows } = await pool.query("SELECT order_id FROM purchase_intents WHERE user_id = ANY($1::uuid[]) AND order_id IS NOT NULL", [userIds]);
  await pool.query("DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds]);
  if (rows.length) await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [rows.map((r) => r.order_id)]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const products = await loadProducts();
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { catalog, decisions, ledger } = engine;
  const course = catalog.list().find((p) => (p.type || "COURSE") === "COURSE");
  const slug = course.slug || course.id;

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `m7_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const payments = [];
  const startPayment = async ({ intent, orderId }) => { payments.push({ intentId: intent.id, orderId }); return { status: "PAID" }; };
  const exec = (u, intentId, token, extra = {}) => agent.execute({ intentId, token, userId: u.id, catalog, startPayment, ...extra });
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));
  const ledgerCountBefore = (await ledger.getAll()).length;

  // ------------------------------------------------------------ propose
  const u = await newUser("u");
  const i1 = await agent.propose({ userId: u.id, productId: slug, provider: "mock", catalog, decisions });
  assert.equal(i1.status, "PROPOSED");
  assert.equal(i1.amount_cents, course.priceCents, "price taken from the catalog");
  assert.equal(i1.merchant, "LEARNX");
  await rejects(agent.propose({ userId: u.id, productId: "no-such-course", catalog, decisions }), "UNKNOWN_ITEM");
  await rejects(exec(u, i1.id, "not-a-token"), "TAMPERED");
  console.log("[ok] M7 propose: item, merchant and price filled in by the server; unknown items refused");

  // ------------------------------------------------------------ approval required
  const other = await newUser("other");
  await rejects(agent.approve({ intentId: i1.id, userId: other.id }), "NOT_FOUND");
  const { token } = await agent.approve({ intentId: i1.id, userId: u.id });
  await rejects(agent.approve({ intentId: i1.id, userId: u.id }), "ALREADY_APPROVED");
  console.log("[ok] M7 only the owner can approve, and only once");

  // ------------------------------------------------------------ tampering
  const [h, p, s] = token.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, amount: 1 })).toString("base64url")}.${s}`;
  await rejects(exec(u, i1.id, forged), "TAMPERED");
  const otherKey = jwt.sign({ ...claims, amount: 1 }, "attacker-key"); // keeps aud/sub/exp from claims
  await rejects(exec(u, i1.id, otherKey), "TAMPERED");
  await rejects(exec(other, i1.id, token), "WRONG_USER");
  const i2 = await agent.propose({ userId: u.id, productId: slug, catalog, decisions });
  await rejects(exec(u, i2.id, token), "WRONG_INTENT");
  console.log("[ok] M7 changed amount, foreign signature, other user and other intent are all rejected");

  // ------------------------------------------------------------ price changed after approval
  const pricier = { list: () => catalog.list().map((x) => (x === course ? { ...x, priceCents: x.priceCents + 100 } : x)) };
  await rejects(exec(u, i1.id, token, { catalog: pricier }), "PRICE_CHANGED");
  console.log("[ok] M7 a price change after approval is rejected");

  // ------------------------------------------------------------ happy path + concurrent replay
  const results = await Promise.allSettled([exec(u, i1.id, token), exec(u, i1.id, token), exec(u, i1.id, token)]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one execution wins");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "REPLAYED"));
  assert.equal(payments.length, 1, "one payment started");
  const { orderId } = ok[0].value;
  const order = (await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  const lines = (await pool.query("SELECT * FROM order_line_items WHERE order_id=$1", [orderId])).rows;
  assert.equal(order.final_payable_cents, course.priceCents);
  assert.equal(order.status, "PENDING", "paid later by the normal webhook");
  assert.deepEqual(lines.map((l) => [l.item_id, l.paid_cents]), [[slug, course.priceCents]]);
  assert.equal((await agent.getIntent(i1.id)).status, "EXECUTED");
  await rejects(exec(u, i1.id, token), "REPLAYED");
  await rejects(agent.cancel({ intentId: i1.id, userId: u.id }), "ALREADY_EXECUTED");
  console.log("[ok] M7 valid approval: one normal order for the approved amount; 3 concurrent sends -> 1 executed, 2 REPLAYED");

  // ------------------------------------------------------------ cancelled
  const t2 = (await agent.approve({ intentId: i2.id, userId: u.id })).token;
  await agent.cancel({ intentId: i2.id, userId: u.id });
  await rejects(exec(u, i2.id, t2), "CANCELLED");
  const i3 = await agent.propose({ userId: u.id, productId: slug, catalog, decisions });
  await rejects(exec(u, i3.id, t2), "WRONG_INTENT");
  console.log("[ok] M7 a cancelled approval is rejected");

  // ------------------------------------------------------------ expired
  const t3 = (await agent.approve({ intentId: i3.id, userId: u.id, ttlSeconds: 1 })).token;
  await sleep(1500);
  await rejects(exec(u, i3.id, t3), "EXPIRED");
  assert.equal((await agent.getIntent(i3.id)).status, "APPROVED", "nothing executed");
  console.log("[ok] M7 an expired approval is rejected");

  // ------------------------------------------------------------ payment failure
  const i4 = await agent.propose({ userId: u.id, productId: slug, catalog, decisions });
  const t4 = (await agent.approve({ intentId: i4.id, userId: u.id })).token;
  await rejects(exec(u, i4.id, t4, { startPayment: async () => { throw new Error("provider down"); } }), "PAYMENT_FAILED");
  const f = await agent.getIntent(i4.id);
  assert.equal(f.status, "FAILED");
  assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [f.order_id])).rows[0].status, "FAILED");
  await rejects(exec(u, i4.id, t4), "REPLAYED");
  console.log("[ok] M7 provider failure: request FAILED, order FAILED, approval cannot be reused");

  // ------------------------------------------------------------ ledger untouched
  assert.equal((await ledger.getAll()).length, ledgerCountBefore, "agent flow writes nothing to the ledger itself");
  console.log("[ok] M7 the agent flow wrote nothing to the ledger (purchases arrive through the normal webhook)");

  console.log("\nM7 CHECKS PASSED");
  await cleanup();
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

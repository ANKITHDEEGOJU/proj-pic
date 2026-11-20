"use strict";
// M7 checks against Postgres.
//   Service: agent-proposed purchases need the user's approval; the approval token is
//   rejected when tampered, signed with another key, for another intent, expired, cancelled,
//   replayed (also concurrently), when the price changed or the user owns the course by now;
//   a valid one creates exactly one normal order. One open request per course, a daily
//   proposal limit, the sweeper (expired / unpaid requests) and the audit trail.
//   HTTP: removed routes (simulated agent, agent-key API) are gone; approving (page or chat card)
//   needs the login session and a password above the step-up threshold; the approval token is
//   collected once and only by the proposing agent.
// Payment is stubbed (no provider needed). Removes its own rows at the end; its @test.local
// users stay.
require("dotenv").config();
for (const k of ["GROQ_API_KEY", "GEMINI_API_KEY", "LLM_BASE_URL"]) delete process.env[k]; // never call a real model here
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { createEngine } = require("../domain");
const { loadProducts } = require("../domain/catalogLoader");
const { PgLedgerStore } = require("../domain/stores/pgLedgerStore");
const { attachUser } = require("../auth");
const agent = require("./agentPurchase");
const agentKeys = require("./agentKeys");

const userIds = [];
let server = null;
async function cleanup() {
  server?.close();
  if (!userIds.length) return;
  const intents = (await pool.query("SELECT id, order_id FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  const keys = (await pool.query("SELECT id FROM agent_keys WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  await pool.query("DELETE FROM intent_events WHERE user_id = ANY($1::uuid[]) OR intent_ref = ANY($2::text[])", [userIds, intents.map((i) => i.id)]);
  await pool.query("DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds]);
  const orders = intents.map((i) => i.order_id).filter(Boolean);
  if (orders.length) await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [
    [...userIds.map((id) => `user:${id}:agent`), ...keys.map((k) => `agentkey:${k.id}`)],
  ]);
  await pool.query("DELETE FROM agent_keys WHERE user_id = ANY($1::uuid[])", [userIds]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

(async () => {
  const products = await loadProducts();
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { catalog, decisions, ledger } = engine;
  const courses = catalog.list().filter((p) => (p.type || "COURSE") === "COURSE");
  assert.ok(courses.length >= 3, "needs 3 courses in the catalog");
  const [A, B, C] = courses.map((c) => ({ course: c, slug: c.slug || c.id }));

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `m7_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const payments = [];
  const startPayment = async ({ intent, orderId }) => { payments.push({ intentId: intent.id, orderId }); return { status: "PAID" }; };
  const exec = (u, intentId, token, extra = {}) => agent.execute({ intentId, token, userId: u.id, catalog, decisions, startPayment, ...extra });
  const prop = (u, x, extra = {}) => agent.propose({ userId: u.id, productId: x.slug, provider: "mock", catalog, decisions, ...extra });
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));
  const events = async (id) => (await agent.listEvents(id)).map((e) => (e.code ? `${e.event}:${e.code}` : e.event));
  const ledgerCountBefore = (await ledger.getAll()).length;

  // ------------------------------------------------------------ propose
  const u = await newUser("u");
  const i1 = await prop(u, A);
  assert.equal(i1.status, "PROPOSED");
  assert.equal(i1.amount_cents, A.course.priceCents, "price taken from the catalog");
  assert.equal(i1.merchant, "LEARNX");
  await rejects(agent.propose({ userId: u.id, productId: "no-such-course", catalog, decisions }), "UNKNOWN_ITEM");
  await rejects(prop(u, A), "DUPLICATE_REQUEST");
  await rejects(exec(u, i1.id, "not-a-token"), "TAMPERED");
  console.log("[ok] M7 propose: item, merchant and price filled in by the server; unknown items and duplicates refused");

  const other = await newUser("other");
  const burst = await Promise.allSettled([prop(other, B), prop(other, B), prop(other, B)]);
  assert.equal(burst.filter((r) => r.status === "fulfilled").length, 1, "one open request per course");
  assert.ok(burst.filter((r) => r.status === "rejected").every((r) => r.reason.code === "DUPLICATE_REQUEST"));
  console.log("[ok] M7 3 concurrent proposals for one course -> 1 request, 2 DUPLICATE_REQUEST");

  // ------------------------------------------------------------ approval required
  await rejects(agent.approve({ intentId: i1.id, userId: other.id }), "NOT_FOUND");
  const { token } = await agent.approve({ intentId: i1.id, userId: u.id });
  assert.ok(token, "simulated agent gets its token at approval");
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
  const i2 = await prop(u, B);
  await rejects(exec(u, i2.id, token), "WRONG_INTENT");
  console.log("[ok] M7 changed amount, foreign signature, other user and other intent are all rejected");

  // ------------------------------------------------------------ price changed after approval
  const pricier = { list: () => catalog.list().map((x) => (x === A.course ? { ...x, priceCents: x.priceCents + 100 } : x)) };
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
  assert.equal(order.final_payable_cents, A.course.priceCents);
  assert.equal(order.status, "PENDING", "paid later by the normal webhook");
  assert.deepEqual(lines.map((l) => [l.item_id, l.paid_cents]), [[A.slug, A.course.priceCents]]);
  const done = await agent.getIntent(i1.id);
  assert.equal(done.status, "EXECUTED");
  assert.equal(agent.paymentState(done), "PENDING", "payment outcome read from the order");
  await rejects(exec(u, i1.id, token), "REPLAYED");
  await rejects(agent.cancel({ intentId: i1.id, userId: u.id }), "ALREADY_EXECUTED");
  console.log("[ok] M7 valid approval: one normal order for the approved amount; 3 concurrent sends -> 1 executed, 2 REPLAYED");

  // ------------------------------------------------------------ audit trail
  const ev1 = await events(i1.id);
  for (const e of ["PROPOSED", "APPROVED", "REJECTED:TAMPERED", "REJECTED:WRONG_USER", "REJECTED:PRICE_CHANGED", "EXECUTED", "REJECTED:REPLAYED", "REJECTED:ALREADY_EXECUTED"])
    assert.ok(ev1.includes(e), `history has ${e}: ${ev1.join(", ")}`);
  assert.equal(ev1.filter((e) => e === "EXECUTED").length, 1);
  console.log("[ok] M7 every step and every rejected attempt is in the request's history");

  // ------------------------------------------------------------ cancelled
  const t2 = (await agent.approve({ intentId: i2.id, userId: u.id })).token;
  await agent.cancel({ intentId: i2.id, userId: u.id });
  await rejects(exec(u, i2.id, t2), "CANCELLED");
  await rejects(prop(u, A), "PAYMENT_PENDING"); // i1 for A is still waiting for its payment
  await pool.query("UPDATE orders SET status='FAILED' WHERE id=$1", [orderId]); // ...until that payment fails
  const i3 = await prop(u, A); // now A can be requested again
  await rejects(exec(u, i3.id, t2), "WRONG_INTENT");
  console.log("[ok] M7 a cancelled approval is rejected");

  // ------------------------------------------------------------ expired + sweeper
  const t3 = (await agent.approve({ intentId: i3.id, userId: u.id, ttlSeconds: 1 })).token;
  await sleep(1500);
  await rejects(exec(u, i3.id, t3), "EXPIRED");
  await agent.sweep();
  assert.equal((await agent.getIntent(i3.id)).status, "EXPIRED", "sweeper closes a lapsed approval");
  assert.ok((await events(i3.id)).includes("EXPIRED"));
  const i7 = await prop(u, B); // i2 for B was cancelled
  await pool.query("UPDATE purchase_intents SET created_at = now() - interval '25 hours' WHERE id=$1", [i7.id]);
  await agent.sweep();
  assert.equal((await agent.getIntent(i7.id)).status, "EXPIRED", "sweeper closes a proposal nobody approved");
  console.log("[ok] M7 an expired approval is rejected; the sweeper expires lapsed approvals and day-old proposals");

  // ------------------------------------------------------------ owned by now
  const i4 = await prop(u, A); // proposal works again: i3 is EXPIRED
  const t4 = (await agent.approve({ intentId: i4.id, userId: u.id })).token;
  const owns = { evaluateAccess: () => ({ allowed: true }) };
  await rejects(exec(u, i4.id, t4, { decisions: owns }), "ALREADY_OWNED");
  const f4 = await agent.getIntent(i4.id);
  assert.equal(f4.status, "FAILED");
  assert.equal(f4.order_id, null, "nothing was bought");
  console.log("[ok] M7 bought another way after approval -> ALREADY_OWNED, no second order");

  // ------------------------------------------------------------ payment failure
  const i5 = await prop(u, A);
  const t5 = (await agent.approve({ intentId: i5.id, userId: u.id })).token;
  await rejects(exec(u, i5.id, t5, { startPayment: async () => { throw new Error("provider down"); } }), "PAYMENT_FAILED");
  const f = await agent.getIntent(i5.id);
  assert.equal(f.status, "FAILED");
  assert.equal(f.order_status, "FAILED");
  assert.equal(agent.paymentState(f), "FAILED");
  await rejects(exec(u, i5.id, t5), "REPLAYED");
  console.log("[ok] M7 provider failure: request FAILED, order FAILED, approval cannot be reused");

  // ------------------------------------------------------------ unpaid (abandoned checkout)
  const i6 = await prop(u, C);
  const t6 = (await agent.approve({ intentId: i6.id, userId: u.id })).token;
  const out6 = await exec(u, i6.id, t6, { startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "/checkout/x" }) });
  await agent.sweep();
  assert.equal((await agent.getIntent(i6.id)).status, "EXECUTED", "not failed before AGENT_UNPAID_MINUTES");
  await pool.query("UPDATE purchase_intents SET executed_at = now() - interval '2 hours' WHERE id=$1", [i6.id]);
  await agent.sweep();
  const f6 = await agent.getIntent(i6.id);
  assert.equal(f6.status, "FAILED");
  assert.match(f6.failure_reason, /not completed/);
  assert.ok((await events(i6.id)).includes("FAILED:UNPAID"));
  await pool.query("UPDATE orders SET status='COMPLETED' WHERE id=$1", [out6.orderId]); // the user paid late after all
  assert.equal(agent.paymentState(await agent.getIntent(i6.id)), "PAID", "a late payment still shows as PAID");
  console.log("[ok] M7 executed but never paid -> FAILED by the sweeper; the order is left to the normal webhook");

  // ------------------------------------------------------------ the user picks the provider before approving
  {
    const up = await newUser("provider");
    const other = await newUser("provider-other");
    const ip = await prop(up, B); // proposed with mock
    await rejects(agent.setProvider({ intentId: ip.id, userId: other.id, provider: "razorpay" }), "NOT_FOUND");
    await rejects(agent.setProvider({ intentId: ip.id, userId: up.id, provider: "paypal" }), "BAD_PROVIDER");
    const changed = await agent.setProvider({ intentId: ip.id, userId: up.id, provider: "razorpay" });
    assert.equal(changed.provider, "razorpay");
    assert.equal(changed.amount_cents, B.course.priceCents, "price unchanged");
    assert.ok((await events(ip.id)).includes("PROVIDER_CHANGED"));
    await agent.approve({ intentId: ip.id, userId: up.id });
    await rejects(agent.setProvider({ intentId: ip.id, userId: up.id, provider: "mock" }), "ALREADY_APPROVED");
  }
  console.log("[ok] M7 the user can switch Razorpay / mock only before approving, only on their own request; logged");

  // ------------------------------------------------------------ waiting for payment blocks a second request
  {
    const uw = await newUser("waiting");
    const w1 = await prop(uw, A);
    const { token: wt } = await agent.approve({ intentId: w1.id, userId: uw.id });
    await exec(uw, w1.id, wt, { startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "/pay" }) });
    assert.equal((await agent.getIntent(w1.id)).pay_url, "/pay", "the checkout link is stored on the request");
    await rejects(prop(uw, A), "PAYMENT_PENDING");
    const o = (await agent.getIntent(w1.id)).order_id;
    await pool.query("UPDATE orders SET status='FAILED' WHERE id=$1", [o]);
    const w2 = await prop(uw, A);
    assert.equal(w2.status, "PROPOSED", "once that payment failed, a new request is allowed");
    // The user cancelled at checkout, then the money arrived anyway: the sweeper restores the request.
    await pool.query("UPDATE purchase_intents SET status='FAILED', failure_reason='Payment cancelled at checkout' WHERE id=$1", [w1.id]);
    await pool.query("UPDATE orders SET status='COMPLETED' WHERE id=$1", [o]);
    await agent.sweep({ userId: uw.id });
    const back = await agent.getIntent(w1.id);
    assert.deepEqual([back.status, back.failure_reason, agent.paymentState(back)], ["EXECUTED", null, "PAID"]);
    assert.ok((await events(w1.id)).includes("PAID_LATE"));
  }
  console.log("[ok] M7 a request waiting for payment blocks a second one (no double charge); paid after a cancel -> EXECUTED again (PAID_LATE)");

  // ------------------------------------------------------------ daily proposal limit
  const u3 = await newUser("limit");
  await withEnv({ AGENT_PROPOSALS_PER_DAY: "2" }, async () => {
    await prop(u3, A);
    await prop(u3, B);
    await rejects(prop(u3, C), "RATE_LIMITED");
  });
  console.log("[ok] M7 proposals over the daily limit -> RATE_LIMITED");

  // ------------------------------------------------------------ ledger untouched
  assert.equal((await ledger.getAll()).length, ledgerCountBefore, "agent flow writes nothing to the ledger itself");
  console.log("[ok] M7 the agent flow wrote nothing to the ledger (purchases arrive through the normal webhook)");

  // ================================================================ HTTP: agent keys + API
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.locals.engine = engine;
  app.locals.agentStartPayment = startPayment;
  app.use(require("../routes/agent"));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ua = await newUser("api");
  const testPassword = randomBytes(12).toString("hex"); // generated here, never printed
  await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [ua.id, await bcrypt.hash(testPassword, 4)]);
  const cookie = `token=${jwt.sign({ sub: ua.id, email: ua.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const k1 = await agentKeys.createKey({ userId: ua.id, name: "test-agent" });
  const k3 = await agentKeys.createKey({ userId: ua.id, name: "second-agent" });
  const call = async (method, path, { key, body, cookie: c, form } = {}) => {
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    if (c) headers.Cookie = c;
    if (body) headers["Content-Type"] = "application/json";
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const r = await fetch(base + path, { method, headers, redirect: "manual",
      body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };

  // An agent identity (the kind LEARNX Assistant uses) proposes; only the user can approve.
  const created = await agent.propose({ userId: ua.id, productId: C.slug, provider: "mock", agentName: "test-agent", agentKeyId: k1.row.id, catalog, decisions });
  const id = created.id;
  assert.equal(created.amount_cents, C.course.priceCents, "amount from the catalog, not the agent");

  // The simulated agent, the agent-key API and key management were removed.
  for (const [m, path] of [["POST", "/agent/propose"], ["GET", "/agent/api/courses"], ["POST", "/agent/api/intents"], ["POST", "/agent/keys"], ["POST", `/agent/intents/${id}/execute`]])
    assert.equal((await call(m, path, m === "GET" ? { cookie } : { cookie, form: {} })).status, 404, `${m} ${path} is gone`);
  const page = await call("GET", "/agent", { cookie });
  assert.match(page.text, /LEARNX Assistant/);
  assert.ok(!/Simulated agent|Agent keys/.test(page.text), "no simulated agent / agent keys panels");
  console.log("[ok] M7 simulated agent, agent-key API and key management are gone; /agent shows the assistant");

  // Approving needs the login session
  assert.equal((await call("POST", `/agent/intents/${id}/approve`, { form: {} })).status, 302, "redirected to login");
  assert.equal((await call("POST", `/assistant/approve/${id}`, { form: {} })).status, 302, "card button needs login too");
  assert.equal((await agent.getIntent(id)).status, "PROPOSED");
  console.log("[ok] M7 approve (page or card button) needs the user's login session");

  // Step-up: password required above the threshold, on the card button and on the page
  await withEnv({ AGENT_STEPUP_ABOVE_CENTS: "1" }, async () => {
    const card = await call("POST", `/assistant/approve/${id}`, { cookie, form: { password: "wrong" } });
    assert.equal(card.status, 200);
    assert.match(card.text, /Password is wrong or missing/);
    assert.match(card.text, /hx-swap-oob/, "the card is updated in place");
    const reviewPg = await call("GET", `/agent/intents/${id}`, { cookie });
    assert.match(reviewPg.text, /enter your password/);
    for (const html of [card.text, reviewPg.text]) {
      assert.match(html, /type="password" name="password" autocomplete="new-password"/, "the browser must not autofill the saved password");
    }
    assert.equal((await call("POST", `/agent/intents/${id}/approve`, { cookie, form: {} })).status, 403);
    assert.equal((await agent.getIntent(id)).status, "PROPOSED", "not approved without the password");
    const ok2 = await call("POST", `/agent/intents/${id}/approve`, { cookie, form: { password: testPassword } });
    assert.equal(ok2.status, 303);
    assert.equal(ok2.headers.get("location"), "/agent");
  });
  assert.equal((await agent.getIntent(id)).status, "APPROVED");
  assert.ok((await events(id)).filter((e) => e === "APPROVE_DENIED:STEP_UP_FAILED").length === 2);
  console.log("[ok] M7 step-up: wrong / missing password -> refused and logged (card and page); right password approves");

  // Token pickup: once, by the proposing agent only; the browser never gets it
  assert.equal(await agent.pickupToken({ intentId: id, agentKeyId: k3.row.id }), null, "another agent can't collect it");
  const tok = await agent.pickupToken({ intentId: id, agentKeyId: k1.row.id });
  assert.ok(tok, "token handed to the proposing agent");
  assert.equal(await agent.pickupToken({ intentId: id, agentKeyId: k1.row.id }), null, "only once");
  console.log("[ok] M7 the approval token is collected once, only by the agent that proposed");

  // Execute: wrong agent (another identity, or none) is refused; the owner executes once
  await rejects(exec(ua, id, tok, { agentKeyId: k3.row.id }), "WRONG_AGENT");
  await rejects(exec(ua, id, tok, { agentKeyId: null }), "WRONG_AGENT");
  const paid = await exec(ua, id, tok, { agentKeyId: k1.row.id });
  assert.equal(paid.status, "PAID");
  await rejects(exec(ua, id, tok, { agentKeyId: k1.row.id }), "REPLAYED");
  console.log("[ok] M7 other agent / no agent -> WRONG_AGENT; the proposing agent executes once; replay -> REPLAYED");

  const hist = await call("GET", `/agent/intents/${id}`, { cookie });
  assert.match(hist.text, /History/);
  assert.match(hist.text, /TOKEN_ISSUED/);
  assert.match(hist.text, /WRONG_AGENT/);
  console.log("[ok] M7 request history (incl. rejected attempts) visible to the user");

  assert.equal((await ledger.getAll()).length, ledgerCountBefore, "still nothing written to the ledger");
  console.log("\nM7 CHECKS PASSED");
  await cleanup();
  await pool.end();
})().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

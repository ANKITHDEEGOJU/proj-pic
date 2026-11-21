"use strict";
// Coupons on agent purchases, against Postgres (payment stubbed, no model needed).
//   - propose with a coupon: amount = discounted price, list price + coupon stored, logged
//   - refused coupons (unknown, expired, disabled, scheduled, other course, pass-only, not eligible,
//     free after discount, bad characters) -> BAD_COUPON, no request, no daily-limit unit used
//   - the user applies / removes a coupon on the card: only the owner, only while PROPOSED
//   - approve checks the price the user saw (stale card -> PRICE_CHANGED, nothing approved)
//   - the approval token pins list price + coupon; execute re-checks the coupon:
//     disabled or changed after approval -> COUPON_INVALID, request FAILED, nothing ordered
//   - the order carries subtotal / discount / rule; the line's paid amount is the discounted price
//   - HTTP: card shows the struck price and the coupon field; Apply / Remove / refused code
// Removes its rules, requests, orders and quota rows; its @test.local users stay.
require("dotenv").config();
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("../src/db");
const { createEngine } = require("../src/domain");
const { loadProducts } = require("../src/domain/catalogLoader");
const { PgLedgerStore } = require("../src/domain/stores/pgLedgerStore");
const { attachUser } = require("../src/auth");
const agent = require("../src/services/agentPurchase");

const TAG = randomUUID().slice(0, 6).toUpperCase();
const code = (name) => `T${TAG}${name}`;
const userIds = [];
let server, model;

async function cleanup() {
  if (server) server.close();
  if (model) model.close();
  await pool.query("DELETE FROM pricing_rules WHERE code LIKE $1", [`T${TAG}%`]);
  if (!userIds.length) return;
  const intents = (await pool.query("SELECT id, order_id FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  await pool.query("DELETE FROM intent_events WHERE user_id = ANY($1::uuid[]) OR intent_ref = ANY($2::text[])", [userIds, intents.map((i) => i.id)]);
  await pool.query("DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds]);
  const orders = intents.map((i) => i.order_id).filter(Boolean);
  if (orders.length) {
    await pool.query("DELETE FROM order_line_items WHERE order_id = ANY($1::uuid[])", [orders]);
    await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orders]);
  }
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [userIds.map((id) => `user:${id}:agent`)]);
}

(async () => {
  const engine = createEngine({ products: await loadProducts(), store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { catalog, decisions } = engine;
  const courses = catalog.list().filter((p) => (p.type || "COURSE") === "COURSE");
  const [A, B] = [courses[0], courses[1]];
  const aId = A.slug || A.id, bId = B.slug || B.id;

  const rule = async (name, o = {}) => (await pool.query(
    `INSERT INTO pricing_rules (code, rule_name, application_mode, discount_type, value, applicable_product, applicable_course_ids, eligibility_targets, start_at, expires_at, is_disabled)
     VALUES ($1,$2,'CODE_REQUIRED',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [code(name), `test ${name}`, o.type || "PERCENTAGE", o.value ?? 20, o.product || "ALL", o.courses || ["*"], o.targets || ["*"],
      o.start || new Date(Date.now() - 60e3), o.expires || null, o.disabled || false]
  )).rows[0];
  const R = {
    pct: await rule("PCT20", { value: 20 }),
    fixed: await rule("FIX5", { type: "FIXED_DISCOUNT", value: 500 }),
    free: await rule("FREE", { value: 100 }),
    expired: await rule("OLD", { expires: new Date(Date.now() - 1000) }),
    disabled: await rule("OFF", { disabled: true }),
    later: await rule("LATER", { start: new Date(Date.now() + 86400e3) }),
    otherCourse: await rule("ONLYB", { courses: [bId] }),
    passOnly: await rule("PASS", { product: "SUBSCRIPTION_ONLY" }),
    vip: await rule("VIP", { targets: ["vip@nowhere.test"] }),
    toDisable: await rule("SOON", { value: 10 }),
    toChange: await rule("CHANGE", { value: 10 }),
    dotted: await rule("NEW.YEAR", { value: 10 }),
  };

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `cpn_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const propose = (u, productId, couponCode) => agent.propose({ userId: u.id, productId, provider: "mock", couponCode, agentName: "coupon-test", catalog, decisions });
  const usage = async (u) => (await pool.query("SELECT count(*)::int n FROM usage_events WHERE user_id=$1 AND status='CONSUMED'", [u.id])).rows[0].n;
  const rejects = (p, c, msg) => assert.rejects(p, (e) => { assert.equal(e.code, c, `${msg}: got ${e.code} ${e.message}`); return true; });
  const payments = [];
  const startPayment = async ({ intent, orderId }) => { payments.push({ intent, orderId }); return { status: "CHECKOUT", redirectUrl: `http://mock.test/pay/${orderId}` }; };
  const run = async (u, i) => agent.execute({ intentId: i.id, token: (await agent.approve({ intentId: i.id, userId: u.id, expectAmountCents: i.amount_cents })).token, userId: u.id, catalog, decisions, startPayment });

  // ------------------------------------------------------------ propose with a coupon
  const u1 = await newUser("ok");
  const i1 = await propose(u1, aId, code("pct20").toLowerCase()); // codes are case-insensitive
  const off = Math.round(A.priceCents * 0.2);
  assert.deepEqual([i1.list_amount_cents, i1.discount_cents, i1.amount_cents, i1.coupon_code, i1.coupon_rule_id],
    [A.priceCents, off, A.priceCents - off, code("PCT20"), R.pct.id]);
  assert.match((await agent.listEvents(i1.id))[0].detail, new RegExp(`coupon ${code("PCT20")} -${off}`));
  const i1b = await propose(u1, bId, code("FIX5"));
  assert.equal(i1b.amount_cents, B.priceCents - 500, "fixed discount");
  console.log("[ok] propose with a coupon: discounted amount, list price, coupon and rule stored (case-insensitive code), logged");

  // ------------------------------------------------------------ refused coupons
  const u2 = await newUser("bad");
  const before = await usage(u2);
  const cases = [
    ["NOPE" + TAG, /Invalid coupon code/], [code("OLD"), /expired/], [code("OFF"), /disabled/], [code("LATER"), /not active yet/],
    [code("ONLYB"), /not applicable/], [code("PASS"), /only valid for subscription/], [code("VIP"), /not eligible/],
    [code("FREE"), /makes the course free/], ["bad code!", /not valid/], ["x".repeat(41), /not valid/],
  ];
  for (const [c, re] of cases) {
    await assert.rejects(propose(u2, aId, c), (e) => e.code === "BAD_COUPON" && re.test(e.message), `coupon ${c}`);
  }
  assert.equal((await agent.listIntents(u2.id)).length, 0, "no request created");
  assert.equal(await usage(u2), before, "a refused coupon uses no daily proposal");
  assert.equal((await propose(u2, bId, code("ONLYB"))).coupon_code, code("ONLYB"), "a course-scoped coupon works on its course");
  console.log("[ok] refused coupons (unknown, expired, disabled, not yet active, other course, pass-only, not eligible, free, bad characters, too long) -> BAD_COUPON, nothing created, no limit used");

  // ------------------------------------------------------------ card: apply / remove, owner only, PROPOSED only
  const u3 = await newUser("card");
  const other = await newUser("other");
  let i3 = await propose(u3, aId, null);
  assert.equal(i3.amount_cents, A.priceCents);
  i3 = await agent.setCoupon({ intentId: i3.id, userId: u3.id, couponCode: code("PCT20"), catalog });
  assert.equal(i3.amount_cents, A.priceCents - off);
  await rejects(agent.setCoupon({ intentId: i3.id, userId: other.id, couponCode: code("FIX5"), catalog }), "NOT_FOUND", "another user");
  await rejects(agent.setCoupon({ intentId: i3.id, userId: u3.id, couponCode: code("OLD"), catalog }), "BAD_COUPON", "expired");
  assert.equal((await agent.getIntent(i3.id)).coupon_code, code("PCT20"), "a refused code leaves the applied one");
  i3 = await agent.setCoupon({ intentId: i3.id, userId: u3.id, couponCode: "", catalog });
  assert.deepEqual([i3.amount_cents, i3.coupon_code, i3.discount_cents], [A.priceCents, null, 0], "removed");
  const evs = (await agent.listEvents(i3.id)).map((e) => e.event);
  assert.ok(evs.includes("COUPON_APPLIED") && evs.includes("COUPON_REMOVED") && evs.includes("COUPON_REJECTED"));
  console.log("[ok] card coupon: apply / remove by the owner only; a refused code changes nothing; all logged");

  // ------------------------------------------------------------ approve checks the price the user saw
  const shown = i3.amount_cents; // card shows the full price
  await agent.setCoupon({ intentId: i3.id, userId: u3.id, couponCode: code("PCT20"), catalog }); // e.g. another tab
  await rejects(agent.approve({ intentId: i3.id, userId: u3.id, expectAmountCents: shown }), "PRICE_CHANGED", "stale card");
  assert.equal((await agent.getIntent(i3.id)).status, "PROPOSED", "nothing approved");
  await rejects(agent.approve({ intentId: i3.id, userId: u3.id, expectAmountCents: "abc" }), "PRICE_CHANGED", "garbage amount");
  const ap = await agent.approve({ intentId: i3.id, userId: u3.id, expectAmountCents: A.priceCents - off });
  assert.equal(ap.intent.status, "APPROVED");
  await rejects(agent.setCoupon({ intentId: i3.id, userId: u3.id, couponCode: "", catalog }), "ALREADY_APPROVED", "no coupon change after approval");
  const claims = jwt.decode(ap.token);
  assert.deepEqual([claims.amount, claims.list, claims.coupon], [A.priceCents - off, A.priceCents, code("PCT20")], "token pins amount, list price and coupon");
  console.log("[ok] approve: a stale card (price changed) is refused and nothing is approved; the token pins amount, list price and coupon; no change after approval");

  // Step-up race: the card is under the password threshold thanks to a coupon; the coupon is removed
  // (other tab) while an Approve without password is sent -> refused, nothing approved.
  const ur = await newUser("race");
  let ir = await propose(ur, aId, code("PCT20"));
  const threshold = ir.amount_cents; // pretend the password is needed above the discounted price
  await agent.setCoupon({ intentId: ir.id, userId: ur.id, couponCode: "", catalog }); // now above the threshold
  await rejects(agent.approve({ intentId: ir.id, userId: ur.id, expectAmountCents: A.priceCents, noPasswordMaxCents: threshold }), "STEP_UP_REQUIRED", "no password above the threshold");
  assert.equal((await agent.getIntent(ir.id)).status, "PROPOSED");
  assert.ok((await agent.listEvents(ir.id)).some((e) => e.code === "STEP_UP_REQUIRED"));
  await rejects(agent.approve({ intentId: ir.id, userId: ur.id, expectAmountCents: "missing" }), "PRICE_CHANGED", "Approve without the shown amount");
  // A code with a dot (valid in the cart) works here too.
  ir = await agent.setCoupon({ intentId: ir.id, userId: ur.id, couponCode: code("new.year"), catalog });
  assert.equal(ir.coupon_code, code("NEW.YEAR"));
  console.log("[ok] step-up race (coupon removed while approving without password) -> STEP_UP_REQUIRED; Approve without the amount -> refused; codes with dots work");

  // ------------------------------------------------------------ execute: order carries the discount
  const out = await agent.execute({ intentId: i3.id, token: ap.token, userId: u3.id, catalog, decisions, startPayment });
  const order = (await pool.query("SELECT subtotal_cents, discount_cents, final_payable_cents, applied_rule_id FROM orders WHERE id=$1", [out.orderId])).rows[0];
  assert.deepEqual(order, { subtotal_cents: A.priceCents, discount_cents: off, final_payable_cents: A.priceCents - off, applied_rule_id: R.pct.id });
  const line = (await pool.query("SELECT unit_price_cents, paid_cents FROM order_line_items WHERE order_id=$1", [out.orderId])).rows[0];
  assert.deepEqual(line, { unit_price_cents: A.priceCents, paid_cents: A.priceCents - off }, "the ledger will record what was really paid");
  console.log("[ok] execute: order subtotal / discount / final / rule set; the line's paid amount is the discounted price");

  // ------------------------------------------------------------ coupon changes between approval and payment
  const u4 = await newUser("late");
  const i4 = await propose(u4, aId, code("SOON"));
  const ap4 = await agent.approve({ intentId: i4.id, userId: u4.id, expectAmountCents: i4.amount_cents });
  await pool.query("UPDATE pricing_rules SET is_disabled = true WHERE id=$1", [R.toDisable.id]);
  await rejects(agent.execute({ intentId: i4.id, token: ap4.token, userId: u4.id, catalog, decisions, startPayment }), "COUPON_INVALID", "disabled after approval");
  const f4 = await agent.getIntent(i4.id);
  assert.equal(f4.status, "FAILED");
  assert.match(f4.failure_reason, /no longer valid: This coupon has been disabled/);
  assert.equal(f4.order_id, null, "no order, nothing charged");
  assert.ok(await propose(u4, aId, null), "the user can ask again");

  const u5 = await newUser("chg");
  const i5 = await propose(u5, aId, code("CHANGE"));
  const ap5 = await agent.approve({ intentId: i5.id, userId: u5.id, expectAmountCents: i5.amount_cents });
  await pool.query("UPDATE pricing_rules SET value = 50 WHERE id=$1", [R.toChange.id]); // now a bigger discount
  await rejects(agent.execute({ intentId: i5.id, token: ap5.token, userId: u5.id, catalog, decisions, startPayment }), "COUPON_INVALID", "different price now");
  assert.match((await agent.getIntent(i5.id)).failure_reason, /now gives a different price/);

  const u6 = await newUser("tamper");
  const i6 = await propose(u6, aId, code("PCT20"));
  const ap6 = await agent.approve({ intentId: i6.id, userId: u6.id, expectAmountCents: i6.amount_cents });
  await pool.query("UPDATE purchase_intents SET coupon_code=$2 WHERE id=$1", [i6.id, code("FIX5")]); // changed behind the approval
  await rejects(agent.execute({ intentId: i6.id, token: ap6.token, userId: u6.id, catalog, decisions, startPayment }), "MISMATCH", "coupon changed behind the token");
  const forged = jwt.sign({ ...jwt.decode(ap6.token), coupon: code("FREE") }, "wrong-key");
  await rejects(agent.execute({ intentId: i6.id, token: forged, userId: u6.id, catalog, decisions, startPayment }), "TAMPERED", "token edited");
  console.log("[ok] coupon disabled / changed after approval -> COUPON_INVALID, request FAILED, no order; coupon changed behind the token -> MISMATCH; edited token -> TAMPERED");

  // A request without a coupon still works exactly as before (list = amount, no discount).
  const u7 = await newUser("plain");
  const i7 = await propose(u7, bId, null);
  const o7 = await run(u7, i7);
  const ord7 = (await pool.query("SELECT subtotal_cents, discount_cents, final_payable_cents, applied_rule_id FROM orders WHERE id=$1", [o7.orderId])).rows[0];
  assert.deepEqual(ord7, { subtotal_cents: B.priceCents, discount_cents: 0, final_payable_cents: B.priceCents, applied_rule_id: null });
  console.log("[ok] without a coupon nothing changes (full price, no discount, no rule)");

  // ------------------------------------------------------------ HTTP: card
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(attachUser);
  app.locals.engine = engine;
  app.locals.agentStartPayment = startPayment;
  app.use(require("../src/routes/agent"));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).send(err.message); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const uh = await newUser("http");
  const cookie = `token=${jwt.sign({ sub: uh.id, email: uh.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const post = async (path, form, c = cookie) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", redirect: "manual",
      headers: { Cookie: c, "HX-Request": "true", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { status: r.status, text: await r.text() };
  };
  const ih = await propose(uh, aId, null);
  let r = await post(`/assistant/coupon/${ih.id}`, { coupon: code("pct20") });
  assert.match(r.text, /hx-swap-oob="true"/);
  assert.match(r.text, new RegExp(`<s[^>]*>${(A.priceCents / 100).toFixed(2)} [A-Z]{3}</s> ${((A.priceCents - off) / 100).toFixed(2)}`), "struck list price and the new price");
  assert.match(r.text, new RegExp(`coupon <code>${code("PCT20")}</code>`));
  assert.match(r.text, new RegExp(`name="amount" value="${A.priceCents - off}"`), "Approve carries the price shown");
  assert.match(r.text, />Remove</);
  r = await post(`/assistant/coupon/${ih.id}`, { coupon: code("OLD") });
  assert.match(r.text, /class="err"[^>]*>This coupon has expired/);
  r = await post(`/assistant/coupon/${ih.id}`, { coupon: "" });
  assert.ok(!/<s /.test(r.text) && /Coupon code \(optional\)/.test(r.text), "removed -> plain price and the field again");
  const intruder = `token=${jwt.sign({ sub: other.id, email: other.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  r = await post(`/assistant/coupon/${ih.id}`, { coupon: code("PCT20") }, intruder);
  assert.match(r.text, /not found/);
  assert.equal((await agent.getIntent(ih.id)).coupon_code, null, "another user can't apply a coupon");
  await agent.setCoupon({ intentId: ih.id, userId: uh.id, couponCode: code("PCT20"), catalog });
  r = await post(`/assistant/approve/${ih.id}`, { amount: String(A.priceCents), provider: "mock" }); // card showed the old price
  assert.match(r.text, /The price changed/);
  assert.equal((await agent.getIntent(ih.id)).status, "PROPOSED");
  console.log("[ok] HTTP card: Apply shows the struck list price + coupon + Remove; refused code shows why; another user can't; Approve with an outdated price is refused");

  // ------------------------------------------------------------ the assistant passes the user's code
  // A scripted OpenAI-compatible model: "buy <course> with code <X>" -> propose_purchase(couponCode X).
  for (const k of ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "GROQ_API_KEY", "GROQ_BASE_URL"]) delete process.env[k];
  const http = require("node:http");
  const seen = [];
  model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { messages } = JSON.parse(body);
      const last = messages[messages.length - 1];
      const result = last.role === "tool" ? JSON.parse(last.content) : null;
      let message;
      if (result && !Array.isArray(result)) { // the propose_purchase result
        seen.push(result);
        message = { role: "assistant", content: "Done." };
      } else { // first turn, or after the app's own list_courses lookup for a buy request
        const u = [...messages].reverse().find((m) => m.role === "user").content;
        const m = /code (\S+)/.exec(u);
        message = { role: "assistant", content: null, tool_calls: [{ id: `c${seen.length}`, type: "function",
          function: { name: "propose_purchase", arguments: JSON.stringify({ productId: aId, couponCode: m[1] }) } }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  const assistant = require("../src/services/assistant");
  const ua = await newUser("asst");
  await assistant.chat({ user: ua, text: `please buy it with code ${code("PCT20")}`, catalog, decisions, startPayment, ip: "127.0.0.1" });
  const okResult = seen.find((x) => x.coupon);
  assert.ok(okResult, "tool result shows the coupon");
  assert.equal(okResult.coupon, code("PCT20"));
  assert.equal(okResult.amount, `${((A.priceCents - off) / 100).toFixed(2)} ${A.currency || "USD"}`);
  assert.equal(okResult.listPrice, `${(A.priceCents / 100).toFixed(2)} ${A.currency || "USD"}`);
  await agent.cancel({ intentId: okResult.intentId, userId: ua.id });
  await assistant.chat({ user: ua, text: "buy it with code MADEUP-123", catalog, decisions, startPayment, ip: "127.0.0.1" });
  const bad = seen[seen.length - 1];
  assert.equal(bad.error, "BAD_COUPON");
  assert.match(bad.message, /Invalid coupon code/);
  assert.equal((await agent.listIntents(ua.id)).filter((x) => x.status === "PROPOSED").length, 0, "an invented code creates no request");
  await pool.query("DELETE FROM assistant_messages WHERE user_id=$1", [ua.id]);
  {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('learnx.assistant_log_purge', 'on', true)");
      await c.query("DELETE FROM assistant_log WHERE user_id=$1", [ua.id]);
      await c.query("COMMIT");
    } finally { c.release(); }
  }
  await pool.query("DELETE FROM usage_counters WHERE scope_key=$1", [`user:${ua.id}:assistant`]);
  console.log("[ok] assistant: the user's code goes to propose_purchase -> discounted request; an invented code -> BAD_COUPON to the model, no request");

  console.log("\nAGENT COUPON CHECKS PASSED");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error("cleanup:", e.message)); await pool.end(); });

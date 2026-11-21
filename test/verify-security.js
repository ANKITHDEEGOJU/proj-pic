"use strict";
// Security checks over HTTP against Postgres (small limits set here, nothing external called):
//   - login: N wrong passwords per email -> blocked, even with the right password, until the window
//     ends; a success resets the count; per-IP cap; register per-IP cap
//   - step-up password: N wrong -> locked (no bcrypt), logged STEP_UP_LOCKED, request stays PROPOSED
//   - forged sessions: alg=none, wrong key, edited payload -> not logged in
//   - /api/dev/events: 404 for users, 404 for the admin unless ENABLE_DEV_EVENTS=1; bad input -> 400
//   - error handler: no internal error text to the client, only a reference
//   - malformed ids on org routes: 404, no crash
//   - the admin stays in the admin pages: admin navbar, login lands on /admin, shopper pages
//     redirect, shopper actions refused; guides and /org/<id> stay open; learners unaffected
//   - organizations (ADR-023): a learner requests one, only the admin approves / rejects; the
//     requester then manages it (buys, assigns); the admin only looks; a seat holder only sees
//     their organization and course
// Removes its requests, quota rows, organizations and orders; its @test.local users stay.
process.env.LOGIN_MAX_FAILS = "3";
process.env.LOGIN_MAX_PER_IP = "1000";
process.env.REGISTER_MAX_PER_IP = "1000";
process.env.STEPUP_MAX_FAILS = "3";
process.env.AGENT_STEPUP_ABOVE_CENTS = "1";
delete process.env.ENABLE_DEV_EVENTS;
require("dotenv").config();
process.env.MOCK_PROVIDER_URL = "http://mock.test"; // seat checkout links only; nothing is called
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../src/db");
const { createEngine } = require("../src/domain");
const { loadProducts } = require("../src/domain/catalogLoader");
const { PgLedgerStore } = require("../src/domain/stores/pgLedgerStore");
const { attachUser, keepAdminInAdminArea } = require("../src/auth");
const agent = require("../src/services/agentPurchase");
const limit = require("../src/services/rateLimit");
// Clears every login counter (per email+IP, per email, per IP) between scenarios.
const resetLogin = () => { for (const k of [...limit._buckets.keys()]) if (/^login(Fail|Email|Ip):/.test(k)) limit._buckets.delete(k); };

const userIds = [];
const orgIds = [];
let server;
async function cleanup() {
  if (server) server.close();
  if (orgIds.length) {
    await pool.query("DELETE FROM org_seat_pools WHERE org_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
  }
  if (!userIds.length) return;
  await pool.query("DELETE FROM org_requests WHERE user_id = ANY($1::uuid[])", [userIds]);
  const orders = (await pool.query("SELECT id FROM orders WHERE user_id = ANY($1::uuid[])", [userIds])).rows.map((r) => r.id);
  await pool.query("DELETE FROM order_line_items WHERE order_id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orders]);
  const intents = (await pool.query("SELECT id FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds])).rows.map((r) => r.id);
  await pool.query("DELETE FROM intent_events WHERE user_id = ANY($1::uuid[]) OR intent_ref = ANY($2::text[])", [userIds, intents]);
  await pool.query("DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [userIds.map((id) => `user:${id}:agent`)]);
}

(async () => {
  const engine = createEngine({ products: await loadProducts(), store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const course = engine.catalog.list().find((p) => (p.type || "COURSE") === "COURSE");
  const PW = "correct horse battery";
  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id, email", [
      `sec_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`, await bcrypt.hash(PW, 4)])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const admin = await newUser("admin");
  process.env.ADMIN_EMAIL = admin.email;

  const app = express();
  app.set("trust proxy", "loopback"); // as in server.js: a proxy on this machine (ngrok) is trusted
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.use(keepAdminInAdminArea); // as in server.js
  app.locals.engine = engine;
  app.locals.agentStartPayment = async () => ({ status: "CHECKOUT", redirectUrl: "http://mock.test/pay/x" });
  app.use(require("../src/routes/auth"));
  app.use(require("../src/routes/commerce"));
  app.use(require("../src/routes/agent"));
  app.use(require("../src/routes/org"));
  app.get("/boom", () => { throw new Error('relation "secret_internal_table" does not exist'); });
  app.use(require("../src/errorHandler"));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, path, { form, json, cookie, hx = true } = {}) => {
    const r = await fetch(base + path, { method, redirect: "manual", headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(hx ? { "HX-Request": "true" } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(json ? { "Content-Type": "application/json" } : {}) },
      body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined });
    return { status: r.status, text: await r.text(), redirect: r.headers.get("HX-Redirect"), location: r.headers.get("location"), retry: r.headers.get("Retry-After") };
  };
  const sendFrom = async (ip, path, form) => {
    const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "HX-Request": "true", "X-Forwarded-For": ip,
      "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { text: await r.text(), redirect: r.headers.get("HX-Redirect") };
  };
  const cookieOf = (u) => `token=${jwt.sign({ sub: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const errorsOrigConsole = console.error;

  // ------------------------------------------------------------ login limits
  const u = await newUser("login");
  const login = (pw, email = u.email) => send("POST", "/login", { form: { email, password: pw } });
  assert.ok((await login(PW)).redirect, "right password logs in");
  for (let k = 0; k < 3; k++) assert.match((await login("wrong")).text, /Invalid credentials/);
  let r = await login(PW);
  assert.match(r.text, /Too many attempts\. Try again in/, "blocked after 3 failures, even with the right password");
  assert.ok(Number(r.retry) > 0, "Retry-After header");
  assert.match((await login(PW, u.email.toUpperCase())).text, /Too many attempts/, "same email in other case is the same account");
  resetLogin();
  assert.ok((await login(PW)).redirect, "after the window: logs in");
  await login("wrong"); await login("wrong");
  assert.ok((await login(PW)).redirect, "a success resets the failure count");
  assert.ok((await login("wrong")).text.includes("Invalid credentials") && !(await login("wrong")).text.includes("Too many"), "count restarted");
  resetLogin();
  assert.match((await login("x".repeat(100000))).text, /Invalid credentials/, "a huge password is cut, no crash");
  process.env.LOGIN_MAX_PER_IP = "2";
  limit.reset("loginIp", "::ffff:127.0.0.1"); limit.reset("loginIp", "127.0.0.1"); limit.reset("loginIp", "::1");
  await login("wrong", `nobody1_${Date.now()}@test.local`); await login("wrong", `nobody2_${Date.now()}@test.local`);
  assert.match((await login("wrong", `nobody3_${Date.now()}@test.local`)).text, /Too many attempts/, "per-IP cap across many emails (2 allowed, the 3rd refused)");
  process.env.LOGIN_MAX_PER_IP = "1000";
  for (const k of [...limit._buckets.keys()]) if (k.startsWith("loginIp:")) limit._buckets.delete(k);
  process.env.REGISTER_MAX_PER_IP = "1";
  for (const k of [...limit._buckets.keys()]) if (k.startsWith("registerIp:")) limit._buckets.delete(k);
  const regEmail = `sec_reg_${Date.now()}@test.local`;
  const reg1 = await send("POST", "/register", { form: { email: regEmail, password: PW } });
  assert.ok(reg1.redirect, "first sign-up works");
  userIds.push((await pool.query("SELECT id FROM users WHERE email=$1", [regEmail])).rows[0].id);
  assert.match((await send("POST", "/register", { form: { email: `sec_reg2_${Date.now()}@test.local`, password: PW } })).text, /Too many attempts/, "register per-IP cap");
  process.env.REGISTER_MAX_PER_IP = "1000";
  // Parallel guesses get no extra tries: 10 at once with a limit of 3 -> at most 3 checked.
  resetLogin();
  const burst = await Promise.all(Array.from({ length: 10 }, () => login("wrong")));
  assert.ok(burst.filter((x) => /Invalid credentials/.test(x.text)).length <= 3, "at most 3 parallel guesses reach the password check");
  assert.match((await login(PW)).text, /Too many attempts/);
  // Behind the local tunnel each visitor has their own IP: one visitor locked out, another not.
  resetLogin();
  for (let k = 0; k < 3; k++) await sendFrom("203.0.113.7", "/login", { email: u.email, password: "wrong" });
  assert.match((await sendFrom("203.0.113.7", "/login", { email: u.email, password: PW })).text, /Too many attempts/, "the guessing visitor is blocked");
  assert.ok((await sendFrom("198.51.100.9", "/login", { email: u.email, password: PW })).redirect, "the real user from another IP still logs in");
  // The per-email cap from any IP is higher (LOGIN_MAX_PER_EMAIL), so a stranger can't lock the account cheaply.
  resetLogin();
  process.env.LOGIN_MAX_PER_EMAIL = "4";
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) await sendFrom(ip, "/login", { email: u.email, password: "wrong" });
  assert.match((await sendFrom("192.0.2.5", "/login", { email: u.email, password: "wrong" })).text, /Too many attempts/, "per-email cap across IPs");
  delete process.env.LOGIN_MAX_PER_EMAIL;
  resetLogin();
  // The admin address can't be claimed by signing up.
  process.env.REGISTER_MAX_PER_IP = "1000";
  const prevAdmin = process.env.ADMIN_EMAIL;
  process.env.ADMIN_EMAIL = `sec_admin_reserved_${Date.now()}@test.local`;
  assert.match((await send("POST", "/register", { form: { email: process.env.ADMIN_EMAIL.toUpperCase(), password: PW } })).text, /reserved/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email=$1", [process.env.ADMIN_EMAIL])).rows[0].n, 0);
  process.env.ADMIN_EMAIL = prevAdmin;
  console.log("[ok] login: 3 failures per email+IP -> blocked even with the right password (Retry-After), case-insensitive; success resets; huge password safe; per-IP cap; register per-IP cap");
  console.log("[ok] login: 10 parallel guesses -> at most 3 checked; behind the tunnel each visitor has its own IP (the real user still logs in); per-email cap across IPs; admin email can't be registered");

  // ------------------------------------------------------------ step-up lock
  const buyer = await newUser("stepup");
  const ck = cookieOf(buyer);
  const i = await agent.propose({ userId: buyer.id, productId: course.slug || course.id, provider: "mock", agentName: "sec-test", catalog: engine.catalog, decisions: engine.decisions });
  const approve = (pw) => send("POST", `/agent/intents/${i.id}/approve`, { form: { password: pw, amount: String(i.amount_cents) }, cookie: ck, hx: false });
  for (let k = 0; k < 3; k++) assert.equal((await approve("wrong")).status, 403);
  r = await approve(PW);
  assert.equal(r.status, 403);
  assert.match(r.text, /Too many wrong passwords/);
  assert.equal((await agent.getIntent(i.id)).status, "PROPOSED", "not approved while locked");
  assert.ok((await agent.listEvents(i.id)).some((e) => e.code === "STEP_UP_LOCKED"), "lock is logged");
  limit.reset("stepUpFail", buyer.id);
  const sBurst = await Promise.all(Array.from({ length: 8 }, () => approve("wrong")));
  assert.equal(sBurst.filter((x) => /Password is wrong/.test(x.text)).length <= 3, true, "at most 3 parallel step-up guesses checked");
  limit.reset("stepUpFail", buyer.id);
  assert.equal((await approve(PW)).status, 303, "after the window the right password approves");
  assert.equal((await agent.getIntent(i.id)).status, "APPROVED");
  console.log("[ok] step-up: 3 wrong passwords -> locked (even the right one is refused), logged STEP_UP_LOCKED, request stays PROPOSED; unlocks after the window");

  // ------------------------------------------------------------ forged sessions
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = [
    `token=${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: admin.id, email: admin.email })}.`,
    `token=${jwt.sign({ sub: admin.id, email: admin.email }, "guessed-secret")}`,
    cookieOf(buyer).replace(/\.([^.]+)\./, (m, p) => `.${b64({ ...JSON.parse(Buffer.from(p, "base64url")), email: admin.email })}.`),
    `token=${jwt.sign({ sub: admin.id, email: admin.email }, process.env.JWT_SECRET, { algorithm: "HS512" })}`,
  ];
  for (const f of forged) {
    const d = await send("POST", "/api/dev/events", { json: { eventType: "PURCHASE_SUCCEEDED", productId: course.id }, cookie: f });
    assert.ok(d.status === 302 || d.status === 401, `forged session rejected (got ${d.status})`);
  }
  console.log("[ok] forged sessions (alg none, guessed key, edited payload, other algorithm) are not logged in");

  // ------------------------------------------------------------ dev events route
  const grant = { eventType: "PURCHASE_SUCCEEDED", productId: course.id, amount: 0 };
  assert.equal((await send("POST", "/api/dev/events", { json: grant, cookie: ck })).status, 404, "normal user");
  assert.equal((await send("POST", "/api/dev/events", { json: grant, cookie: cookieOf(admin) })).status, 404, "admin without ENABLE_DEV_EVENTS");
  process.env.ENABLE_DEV_EVENTS = "1";
  assert.equal((await send("POST", "/api/dev/events", { json: grant, cookie: ck })).status, 404, "normal user even with the flag");
  r = await send("POST", "/api/dev/events", { json: { eventType: "NOT_A_TYPE", productId: course.id }, cookie: cookieOf(admin) });
  assert.equal(r.status, 400, "bad input -> 400, server keeps running");
  delete process.env.ENABLE_DEV_EVENTS;
  assert.equal(engine.decisions.evaluateAccess(buyer.id, course.id).allowed, false, "nobody got access");
  console.log("[ok] /api/dev/events: 404 for users and for the admin unless ENABLE_DEV_EVENTS=1; bad input -> 400 (no crash)");

  // ------------------------------------------------------------ admin stays in the admin pages
  resetLogin();
  r = await send("POST", "/login", { form: { email: admin.email, password: PW } });
  assert.equal(r.redirect, "/admin", "the admin lands on the dashboard after login");
  resetLogin();
  assert.equal((await send("POST", "/login", { form: { email: buyer.email, password: PW } })).redirect, "/courses", "a learner lands on the courses");
  const ack = cookieOf(admin);
  for (const p of ["/", "/courses", "/courses/intro-to-sql/card", "/cart", "/checkout/cancelled", "/razorpay/checkout", "/activity", "/activity/ledger", "/org", "/agent", "/assistant/card/x"]) {
    const page = await send("GET", p, { cookie: ack, hx: false });
    assert.ok(page.status === 302 && page.location === "/admin", `admin GET ${p} -> /admin (got ${page.status} ${page.location})`);
  }
  assert.equal((await send("GET", "/cart", { cookie: ack })).redirect, "/admin", "htmx request: HX-Redirect to /admin");
  for (const p of ["/cart/add", "/cart/checkout", "/subscription/renew", "/org/seats/checkout", "/assistant/chat", `/courses/${course.slug || course.id}/checkout`]) {
    const x = await send("POST", p, { form: { productId: course.id, message: "buy" }, cookie: ack });
    assert.equal(x.status, 403, `admin POST ${p} refused`);
  }
  const orgPage = await send("GET", `/org/${randomUUID()}`, { cookie: ack, hx: false });
  assert.notEqual(orgPage.location, "/admin", "an organization's page stays open to the admin");
  const guide = await send("GET", `/courses/${course.slug || course.id}/doc`, { cookie: ack, hx: false });
  assert.notEqual(guide.location, "/admin", "course guides stay open to the admin (preview)");
  assert.equal((await send("GET", "/org", { cookie: ck, hx: false })).status, 200, "learners keep their pages");
  const { layout } = require("../src/views");
  const adminNav = layout("x", "", { email: admin.email, isAdmin: true }).match(/<nav>[\s\S]*?<\/nav>/)[0];
  const userNav = layout("x", "", { email: buyer.email, isAdmin: false }).match(/<nav>[\s\S]*?<\/nav>/)[0];
  for (const h of ["/admin", "/admin/users", "/admin/pricing-rules", "/admin/reconciliation", "/admin/orgs", "/admin/content", "/admin/assistant"]) assert.ok(adminNav.includes(`href="${h}"`), `admin navbar has ${h}`);
  for (const h of ["/courses", "/activity", '"/org"', "/agent", "/cart"]) assert.ok(!adminNav.includes(h.startsWith('"') ? `href=${h}` : `href="${h}`), `admin navbar has no ${h}`);
  assert.ok(userNav.includes('href="/courses"') && !userNav.includes('href="/admin'), "learner navbar unchanged, no admin links");
  console.log("[ok] admin: own navbar (dashboard, users, pricing, reconciliation, organizations, guides, assistant log); login -> /admin; shopper pages -> /admin, shopper actions 403; guides and /org/<id> open; learners unchanged");

  // ------------------------------------------------------------ organizations (ADR-023)
  const mgr = await newUser("orgmgr");
  const holder = await newUser("orgseat");
  const outsider = await newUser("orgnone");
  const mc = cookieOf(mgr), hc = cookieOf(holder), oc = cookieOf(outsider);
  let page = (await send("GET", "/org", { cookie: mc, hx: false })).text;
  assert.match(page, /You are not part of an organization/);
  assert.match(page, /Request an organization/);
  assert.ok(!page.includes("/org/seats/checkout"), "no buy form before approval");
  const orgName = `Sec Org ${randomUUID().slice(0, 8)}`;
  r = await send("POST", "/org/request", { form: { name: orgName }, cookie: mc });
  assert.equal(r.status, 200);
  const request = (await pool.query("SELECT * FROM org_requests WHERE user_id=$1", [mgr.id])).rows[0];
  assert.equal(request.status, "PENDING");
  assert.match((await send("POST", "/org/request", { form: { name: `${orgName} 2` }, cookie: mc })).text, /already have a request waiting/);
  assert.match((await send("POST", "/org/request", { form: { name: orgName.toUpperCase() }, cookie: oc })).text, /already taken or requested/);
  page = (await send("GET", "/org", { cookie: mc, hx: false })).text;
  assert.ok(page.includes(orgName) && page.includes("Waiting for approval") && !page.includes("/org/seats/checkout"), "pending: status shown, no buy form");
  assert.equal((await send("POST", "/org/request", { form: { name: "Admin Org" }, cookie: ack })).status, 403, "the admin can't request");
  for (const [c, who] of [[mc, "requester"], [oc, "learner"]]) {
    assert.equal((await send("POST", `/admin/orgs/requests/${request.id}/approve`, { cookie: c })).status, 403, `${who} cannot approve`);
    assert.equal((await send("POST", `/admin/orgs/requests/${request.id}/reject`, { cookie: c })).status, 403, `${who} cannot reject`);
  }
  page = (await send("GET", "/admin/orgs", { cookie: ack, hx: false })).text;
  assert.ok(page.includes(orgName) && page.includes(mgr.email) && page.includes(`/admin/orgs/requests/${request.id}/approve`), "admin sees the request");
  assert.ok(!page.includes('hx-post="/admin/orgs"') && !page.includes("Add manager"), "the admin no longer creates organizations or edits managers");
  r = await send("POST", `/admin/orgs/requests/${request.id}/approve`, { cookie: ack });
  assert.equal(r.status, 200);
  const org = (await pool.query("SELECT o.* FROM organizations o JOIN org_requests q ON q.org_id=o.id WHERE q.id=$1", [request.id])).rows[0];
  assert.ok(org && org.name === orgName, "approval created the organization");
  orgIds.push(org.id);
  assert.match((await send("POST", `/admin/orgs/requests/${request.id}/approve`, { cookie: ack })).text, /already approved/);

  // Manager: runs the organization (buys and assigns seats); managers are read-only.
  page = (await send("GET", "/org", { cookie: mc, hx: false })).text;
  assert.ok(page.includes(orgName) && page.includes(`name="orgId" value="${org.id}"`), "approved requester sees the organization and the buy form");
  assert.ok(page.includes("Managers") && !/Add manager|\/managers\//.test(page), "managers shown, not editable");
  const buyKey = /name="checkoutKey" value="([0-9a-f-]{36})"/.exec(page)[1];
  r = await send("POST", "/org/seats/checkout", { form: { orgId: org.id, courseId: course.id, seats: "1", provider: "mock", checkoutKey: buyKey }, cookie: mc });
  assert.match(r.redirect || "", /^http:\/\/mock\.test\/pay\/.*back=org/, "manager is sent to pay");
  r = await send("POST", "/org/seats/checkout", { form: { orgId: org.id, courseId: course.id, seats: "1", provider: "mock", checkoutKey: randomUUID() }, cookie: oc });
  assert.ok(!r.redirect && /Only a manager/.test(r.text), "a non-manager cannot buy seats for it");
  assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE user_id=$1", [outsider.id])).rows[0].n, 0, "no order for the non-manager");
  const seatPool = (await pool.query("SELECT id FROM org_seat_pools WHERE org_id=$1", [org.id])).rows[0];
  await pool.query("UPDATE org_seat_pools SET status='ACTIVE' WHERE id=$1", [seatPool.id]); // as if the payment webhook arrived
  assert.equal((await send("POST", `/org/pools/${seatPool.id}/assign`, { form: { email: holder.email }, cookie: oc })).status, 404, "a non-manager cannot assign seats");
  await send("POST", `/org/pools/${seatPool.id}/assign`, { form: { email: holder.email }, cookie: mc });
  assert.equal(engine.decisions.evaluateAccess(holder.id, course.id).grantedVia, "SEAT_ASSIGNED", "the manager assigned a seat");

  // Seat holder: sees which organization gives which course, nothing to manage; still a learner.
  page = (await send("GET", "/org", { cookie: hc, hx: false })).text;
  assert.ok(page.includes("Your organization seats") && page.includes(orgName) && page.includes(course.name || course.id), "seat holder sees organization and course");
  assert.ok(!/Assign seat|Unassign|Refund this seat pack|name="orgId"/.test(page), "seat holder gets no management controls");
  assert.equal((await send("GET", `/org/${org.id}`, { cookie: hc, hx: false })).location, "/org", "seat holder cannot open the management page");
  assert.equal((await send("POST", `/org/pools/${seatPool.id}/assign`, { form: { email: outsider.email }, cookie: hc })).status, 404);
  assert.ok(page.includes('href="/courses"') && page.includes('href="/cart"'), "a seat holder keeps the learner navbar (still shops for themselves)");

  // Admin: looks only. No seat or refund actions, no buy form.
  page = (await send("GET", `/org/${org.id}`, { cookie: ack, hx: false })).text;
  assert.ok(page.includes("read-only") && page.includes(holder.email), "admin sees the organization and its seats");
  assert.ok(!/Assign seat|Unassign|Refund this seat pack|name="orgId"/.test(page), "no actions for the admin");
  assert.equal((await send("POST", `/org/pools/${seatPool.id}/assign`, { form: { email: outsider.email }, cookie: ack })).status, 404, "the admin can't assign seats");
  assert.equal((await send("POST", `/org/pools/${seatPool.id}/refund`, { cookie: ack })).status, 404, "the admin can't refund a pack");

  // Rejected request: nothing created, the learner sees why and can ask again.
  r = await send("POST", "/org/request", { form: { name: `Sec Rejected ${randomUUID().slice(0, 6)}` }, cookie: oc });
  const rejected = (await pool.query("SELECT * FROM org_requests WHERE user_id=$1 AND status='PENDING'", [outsider.id])).rows[0];
  await send("POST", `/admin/orgs/requests/${rejected.id}/reject`, { form: { reason: "no team details" }, cookie: ack });
  page = (await send("GET", "/org", { cookie: oc, hx: false })).text;
  assert.ok(/was not approved: no team details/.test(page) && page.includes("Request an organization") && !page.includes("/org/seats/checkout"), "rejected: reason shown, can ask again");
  assert.equal((await pool.query("SELECT org_id FROM org_requests WHERE id=$1", [rejected.id])).rows[0].org_id, null);
  console.log("[ok] organizations: a learner requests, only the admin approves / rejects (admin can't request); the requester then manages it (buys, assigns); the admin only looks; seat holders see their organization and course and stay learners; a rejection shows its reason");

  // ------------------------------------------------------------ errors and malformed ids
  console.error = () => {};
  r = await send("GET", "/boom", { hx: false });
  const r2 = await send("GET", "/boom");
  console.error = errorsOrigConsole;
  assert.equal(r.status, 500);
  assert.ok(!r.text.includes("secret_internal_table") && !r2.text.includes("secret_internal_table"), "no internal error text");
  assert.match(JSON.parse(r.text).ref, /^[0-9a-f]{8}$/);
  assert.match(r2.text, /Server error \(ref [0-9a-f]{8}\)/);
  for (const p of ["/org/pools/not-a-uuid/assign", "/org/pools/'%3B--/refund", "/assistant/coupon/not-a-uuid", "/assistant/approve/../../x"]) {
    const x = await send("POST", p, { form: { email: "a@b.c", coupon: "X" }, cookie: ck });
    assert.ok(x.status < 500, `${p}: ${x.status}`);
  }
  assert.equal((await fetch(base + "/login")).status, 200, "server still up");
  console.log("[ok] errors: generic message with a reference, no internal text; malformed ids on org / assistant routes -> no 500, server up");

  // Unset mock secret: every mock webhook is rejected (no built-in default).
  const { MockPaymentAdapter } = require("../src/payment/adapters/mock");
  const saved = process.env.MOCK_WEBHOOK_SECRET;
  delete process.env.MOCK_WEBHOOK_SECRET;
  const m = new MockPaymentAdapter();
  for (const guess of ["mock_dev_secret_123", "mock-secret-dev", "", "undefined", "null"]) assert.equal(m.verifyWebhook("{}", { "x-mock-secret": guess }), false, `secret unset, header ${JSON.stringify(guess)}`);
  process.env.MOCK_WEBHOOK_SECRET = saved;
  assert.equal(m.verifyWebhook("{}", { "x-mock-secret": saved }), true, "the configured secret works");
  assert.equal(m.verifyWebhook("{}", { "x-mock-secret": saved + "x" }), false);
  console.log("[ok] mock webhooks: without MOCK_WEBHOOK_SECRET everything is rejected (old built-in default too); only the configured secret works");

  console.log("\nSECURITY CHECKS PASSED");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error("cleanup:", e.message)); await pool.end(); });

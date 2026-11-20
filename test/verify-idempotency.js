"use strict";
// One state change per click, over HTTP against Postgres (mock provider adapter, no network):
//   - cart checkout: the same form (checkoutKey) sent 3x at once + once more -> one order,
//     every answer goes to the same checkout page; a new cart page gets a new key
//   - seat-pack checkout: the same form sent 3x at once -> one order, one pack
//   - admin grant: the same form (grantKey) sent 3x at once + once more -> one MANUAL_GRANT;
//     a scholarship pass period is added once, not once per submit
// Removes its orders / packs / organizations / cart rows; ledger rows stay (append-only).
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

process.env.MOCK_PROVIDER_URL = "http://mock.test"; // checkout links only; nothing is called
const userIds = [];
let server;

async function cleanup() {
  if (server) server.close();
  if (!userIds.length) return;
  const orders = (await pool.query("SELECT id FROM orders WHERE user_id = ANY($1::uuid[])", [userIds])).rows.map((r) => r.id);
  await pool.query("DELETE FROM org_seat_pools WHERE order_id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM organizations WHERE owner_user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM order_line_items WHERE order_id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM cart_items WHERE user_id = ANY($1::uuid[])", [userIds]);
}

(async () => {
  const products = await loadProducts();
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { catalog, projection } = engine;
  const course = catalog.list().find((p) => (p.type || "COURSE") === "COURSE");
  const pass = catalog.list().find((p) => p.type === "SUBSCRIPTION");

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `idem_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const admin = await newUser("admin");
  process.env.ADMIN_EMAIL = admin.email;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(require("../src/services/cartSession"));
  app.use(attachUser);
  app.locals.engine = engine;
  app.use(require("../src/routes/admin"));
  app.use(require("../src/routes/cart"));
  app.use(require("../src/routes/org"));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).send(err.message); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookieFor = (u) => `token=${jwt.sign({ sub: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const get = (u, path) => fetch(base + path, { headers: { Cookie: cookieFor(u) } }).then((r) => r.text());
  const post = async (u, path, form) => {
    const r = await fetch(base + path, { method: "POST", redirect: "manual",
      headers: { Cookie: cookieFor(u), "HX-Request": "true", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString() });
    return { status: r.status, redirect: r.headers.get("HX-Redirect"), location: r.headers.get("location"), text: await r.text() };
  };
  const keyIn = (html, name) => new RegExp(`name="${name}" value="([0-9a-f-]{36})"`).exec(html)?.[1];
  const ordersOf = async (u) => (await pool.query("SELECT id, status, checkout_key FROM orders WHERE user_id=$1", [u.id])).rows;

  // ------------------------------------------------------------ cart checkout
  const buyer = await newUser("cart");
  await pool.query("INSERT INTO cart_items (user_id, product_id) VALUES ($1,$2)", [buyer.id, course.slug || course.id]);
  const cartPage = await get(buyer, "/cart");
  const ck = keyIn(cartPage, "checkoutKey");
  assert.ok(ck, "the cart's checkout form carries a one-time key");
  assert.match(cartPage, /hx-post="\/cart\/checkout"[^>]*hx-disabled-elt=/, "the checkout button is disabled while the request runs");
  const form = { provider: "mock", checkoutKey: ck };
  const burst = await Promise.all([1, 2, 3].map(() => post(buyer, "/cart/checkout", form)));
  const later = await post(buyer, "/cart/checkout", form);
  const orders = await ordersOf(buyer);
  assert.equal(orders.length, 1, "one order for one click, however often it is sent");
  assert.equal(orders[0].checkout_key, ck);
  const urls = [...burst, later].map((r) => r.redirect);
  assert.ok(urls.every((u) => u && u === urls[0]), "every repeat is sent to the same checkout page");
  assert.match(urls[0], /^http:\/\/mock\.test\/pay\//);
  assert.equal((await pool.query("SELECT count(*)::int n FROM cart_items WHERE user_id=$1", [buyer.id])).rows[0].n, 0);
  // A new cart page is a new click: it gets a new key and its own order.
  await pool.query("INSERT INTO cart_items (user_id, product_id) VALUES ($1,$2)", [buyer.id, course.slug || course.id]);
  const ck2 = keyIn(await get(buyer, "/cart"), "checkoutKey");
  assert.notEqual(ck2, ck);
  assert.ok((await post(buyer, "/cart/checkout", { provider: "mock", checkoutKey: ck2 })).redirect);
  assert.equal((await ordersOf(buyer)).length, 2);
  // Once the first order is no longer open, its key only gets a message.
  await pool.query("UPDATE orders SET status='COMPLETED' WHERE id=$1", [orders[0].id]);
  const used = await post(buyer, "/cart/checkout", form);
  assert.equal(used.redirect, null);
  assert.match(used.text, /already used \(order completed\)\. Nothing new was charged/);
  assert.equal((await ordersOf(buyer)).length, 2);
  console.log("[ok] cart checkout: the same click sent 4x (3 at once) -> one order, same checkout page; a new cart page -> a new order; a used key -> message only");

  // ------------------------------------------------------------ seat-pack checkout
  const owner = await newUser("seats");
  const orgPage = await get(owner, "/org");
  const sk = keyIn(orgPage, "checkoutKey");
  assert.ok(sk, "the seat form carries a one-time key");
  const seatForm = { orgName: "Idem Org", courseId: course.id, seats: "2", provider: "mock", checkoutKey: sk };
  const seatBurst = await Promise.all([1, 2, 3].map(() => post(owner, "/org/seats/checkout", seatForm)));
  assert.equal((await ordersOf(owner)).length, 1, "one seat order");
  const packs = (await pool.query("SELECT p.id FROM org_seat_pools p JOIN organizations o ON o.id=p.org_id WHERE o.owner_user_id=$1", [owner.id])).rows;
  assert.equal(packs.length, 1, "one seat pack");
  const seatUrls = seatBurst.map((r) => r.redirect);
  assert.ok(seatUrls.every((u) => u && u === seatUrls[0] && /back=org/.test(u)), "same checkout page (back to /org) for every repeat");
  console.log("[ok] seat-pack checkout: the same click sent 3x at once -> one order, one pack, same checkout page");
  // Checkout cancelled: the pack is shown as one line, not "Waiting for payment ... paid".
  let org = await get(owner, "/org");
  assert.match(org, /Waiting for payment/);
  assert.match(org, /price \$40\.00 USD/, "an unpaid pack shows its price, not 'paid'");
  await pool.query("UPDATE orders SET status='CANCELLED' WHERE user_id=$1", [owner.id]);
  org = await get(owner, "/org");
  assert.match(org, /Payment cancelled<\/span>\. Nothing was charged\./);
  assert.doesNotMatch(org, /Waiting for payment|paid \$40\.00/);
  assert.match(org, /class="card org-notice"[^>]*>\s*<small>[^<]*2 seats/, "the line is a notice that fades out");
  assert.match(org, /classList\.add\('gone'\)/, "the page fades notices after a few seconds");
  // An unpaid checkout that ended a while ago is not listed any more (the pack row stays).
  await pool.query("UPDATE orders SET updated_at = now() - interval '10 minutes' WHERE user_id=$1", [owner.id]);
  org = await get(owner, "/org");
  assert.doesNotMatch(org, /Payment cancelled<\/span>/, "old unpaid checkout not listed");
  assert.match(org, /No seat packs yet/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM org_seat_pools p JOIN organizations o ON o.id=p.org_id WHERE o.owner_user_id=$1", [owner.id])).rows[0].n, 1, "the pack row is kept");
  console.log("[ok] seat pack whose checkout was cancelled: a short notice that fades out (no 'Waiting for payment' / 'paid'); after a while it is no longer listed (row kept)");

  // ------------------------------------------------------------ admin grant
  const student = await newUser("grant");
  const usersPage = await get(admin, `/admin/users/rows?q=${encodeURIComponent(student.email)}`);
  const gk = keyIn(usersPage, "grantKey");
  assert.ok(gk, "the grant form carries a one-time key");
  const grant = { userId: student.id, productId: pass.slug || pass.id, source: "SCHOLARSHIP", reason: "idempotency test", grantKey: gk };
  const gBurst = await Promise.all([1, 2, 3].map(() => post(admin, "/admin/users/grant", grant)));
  const gLater = await post(admin, "/admin/users/grant", grant);
  assert.ok([...gBurst, gLater].every((r) => r.status === 302), "each submit just returns to the user list");
  const grants = (await pool.query("SELECT event_id FROM commerce_ledger WHERE user_id=$1 AND event_type='MANUAL_GRANT'", [student.id])).rows;
  assert.deepEqual(grants.map((g) => g.event_id), [`admin_grant_${gk}`], "one grant for one submit of the form");
  const ent = projection.getSubscription(student.id, "ALL_ACCESS");
  assert.equal(ent.periods.length, 1, "the pass got one free period, not one per submit");
  assert.equal(Date.parse(ent.expiresAt), Date.parse(ent.periods[0].endsAt), "access ends after that one period");
  // A new form (new key) is a deliberate second grant.
  await post(admin, "/admin/users/grant", { ...grant, grantKey: randomUUID() });
  assert.equal((await pool.query("SELECT count(*)::int n FROM commerce_ledger WHERE user_id=$1 AND event_type='MANUAL_GRANT'", [student.id])).rows[0].n, 2);
  console.log("[ok] admin grant: the same form sent 4x (3 at once) -> one MANUAL_GRANT, one pass period added; a new form -> a second grant");

  console.log("\nIDEMPOTENCY CHECKS PASSED");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error("cleanup:", e.message)); await pool.end(); });

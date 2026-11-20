"use strict";
// Course guides: published by an admin, opened only with access, closed by refund / expiry.
// Uses a temporary course and a temporary content folder, so the real guides are never touched.
//   - nothing visible before the admin adds it; only the admin can add / remove
//   - add is idempotent (3 at once -> one ADDED), a changed file -> UPDATED, all audited
//   - no access -> 403 with the reason; purchase -> 200; refund -> 403 PURCHASE_REFUNDED
//   - All-Access Pass opens it; when the pass ends -> 403 SUBSCRIPTION_EXPIRED
//   - an open guide's status poll reloads the page once access ends
//   - document text is escaped (no HTML from the file reaches the page)
// Removes its course, guide and cart rows; its ledger rows / doc history stay (append-only).
require("dotenv").config();
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("../src/db");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnx-content-"));
process.env.CONTENT_DIR = dir;
const COURSE = `doc-test-${randomUUID().slice(0, 8)}`;
let server;

async function cleanup() {
  if (server) server.close();
  await pool.query("DELETE FROM course_docs WHERE course_id = $1", [COURSE]);
  await pool.query("DELETE FROM cart_items WHERE product_id = $1", [COURSE]);
  await pool.query("DELETE FROM courses WHERE id = $1", [COURSE]);
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await pool.query(
    `INSERT INTO courses (id, slug, name, description, price_cents, currency, type) VALUES ($1,$1,'Doc Test Course','temporary',1000,'USD','COURSE')`,
    [COURSE]
  );
  const file = path.join(dir, `${COURSE}.md`);
  fs.writeFileSync(file, "# Doc Test Guide\n\nThe secret lesson body.\n\nInjected <b>tag</b> and <script>x</script>.\n");

  const { createEngine } = require("../src/domain");
  const { loadProducts } = require("../src/domain/catalogLoader");
  const { PgLedgerStore } = require("../src/domain/stores/pgLedgerStore");
  const { attachUser } = require("../src/auth");
  const docs = require("../src/services/courseDocs");
  const engine = createEngine({ products: await loadProducts(), store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { ledger } = engine;
  const pass = engine.catalog.list().find((p) => p.type === "SUBSCRIPTION");

  const newUser = async (tag) => (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
    `doc_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
  ])).rows[0];
  const admin = await newUser("admin");
  const buyer = await newUser("buyer");
  const passUser = await newUser("pass");
  process.env.ADMIN_EMAIL = admin.email;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(attachUser);
  app.locals.engine = engine;
  app.use(require("../src/routes/content"));
  app.use(require("../src/routes/courses"));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).send(err.message); });
  await docs.refresh();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ck = (u) => `token=${jwt.sign({ sub: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const req = async (u, method, p, opts = {}) => {
    const r = await fetch(base + p, { method, redirect: "manual", headers: { Cookie: ck(u), ...(opts.hx ? { "HX-Request": "true" } : {}) } });
    return { status: r.status, location: r.headers.get("location"), refresh: r.headers.get("HX-Refresh"), cache: r.headers.get("cache-control"), text: await r.text() };
  };
  const doc = (u) => req(u, "GET", `/courses/${COURSE}/doc`);
  const status = (u) => req(u, "GET", `/courses/${COURSE}/doc/status`, { hx: true });
  const card = (u) => req(u, "GET", `/courses/${COURSE}/card`, { hx: true });
  const events = async () => (await pool.query("SELECT action, actor FROM course_doc_events WHERE course_id=$1 ORDER BY id", [COURSE])).rows;

  // ------------------------------------------------------------ before publishing
  assert.equal((await doc(buyer)).status, 404, "nothing to open before the admin adds it");
  assert.ok(!/Open guide|course guide/.test((await card(buyer)).text), "no guide on the card yet");
  const sneaky = await req(buyer, "POST", `/admin/content/${COURSE}/add`);
  assert.equal(sneaky.status, 302);
  assert.ok(!/admin\/content/.test(sneaky.location || ""), "a learner is sent away, not to the admin page");
  assert.equal(await docs.get(COURSE), null, "a learner cannot publish");
  assert.equal((await req(buyer, "GET", "/admin/content")).status, 302, "a learner cannot see the admin page");
  console.log("[ok] before publishing: no guide for anyone; only the admin can open Course content or add");

  // ------------------------------------------------------------ admin adds (idempotent, audited)
  const page = await req(admin, "GET", "/admin/content");
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`content/${COURSE}.md`) && /Add to course/.test(page.text));
  const adds = await Promise.all([1, 2, 3].map(() => req(admin, "POST", `/admin/content/${COURSE}/add`)));
  assert.ok(adds.every((a) => a.status === 302));
  assert.deepEqual((await events()).map((e) => e.action), ["ADDED"], "3 adds at once -> one ADDED");
  assert.match((await req(admin, "POST", `/admin/content/${COURSE}/add`)).location, /done=UNCHANGED/);
  fs.appendFileSync(file, "\nA new paragraph.\n");
  assert.match((await req(admin, "POST", `/admin/content/${COURSE}/add`)).location, /done=UPDATED/);
  assert.deepEqual((await events()).map((e) => [e.action, e.actor]), [["ADDED", admin.email], ["UPDATED", admin.email]]);
  assert.match((await card(buyer)).text, /Includes the course guide/, "the card says a guide comes with the course");
  const preview = await doc(admin);
  assert.equal(preview.status, 200, "the admin can preview a guide without owning the course");
  assert.match(preview.text, /admin preview/);
  assert.ok(!preview.text.includes("/doc/status"), "no access poll on the admin preview");
  console.log("[ok] admin add: 3 at once -> one ADDED; again -> unchanged; changed file -> UPDATED; recorded with the admin's email; admin preview works");

  // ------------------------------------------------------------ access decides
  let r = await doc(buyer);
  assert.equal(r.status, 403);
  assert.match(r.text, /don&#39;t have access|don't have access/);
  assert.ok(!r.text.includes("secret lesson body"), "no content without access");
  assert.ok(!r.text.includes("Doc Test Guide"), "not even the document's title without access");
  assert.equal((await status(buyer)).refresh, "true");

  const buy = await ledger.appendEvent({
    eventId: `pay_${randomUUID()}`, eventType: "PURCHASE_SUCCEEDED", userId: buyer.id, productId: COURSE,
    quantity: 1, amount: 10, currency: "USD", occurredAt: new Date().toISOString(), source: "PAYMENT",
  }, { provider: "test", method: "TEST" });
  r = await doc(buyer);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("The secret lesson body.") && r.text.includes("A new paragraph."));
  assert.match(r.text, /Open through your purchase/);
  assert.equal(r.cache, "no-store, private", "paid content is never cached");
  assert.ok(r.text.includes("&lt;b&gt;tag&lt;/b&gt;") && !r.text.includes("<script>x</script>"), "document text is escaped");
  assert.equal((await status(buyer)).status, 204, "status poll: still allowed");
  assert.match((await card(buyer)).text, new RegExp(`href="/courses/${COURSE}/doc"><button class="alt" type="button">Open guide`));
  console.log("[ok] no access -> 403 with the reason, no content; after purchase -> the guide opens (escaped), card shows Open guide");

  await ledger.appendEvent({
    eventId: `ref_${randomUUID()}`, eventType: "REFUND", userId: buyer.id, productId: COURSE, quantity: 1, amount: 10,
    currency: "USD", occurredAt: new Date().toISOString(), referenceeventId: buy.record.event.eventId, source: "PAYMENT",
  }, { provider: "test", method: "TEST" });
  r = await doc(buyer);
  assert.equal(r.status, 403);
  assert.match(r.text, /was refunded/);
  assert.match(r.text, /PURCHASE_REFUNDED/);
  assert.equal((await status(buyer)).refresh, "true", "an open guide reloads (and shows why) after the refund");
  console.log("[ok] refund -> guide closed (403 PURCHASE_REFUNDED); an open guide's poll reloads it");

  // ------------------------------------------------------------ pass opens it, expiry closes it
  await ledger.appendEvent({
    eventId: `grant_${randomUUID()}`, eventType: "MANUAL_GRANT", userId: passUser.id, productId: pass.slug || pass.id,
    quantity: 1, amount: 0, currency: "USD", occurredAt: new Date().toISOString(), source: "SCHOLARSHIP", actor: "verify-content",
    entitlement: { kind: "SUBSCRIPTION", scope: "ALL_ACCESS", expiresAt: new Date(Date.now() + 2500).toISOString() },
  }, { method: "TEST" });
  r = await doc(passUser);
  assert.equal(r.status, 200);
  assert.match(r.text, /Open through your All-Access Pass/);
  await new Promise((res) => setTimeout(res, 3000));
  r = await doc(passUser);
  assert.equal(r.status, 403);
  assert.match(r.text, /All-Access Pass has ended/);
  assert.equal((await status(passUser)).refresh, "true");
  console.log("[ok] All-Access Pass opens the guide; the moment the pass ends -> 403 SUBSCRIPTION_EXPIRED (no event needed)");

  // ------------------------------------------------------------ admin removes
  const late = await ledger.appendEvent({
    eventId: `pay_${randomUUID()}`, eventType: "PURCHASE_SUCCEEDED", userId: buyer.id, productId: COURSE,
    quantity: 1, amount: 10, currency: "USD", occurredAt: new Date().toISOString(), source: "PAYMENT",
  }, { provider: "test", method: "TEST" });
  assert.ok(late.appended);
  assert.equal((await doc(buyer)).status, 200, "bought again -> open again");
  assert.match((await req(admin, "POST", `/admin/content/${COURSE}/remove`)).location, /done=REMOVED/);
  assert.equal((await doc(buyer)).status, 404, "removed -> gone even for an owner");
  assert.equal((await status(buyer)).refresh, "true");
  assert.match((await req(admin, "POST", `/admin/content/${COURSE}/remove`)).location, /done=NOT_PUBLISHED/);
  assert.deepEqual((await events()).map((e) => e.action), ["ADDED", "UPDATED", "REMOVED"], "removing twice is recorded once");
  await assert.rejects(pool.query("UPDATE course_doc_events SET actor='x' WHERE course_id=$1", [COURSE]), /append-only/);
  console.log("[ok] admin remove: guide gone for everyone; second remove does nothing; history is append-only");

  console.log("\nCONTENT CHECKS PASSED");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error("cleanup:", e.message)); await pool.end(); });

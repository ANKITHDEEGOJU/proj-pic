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
    pid = products[0].id,
    p = products[0];
  const {
    rows: [u],
  } = await pool.query(
    `INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id`,
    [`t_${Date.now()}@test.local`],
  );
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
    { code: "E1_REFUND_ALREADY_APPLIED" },
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

  for (const sql of [
    "UPDATE commerce_ledger SET amount = 0",
    "DELETE FROM commerce_ledger",
    "TRUNCATE commerce_ledger",
  ])
    await assert.rejects(() => pool.query(sql), /append-only/);
  console.log("[ok] UPDATE / DELETE / TRUNCATE rejected by DB triggers (L1)");
  console.log("\nPG CHECKS PASSED");
  await pool.end();
})().catch((e) => {
  console.error("\nFAILED:", e);
  process.exit(1);
});

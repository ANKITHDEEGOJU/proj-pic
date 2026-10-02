"use strict";
// Run: npm run verify   (no Postgres, no network)
const assert = require("node:assert/strict");
const { createEngine } = require("./index");
const { CatalogStore } = require("./catalog");
const { PRODUCTS } = require("./seed");

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n=== STEP ${n}: ${t} ===`);
const users = new Set(["user_123"]);
const { catalog, ledger, projection, decisions } = createEngine({
  products: PRODUCTS,
  userExists: (id) => users.has(id),
});

const ev = (o) => ({
  eventId: "x",
  eventType: "PURCHASE_SUCCEEDED",
  userId: "user_123",
  productId: "course_1",
  quantity: 1,
  amount: 499,
  currency: "INR",
  occurredAt: new Date().toISOString(),
  referenceeventId: null,
  ...o,
});
const expectCode = (code, fn) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code);
    log(`  [ok] rejected with ${code}`);
    return;
  }
  assert.fail(`expected ${code}`);
};

step(1, "Setup catalog");
log("  catalog:", JSON.stringify(catalog.list()));
assert.equal(catalog.list().length, 1);

step(2, "Initial access check");
let d = decisions.evaluateAccess("user_123", "course_1");
log("  decision:", JSON.stringify(d));
assert.deepEqual(d, {
  allowed: false,
  reason: "NO_PURCHASE_RECORD",
  sourceEventIds: [],
});

step(3, "Successful purchase");
const r1 = ledger.appendEvent(ev({ eventId: "evt_001" }), {
  method: "MOCK",
  txnRef: "mock_txn_1",
});
log(
  "  append:",
  r1.appended,
  "| ledger size:",
  ledger.size(),
  "| seq:",
  r1.record.ledgerSequenceId,
);
assert.equal(r1.appended, true);
assert.equal(ledger.size(), 1);
log("  entitlement:", JSON.stringify(projection.get("user_123", "course_1")));
d = decisions.evaluateAccess("user_123", "course_1");
log("  decision:", JSON.stringify(d));
assert.deepEqual(d, {
  allowed: true,
  reason: "ACTIVE_PURCHASE",
  sourceEventIds: ["evt_001"],
});

step(4, "Duplicate ingestion (L3)");
const dup = ledger.appendEvent(ev({ eventId: "evt_001" }), {});
log("  result:", JSON.stringify(dup), "| ledger size:", ledger.size());
assert.equal(dup.appended, false);
assert.equal(dup.reason, "DUPLICATE_EVENT");
assert.equal(ledger.size(), 1);

step(5, "Refund");
ledger.appendEvent(
  ev({ eventId: "evt_002", eventType: "REFUND", referenceeventId: "evt_001" }),
  { method: "MOCK", txnRef: "mock_refund_1" },
);
const ent = projection.get("user_123", "course_1");
log("  entitlement:", JSON.stringify(ent));
assert.equal(ent.status, "REVOKED");
d = decisions.evaluateAccess("user_123", "course_1");
log("  decision:", JSON.stringify(d));
assert.deepEqual(d, {
  allowed: false,
  reason: "PURCHASE_REFUNDED",
  sourceEventIds: ["evt_002"],
});

step(6, "Ledger replay (EN4)");
const before = decisions.evaluateAccess("user_123", "course_1");
const stateBefore = JSON.stringify(projection.snapshot());
projection._clearState();
log(
  "  state cleared ->",
  JSON.stringify(decisions.evaluateAccess("user_123", "course_1")),
);
assert.equal(
  decisions.evaluateAccess("user_123", "course_1").reason,
  "NO_PURCHASE_RECORD",
);
const n = projection.rebuildFromLedger();
const after = decisions.evaluateAccess("user_123", "course_1");
log(`  rebuilt ${n} entitlement(s) ->`, JSON.stringify(after));
assert.deepEqual(after, before);
assert.equal(JSON.stringify(projection.snapshot()), stateBefore);

step(7, "Invariant probes");
expectCode("E3_UNSUPPORTED_TYPE", () =>
  ledger.appendEvent(ev({ eventId: "e3", eventType: "GIFT" })),
);
expectCode("E2_INVALID_USER", () =>
  ledger.appendEvent(ev({ eventId: "e4", userId: "ghost" })),
);
expectCode("E2_INVALID_PRODUCT", () =>
  ledger.appendEvent(ev({ eventId: "e5", productId: "nope" })),
);
expectCode("E1_REFUND_REFERENCE", () =>
  ledger.appendEvent(
    ev({ eventId: "e6", eventType: "REFUND", referenceeventId: "missing" }),
  ),
);
expectCode("E1_REFUND_ALREADY_APPLIED", () =>
  ledger.appendEvent(
    ev({ eventId: "e7", eventType: "REFUND", referenceeventId: "evt_001" }),
  ),
);
expectCode(
  "P1_DUPLICATE_PRODUCT",
  () => new CatalogStore([PRODUCTS[0], PRODUCTS[0]]),
);
expectCode(
  "P2_PROVIDER_DATA",
  () => new CatalogStore([{ ...PRODUCTS[0], stripePriceId: "price_x" }]),
);
assert.throws(() => {
  ledger.getAll()[0].event.amount = 1;
}, TypeError); // E4
assert.throws(() => {
  ledger.getAll()[0].ledgerSequenceId = 99;
}, TypeError); // L1
ledger.getAll().push({ fake: true }); // L1: copy only
assert.equal(ledger.size(), 2);
assert.equal(typeof ledger.update, "undefined");
assert.equal(typeof ledger.delete, "undefined");
log(
  "  [ok] frozen events/records, array copy cannot alter ledger, no update/delete API",
);
ledger.appendEvent(
  ev({ eventId: "evt_003", eventType: "PURCHASE_FAILED" }),
  {},
);
assert.equal(
  decisions.evaluateAccess("user_123", "course_1").reason,
  "PURCHASE_REFUNDED",
);
log("  [ok] PURCHASE_FAILED is ledgered but does not change access");

log("\nALL CHECKS PASSED. Ledger rows:", ledger.size());

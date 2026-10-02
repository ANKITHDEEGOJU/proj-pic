"use strict";
const { DomainError, deepFreeze } = require("./util");
const EVENT_TYPES = ["PURCHASE_SUCCEEDED", "PURCHASE_FAILED", "REFUND"];

class CommerceLedgerService {
  // Enforcing L1: storage is private; no update/delete methods exist on this class.
  #records = [];
  #byEventId = new Map();
  #refunded = new Set();
  #listeners = [];
  #seq = 0;

  constructor({ catalog, userExists }) {
    this.catalog = catalog;
    this.userExists = userExists;
  }

  onAppend(fn) {
    this.#listeners.push(fn);
  }
  size() {
    return this.#records.length;
  }
  getAll() {
    return this.#records.slice();
  } // copy of array of frozen records
  getByEventId(id) {
    return this.#byEventId.get(id) ?? null;
  }

  #normalize(ev) {
    const bad = (code, msg) => {
      throw new DomainError(code, msg);
    };
    if (!ev || typeof ev !== "object")
      bad("E1_INVALID_EVENT", "Event must be an object");
    // Enforcing E1: eventId present (uniqueness is enforced at L3 in appendEvent)
    if (typeof ev.eventId !== "string" || !ev.eventId)
      bad("E1_INVALID_EVENT_ID", "eventId must be a non-empty string");
    // Enforcing E3: supported types only
    if (!EVENT_TYPES.includes(ev.eventType))
      bad("E3_UNSUPPORTED_TYPE", `Unsupported eventType: ${ev.eventType}`);
    // Enforcing E2: valid userId & productId
    if (
      typeof ev.userId !== "string" ||
      !ev.userId ||
      !this.userExists(ev.userId)
    )
      bad("E2_INVALID_USER", `Unknown userId: ${ev.userId}`);
    if (!this.catalog.has(ev.productId))
      bad("E2_INVALID_PRODUCT", `Unknown productId: ${ev.productId}`);
    if (!Number.isInteger(ev.quantity) || ev.quantity < 1)
      bad("E1_INVALID_QUANTITY", "quantity must be a positive integer");
    if (typeof ev.amount !== "number" || !(ev.amount >= 0))
      bad("E1_INVALID_AMOUNT", "amount must be a number >= 0");
    if (typeof ev.currency !== "string" || !ev.currency)
      bad("E1_INVALID_CURRENCY", "currency required");
    if (
      typeof ev.occurredAt !== "string" ||
      Number.isNaN(Date.parse(ev.occurredAt))
    )
      bad("E1_INVALID_TIMESTAMP", "occurredAt must be an ISO string");

    const ref = ev.referenceeventId ?? null;
    if (ev.eventType === "REFUND") {
      const orig = ref && this.#byEventId.get(ref);
      if (!orig || orig.event.eventType !== "PURCHASE_SUCCEEDED")
        bad(
          "E1_REFUND_REFERENCE",
          "REFUND must reference an existing PURCHASE_SUCCEEDED eventId",
        );
      if (
        orig.event.userId !== ev.userId ||
        orig.event.productId !== ev.productId
      )
        bad(
          "E1_REFUND_MISMATCH",
          "REFUND user/product must match original purchase",
        );
      if (this.#refunded.has(ref))
        bad("E1_REFUND_ALREADY_APPLIED", `Purchase ${ref} already refunded`);
    } else if (ref !== null)
      bad("E1_UNEXPECTED_REFERENCE", "referenceeventId only allowed on REFUND");

    // Enforcing E4: immutable copy of the event
    return deepFreeze({
      eventId: ev.eventId,
      eventType: ev.eventType,
      userId: ev.userId,
      productId: ev.productId,
      quantity: ev.quantity,
      amount: ev.amount,
      currency: ev.currency,
      occurredAt: ev.occurredAt,
      referenceeventId: ref,
    });
  }

  appendEvent(event, paymentInfo = {}) {
    const e = this.#normalize(event);
    // Enforcing L3: idempotency. Duplicate eventId is a graceful no-op, ledger unchanged.
    if (this.#byEventId.has(e.eventId))
      return { appended: false, reason: "DUPLICATE_EVENT", eventId: e.eventId };

    const record = deepFreeze({
      ledgerSequenceId: ++this.#seq, // L2: monotonic, gap-free ordering
      event: e,
      productSnapshot: this.catalog.get(e.productId), // frozen snapshot of price at purchase time
      paymentInfo: { ...paymentInfo },
      recordedAt: new Date().toISOString(),
    });
    this.#records.push(record); // L1: append only
    this.#byEventId.set(e.eventId, record);
    if (e.eventType === "REFUND") this.#refunded.add(e.referenceeventId);
    this.#listeners.forEach((fn) => fn(record)); // EN: projection reacts to appends
    return { appended: true, record };
  }
}
module.exports = { CommerceLedgerService };



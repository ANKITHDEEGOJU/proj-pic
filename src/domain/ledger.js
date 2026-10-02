"use strict";
const { DomainError, deepFreeze, sameEvent } = require("./util");
const EVENT_TYPES = ["PURCHASE_SUCCEEDED", "PURCHASE_FAILED", "REFUND"];

// Business rules live here; persistence lives in the injected `store` (memory or Postgres).
class CommerceLedgerService {
  #listeners = [];
  // Enforcing L1: this service exposes no update/delete; the store has none either (and PG triggers block them).
  constructor({ catalog, userExists, store }) {
    this.catalog = catalog;
    this.userExists = userExists;
    this.store = store;
  }

  onAppend(fn) {
    this.#listeners.push(fn);
  }
  async size() {
    return this.store.count();
  }
  async getAll() {
    return this.store.getAll();
  }
  async getByEventId(id) {
    return this.store.getByEventId(id);
  }

  #validate(ev) {
    const bad = (code, msg) => {
      throw new DomainError(code, msg);
    };
    if (!ev || typeof ev !== "object")
      bad("E1_INVALID_EVENT", "Event must be an object");
    if (typeof ev.eventId !== "string" || !ev.eventId)
      bad("E1_INVALID_EVENT_ID", "eventId must be a non-empty string"); // E1
    if (!EVENT_TYPES.includes(ev.eventType))
      bad("E3_UNSUPPORTED_TYPE", `Unsupported eventType: ${ev.eventType}`); // E3
    if (
      typeof ev.userId !== "string" ||
      !ev.userId ||
      !this.userExists(ev.userId)
    )
      bad("E2_INVALID_USER", `Unknown userId: ${ev.userId}`); // E2
    if (!this.catalog.has(ev.productId))
      bad("E2_INVALID_PRODUCT", `Unknown productId: ${ev.productId}`); // E2
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
    if (ev.eventType !== "REFUND" && ref !== null)
      bad("E1_UNEXPECTED_REFERENCE", "referenceeventId only allowed on REFUND");
    return deepFreeze({
      // E4
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

  async #checkRefund(e) {
    if (e.eventType !== "REFUND") return;
    const orig =
      e.referenceeventId && (await this.store.getByEventId(e.referenceeventId));
    if (!orig || orig.event.eventType !== "PURCHASE_SUCCEEDED")
      throw new DomainError(
        "E1_REFUND_REFERENCE",
        "REFUND must reference an existing PURCHASE_SUCCEEDED eventId",
      );
    if (orig.event.userId !== e.userId || orig.event.productId !== e.productId)
      throw new DomainError(
        "E1_REFUND_MISMATCH",
        "REFUND user/product must match original purchase",
      );
    if (await this.store.hasRefundFor(e.referenceeventId))
      throw new DomainError(
        "E1_REFUND_ALREADY_APPLIED",
        `Purchase ${e.referenceeventId} already refunded`,
      );
  }

  async appendEvent(event, paymentInfo = {}) {
    const e = this.#validate(event);
    // Enforcing L3 (checked BEFORE refund rules, so a retried refund webhook is a no-op, not an error).
    const ex = await this.store.getByEventId(e.eventId);
    if (ex)
      return {
        appended: false,
        reason: sameEvent(ex.event, e)
          ? "DUPLICATE_EVENT"
          : "EVENT_ID_CONFLICT",
        eventId: e.eventId,
      };
    await this.#checkRefund(e);
    const out = await this.store.append({
      event: e,
      productSnapshot: this.catalog.get(e.productId),
      paymentInfo: { ...paymentInfo },
    });
    if (!out.inserted)
      return {
        appended: false,
        reason: out.conflict ? "EVENT_ID_CONFLICT" : "DUPLICATE_EVENT",
        eventId: e.eventId,
      }; // lost a race
    this.#listeners.forEach((fn) => fn(out.record));
    return { appended: true, record: out.record };
  }
}
module.exports = { CommerceLedgerService };

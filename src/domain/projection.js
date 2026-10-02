"use strict";
const { deepFreeze } = require("./util");

class EntitlementProjectionEngine {
  // Enforcing EN1: this Map is derived state only. It is written solely by apply(), driven by ledger records.
  #state = new Map();
  constructor(ledger) {
    this.ledger = ledger;
    ledger.onAppend((record) => this.apply(record));
  }
  static key(userId, productId) {
    return `${userId}:${productId}`;
  }

  apply(record) {
    const e = record.event;
    const k = EntitlementProjectionEngine.key(e.userId, e.productId);
    switch (e.eventType) {
      case "PURCHASE_SUCCEEDED": // Enforcing EN2: purchase => ACTIVE
        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            status: "ACTIVE",
            sourceEventId: e.eventId,
            grantedAt: e.occurredAt,
            revokedAt: null,
          }),
        );
        break;
      case "REFUND": {
        // Enforcing EN3: refund => REVOKED
        const cur = this.#state.get(k);
        const orig = this.ledger.getByEventId(e.referenceeventId);
        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            status: "REVOKED",
            sourceEventId: e.eventId,
            grantedAt: cur?.grantedAt ?? orig?.event.occurredAt ?? null,
            revokedAt: e.occurredAt,
          }),
        );
        break;
      }
      default:
        break; // PURCHASE_FAILED never grants or changes access
    }
  }

  get(userId, productId) {
    return (
      this.#state.get(EntitlementProjectionEngine.key(userId, productId)) ??
      null
    );
  }
  snapshot() {
    return Object.fromEntries(this.#state);
  }
  _clearState() {
    this.#state.clear();
  } // used only to prove replay in verification

  //Event Replay -
  // Enforcing EN4: full reconstruction by replaying the ledger in sequence order.
  async rebuildFromLedger() {
    this.#state.clear();
   (await this.ledger.getAll())
      .sort((a, b) => a.ledgerSequenceId - b.ledgerSequenceId)
      .forEach((r) => this.apply(r));
    return this.#state.size;
  }
}
module.exports = { EntitlementProjectionEngine };

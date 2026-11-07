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
    if (!e || !e.userId || !e.productId) return;

    const k = EntitlementProjectionEngine.key(e.userId, e.productId);

    switch (e.eventType) {
      case "PURCHASE_SUCCEEDED": {
        // Compute expiration if durationDays or explicit expiresAt is present in productSnapshot
        let expiresAt = null;
        const snapshot = e.productSnapshot || {};

        if (snapshot.expiresAt) {
          expiresAt = snapshot.expiresAt;
        } else if (snapshot.durationDays) {
          const grantedDate = new Date(e.occurredAt);
          grantedDate.setDate(grantedDate.getDate() + Number(snapshot.durationDays));
          expiresAt = grantedDate.toISOString();
        }

        // Enforcing EN2: purchase => ACTIVE
        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            status: "ACTIVE",
            sourceEventId: e.eventId,
            grantedAt: e.occurredAt,
            expiresAt,
            revokedAt: null,
          }),
        );
        break;
      }

      case "REFUND": {
        // Enforcing EN3: refund => REVOKED
        const cur = this.#state.get(k);
        const refId = e.referenceeventId || e.referenceEventId;
        const orig = refId ? this.ledger.getByEventId(refId) : null;

        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            status: "REVOKED",
            sourceEventId: e.eventId,
            grantedAt: cur?.grantedAt ?? orig?.event?.occurredAt ?? null,
            expiresAt: null,
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
    if (!userId || !productId) return null;
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
  }

  // Enforcing EN4: full reconstruction by replaying the ledger in sequence order.
  async rebuildFromLedger() {
    this.#state.clear();
    const records = await this.ledger.getAll();
    records
      .sort((a, b) => a.ledgerSequenceId - b.ledgerSequenceId)
      .forEach((r) => this.apply(r));
    return this.#state.size;
  }
}

module.exports = { EntitlementProjectionEngine };
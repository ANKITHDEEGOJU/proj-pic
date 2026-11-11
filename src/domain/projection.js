"use strict";

const { deepFreeze } = require("./util");

class EntitlementProjectionEngine {
  #state = new Map();

  constructor(ledger) {
    this.ledger = ledger;
    ledger.onAppend((record) => this.apply(record));
  }

  static key(userId, productId) {
    return `${userId}:${productId}`;
  }

  static subKey(userId, scope = "ALL_ACCESS") {
    return `${userId}:sub:${scope}`;
  }

  apply(record) {
    const e = record.event;
    if (!e || !e.userId || !e.productId) return;

    const snapshot = record.productSnapshot || {};
    const paymentInfo = record.paymentInfo || {};

    // Check type in snapshot or paymentInfo (from webhook line-items)
    const isSubscription =
      snapshot.type === "SUBSCRIPTION" || paymentInfo.itemType === "SUBSCRIPTION";

    if (isSubscription) {
      this.#applySubscription(record, snapshot, paymentInfo);
    } else {
      this.#applyCourse(record, snapshot);
    }
  }

  #applyCourse(record, snapshot) {
    const e = record.event;
    const k = EntitlementProjectionEngine.key(e.userId, e.productId);

    switch (e.eventType) {
      case "PURCHASE_SUCCEEDED": {
        let expiresAt = null;
        if (snapshot.expiresAt) {
          expiresAt = snapshot.expiresAt;
        } else if (snapshot.durationDays) {
          const grantedDate = new Date(e.occurredAt);
          grantedDate.setDate(grantedDate.getDate() + Number(snapshot.durationDays));
          expiresAt = grantedDate.toISOString();
        }

        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            type: "COURSE",
            status: "ACTIVE",
            sourceEventId: e.eventId,
            grantedAt: e.occurredAt,
            expiresAt,
            revokedAt: null,
          })
        );
        break;
      }

      case "REFUND": {
        const cur = this.#state.get(k);

        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            type: "COURSE",
            status: "REVOKED",
            sourceEventId: e.eventId,
            grantedAt: cur?.grantedAt ?? e.occurredAt,
            expiresAt: null,
            revokedAt: e.occurredAt,
          })
        );
        break;
      }

      default:
        break;
    }
  }

  #applySubscription(record, snapshot, paymentInfo) {
    const e = record.event;
    const scope = snapshot.scope || paymentInfo.scope || "ALL_ACCESS";
    const k = EntitlementProjectionEngine.subKey(e.userId, scope);

    switch (e.eventType) {
      case "PURCHASE_SUCCEEDED": {
        const durationDays = Number(
          snapshot.durationDays || paymentInfo.durationDays || 30
        );
        const durationMs = durationDays * 24 * 60 * 60 * 1000;
        const eventTimeMs = new Date(e.occurredAt).getTime();

        const currentSub = this.#state.get(k);
        let baseTimeMs = eventTimeMs;

        // Subscription Stacking: Extend unexpired active subscription
        if (currentSub && currentSub.status === "ACTIVE" && currentSub.expiresAt) {
          const currentExpMs = new Date(currentSub.expiresAt).getTime();
          if (currentExpMs > eventTimeMs) {
            baseTimeMs = currentExpMs;
          }
        }

        const newExpiresAt = new Date(baseTimeMs + durationMs).toISOString();

        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            type: "SUBSCRIPTION",
            scope,
            status: "ACTIVE",
            sourceEventId: e.eventId,
            grantedAt: e.occurredAt,
            expiresAt: newExpiresAt,
            revokedAt: null,
          })
        );
        break;
      }

      case "REFUND": {
        const cur = this.#state.get(k);
        this.#state.set(
          k,
          deepFreeze({
            userId: e.userId,
            productId: e.productId,
            type: "SUBSCRIPTION",
            scope,
            status: "REVOKED",
            sourceEventId: e.eventId,
            grantedAt: cur?.grantedAt ?? null,
            expiresAt: null,
            revokedAt: e.occurredAt,
          })
        );
        break;
      }

      default:
        break;
    }
  }

  get(userId, productId) {
    if (!userId || !productId) return null;
    return (
      this.#state.get(EntitlementProjectionEngine.key(userId, productId)) ??
      null
    );
  }

  getSubscription(userId, scope = "ALL_ACCESS") {
    if (!userId) return null;
    return (
      this.#state.get(EntitlementProjectionEngine.subKey(userId, scope)) ??
      null
    );
  }

  snapshot() {
    return Object.fromEntries(this.#state);
  }

  _clearState() {
    this.#state.clear();
  }

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
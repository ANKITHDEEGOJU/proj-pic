"use strict";

const { deepFreeze, EVENT_EFFECT } = require("./util");

const DAY_MS = 24 * 60 * 60 * 1000;

class EntitlementProjectionEngine {
  #state = new Map();
  #kindByEvent = new Map(); // granting eventId -> { kind, scope }, so reversals hit the right entitlement
  #subs = new Map(); // subKey -> { periods, cancelledAt, lastRevoke } (raw subscription state)

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
    const effect = EVENT_EFFECT[e.eventType];
    if (!effect || effect === "NONE") return;

    const target = this.#resolveTarget(record, effect);
    if (effect === "GRANT" || effect === "EXTEND") this.#kindByEvent.set(e.eventId, target);

    if (target.kind === "SUBSCRIPTION") this.#applySubscription(record, effect, target);
    else this.#applyCourse(record, effect);
  }

  // Works out whether the event is about a course or a subscription (and which scope).
  #resolveTarget(record, effect) {
    const e = record.event;
    if (e.entitlement) return { kind: e.entitlement.kind, scope: e.entitlement.scope };
    if ((effect === "REVOKE" || effect === "STOP_RENEW") && this.#kindByEvent.has(e.referenceeventId))
      return this.#kindByEvent.get(e.referenceeventId);
    // Legacy rows (before M1) carried this in the catalog snapshot / provider payment info.
    const snapshot = record.productSnapshot || {};
    const paymentInfo = record.paymentInfo || {};
    const isSub = snapshot.type === "SUBSCRIPTION" || paymentInfo.itemType === "SUBSCRIPTION";
    return isSub
      ? { kind: "SUBSCRIPTION", scope: snapshot.scope || paymentInfo.scope || "ALL_ACCESS" }
      : { kind: "COURSE", scope: null };
  }

  #durationDays(record) {
    const ent = record.event.entitlement;
    if (ent) return ent.durationDays;
    const snapshot = record.productSnapshot || {};
    const paymentInfo = record.paymentInfo || {};
    return Number(snapshot.durationDays || paymentInfo.durationDays) || null;
  }

  #revoked(cur, e, type, extra = {}) {
    return deepFreeze({
      userId: e.userId,
      productId: e.productId,
      type,
      ...extra,
      status: "REVOKED",
      sourceEventId: e.eventId,
      revokedBy: e.eventType, // REFUND / CHARGEBACK / MANUAL_REVOKE / SEAT_UNASSIGNED
      grantedAt: cur?.grantedAt ?? e.occurredAt,
      expiresAt: null,
      cancelledAt: null,
      revokedAt: e.occurredAt,
    });
  }

  #applyCourse(record, effect) {
    const e = record.event;
    const k = EntitlementProjectionEngine.key(e.userId, e.productId);

    if (effect === "GRANT" || effect === "EXTEND") {
      let expiresAt = e.entitlement?.expiresAt ?? record.productSnapshot?.expiresAt ?? null;
      const days = this.#durationDays(record);
      if (!expiresAt && days) expiresAt = new Date(Date.parse(e.occurredAt) + days * DAY_MS).toISOString();

      this.#state.set(
        k,
        deepFreeze({
          userId: e.userId,
          productId: e.productId,
          type: "COURSE",
          status: "ACTIVE",
          sourceEventId: e.eventId,
          grantedVia: e.eventType,
          source: e.source ?? "PAYMENT",
          grantedAt: e.occurredAt,
          expiresAt,
          cancelledAt: null,
          revokedAt: null,
        }),
      );
    } else if (effect === "REVOKE") {
      this.#state.set(k, this.#revoked(this.#state.get(k), e, "COURSE"));
    }
    // STOP_RENEW has no meaning for a one-time course purchase.
  }

  // Subscriptions are a list of paid/granted periods laid end to end.
  // Each GRANT/EXTEND adds a period; a REVOKE removes only the period it references,
  // so refunding one month never takes away a different month that was paid separately.
  #applySubscription(record, effect, { scope }) {
    const e = record.event;
    const k = EntitlementProjectionEngine.subKey(e.userId, scope);
    const raw = this.#subs.get(k) ?? { periods: [], cancelledAt: null, lastRevoke: null };

    if (effect === "GRANT" || effect === "EXTEND") {
      raw.periods.push({
        eventId: e.eventId,
        productId: e.productId,
        grantedVia: e.eventType,
        source: e.source ?? "PAYMENT",
        occurredAt: e.occurredAt,
        durationDays: this.#durationDays(record) || 30,
        fixedExpiresAt: e.entitlement?.expiresAt ?? null,
      });
      raw.cancelledAt = null; // a new payment / grant re-enables renewal
    } else if (effect === "STOP_RENEW") {
      if (raw.periods.length) raw.cancelledAt = e.occurredAt;
    } else if (effect === "REVOKE") {
      raw.periods = raw.periods.filter((p) => p.eventId !== e.referenceeventId);
      raw.lastRevoke = { eventId: e.eventId, eventType: e.eventType, at: e.occurredAt };
    } else {
      return;
    }
    this.#subs.set(k, raw);
    this.#state.set(k, this.#subscriptionView(e.userId, scope, raw));
  }

  // Lays the periods end to end (a period bought early starts when the previous one ends).
  #subscriptionView(userId, scope, raw) {
    if (raw.periods.length === 0) {
      return deepFreeze({
        userId, productId: null, type: "SUBSCRIPTION", scope,
        status: "REVOKED",
        sourceEventId: raw.lastRevoke?.eventId ?? null,
        revokedBy: raw.lastRevoke?.eventType ?? null,
        grantedVia: null, source: null, grantedAt: null,
        expiresAt: null, cancelledAt: null, revokedAt: raw.lastRevoke?.at ?? null,
        periods: [], refundableEventId: null,
      });
    }
    let endMs = null;
    const periods = raw.periods.map((p) => {
      const startMs = Math.max(Date.parse(p.occurredAt), endMs ?? -Infinity);
      const periodEndMs = p.fixedExpiresAt
        ? Date.parse(p.fixedExpiresAt)
        : startMs + p.durationDays * DAY_MS;
      endMs = Math.max(endMs ?? -Infinity, periodEndMs);
      return {
        eventId: p.eventId, productId: p.productId, grantedVia: p.grantedVia, source: p.source,
        startsAt: new Date(startMs).toISOString(), endsAt: new Date(periodEndMs).toISOString(),
      };
    });
    const latest = periods[periods.length - 1];
    // The most recent period that was actually paid for: what "Refund Subscription" refunds.
    const FREE = ["MANUAL_GRANT", "SEAT_ASSIGNED"];
    const latestPaid = [...periods].reverse().find((p) => !FREE.includes(p.grantedVia)) ?? null;
    return deepFreeze({
      userId,
      productId: latest.productId,
      type: "SUBSCRIPTION",
      scope,
      status: "ACTIVE", // the decision engine still checks expiresAt
      sourceEventId: latest.eventId,
      refundableEventId: latestPaid?.eventId ?? null, // null = only free periods, nothing to refund
      grantedVia: latest.grantedVia,
      source: latest.source,
      grantedAt: raw.periods[0].occurredAt,
      expiresAt: new Date(endMs).toISOString(),
      cancelledAt: raw.cancelledAt,
      revokedAt: null,
      periods,
    });
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
    this.#kindByEvent.clear();
    this.#subs.clear();
  }

  async rebuildFromLedger() {
    this._clearState();
    const records = await this.ledger.getAll();
    records
      .sort((a, b) => a.ledgerSequenceId - b.ledgerSequenceId)
      .forEach((r) => this.apply(r));
    return this.#state.size;
  }
}

module.exports = { EntitlementProjectionEngine };

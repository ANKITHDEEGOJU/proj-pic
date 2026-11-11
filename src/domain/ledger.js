"use strict";
const {
  DomainError,
  deepFreeze,
  sameEvent,
  EVENT_EFFECT,
  NEEDS_REFERENCE,
  SOURCES,
} = require("./util");

const EVENT_TYPES = Object.keys(EVENT_EFFECT);
const PAID_TYPES = ["PURCHASE_SUCCEEDED", "SUBSCRIPTION_STARTED", "SUBSCRIPTION_RENEWED"];
const GRANTING_TYPES = EVENT_TYPES.filter((t) => ["GRANT", "EXTEND"].includes(EVENT_EFFECT[t]));

// Which earlier event types each referencing event may point at.
const ALLOWED_REFERENCES = {
  REFUND: PAID_TYPES, // money goes back: only for paid events
  CHARGEBACK: PAID_TYPES,
  MANUAL_REVOKE: GRANTING_TYPES,
  SEAT_UNASSIGNED: ["SEAT_ASSIGNED"],
  SUBSCRIPTION_CANCELLED: GRANTING_TYPES,
};
const ENTITLEMENT_KINDS = ["COURSE", "SUBSCRIPTION"];

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
    const needsRef = NEEDS_REFERENCE.includes(ev.eventType);
    if (needsRef && !ref)
      bad("E1_MISSING_REFERENCE", `${ev.eventType} must reference an earlier eventId`);
    if (!needsRef && ref !== null)
      bad("E1_UNEXPECTED_REFERENCE", `referenceeventId not allowed on ${ev.eventType}`);

    const source = ev.source ?? "PAYMENT";
    if (!SOURCES.includes(source))
      bad("E1_INVALID_SOURCE", `source must be one of ${SOURCES.join(", ")}`);
    const actor = ev.actor ?? null;
    if (actor !== null && typeof actor !== "string")
      bad("E1_INVALID_ACTOR", "actor must be a string");
    const reason = ev.reason ?? null;
    if (reason !== null && typeof reason !== "string")
      bad("E1_INVALID_REASON", "reason must be a string");

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
      source,
      actor,
      reason,
      entitlement: this.#validateEntitlement(ev.entitlement, bad),
    });
  }

  // What access the event is about, stored on the event itself (not read from provider payloads).
  #validateEntitlement(ent, bad) {
    if (ent === undefined || ent === null) return null;
    if (typeof ent !== "object") bad("E1_INVALID_ENTITLEMENT", "entitlement must be an object");
    if (!ENTITLEMENT_KINDS.includes(ent.kind))
      bad("E1_INVALID_ENTITLEMENT", `entitlement.kind must be ${ENTITLEMENT_KINDS.join(" or ")}`);
    const durationDays = ent.durationDays ?? null;
    if (durationDays !== null && !(Number.isInteger(durationDays) && durationDays > 0))
      bad("E1_INVALID_ENTITLEMENT", "entitlement.durationDays must be a positive integer");
    const expiresAt = ent.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))))
      bad("E1_INVALID_ENTITLEMENT", "entitlement.expiresAt must be an ISO string");
    if (ent.kind === "SUBSCRIPTION" && durationDays === null && expiresAt === null)
      bad("E1_INVALID_ENTITLEMENT", "subscription entitlement needs durationDays or expiresAt");
    return {
      kind: ent.kind,
      scope: ent.scope ?? (ent.kind === "SUBSCRIPTION" ? "ALL_ACCESS" : null),
      durationDays,
      expiresAt,
    };
  }

  async #checkReference(e) {
    if (!e.referenceeventId) return;
    const orig = await this.store.getByEventId(e.referenceeventId);
    const allowed = ALLOWED_REFERENCES[e.eventType];
    if (!orig || !allowed.includes(orig.event.eventType))
      throw new DomainError(
        "E1_INVALID_REFERENCE",
        `${e.eventType} must reference an existing ${allowed.join("/")} event`,
      );
    if (orig.event.userId !== e.userId || orig.event.productId !== e.productId)
      throw new DomainError(
        "E1_REFERENCE_MISMATCH",
        `${e.eventType} user/product must match the referenced event`,
      );
    if (EVENT_EFFECT[e.eventType] === "REVOKE") {
      const prior = await this.store.findReversalOf(e.referenceeventId);
      if (prior)
        throw new DomainError(
          "E1_ALREADY_REVERSED",
          `Event ${e.referenceeventId} already reversed by ${prior}`,
        );
    }
  }

  async appendEvent(event, paymentInfo = {}) {
    const e = this.#validate(event);
    // Enforcing L3 (checked BEFORE reference rules, so a retried refund webhook is a no-op, not an error).
    const ex = await this.store.getByEventId(e.eventId);
    if (ex)
      return {
        appended: false,
        reason: sameEvent(ex.event, e)
          ? "DUPLICATE_EVENT"
          : "EVENT_ID_CONFLICT",
        eventId: e.eventId,
      };
    await this.#checkReference(e);
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
module.exports = { CommerceLedgerService, EVENT_TYPES };

"use strict";
const { deepFreeze } = require("./util");

class EntitlementDecisionEngine {
  constructor(projection) {
    this.projection = projection;
  }

  // Read-only. Enforcing D1 (allowed), D2 (machine-readable reason), D3 (sourceEventIds).
  evaluateAccess(userId, productId) {
    const ent = this.projection.get(userId, productId);
    let allowed = false,
      reason = "NO_PURCHASE_RECORD",
      sourceEventIds = [];
    if (ent) {
      sourceEventIds = [ent.sourceEventId];
      if (ent.status === "ACTIVE") {
        allowed = true;
        reason = "ACTIVE_PURCHASE";
      } else if (ent.status === "REVOKED") {
        reason = "PURCHASE_REFUNDED";
      } else {
        reason = "ENTITLEMENT_EXPIRED";
      }
    }
    return deepFreeze({ allowed, reason, sourceEventIds });
  }
}
module.exports = { EntitlementDecisionEngine };

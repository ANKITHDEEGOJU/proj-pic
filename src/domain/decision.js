"use strict";

const { deepFreeze } = require("./util");

class EntitlementDecisionEngine {
  constructor(projection) {
    this.projection = projection;
  }

  evaluateAccess(userId, productId) {
    const nowMs = Date.now();

    // 1. Direct Perpetual / Specific Course Entitlement Check
    const directEnt = this.projection.get(userId, productId);
    let reason = "NO_PURCHASE_RECORD";
    let sourceEventIds = [];

    if (directEnt) {
      sourceEventIds = [directEnt.sourceEventId];
      if (directEnt.status === "ACTIVE") {
        if (directEnt.expiresAt && new Date(directEnt.expiresAt).getTime() <= nowMs) {
          reason = "ENTITLEMENT_EXPIRED";
        } else {
          return deepFreeze({
            allowed: true,
            reason: "ACTIVE_PURCHASE",
            sourceEventIds,
          });
        }
      } else if (directEnt.status === "REVOKED") {
        reason = "PURCHASE_REFUNDED";
      }
    }

    // 2. Active Subscription Pass Fallback Check (ALL_ACCESS)
    const subEnt = this.projection.getSubscription(userId, "ALL_ACCESS");
    if (subEnt && subEnt.status === "ACTIVE") {
      const isNotExpired = !subEnt.expiresAt || new Date(subEnt.expiresAt).getTime() > nowMs;
      
      if (isNotExpired) {
        return deepFreeze({
          allowed: true,
          reason: "ACTIVE_SUBSCRIPTION_PASS",
          sourceEventIds: [subEnt.sourceEventId],
        });
      }
    }

    return deepFreeze({ allowed: false, reason, sourceEventIds });
  }
}

module.exports = { EntitlementDecisionEngine };
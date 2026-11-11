"use strict";

const { deepFreeze } = require("./util");

// Why access was taken away, keyed by the event type that revoked it.
const REVOKE_REASONS = {
  REFUND: "PURCHASE_REFUNDED",
  CHARGEBACK: "PURCHASE_CHARGED_BACK",
  MANUAL_REVOKE: "ACCESS_REVOKED",
  SEAT_UNASSIGNED: "SEAT_UNASSIGNED",
};

class EntitlementDecisionEngine {
  constructor(projection) {
    this.projection = projection;
  }

  evaluateAccess(userId, productId) {
    const nowMs = Date.now();

    // 1. Direct course entitlement (purchase, manual grant, seat)
    const directEnt = this.projection.get(userId, productId);
    let reason = "NO_PURCHASE_RECORD";
    let sourceEventIds = [];
    let expiresAt;

    if (directEnt) {
      sourceEventIds = [directEnt.sourceEventId];
      if (directEnt.status === "ACTIVE") {
        if (directEnt.expiresAt && new Date(directEnt.expiresAt).getTime() <= nowMs) {
          reason = "ENTITLEMENT_EXPIRED";
          expiresAt = directEnt.expiresAt;
        } else {
          return deepFreeze({
            allowed: true,
            reason: "ACTIVE_PURCHASE",
            sourceEventIds,
            grantedVia: directEnt.grantedVia, // lets the UI hide "Refund" on free grants
          });
        }
      } else if (directEnt.status === "REVOKED") {
        reason = REVOKE_REASONS[directEnt.revokedBy] || "PURCHASE_REFUNDED";
      }
    }

    // 2. All-access subscription fallback
    const subEnt = this.projection.getSubscription(userId, "ALL_ACCESS");
    if (subEnt && subEnt.status === "ACTIVE") {
      const isNotExpired = !subEnt.expiresAt || new Date(subEnt.expiresAt).getTime() > nowMs;
      if (isNotExpired) {
        return deepFreeze({
          allowed: true,
          reason: "ACTIVE_SUBSCRIPTION_PASS",
          sourceEventIds: [subEnt.sourceEventId],
          grantedVia: subEnt.grantedVia,
          expiresAt: subEnt.expiresAt,
        });
      }
      // Say why access ended, instead of pretending nothing was ever bought.
      if (reason === "NO_PURCHASE_RECORD") {
        reason = "SUBSCRIPTION_EXPIRED";
        sourceEventIds = [subEnt.sourceEventId];
        expiresAt = subEnt.expiresAt;
      }
    }

    return deepFreeze(
      expiresAt ? { allowed: false, reason, sourceEventIds, expiresAt } : { allowed: false, reason, sourceEventIds },
    );
  }
}

module.exports = { EntitlementDecisionEngine };

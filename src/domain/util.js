'use strict';
// Machine-readable domain error: `code` carries the invariant ID (e.g. 'E3_UNSUPPORTED_TYPE').
class DomainError extends Error {
  constructor(code, message) { super(message); this.name = 'DomainError'; this.code = code; }
}

// Recursively freezes an object graph (used for E4 immutability).

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

module.exports = { DomainError, deepFreeze };

// Two events are "the same delivery" if their business fields match (occurredAt excluded: retries may differ).
const SAME_FIELDS = ['eventType', 'userId', 'productId', 'quantity', 'amount', 'currency', 'referenceeventId'];
module.exports.sameEvent = (a, b) => SAME_FIELDS.every(k => a[k] === b[k]);
// M1: every ledger event type, grouped by what it does to access.
// The projection switches on the effect, so adding a type is one line here.
const EVENT_EFFECT = Object.freeze({
  PURCHASE_SUCCEEDED:     'GRANT',
  MANUAL_GRANT:           'GRANT',      // admin / scholarship grant
  SEAT_ASSIGNED:          'GRANT',      // enterprise seat (M4)
  SUBSCRIPTION_STARTED:   'GRANT',
  SUBSCRIPTION_RENEWED:   'EXTEND',
  SUBSCRIPTION_CANCELLED: 'STOP_RENEW', // access stays until expiry
  REFUND:                 'REVOKE',
  CHARGEBACK:             'REVOKE',
  MANUAL_REVOKE:          'REVOKE',
  SEAT_UNASSIGNED:        'REVOKE',
  PURCHASE_FAILED:        'NONE',
});
// Event types that must point at an earlier event via referenceeventId.
const NEEDS_REFERENCE = Object.keys(EVENT_EFFECT).filter(
  (t) => EVENT_EFFECT[t] === 'REVOKE' || EVENT_EFFECT[t] === 'STOP_RENEW',
);
const SOURCES = Object.freeze(['PAYMENT', 'ADMIN', 'SCHOLARSHIP', 'ORG_SEAT', 'SYSTEM']);

module.exports.EVENT_EFFECT = EVENT_EFFECT;
module.exports.NEEDS_REFERENCE = NEEDS_REFERENCE;
module.exports.SOURCES = SOURCES;

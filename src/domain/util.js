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
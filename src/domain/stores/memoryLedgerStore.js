"use strict";
const { deepFreeze, sameEvent } = require("../util");
// LedgerStore contract implementation for tests/prototyping. Same interface as PgLedgerStore.
class MemoryLedgerStore {
  #records = [];
  #byId = new Map();
  #refunded = new Set();
  #seq = 0;
  async append({ event, productSnapshot, paymentInfo }) {
    const ex = this.#byId.get(event.eventId);
    if (ex) return { inserted: false, conflict: !sameEvent(ex.event, event) };
    const record = deepFreeze({
      ledgerSequenceId: ++this.#seq,
      event,
      productSnapshot,
      paymentInfo,
      recordedAt: new Date().toISOString(),
    });
    this.#records.push(record);
    this.#byId.set(event.eventId, record);
    if (event.eventType === "REFUND")
      this.#refunded.add(event.referenceeventId);
    return { inserted: true, record };
  }
  async getAll() {
    return this.#records.slice();
  }
  async getByEventId(id) {
    return this.#byId.get(id) ?? null;
  }
  async hasRefundFor(id) {
    return this.#refunded.has(id);
  }
  async count() {
    return this.#records.length;
  }
}
module.exports = { MemoryLedgerStore };

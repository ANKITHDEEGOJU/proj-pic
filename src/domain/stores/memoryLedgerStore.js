"use strict";
const { deepFreeze, sameEvent, EVENT_EFFECT } = require("../util");
// LedgerStore contract implementation for tests/prototyping. Same interface as PgLedgerStore.
class MemoryLedgerStore {
  #records = [];
  #byId = new Map();
  #reversedBy = new Map(); // referenced eventId -> reversing event type
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
    if (EVENT_EFFECT[event.eventType] === "REVOKE")
      this.#reversedBy.set(event.referenceeventId, event.eventType);
    return { inserted: true, record };
  }
  async getAll() {
    return this.#records.slice();
  }
  async getByEventId(id) {
    return this.#byId.get(id) ?? null;
  }
  async findReversalOf(id) {
    return this.#reversedBy.get(id) ?? null;
  }
  async count() {
    return this.#records.length;
  }
}
module.exports = { MemoryLedgerStore };

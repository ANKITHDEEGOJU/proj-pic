"use strict";
const pool = require("../db");

class WebhookProcessor {
  constructor({ ledger }) {
    this.ledger = ledger;
  }

  async process(inboxRow, adapter) {
    const { id, raw_body } = inboxRow;
    await pool.query(
      `UPDATE webhook_inbox SET status='PROCESSING' WHERE id=$1`,
      [id],
    );
    let payload;
    try {
      payload = JSON.parse(raw_body);
    } catch {
      await this.#fail(id, "INVALID_JSON");
      return { outcome: "FAILED", reason: "INVALID_JSON" };
    }
    const event = adapter.normalize(payload);
    if (!event) {
      await pool.query(
        `UPDATE webhook_inbox SET status='IGNORED', processed_at=now() WHERE id=$1`,
        [id],
      );
      return { outcome: "IGNORED" };
    }
    const { _raw, ...commerceEvent } = event;
    const paymentInfo = { provider: adapter.name, ..._raw };
    try {
      const result = await this.ledger.appendEvent(commerceEvent, paymentInfo);
      const ledgerEventId = result.appended
        ? result.record.event.eventId
        : commerceEvent.eventId;
      await pool.query(
        `UPDATE webhook_inbox SET status='PROCESSED', processed_at=now(), ledger_event_id=$2 WHERE id=$1`,
        [id, ledgerEventId],
      );
      return {
        outcome: result.appended ? "APPENDED" : "DUPLICATE",
        ledgerEventId,
      };
    } catch (e) {
      await this.#fail(id, e.message);
      return { outcome: "FAILED", reason: e.message };
    }
  }

  async #fail(id, reason) {
    await pool.query(
      `UPDATE webhook_inbox SET status='FAILED', processed_at=now(), failure_reason=$2 WHERE id=$1`,
      [id, reason],
    );
  }
}
module.exports = { WebhookProcessor };

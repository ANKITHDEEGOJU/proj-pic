"use strict";
const { DomainError, deepFreeze, sameEvent } = require("../util");

const toRecord = (r) =>
  deepFreeze({
    ledgerSequenceId: Number(r.ledger_sequence_id),
    event: {
      eventId: r.event_id,
      eventType: r.event_type,
      userId: r.user_id,
      productId: r.product_id,
      quantity: r.quantity,
      amount: Number(r.amount),
      currency: r.currency,
      occurredAt: r.occurred_at.toISOString(),
      referenceeventId: r.reference_event_id,
    },
    productSnapshot: r.product_snapshot,
    paymentInfo: r.payment_info,
    recordedAt: r.recorded_at.toISOString(),
  });

// Postgres implementation of the LedgerStore contract. The pool is injected (domain stays DB-agnostic).
class PgLedgerStore {
  constructor(pool) {
    this.pool = pool;
  }

  async append({ event: e, productSnapshot, paymentInfo }) {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO commerce_ledger (event_id,event_type,user_id,product_id,quantity,amount,currency,occurred_at,reference_event_id,product_snapshot,payment_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (event_id) DO NOTHING RETURNING *`, // L3: race-safe idempotency
        [
          e.eventId,
          e.eventType,
          e.userId,
          e.productId,
          e.quantity,
          e.amount,
          e.currency,
          e.occurredAt,
          e.referenceeventId,
          productSnapshot,
          paymentInfo,
        ],
      );
      if (rows[0]) return { inserted: true, record: toRecord(rows[0]) };
      const ex = await this.getByEventId(e.eventId);
      return { inserted: false, conflict: !sameEvent(ex.event, e) };
    } catch (err) {
      if (
        err.code === "23505" &&
        err.constraint === "uq_one_refund_per_purchase"
      )
        throw new DomainError(
          "E1_REFUND_ALREADY_APPLIED",
          "Purchase already refunded",
        );
      if (err.code === "23503")
        throw new DomainError(
          "E2_INVALID_USER_OR_PRODUCT",
          "Unknown user or product",
        );
      throw err;
    }
  }
  async getAll() {
    return (
      await this.pool.query(
        "SELECT * FROM commerce_ledger ORDER BY ledger_sequence_id",
      )
    ).rows.map(toRecord);
  }
  async getByEventId(id) {
    const { rows } = await this.pool.query(
      "SELECT * FROM commerce_ledger WHERE event_id=$1",
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async hasRefundFor(id) {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM commerce_ledger WHERE event_type='REFUND' AND reference_event_id=$1`,
      [id],
    );
    return rowCount > 0;
  }
  async count() {
    return Number(
      (await this.pool.query("SELECT count(*) FROM commerce_ledger")).rows[0]
        .count,
    );
  }
}
module.exports = { PgLedgerStore };

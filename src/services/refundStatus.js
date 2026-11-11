'use strict';
const pool = require('../db');

// True when the order behind this entitlement has a refund requested but not yet
// confirmed by the payment provider (Option A: access stays until confirmation).
async function isRefundPending(ledger, sourceEventId) {
  if (!sourceEventId) return false;
  const rec = await ledger.getByEventId(sourceEventId);
  const orderId = rec?.paymentInfo?.orderId || rec?.paymentInfo?.orderRef;
  if (!orderId) return false;
  const { rows } = await pool.query('SELECT status FROM orders WHERE id::text = $1', [String(orderId)]);
  return rows[0]?.status === 'REFUND_PENDING';
}

const FREE_GRANTS = ['MANUAL_GRANT', 'SEAT_ASSIGNED'];

module.exports = { isRefundPending, FREE_GRANTS };

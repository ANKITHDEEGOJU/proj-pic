'use strict';
// Asking a payment provider for a refund: the one place that does it (course refunds in
// routes/checkout.js, pass refunds and renewal cancellations in services/subscriptions.js).
//
// Refunds are webhook-driven: this only ASKS the provider. The order is claimed first
// (COMPLETED -> REFUND_PENDING, which also stops a double click from refunding twice); the
// provider's refund webhook then writes the REFUND events and marks the order REFUNDED. If the
// provider refuses, the order is reopened (REFUND_PENDING -> COMPLETED) and nothing changes.
//
// requestRefund({ catalog, userId, orderId, productId, provider, providerPaymentId, amount?, scope? })
//   amount: in major units; default = the order's final_payable_cents (what was really paid)
//   scope:  orders.refund_scope (PASS_FULL / RENEWAL_CANCEL), null for a course refund
// -> { status: 'REQUESTED', providerRefundId, amount }
//  | { status: 'ALREADY_PENDING' } | { status: 'NOT_REFUNDABLE', orderStatus }
//  | { status: 'REFUSED', error }
const pool = require('../db');
const { PaymentService } = require('../payment/service');

// Provider SDK errors carry their text in different places (Razorpay: e.error.description).
const providerMessage = (e) => e?.message || e?.error?.description || (e?.statusCode ? `provider returned HTTP ${e.statusCode}` : 'payment provider refused the refund');

async function requestRefund({ catalog, userId, orderId, productId, provider, providerPaymentId, amount = null, scope = null }) {
  let refundAmount = amount;
  if (orderId) {
    // (older orders may still say PENDING even though they were paid)
    const claim = await pool.query(
      `UPDATE orders SET status = 'REFUND_PENDING', refund_scope = COALESCE($2, refund_scope), updated_at = now()
        WHERE id::text = $1 AND status IN ('COMPLETED','PENDING') RETURNING final_payable_cents`,
      [String(orderId), scope]
    );
    if (!claim.rowCount) {
      const st = (await pool.query('SELECT status FROM orders WHERE id::text = $1', [String(orderId)])).rows[0]?.status;
      return st === 'REFUND_PENDING' ? { status: 'ALREADY_PENDING' } : { status: 'NOT_REFUNDABLE', orderStatus: st || 'MISSING' };
    }
    if (refundAmount === null) refundAmount = claim.rows[0].final_payable_cents / 100;
  }
  try {
    const { providerRefundId } = await new PaymentService({ catalog }).initiateRefund({
      userId, productId, orderId, amount: refundAmount, providerPaymentId, provider: provider || 'mock',
    });
    console.log(`[refund] ${provider}${scope ? ` ${scope}` : ''}: refund ${providerRefundId} requested for order ${orderId || '-'}; waiting for webhook`);
    return { status: 'REQUESTED', providerRefundId, amount: refundAmount };
  } catch (e) {
    if (orderId) {
      await pool.query(
        `UPDATE orders SET status = 'COMPLETED', refund_scope = CASE WHEN $2::text IS NULL THEN refund_scope ELSE NULL END, updated_at = now()
          WHERE id::text = $1 AND status = 'REFUND_PENDING'`,
        [String(orderId), scope]
      );
    }
    const error = providerMessage(e);
    console.error(`[refund] provider refused order ${orderId || '-'}:`, error);
    return { status: 'REFUSED', error };
  }
}

module.exports = { requestRefund, providerMessage };

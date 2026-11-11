"use strict";

const crypto = require("node:crypto");
const Razorpay = require("razorpay");
const { PaymentProviderAdapter } = require("../adapter");

class RazorpayPaymentAdapter extends PaymentProviderAdapter {
  get name() {
    return "razorpay";
  }

  #client = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  async createPayment({ orderRef, userId, productId, amount, currency }) {
    // Razorpay amounts are in minor units (paise for INR / cents for USD).
    const order = await this.#client.orders.create({
      amount: Math.round(amount * 100),
      currency: currency || "INR",
      receipt: String(orderRef),
      payment_capture: 1, // Auto-capture payment on checkout
      notes: {
        userId: String(userId),
        productId: String(productId || ""),
        orderId: String(orderRef),
        orderRef: String(orderRef),
      },
    });

    // The checkout page is served by this app, so keep the redirect relative: an absolute
    // URL on another host (e.g. the ngrok tunnel) loses the auth cookie and lands on /login.
    const redirectUrl = `/razorpay/checkout?orderId=${encodeURIComponent(order.id)}&userId=${encodeURIComponent(
      userId
    )}&productId=${encodeURIComponent(productId)}&amount=${amount}&currency=${currency}`;

    return { providerPaymentId: order.id, redirectUrl };
  }

  // Extract unique provider event ID for inbox idempotency
  extractEventId(payload) {
    const entityId =
      payload.payload?.dispute?.entity?.id ||
      payload.payload?.refund?.entity?.id ||
      payload.payload?.payment?.entity?.id;
    if (!entityId) return null;
    return `${payload.event}:${entityId}`;
  }

  // Secure HMAC-SHA256 signature verification on raw body bytes
  verifyWebhook(rawBody, headers) {
    const sig = headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!sig || !secret) return false;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);

    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  // Event Normalizer: Translates Razorpay webhook payload -> CommerceEvent
  normalize(payload) {
    const typeMap = {
      "payment.captured": "PURCHASE_SUCCEEDED",
      "payment.failed": "PURCHASE_FAILED",
      // A refund counts once Razorpay ACCEPTS it (refund.created): test-mode refunds stay
      // "pending" and never reach refund.processed. Both map to the same ledger event id,
      // so whichever arrives second is a duplicate. refund.failed is flagged for review.
      "refund.created": "REFUND",
      "refund.processed": "REFUND",
      "refund.failed": "REFUND_FAILED",
      "payment.dispute.lost": "CHARGEBACK", // dispute lost = money taken back by the bank
    };

    const eventType = typeMap[payload.event];
    if (!eventType) return null; // Ignorable event (e.g., payment.authorized)

    const payment = payload.payload?.payment?.entity;
    const refund = payload.payload?.refund?.entity;
    const dispute = payload.payload?.dispute?.entity;
    const entity = dispute || refund || payment;

    if (!entity) return null;

    const notes = payment?.notes || refund?.notes || entity.notes || {};
    const orderId =
      notes.orderId ||
      notes.order_id ||
      notes.orderRef ||
      payment?.receipt ||
      null;
    const orderRef = orderId;

    // Resolve payment & refund IDs
    const paymentId = payment?.id || refund?.payment_id || dispute?.payment_id || entity.id;
    const refundId = refund?.id || null; // refund.* webhooks always carry the refund entity

    // Deterministic event IDs for L3 ledger idempotency
    const isReversal = eventType === "REFUND" || eventType === "CHARGEBACK";
    const ledgerEventId =
      eventType === "CHARGEBACK"
        ? `razorpay:${dispute?.id || `dispute_${paymentId}`}`
        : eventType === "REFUND"
          ? `razorpay:${refundId || paymentId}`
          : `razorpay:${paymentId}`;

    const referenceeventId = isReversal ? `razorpay:${paymentId}` : null;

    return {
      eventId: ledgerEventId,
      eventType,
      userId: notes.userId || entity.notes?.userId,
      productId: notes.productId || entity.notes?.productId,
      quantity: 1,
      amount: Number(entity.amount / 100), // paise -> major units
      currency: entity.currency || "INR",
      occurredAt: entity.created_at
        ? new Date(entity.created_at * 1000).toISOString()
        : new Date().toISOString(),
      referenceeventId,
      // _raw is stored in commerce_ledger paymentInfo JSONB
      _raw: {
        providerPaymentId: paymentId,
        providerRefundId: refundId,
        providerDisputeId: dispute?.id || null,
        orderId,
        orderRef,
        notes,
        razorpayOrderId: payment?.order_id || null,
        errorCode: entity.error_code || null,
        errorDescription: entity.error_description || null,
        errorReason: entity.error_reason || null,
      },
    };
  }

  async refund({ providerPaymentId, amount, currency, orderId }) {
    let paymentId = providerPaymentId;

    // Handle order ID lookup: If an order_xxx ID was passed, fetch the captured payment ID
    if (paymentId && paymentId.startsWith("order_")) {
      const payments = await this.#client.orders.fetchPayments(paymentId);
      const captured = payments.items?.find((p) => p.status === "captured") || payments.items?.[0];
      if (!captured) {
        throw new Error(`Razorpay: No successful captured payment found for order ${paymentId}`);
      }
      paymentId = captured.id;
    }

    if (!paymentId) {
      throw new Error("Razorpay: Missing valid providerPaymentId for refund.");
    }

    const options = {};
    if (amount !== undefined && amount !== null && amount > 0) {
      options.amount = Math.round(amount * 100); // Convert to paise
    }

    const refund = await this.#client.payments.refund(paymentId, options);
    return { providerRefundId: refund.id };
  }

  // ---- M6 reconciliation ----------------------------------------------------------
  get supportsReconciliation() {
    return true;
  }

  // Provider-neutral view of a Razorpay payment entity (ProviderTxn).
  #toTxn(p) {
    return {
      providerPaymentId: p.id,
      amount: p.amount / 100,
      amountMinor: p.amount,
      currency: p.currency,
      status: p.status, // created | authorized | captured | refunded | failed
      paid: p.status === "captured" || p.status === "refunded" || Boolean(p.captured),
      amountRefundedMinor: p.amount_refunded || 0,
      orderRef: p.notes?.orderId || p.notes?.orderRef || null,
      occurredAt: new Date(p.created_at * 1000).toISOString(),
      raw: p,
    };
  }

  async listTransactions({ since }) {
    const from = Math.floor(new Date(since).getTime() / 1000);
    const out = [];
    // Razorpay returns at most 100 payments per call: page with skip.
    for (let skip = 0; ; skip += 100) {
      const { items = [] } = await this.#client.payments.all({ from, count: 100, skip });
      out.push(...items.map((p) => this.#toTxn(p)));
      if (items.length < 100) break;
    }
    return out;
  }

  // Refunds created since `since`. Razorpay's payment LIST lags behind refunds (a just-refunded
  // payment can still show status "captured", amount_refunded 0), so reconciliation uses this
  // list to decide which payments need their refunds checked.
  async listRefunds({ since }) {
    const from = Math.floor(new Date(since).getTime() / 1000);
    const out = [];
    for (let skip = 0; ; skip += 100) {
      const { items = [] } = await this.#client.refunds.all({ from, count: 100, skip });
      out.push(...items.map((r) => ({
        providerRefundId: r.id, providerPaymentId: r.payment_id, amountMinor: r.amount, status: r.status, raw: r,
      })));
      if (items.length < 100) break;
    }
    return out;
  }

  async fetchPayment(providerPaymentId) {
    try {
      return this.#toTxn(await this.#client.payments.fetch(providerPaymentId));
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) return null; // unknown id
      throw e;
    }
  }

  async fetchRefunds(providerPaymentId) {
    const { items = [] } = await this.#client.payments.fetchMultipleRefund(providerPaymentId, { count: 100 });
    return items.map((r) => ({
      providerRefundId: r.id,
      amountMinor: r.amount,
      status: r.status, // pending | processed | failed
      raw: r,
    }));
  }

  // Same shape as Razorpay's own webhooks, so normalize() and the processor treat a
  // replayed event exactly like the lost one.
  recoveryEvent(kind, txn, refund = null) {
    if (kind === "purchase") {
      return {
        eventKey: `payment.captured:${txn.providerPaymentId}`,
        payload: { event: "payment.captured", payload: { payment: { entity: txn.raw } } },
      };
    }
    if (kind === "refund") {
      return {
        eventKey: `refund.created:${refund.providerRefundId}`,
        payload: {
          event: "refund.created",
          payload: { refund: { entity: refund.raw }, payment: { entity: txn.raw } },
        },
      };
    }
    throw new Error(`unknown recovery event kind: ${kind}`);
  }
}

module.exports = { RazorpayPaymentAdapter };
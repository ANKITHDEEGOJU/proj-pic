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

    const base = process.env.RAZORPAY_CHECKOUT_URL || "";
    const redirectUrl = `${base}/razorpay/checkout?orderId=${order.id}&userId=${encodeURIComponent(
      userId
    )}&productId=${encodeURIComponent(productId)}&amount=${amount}&currency=${currency}`;

    return { providerPaymentId: order.id, redirectUrl };
  }

  // Extract unique provider event ID for inbox idempotency
  extractEventId(payload) {
    const entityId =
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
      "refund.created": "REFUND",
      "refund.processed": "REFUND",
    };

    const eventType = typeMap[payload.event];
    if (!eventType) return null; // Ignorable event (e.g., payment.authorized)

    const payment = payload.payload?.payment?.entity;
    const refund = payload.payload?.refund?.entity;
    const entity = refund || payment;

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
    const paymentId = payment?.id || refund?.payment_id || entity.id;
    const refundId = refund?.id || (eventType === "REFUND" ? entity.id : null);

    // Deterministic event IDs for L3 ledger idempotency
    const ledgerEventId =
      eventType === "REFUND"
        ? `razorpay:${refundId || paymentId}`
        : `razorpay:${paymentId}`;

    const referenceeventId =
      eventType === "REFUND" ? `razorpay:${paymentId}` : null;

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

  async listTransactions({ since }) {
    const { items } = await this.#client.payments.all({
      from: Math.floor(new Date(since).getTime() / 1000),
    });

    return items.map((p) => ({
      providerPaymentId: p.id,
      amount: p.amount / 100,
      currency: p.currency,
      status: p.status,
      occurredAt: new Date(p.created_at * 1000).toISOString(),
    }));
  }
}

module.exports = { RazorpayPaymentAdapter };
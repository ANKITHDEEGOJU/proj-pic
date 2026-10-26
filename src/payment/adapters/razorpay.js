"use strict";
const { PaymentProviderAdapter } = require("../adapter");
const Razorpay = require("razorpay");
const crypto = require("node:crypto");

class RazorpayPaymentAdapter extends PaymentProviderAdapter {
  get name() {
    return "razorpay";
  }

  #client = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  async createPayment({ orderRef, userId, productId, amount, currency }) {
    // Razorpay amounts are in minor units (paise for INR).
    const order = await this.#client.orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt: orderRef,
      payment_capture: 1, // 👈 Tell Razorpay to automatically capture the payment!
      notes: { userId, productId },
    });
    const base = process.env.RAZORPAY_CHECKOUT_URL;
    // Send the browser to your own hosted checkout page that loads Razorpay.js.
    const redirectUrl = `${base}/razorpay/checkout?orderId=${order.id}&userId=${encodeURIComponent(userId)}&productId=${encodeURIComponent(productId)}&amount=${amount}&currency=${currency}`;
    return { providerPaymentId: order.id, redirectUrl };
  }

  // Razorpay payload structure:
  // { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_xxx', ... } } } }
  // { event: 'refund.created',   payload: { refund:  { entity: { id: 'rfnd_xxx', ... } } } }
  extractEventId(payload) {
    const entityId =
      payload.payload?.refund?.entity?.id ||
      payload.payload?.payment?.entity?.id;
    if (!entityId) return null;
    return `${payload.event}:${entityId}`; // e.g. "payment.captured:pay_xxx"
  }

  // Razorpay signs webhooks with HMAC-SHA256 of the raw body using the webhook secret.
  verifyWebhook(rawBody, headers) {
    const sig = headers["x-razorpay-signature"];
    if (!sig) return false;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  // EventNormalizer: Razorpay event types -> CommerceEvent.
  normalize(payload) {
    const typeMap = {
      "payment.captured": "PURCHASE_SUCCEEDED",
      "payment.failed": "PURCHASE_FAILED",
      "refund.created": "REFUND",
      "refund.processed": "REFUND", // 👈 Handle refund.processed
    };
    const eventType = typeMap[payload.event];
    if (!eventType) return null;

    const payment = payload.payload?.payment?.entity;
    const refund = payload.payload?.refund?.entity;
    const entity = refund || payment;
    const notes = payment?.notes || {};

    return {
      eventId: `razorpay:${entity.id}`, // deterministic for L3
      eventType,
      userId: notes.userId,
      productId: notes.productId,
      quantity: 1,
      amount: entity.amount / 100, // paise -> major units
      currency: entity.currency,
      occurredAt: new Date(entity.created_at * 1000).toISOString(),
      referenceeventId:
        eventType === "REFUND" ? `razorpay:${refund.payment_id}` : null,
    // _raw is picked up by webhookProcessor and stored in paymentInfo JSONB.
      // providerPaymentId is the Razorpay payment ID needed to issue refunds later.
      _raw: {
        providerPaymentId: payment?.id || entity.id,
        providerRefundId:  eventType === 'REFUND' ? entity.id : null,
        },
    };
  }

  async refund({ providerPaymentId, amount, currency }) {
    const refund = await this.#client.payments.refund(providerPaymentId, {
      amount: Math.round(amount * 100),
      
    });
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

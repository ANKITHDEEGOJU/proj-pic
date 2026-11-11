"use strict";
const { randomUUID } = require("node:crypto");
const { getAdapter } = require("./registry");

class PaymentService {
  constructor({ catalog }) {
    this.catalog = catalog;
  }

  async initiatePayment({ userId, productId = null, amount, orderId, provider }) {
    const p = (productId && this.catalog) ? this.catalog.get(productId) : null;

    // Strict validation: Throw error if amount is missing and product isn't in catalog
    if (!p && amount === undefined) {
      throw new Error(`Unknown product or missing payment amount.`);
    }

    const adapter = getAdapter(provider);
    const finalAmount = amount !== undefined ? Number(amount) : p.price;
    const currency = p?.currency || "USD";
    const orderRef = orderId ? String(orderId) : `order_${randomUUID()}`;

    const { providerPaymentId, redirectUrl } = await adapter.createPayment({
      orderRef,
      userId,
      productId: productId || "multi_item_order",
      amount: finalAmount,
      currency,
    });

    return { orderRef, providerPaymentId, redirectUrl, provider };
  }

  async initiateRefund({ userId, productId, orderId, amount, providerPaymentId, provider = "mock" }) {
    const p = (productId && this.catalog) ? this.catalog.get(productId) : null;

    if (!p && amount === undefined) {
      throw new Error(`Unknown product or missing refund amount.`);
    }

    const adapter = getAdapter(provider);
    const finalAmount = amount !== undefined ? Number(amount) : p.price;
    const currency = p?.currency || "USD";

    const { providerRefundId } = await adapter.refund({
      providerPaymentId,
      orderId, // lets the provider's refund webhook point back at our order
      amount: finalAmount,
      currency,
      userId,
      productId,
    });

    return { providerRefundId };
  }
}

module.exports = { PaymentService };
"use strict";
const { randomUUID } = require("node:crypto");
const { getAdapter } = require("./registry");

class PaymentService {
  constructor({ catalog }) {
    this.catalog = catalog;
  }

  async initiatePayment({ userId, productId, provider = "mock" }) {
    const p = this.catalog.get(productId);
    if (!p) throw new Error(`Unknown product: ${productId}`);
    const adapter = getAdapter(provider);
    const orderRef = `order_${randomUUID()}`;
    const { providerPaymentId, redirectUrl } = await adapter.createPayment({
      orderRef,
      userId,
      productId,
      amount: p.price,
      currency: p.currency,
    });
    return { orderRef, providerPaymentId, redirectUrl, provider };
  }

  async initiateRefund({
    userId,
    productId,
    providerPaymentId,
    provider = "mock",
  }) {
    const p = this.catalog.get(productId);
    if (!p) throw new Error(`Unknown product: ${productId}`);
    const adapter = getAdapter(provider);
    const { providerRefundId } = await adapter.refund({
      providerPaymentId,
      amount: p.price,
      currency: p.currency,
      userId,
      productId,
    });
    return { providerRefundId };
  }
}
module.exports = { PaymentService };

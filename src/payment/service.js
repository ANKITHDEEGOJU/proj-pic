"use strict";
const { randomUUID } = require("node:crypto");
const { getAdapter } = require("./registry");

class PaymentService {
  constructor({ catalog }) {
    this.catalog = catalog;
  }

  async initiatePayment({ userId, productId, amount, orderId, provider}) {

	const p = this.catalog ? this.catalog.get(productId) : null;

    // Strict validation: Throw 'Unknown product' IF amount is missing AND product isn't in catalog
    if (!p && amount === undefined) {
      throw new Error(`Unknown product: ${productId}`);
    }
    const adapter = getAdapter(provider);

    // 1. Amount: Use explicit amount override (e.g. discounted cart) OR fallback to catalog price
    const finalAmount = amount !== undefined ? Number(amount) : p.price;

    // 2. Currency: Use catalog currency or default to USD
    const currency = p?.currency || "USD";

    // 3. Order Reference: Use database orderId if provided, else fallback to random UUID
    const orderRef = orderId ? String(orderId) : `order_${randomUUID()}`;

    const { providerPaymentId, redirectUrl } = await adapter.createPayment({
      orderRef,
      userId,
      productId,
      amount: finalAmount,
      currency,
    });
    return { orderRef, providerPaymentId, redirectUrl, provider };
  }

  async initiateRefund({
    userId,
    productId,
    amount,
    providerPaymentId,
    provider = "mock",
  }) {
    const p = this.catalog ? this.catalog.get(productId) : null;

    if (!p && amount === undefined) {
      throw new Error(`Unknown product: ${productId}`);
    }

    const adapter = getAdapter(provider);
    const finalAmount = amount !== undefined ? Number(amount) : p.price;
    const currency = p?.currency || "USD";

    const { providerRefundId } = await adapter.refund({
      providerPaymentId,
      amount: finalAmount,
      currency,
      userId,
      productId,
    });

    return { providerRefundId };
  }
}

module.exports = { PaymentService };

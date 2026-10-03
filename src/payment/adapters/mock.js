'use strict';
const { randomUUID } = require('node:crypto');
const { PaymentProviderAdapter } = require('../adapter');

const MOCK_SECRET = process.env.MOCK_WEBHOOK_SECRET 

// In-memory store of payments for refunds + reconciliation. Lost on mock-provider restart, which is fine.
const payments = new Map();

class MockPaymentAdapter extends PaymentProviderAdapter {
  get name() { return 'mock'; }

  async createPayment({ orderRef, userId, productId, amount, currency }) {
    const providerPaymentId = `mock_pay_${randomUUID()}`;
    payments.set(providerPaymentId, { orderRef, userId, productId, amount, currency, status: 'PENDING', createdAt: new Date().toISOString() });
    // redirectUrl points to the mock provider's hosted payment page.
    const base = process.env.MOCK_PROVIDER_URL;
    const redirectUrl = `${base}/pay/${providerPaymentId}?amount=${amount}&currency=${currency}&product=${encodeURIComponent(productId)}&ref=${encodeURIComponent(orderRef)}&userId=${encodeURIComponent(userId)}`;
    return { providerPaymentId, redirectUrl };
  }

  // Signature: we just check the secret header. Real adapters use HMAC-SHA256 of raw body.
  verifyWebhook(rawBody, headers) {
    return headers['x-mock-secret'] === MOCK_SECRET;
  }

  // EventNormalizer: translate mock payload → CommerceEvent.
  // eventId is deterministic so provider retries are idempotent at L3.
  normalize(payload) {
    const { eventType: mockType, providerPaymentId, userId, productId, amount, currency, providerRefundId } = payload;
    const typeMap = { 'payment.succeeded': 'PURCHASE_SUCCEEDED', 'payment.failed': 'PURCHASE_FAILED', 'refund.succeeded': 'REFUND' };
    const eventType = typeMap[mockType];
    if (!eventType) return null;                              // ignorable event (e.g. payment.pending)
    const providerEventId = providerRefundId || providerPaymentId;
    return {
      eventId: `mock:${providerEventId}`,                    // deterministic (L3)
      eventType,
      userId,
      productId,
      quantity: 1,
      amount: Number(amount),
      currency,
      occurredAt: payload.occurredAt || new Date().toISOString(),
      referenceeventId: eventType === 'REFUND' ? `mock:${providerPaymentId}` : null,
      _raw: { providerPaymentId, providerRefundId: providerRefundId || null },
    };
  }

  async refund({ providerPaymentId, amount, currency, userId, productId }) {
    const pay = payments.get(providerPaymentId);
    if (!pay) throw new Error(`Mock: unknown providerPaymentId ${providerPaymentId}`);
    if (pay.status === 'REFUNDED') throw new Error('Mock: already refunded');
    pay.status = 'REFUNDED';
    const providerRefundId = `mock_ref_${randomUUID()}`;
    pay.providerRefundId = providerRefundId;
    // Tell the mock provider to fire the refund webhook to StreamFlix.
    const base = process.env.MOCK_PROVIDER_URL 
    await fetch(`${base}/refund/${providerPaymentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: pay.userId, productId: pay.productId, amount, currency, providerRefundId }),
    });
    return { providerRefundId };
  }

  async listTransactions({ since }) {
    return [...payments.entries()]
      .filter(([, p]) => new Date(p.createdAt) >= new Date(since))
      .map(([id, p]) => ({ providerPaymentId: id, amount: p.amount, currency: p.currency, status: p.status, occurredAt: p.createdAt }));
  }
}
module.exports = { MockPaymentAdapter };
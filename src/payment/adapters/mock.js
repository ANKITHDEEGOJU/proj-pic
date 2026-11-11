'use strict';

const { randomUUID } = require('node:crypto');
const { PaymentProviderAdapter } = require('../adapter');

const MOCK_SECRET = process.env.MOCK_WEBHOOK_SECRET || 'mock_dev_secret_123';

// In-memory store of payments for refunds + reconciliation.
const payments = new Map();

class MockPaymentAdapter extends PaymentProviderAdapter {
  get name() { return 'mock'; }

  async createPayment({ orderRef, userId, productId, amount, currency }) {
    const providerPaymentId = `mock_pay_${randomUUID()}`;
    payments.set(providerPaymentId, { 
      orderRef, 
      userId, 
      productId, 
      amount, 
      currency, 
      status: 'PENDING', 
      createdAt: new Date().toISOString() 
    });

    const base = process.env.MOCK_PROVIDER_URL || 'http://localhost:3000';
    const redirectUrl = `${base}/pay/${providerPaymentId}?amount=${amount}&currency=${currency}&product=${encodeURIComponent(productId)}&ref=${encodeURIComponent(orderRef)}&userId=${encodeURIComponent(userId)}`;
    return { providerPaymentId, redirectUrl };
  }

  // Extract payment or refund ID from mock webhook payloads
  extractEventId(payload) {
    return payload.providerRefundId || payload.providerPaymentId || payload.eventId || null;
  }

  // Header signature verification with safe fallback
  verifyWebhook(rawBody, headers) {
    const incomingSecret = headers['x-mock-secret'] || headers['X-Mock-Secret'];
    return incomingSecret === MOCK_SECRET;
  }

  // Normalize mock payload → CommerceEvent
  normalize(payload) {
    const { 
      eventType: mockType, 
      providerPaymentId, 
      userId, 
      productId, 
      amount, 
      currency, 
      providerRefundId,
      orderRef,
      orderId
    } = payload;

    const typeMap = { 
      'payment.succeeded': 'PURCHASE_SUCCEEDED', 
      'payment.failed': 'PURCHASE_FAILED', 
      'refund.succeeded': 'REFUND' 
    };

    const eventType = typeMap[mockType];
    if (!eventType) return null; // Ignorable event

    const providerEventId = providerRefundId || providerPaymentId;
    const payRecord = payments.get(providerPaymentId);
    
    // Resolve orderRef from payload or in-memory map fallback
    const resolvedOrderRef = orderRef || orderId || payRecord?.orderRef || null;

    return {
      eventId: `mock:${providerEventId}`,
      eventType,
      userId: userId || payRecord?.userId,
      productId: productId || payRecord?.productId,
      quantity: 1,
      amount: Number(amount ?? payRecord?.amount ?? 0),
      currency: currency || payRecord?.currency || 'USD',
      occurredAt: payload.occurredAt || new Date().toISOString(),
      referenceeventId: eventType === 'REFUND' ? `mock:${providerPaymentId}` : null,
      _raw: { 
        providerPaymentId, 
        providerRefundId: providerRefundId || null,
        orderRef: resolvedOrderRef,
        orderId: resolvedOrderRef
      },
    };
  }

async refund({ providerPaymentId, amount, currency, userId, productId }) {
    // 1. Strip 'mock:' prefix if present
    const cleanId = providerPaymentId ? String(providerPaymentId).replace(/^mock:/, '') : providerPaymentId;
    
    let pay = payments.get(cleanId) || payments.get(providerPaymentId);

    // 2. Fallback: If in-memory map lost the reference across sessions/restarts, auto-recreate the mock stub
    if (!pay) {
      pay = {
        orderRef: `order_${randomUUID()}`,
        userId,
        productId,
        amount,
        currency,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };
      payments.set(cleanId, pay);
    }

    if (pay.status === 'REFUNDED') throw new Error('Mock: already refunded');

    pay.status = 'REFUNDED';
    const providerRefundId = `mock_ref_${randomUUID()}`;
    pay.providerRefundId = providerRefundId;

    const base = process.env.MOCK_PROVIDER_URL || 'http://localhost:3000';
    try {
      await fetch(`${base}/refund/${cleanId}`, {
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'x-mock-secret': MOCK_SECRET
        },
        body: JSON.stringify({ 
          userId: userId || pay.userId, 
          productId: productId || pay.productId, 
          amount, 
          currency, 
          providerRefundId,
          orderRef: pay.orderRef
        }),
      });
    } catch (err) {
      console.warn('[MockAdapter] Refund webhook dispatch note:', err.message);
    }

    return { providerRefundId };
  }
  async listTransactions({ since }) {
    return [...payments.entries()]
      .filter(([, p]) => new Date(p.createdAt) >= new Date(since))
      .map(([id, p]) => ({ 
        providerPaymentId: id, 
        amount: p.amount, 
        currency: p.currency, 
        status: p.status, 
        occurredAt: p.createdAt 
      }));
  }
}

module.exports = { MockPaymentAdapter };
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
    return payload.providerChargebackId || payload.providerRefundId || payload.providerPaymentId || payload.eventId || null;
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
      providerChargebackId,
      orderRef,
      orderId
    } = payload;

    const typeMap = { 
      'payment.succeeded': 'PURCHASE_SUCCEEDED', 
      'payment.failed': 'PURCHASE_FAILED', 
      'refund.succeeded': 'REFUND',      // mock refunds succeed straight away (= Razorpay refund.processed)
      'refund.failed': 'REFUND_FAILED',
      'chargeback.created': 'CHARGEBACK'
    };

    const eventType = typeMap[mockType];
    if (!eventType) return null; // Ignorable event

    const providerEventId = providerChargebackId || providerRefundId || providerPaymentId;
    const isReversal = eventType === 'REFUND' || eventType === 'CHARGEBACK';
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
      referenceeventId: isReversal ? `mock:${providerPaymentId}` : null,
      _raw: { 
        providerPaymentId, 
        providerRefundId: providerRefundId || null,
        providerChargebackId: providerChargebackId || null,
        orderRef: resolvedOrderRef,
        orderId: resolvedOrderRef
      },
    };
  }

async refund({ providerPaymentId, amount, currency, userId, productId, orderId }) {
    // 1. Strip 'mock:' prefix if present
    const cleanId = providerPaymentId ? String(providerPaymentId).replace(/^mock:/, '') : providerPaymentId;
    
    let pay = payments.get(cleanId) || payments.get(providerPaymentId);

    // 2. Fallback: If in-memory map lost the reference across sessions/restarts, auto-recreate the mock stub
    if (!pay) {
      pay = {
        orderRef: orderId || null, // real order id from the caller (never a made-up one)
        userId,
        productId,
        amount,
        currency,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };
      payments.set(cleanId, pay);
    }

    if (orderId) pay.orderRef = orderId;
    if (pay.status === 'REFUNDED') throw new Error('Mock: already refunded');

    const providerRefundId = `mock_ref_${randomUUID()}`;
    const base = process.env.MOCK_PROVIDER_URL || 'http://localhost:3000';
    // Like a real provider API: if the provider can't be reached or says no, the refund FAILS
    // (the caller reopens the order) instead of pretending it went through.
    let r;
    try {
      r = await fetch(`${base}/refund/${cleanId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mock-secret': MOCK_SECRET },
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
      throw new Error(`mock provider unreachable (${err.cause?.code || err.message})`);
    }
    if (!r.ok) throw new Error(`mock provider returned HTTP ${r.status}`);

    pay.status = 'REFUNDED';
    pay.providerRefundId = providerRefundId;
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
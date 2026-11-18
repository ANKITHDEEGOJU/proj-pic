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
  // ---- M7: server-to-server charge (sandbox only) ---------------------------------------
  get supportsDirectCharge() { return true; }

  async charge({ providerPaymentId, orderRef, userId, productId, amount, currency }) {
    const base = process.env.MOCK_PROVIDER_URL || 'http://localhost:3001';
    let r;
    try {
      r = await fetch(`${base}/api/charge/${encodeURIComponent(providerPaymentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mock-secret': MOCK_SECRET },
        body: JSON.stringify({ orderRef, userId, productId, amount, currency }),
      });
    } catch (err) {
      throw new Error(`mock provider unreachable (${err.cause?.code || err.message})`);
    }
    if (!r.ok) throw new Error(`mock provider returned HTTP ${r.status}`);
    const pay = payments.get(providerPaymentId);
    if (pay) pay.status = 'PAID';
    return r.json();
  }

  // ---- M6 reconciliation: ask the mock provider what really happened ------------------
  get supportsReconciliation() { return true; }

  async #api(path) {
    const base = process.env.MOCK_PROVIDER_URL || 'http://localhost:3001';
    let r;
    try {
      r = await fetch(`${base}/api${path}`, { headers: { 'x-mock-secret': MOCK_SECRET } });
    } catch (err) {
      throw new Error(`mock provider unreachable (${err.cause?.code || err.message})`);
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`mock provider returned HTTP ${r.status}`);
    return r.json();
  }

  #toTxn(p) {
    const minor = (x) => Math.round(Number(x || 0) * 100);
    return {
      providerPaymentId: p.id,
      amountMinor: minor(p.amount),
      currency: p.currency || 'USD',
      status: p.status, // paid | failed | refunded
      paid: p.status === 'paid' || p.status === 'refunded',
      amountRefundedMinor: (p.refunds || []).reduce((sum, r) => sum + minor(r.amount), 0),
      orderRef: p.orderRef || null,
      occurredAt: p.createdAt,
      userId: p.userId,
      productId: p.productId,
    };
  }

  #toRefund(r, paymentId) {
    return {
      providerRefundId: r.id,
      providerPaymentId: paymentId,
      amountMinor: Math.round(Number(r.amount) * 100),
      status: r.status,
      raw: { created_at: Math.floor(new Date(r.createdAt).getTime() / 1000) },
    };
  }

  async listTransactions({ since }) {
    const list = await this.#api(`/payments?since=${encodeURIComponent(new Date(since).toISOString())}`);
    return (list || []).map((p) => this.#toTxn(p));
  }

  async fetchPayment(providerPaymentId) {
    const p = await this.#api(`/payments/${encodeURIComponent(String(providerPaymentId).replace(/^mock:/, ''))}`);
    return p ? this.#toTxn(p) : null;
  }

  async listRefunds({ since }) {
    const list = await this.#api(`/refunds?since=${encodeURIComponent(new Date(since).toISOString())}`);
    return (list || []).map((r) => this.#toRefund(r, r.paymentId));
  }

  async fetchRefunds(providerPaymentId) {
    const p = await this.#api(`/payments/${encodeURIComponent(String(providerPaymentId).replace(/^mock:/, ''))}`);
    return p ? p.refunds.map((r) => this.#toRefund(r, p.id)) : [];
  }

  // The webhook the mock provider would have sent, for replaying a lost one.
  recoveryEvent(kind, txn, refund = null) {
    const common = {
      providerPaymentId: txn.providerPaymentId,
      userId: txn.userId,
      productId: txn.productId,
      currency: txn.currency,
      orderRef: txn.orderRef || undefined,
    };
    if (kind === 'purchase') {
      return {
        eventKey: `payment.succeeded:${txn.providerPaymentId}`,
        payload: { ...common, eventType: 'payment.succeeded', amount: txn.amountMinor / 100, occurredAt: txn.occurredAt },
      };
    }
    return {
      eventKey: `refund.succeeded:${refund.providerRefundId}`,
      payload: {
        ...common, eventType: 'refund.succeeded', providerRefundId: refund.providerRefundId,
        amount: refund.amountMinor / 100, occurredAt: new Date(refund.raw.created_at * 1000).toISOString(),
      },
    };
  }
}

module.exports = { MockPaymentAdapter };
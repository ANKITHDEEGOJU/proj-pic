"use strict";
/**
 * PaymentProviderAdapter – interface contract.
 * Every provider adapter must implement these five methods.
 * The domain (ledger, projection, decisions) NEVER imports an adapter.
 */
class PaymentProviderAdapter {
  get name() {
    throw new Error("name getter required");
  }

  /**
   * Open a payment with the provider.
   * Returns { providerPaymentId, redirectUrl } so the browser can be sent
   * to the provider's hosted payment page.
   */
  async createPayment({ orderRef, userId, productId, amount, currency }) {
    throw new Error("not implemented");
  }

  /**
   * Verify the webhook signature using the RAW request body (Buffer) and headers.
   * Must be called BEFORE any JSON parsing. Returns boolean.
   */
  verifyWebhook(rawBody, headers) {
    throw new Error("not implemented");
  }

    /**
   * Extract the provider's own event/payment ID from the raw parsed payload.
   * Used by the webhook route to key the inbox row BEFORE normalization.
   * Must return a stable string that is unique per event delivery.
   * Returns null for payloads that cannot be keyed (will be rejected with 400).
   */
  extractEventId(payload) { throw new Error('not implemented'); }


  /**
   * Translate a provider-specific payload into a CommerceEvent (or null for ignorable events).
   * This is the EventNormalizer step in the pipeline.
   * eventId must be deterministic: `${this.name}:${providerEventId}` so retries hit L3.
   */
  normalize(rawPayload) {
    throw new Error("not implemented");
  }

  /**
   * Issue a refund with the provider.
   * Returns { providerRefundId }.
   */
  async refund({ providerPaymentId, amount, currency }) {
    throw new Error("not implemented");
  }

  /**
   * List provider transactions since a given date.
   * Used by the ReconciliationService.
   * Returns ProviderTxn[]: [{ providerPaymentId, amount, currency, status, occurredAt }]
   */
  async listTransactions({ since }) {
    throw new Error("not implemented");
  }

  // ---- M6 reconciliation (optional) -------------------------------------------------
  // Adapters that can be asked "what really happened?" return true and implement the
  // methods below. Others only get the provider-independent (database) checks.
  get supportsReconciliation() {
    return false;
  }

  /** One payment as a ProviderTxn (see listTransactions), or null if the provider has none. */
  async fetchPayment(providerPaymentId) {
    throw new Error("not implemented");
  }

  /** Refunds created since a date: [{ providerRefundId, providerPaymentId, amountMinor, status, raw }]. */
  async listRefunds({ since }) {
    throw new Error("not implemented");
  }

  /** Refunds of a payment: [{ providerRefundId, amountMinor, status, raw }]. */
  async fetchRefunds(providerPaymentId) {
    throw new Error("not implemented");
  }

  /**
   * Rebuilds the webhook payload the provider would have sent, so a lost event can be
   * replayed through the normal webhook pipeline (same deterministic ledger ids).
   * kind: 'purchase' | 'refund'. Returns { eventKey, payload } (eventKey = inbox id suffix).
   */
  recoveryEvent(kind, txn, refund = null) {
    throw new Error("not implemented");
  }
}
module.exports = { PaymentProviderAdapter };

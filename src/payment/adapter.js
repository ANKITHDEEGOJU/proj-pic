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
}
module.exports = { PaymentProviderAdapter };

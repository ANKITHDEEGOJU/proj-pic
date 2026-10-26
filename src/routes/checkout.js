"use strict";
const router = require("express").Router();
const { requireAuth } = require("../auth");
const { PaymentService } = require("../payment/service");
const { courseCard } = require("../views");

router.post("/courses/:slug/checkout", requireAuth, async (req, res, next) => {
  try {
    const { catalog, decisions, projection } = req.app.locals.engine;
    const p = catalog.get(req.params.slug);
    if (!p) return res.status(404).end();
    const d = decisions.evaluateAccess(req.user.id, p.id);
    if (d.allowed)
      return res.send(courseCard(p, d, "You already own this course."));
    const svc = new PaymentService({ catalog });
    const provider = req.body.provider === 'razorpay' ? 'razorpay' : 'mock';
    const { redirectUrl } = await svc.initiatePayment({
      userId: req.user.id,
      productId: p.id,
      provider
    });
    // Tell HTMX to navigate the browser to the mock provider's payment page.
    res.set("HX-Redirect", redirectUrl).end();
  } catch (e) {
    next(e);
  }
});

router.post(
  "/courses/:slug/checkout/refund",
  requireAuth,
  async (req, res, next) => {
    try {
      const { catalog, decisions, projection, ledger } = req.app.locals.engine;
      const p = catalog.get(req.params.slug);
      if (!p) return res.status(404).end();
      const ent = projection.get(req.user.id, p.id);
      if (!ent || ent.status !== "ACTIVE")
        return res.send(
          courseCard(
            p,
            decisions.evaluateAccess(req.user.id, p.id),
            "Nothing to refund.",
          ),
        );
      // Find the provider payment id from the ledger record of the original purchase.
     // Read the original purchase record to get provider and providerPaymentId.
    const purchaseRecord = await ledger.getByEventId(ent.sourceEventId);
    const paymentInfo    = purchaseRecord?.paymentInfo || {};
    const provider       = paymentInfo.provider;
    const providerPaymentId = paymentInfo.providerPaymentId;

    console.log(`[refund] user=${req.user.id} product=${p.id} provider=${provider} providerPaymentId=${providerPaymentId}`);

    if (!provider || !providerPaymentId) {
      // No provider info on the ledger record (e.g. a mock-checkout purchase from earlier dev).
      // Fall back to appending the REFUND directly without a provider round-trip.
      await ledger.appendEvent({
        eventId: `direct_ref_${randomUUID()}`, eventType: 'REFUND',
        userId: req.user.id, productId: p.id, quantity: 1,
        amount: p.price, currency: p.currency,
        occurredAt: new Date().toISOString(), referenceeventId: ent.sourceEventId,
      }, { method: 'DIRECT_REFUND' });
      return res.send(courseCard(p,  decisions.evaluateAccess(req.user.id, p.id), 'Refund processed. Access revoked.'));
    }
    // Call the provider adapter to issue the actual refund.
    // For mock: fires refund webhook synchronously → ledger updated before response.
    // For Razorpay: calls Razorpay API; Razorpay fires refund.created webhook asynchronously.
    const svc = new PaymentService({ catalog });
    try {
      await svc.initiateRefund({ userId: req.user.id, productId: p.id, providerPaymentId, provider });
    } catch (e) {
      console.error('[refund] provider error:', e.message);
      return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), `Refund failed: ${e.message}`));
    }
    // Mock: projection already updated via synchronous webhook. Razorpay: webhook is async.
    if (provider === 'razorpay') {
      // Razorpay webhook is async: the projection is not yet updated.
      // Return a pending card that polls /courses/:slug/card every 2s until confirmed.
      return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), '', true));
    }
    // Mock: webhook was awaited synchronously, projection already updated.
    res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), 'Refund processed. Access revoked'));
  } catch (e) { next(e); }
});

// Hosted Razorpay checkout page (the redirectUrl from createPayment lands here).
router.get('/razorpay/checkout', requireAuth, (req, res) => {
  const { orderId, userId, productId, amount, currency } = req.query;
  res.send(`<!doctype html><html><head>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  </head><body><script>
    const options = {
      key: "${process.env.RAZORPAY_KEY_ID}",
      order_id: "${orderId}",
      handler: function(response) {
        // Payment captured. Razorpay fires the webhook to /webhooks/razorpay automatically.
        // Just send the browser home; the webhook will update the card.
        window.location.href = '/courses';
      }
    };
    const rzp = new Razorpay(options);
    rzp.open();
  </script></body></html>`);
});

module.exports = router;

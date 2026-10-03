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
    const { redirectUrl } = await svc.initiatePayment({
      userId: req.user.id,
      productId: p.id,
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
      const purchaseRecord = await ledger.getByEventId(ent.sourceEventId);
      const providerPaymentId = purchaseRecord?.paymentInfo?.providerPaymentId;
      if (!providerPaymentId)
        return res.send(
          courseCard(
            p,
            decisions.evaluateAccess(req.user.id, p.id),
            "No provider payment found.",
          ),
        );
      const svc = new PaymentService({ catalog });
      await svc.initiateRefund({
        userId: req.user.id,
        productId: p.id,
        providerPaymentId,
      });
      // Refund fires a webhook; response will come async. Tell the user to wait a moment.
      res.send(
        courseCard(
          p,
          decisions.evaluateAccess(req.user.id, p.id),
          "Refund initiated. Page will reflect change shortly.",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);
module.exports = router;

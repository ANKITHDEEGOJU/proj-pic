"use strict";
const router = require("express").Router();
const { randomUUID } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../auth");
const { PaymentService } = require("../payment/service");
const { courseCard } = require("../views");
const { validateCoupon } = require("../services/pricingEngine");
const {resolveCatalogProduct} =require("../routes/cart")

router.post("/courses/:slug/checkout", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  let inTransaction = false;

  try {
    const { catalog, decisions } = req.app.locals.engine;
    
    const p = resolveCatalogProduct(catalog, req.params.slug);

    if (!p) {
      // client.release() is handled automatically in the finally block
      return res.status(404).send("Course not found");
    }

    const productId = p.slug || p.id;
    const d = decisions.evaluateAccess(req.user.id, productId);

    if (d.allowed) {
      // client.release() is handled automatically in the finally block
      return res.send(courseCard(p, d, "You already own this course."));
    }

    await client.query("BEGIN");
    inTransaction = true;

    const subtotalCents = Math.round(p.price * 100);
    let discountCents = 0;
    let finalPayableCents = subtotalCents;
    let appliedRuleId = null;

    if (req.session?.couponCode) {
      const couponResult = await validateCoupon(
        req.session.couponCode,
        req.user,
        false,
        [p]
      );

      if (couponResult.valid) {
        discountCents = couponResult.discountCents;
        finalPayableCents = couponResult.finalPayableCents;
        appliedRuleId = couponResult.rule.id;
      } else {
        delete req.session.couponCode;
      }
    }

    const body = req.body || {};
    const provider = body.provider === 'razorpay' ? 'razorpay' : 'mock';

    const orderRes = await client.query(
      `INSERT INTO orders (
        user_id, subtotal_cents, discount_cents, final_payable_cents,
        applied_rule_id, provider, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
      RETURNING id`,
      [req.user.id, subtotalCents, discountCents, finalPayableCents, appliedRuleId, provider]
    );
    const orderId = orderRes.rows[0].id;

    await client.query("COMMIT");
    inTransaction = false;

    const svc = new PaymentService({ catalog });
    const { redirectUrl } = await svc.initiatePayment({
      userId: req.user.id,
      productId,
      amount: finalPayableCents / 100,
      orderId,
      provider
    });

    res.status(200).set("HX-Redirect", redirectUrl || "/courses").end();
  } catch (e) {
    if (inTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error('[checkout] Direct course checkout error:', e);
    next(e);
  } finally {
    client.release();
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

      const productId = p.slug || p.id;
      const ent = projection.get(req.user.id, productId);
      if (!ent || ent.status !== "ACTIVE") {
        return res.send(
          courseCard(
            p,
            decisions.evaluateAccess(req.user.id, productId),
            "Nothing to refund."
          )
        );
      }

      const purchaseRecord = await ledger.getByEventId(ent.sourceEventId);
      const paymentInfo = purchaseRecord?.paymentInfo || {};
      const provider = paymentInfo.provider;
      const providerPaymentId = paymentInfo.providerPaymentId;

      console.log(`[refund] user=${req.user.id} product=${productId} provider=${provider} providerPaymentId=${providerPaymentId}`);

      if (!provider || !providerPaymentId) {
        await ledger.appendEvent({
          eventId: `direct_ref_${randomUUID()}`,
          eventType: 'REFUND',
          userId: req.user.id,
          productId,
          quantity: 1,
          amount: p.price,
          currency: p.currency,
          occurredAt: new Date().toISOString(),
          referenceeventId: ent.sourceEventId,
        }, { method: 'DIRECT_REFUND' });

        await pool.query(
          "UPDATE orders SET status = 'REFUNDED' WHERE user_id = $1 AND status = 'COMPLETED'",
          [req.user.id]
        );
        return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), 'Refund processed. Access revoked.'));
      }

      const svc = new PaymentService({ catalog });
      try {
        await svc.initiateRefund({ userId: req.user.id, productId, providerPaymentId, provider });
        await pool.query(
          "UPDATE orders SET status = 'REFUNDED' WHERE user_id = $1 AND status = 'COMPLETED'",
          [req.user.id]
        );
      } catch (e) {
        console.error('[refund] provider error:', e.message);
        return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), `Refund failed: ${e.message}`));
      }

      if (provider === 'razorpay') {
        return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), '', true));
      }

      res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), 'Refund processed. Access revoked'));
    } catch (e) {
      next(e);
    }
  }
);

router.get('/razorpay/checkout', requireAuth, (req, res) => {
  const { orderId } = req.query;
  res.send(`<!doctype html><html><head>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  </head><body><script>
    const options = {
      key: "${process.env.RAZORPAY_KEY_ID || ''}",
      order_id: "${orderId}",
      handler: function(response) {
        window.location.href = '/courses';
      }
    };
    const rzp = new Razorpay(options);
    rzp.open();
  </script></body></html>`);
});

module.exports = router;

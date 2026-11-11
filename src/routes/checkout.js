"use strict";

const router = require("express").Router();
const { randomUUID } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../auth");
const { PaymentService } = require("../payment/service");
const { courseCard } = require("../views");
const { validateCoupon } = require("../services/pricingEngine");

// Helper to look up catalog item by id or slug safely
function resolveCatalogProduct(catalog, key) {
  if (!catalog || !key) return null;
  if (typeof catalog.get === "function") {
    const item = catalog.get(key);
    if (item) return item;
  }
  if (typeof catalog.list === "function") {
    for (const item of catalog.list()) {
      if (item.id === key || item.slug === key) return item;
    }
  }
  return null;
}

router.post("/courses/:slug/checkout", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  let inTransaction = false;

  try {
    const { catalog, decisions } = req.app.locals.engine;

    const p = resolveCatalogProduct(catalog, req.params.slug);
    if (!p) {
      return res.status(404).send("Course not found");
    }

    const productId = p.slug || p.id;
    const d = decisions.evaluateAccess(req.user.id, productId);

    if (d.allowed) {
      return res.send(courseCard(p, d, "You already own this course."));
    }

    await client.query("BEGIN");
    inTransaction = true;

    const priceCents = p.priceCents ?? Math.round((p.price || 0) * 100);
    const subtotalCents = priceCents;
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

      if (couponResult && couponResult.valid) {
        discountCents = couponResult.discountCents || 0;
        finalPayableCents = couponResult.finalPayableCents ?? subtotalCents;
        appliedRuleId = couponResult.rule ? couponResult.rule.id : null;
      } else {
        delete req.session.couponCode;
      }
    }

    const body = req.body || {};
    const provider = body.provider === 'razorpay' ? 'razorpay' : 'mock';

    // 1. Insert Order Header
    const orderRes = await client.query(
      `INSERT INTO orders (
        user_id, subtotal_cents, discount_cents, final_payable_cents,
        applied_rule_id, provider, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
      RETURNING id`,
      [req.user.id, subtotalCents, discountCents, finalPayableCents, appliedRuleId, provider]
    );
    const orderId = orderRes.rows[0].id;

    // 2. Insert Order Line Item (Required for WebhookProcessor line-item resolution)
    const itemType = p.type || 'COURSE';
    await client.query(
      `INSERT INTO order_line_items (
        order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orderId,
        itemType,
        productId,
        finalPayableCents,
        1,
        p.durationDays || null,
        p.scope || null
      ]
    );

    await client.query("COMMIT");
    inTransaction = false;

    if (req.session) delete req.session.couponCode;

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
      const p = resolveCatalogProduct(catalog, req.params.slug);
      if (!p) return res.status(404).end();

      const productId = p.slug || p.id;
      const isSub = p.type === "SUBSCRIPTION" || productId.startsWith("sub");

      // 1. Look up entitlement using the correct Projection Engine getter
      let ent = isSub
        ? projection.getSubscription(req.user.id, p.scope || "ALL_ACCESS")
        : projection.get(req.user.id, productId);

      if (!ent) {
        ent = projection.get(req.user.id, productId) || projection.getSubscription(req.user.id, "ALL_ACCESS");
      }

      // Guard: Return the matching UI card if no active entitlement exists
      if (!ent || ent.status !== "ACTIVE") {
        if (isSub) {
          const subPriceInfo = await resolveSubscriptionPrice(req.user, productId, catalog);
          return res.send(subscriptionCard(false, subPriceInfo, false, null));
        }
        return res.send(
          courseCard(
            p,
            decisions.evaluateAccess(req.user.id, productId),
            "Nothing to refund."
          )
        );
      }

      // 2. Locate original purchase record in ledger
      const purchaseRecord = await ledger.getByEventId(ent.sourceEventId);
      const paymentInfo = purchaseRecord?.paymentInfo || {};
      const provider = paymentInfo.provider || "mock";
      const providerPaymentId = paymentInfo.providerPaymentId;
      const orderId = paymentInfo.orderId || paymentInfo.orderRef;

      let itemsToRefund = [{ 
        item_id: productId, 
        item_type: isSub ? "SUBSCRIPTION" : "COURSE",
        sourceEventId: ent.sourceEventId 
      }];

      // 3. Fetch all line items if part of a multi-cart order
      if (orderId) {
        const lineRes = await pool.query(
          "SELECT item_id, item_type, unit_price_cents, quantity, scope FROM order_line_items WHERE order_id = $1",
          [orderId]
        );

        if (lineRes.rows.length > 0) {
          const baseEventId = ent.sourceEventId.includes(":") 
            ? ent.sourceEventId.substring(0, ent.sourceEventId.lastIndexOf(":")) 
            : ent.sourceEventId;

          itemsToRefund = lineRes.rows.map((r) => ({
            item_id: r.item_id,
            item_type: r.item_type || (r.item_id.startsWith("sub") ? "SUBSCRIPTION" : "COURSE"),
            sourceEventId: `${baseEventId}:${r.item_id}`,
            unitPriceCents: r.unit_price_cents,
            quantity: r.quantity,
            scope: r.scope
          }));
        }
      }

      // 4. Initiate Gateway Refund
      if (provider && providerPaymentId) {
        const svc = new PaymentService({ catalog });
        try {
          await svc.initiateRefund({ 
            userId: req.user.id, 
            productId, 
            orderId,
            providerPaymentId, 
            provider 
          });
        } catch (e) {
          console.error('[refund] Provider error:', e.message);
          if (isSub) {
            const subPriceInfo = await resolveSubscriptionPrice(req.user, productId, catalog);
            return res.send(subscriptionCard(false, subPriceInfo, true, ent));
          }
          return res.send(
            courseCard(p, decisions.evaluateAccess(req.user.id, productId), `Refund failed: ${e.message}`)
          );
        }
      }

      // 5. Append individual REFUND events for ALL line items
      for (const item of itemsToRefund) {
        const itemProduct = resolveCatalogProduct(catalog, item.item_id);
        const itemPrice = itemProduct ? itemProduct.price : ((item.unitPriceCents || 0) / 100);
        const itemType = item.item_type || itemProduct?.type || (item.item_id.startsWith("sub") ? "SUBSCRIPTION" : "COURSE");
        const scope = item.scope || itemProduct?.scope || (itemType === "SUBSCRIPTION" ? "ALL_ACCESS" : null);

        try {
          await ledger.appendEvent(
            {
              eventId: `ref_${randomUUID()}:${item.item_id}`,
              eventType: 'REFUND',
              userId: req.user.id,
              productId: item.item_id,
              quantity: item.quantity || 1,
              amount: itemPrice,
              currency: itemProduct?.currency || 'USD',
              occurredAt: new Date().toISOString(),
              referenceeventId: item.sourceEventId,
            }, 
            { 
              ...paymentInfo, 
              itemType, 
              scope, 
              method: provider ? 'GATEWAY_REFUND' : 'DIRECT_REFUND' 
            },
            {
              type: itemType,
              scope,
              id: item.item_id
            }
          );
        } catch (ledgerErr) {
          console.warn(`[refund] Ledger note for ${item.item_id}:`, ledgerErr.message);
        }
      }

      // 6. Update Postgres order header
      if (orderId) {
        await pool.query(
          "UPDATE orders SET status = 'REFUNDED', updated_at = now() WHERE id = $1",
          [orderId]
        );
      }

      // 7. For Subscription or Multi-item refunds: trigger full page reload so all course cards lock back
      if (isSub || itemsToRefund.length > 1) {
        return res.set("HX-Refresh", "true").send();
      }

      if (provider === 'razorpay') {
        return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), '', true));
      }

      res.send(
        courseCard(
          p, 
          decisions.evaluateAccess(req.user.id, productId), 
          'Refund processed. Access revoked.'
        )
      );
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

// Attach helper to router before export so other modules can import it cleanly
router.resolveCatalogProduct = resolveCatalogProduct;

module.exports = router;
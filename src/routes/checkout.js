"use strict";

const router = require("express").Router();
const { randomUUID } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../auth");
const { PaymentService } = require("../payment/service");
const { courseCard, subscriptionCard } = require("../views");
const { validateCoupon, resolveSubscriptionPrice } = require("../services/pricingEngine");

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
        order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orderId,
        itemType,
        productId,
        finalPayableCents,
        1,
        p.durationDays || null,
        p.scope || null,
        finalPayableCents // single item: it carries the whole (discounted) payment
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

      // Which purchase a refund undoes: for a subscription, the most recent PAID period
      // (a free admin month stacked on top must not block refunding the paid one).
      const refundEventId = ent.type === "SUBSCRIPTION" ? ent.refundableEventId : ent.sourceEventId;
      const isFreeOnly = ent.type === "SUBSCRIPTION"
        ? !refundEventId
        : ent.grantedVia === "MANUAL_GRANT" || ent.grantedVia === "SEAT_ASSIGNED";

      // M1: free access (admin/scholarship grant, org seat) was never paid for, so there is nothing to refund.
      if (isFreeOnly) {
        if (isSub) {
          const subPriceInfo = await resolveSubscriptionPrice(req.user, productId, catalog);
          return res.send(subscriptionCard(false, subPriceInfo, true, ent));
        }
        return res.send(
          courseCard(p, decisions.evaluateAccess(req.user.id, productId), "This access was granted for free and can't be refunded.")
        );
      }

      // 2. Locate original purchase record in ledger
      const purchaseRecord = await ledger.getByEventId(refundEventId);
      const paymentInfo = purchaseRecord?.paymentInfo || {};
      const provider = paymentInfo.provider || "mock";
      const providerPaymentId = paymentInfo.providerPaymentId;
      const orderId = paymentInfo.orderId || paymentInfo.orderRef;

      let itemsToRefund = [{ 
        item_id: productId, 
        item_type: isSub ? "SUBSCRIPTION" : "COURSE",
        sourceEventId: refundEventId 
      }];

      // 3. Whole-order refund: every paid event recorded for this same provider payment
      //    (one per cart item), read from the ledger itself rather than rebuilt from id strings.
      if (providerPaymentId) {
        const { rows } = await pool.query(
          `SELECT event_id, product_id, quantity FROM commerce_ledger
            WHERE user_id = $1 AND payment_info->>'providerPaymentId' = $2
              AND event_type IN ('PURCHASE_SUCCEEDED','SUBSCRIPTION_STARTED','SUBSCRIPTION_RENEWED')
            ORDER BY ledger_sequence_id`,
          [req.user.id, providerPaymentId]
        );
        if (rows.length > 0) {
          itemsToRefund = rows.map((r) => ({ item_id: r.product_id, sourceEventId: r.event_id, quantity: r.quantity }));
        }
      }

      // A refund is always for the whole order: every item bought in that payment is
      // revoked, so the customer gets back everything they actually paid (after coupons),
      // not just the catalog price of the item they clicked.
      for (const item of itemsToRefund) {
        const orig = await ledger.getByEventId(item.sourceEventId);
        item.paidAmount = orig ? orig.event.amount : null;
      }
      let refundAmount = null;
      if (orderId) {
        const o = await pool.query("SELECT final_payable_cents FROM orders WHERE id = $1", [orderId]);
        if (o.rows[0]) refundAmount = o.rows[0].final_payable_cents / 100;
      }
      if (refundAmount === null) {
        refundAmount = itemsToRefund.reduce((sum, i) => sum + (i.paidAmount ?? 0), 0);
      }

      const renderAfter = async (msg, pending = false) => {
        if (isSub || itemsToRefund.length > 1) {
          // Whole page reload so every card / the banner shows the new state.
          return res.set("HX-Refresh", "true").send();
        }
        return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), msg, pending));
      };

      // Records one REFUND per item of the order and closes the order.
      // `idFor` gives each item's ledger event id; for provider refunds it is the same id the
      // provider's refund webhook produces, so a later webhook is just a duplicate.
      const recordRefund = async (idFor, extraInfo) => {
        const problems = [];
        for (const item of itemsToRefund) {
          const itemProduct = resolveCatalogProduct(catalog, item.item_id);
          const itemPrice = item.paidAmount ?? (itemProduct ? itemProduct.price : ((item.unitPriceCents || 0) / 100));
          try {
            await ledger.appendEvent(
              {
                eventId: idFor(item),
                eventType: 'REFUND',
                userId: req.user.id,
                productId: item.item_id,
                quantity: item.quantity || 1,
                amount: itemPrice,
                currency: itemProduct?.currency || 'USD',
                occurredAt: new Date().toISOString(),
                referenceeventId: item.sourceEventId,
                source: 'PAYMENT',
                actor: `user:${req.user.id}`,
              },
              { ...paymentInfo, ...extraInfo }
            );
          } catch (ledgerErr) {
            // E1_ALREADY_REVERSED here just means the provider's webhook got there first.
            if (ledgerErr.code !== 'E1_ALREADY_REVERSED') {
              console.error(`[refund] could not record refund for ${item.item_id}:`, ledgerErr.message);
              problems.push(`${item.item_id}: ${ledgerErr.message}`);
            }
          }
        }
        if (orderId) {
          // Money already went back; if access could not be updated, flag it for an admin.
          await pool.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1",
            [orderId, problems.length ? 'REFUND_FAILED' : 'REFUNDED']);
        }
        return problems;
      };
      const finish = (problems) => problems.length
        ? renderAfter('Refund sent, but access could not be updated. An admin has been notified.')
        : renderAfter('Refund processed. Access revoked.');

      // 4. Provider refund. This route only ASKS the provider for the refund. The order stays
      //    REFUND_PENDING (access kept, card shows "Refund pending") until the provider's refund
      //    webhook arrives (Razorpay refund.created/processed, mock refund.succeeded); the
      //    webhook processor then writes the REFUND events and marks the order REFUNDED.
      //    A refund.failed webhook reopens the order (REFUND_PENDING -> COMPLETED).
      if (provider && providerPaymentId) {
        if (orderId) {
          // Claim the order first: stops double-clicks from issuing two refunds.
          const claim = await pool.query(
            // (older orders may still say PENDING even though they were paid)
            "UPDATE orders SET status='REFUND_PENDING', updated_at=now() WHERE id=$1 AND status IN ('COMPLETED','PENDING') RETURNING id",
            [orderId]
          );
          if (claim.rowCount === 0) {
            const cur = await pool.query("SELECT status FROM orders WHERE id=$1", [orderId]);
            const st = cur.rows[0]?.status;
            if (st === 'REFUND_PENDING') return renderAfter('Refund already in progress.', true);
            if (st) return renderAfter(`Order is ${st.toLowerCase().replace('_', ' ')}, nothing to refund.`);
          }
        }

        const svc = new PaymentService({ catalog });
        let providerRefundId;
        try {
          ({ providerRefundId } = await svc.initiateRefund({ 
            userId: req.user.id, 
            productId, 
            orderId,
            amount: refundAmount,
            providerPaymentId, 
            provider 
          }));
        } catch (e) {
          // Provider said no: nothing changed, reopen the order.
          if (orderId) {
            await pool.query(
              "UPDATE orders SET status='COMPLETED', updated_at=now() WHERE id=$1 AND status='REFUND_PENDING'",
              [orderId]
            );
          }
          // Razorpay SDK errors carry the text in e.error.description, not e.message.
          e.message = e.message || e.error?.description || (e.statusCode ? `provider returned HTTP ${e.statusCode}` : 'payment provider refused the refund');
          console.error('[refund] Provider error:', e.message);
          if (isSub) {
            const subPriceInfo = await resolveSubscriptionPrice(req.user, productId, catalog);
            return res.send(subscriptionCard(false, subPriceInfo, true, ent, { message: `Refund failed: ${e.message}` }));
          }
          return res.send(
            courseCard(p, decisions.evaluateAccess(req.user.id, productId), `Refund failed: ${e.message}`)
          );
        }

        // Provider accepted the request. Nothing is written to the ledger here: the order stays
        // REFUND_PENDING until the provider's refund webhook confirms it. (The mock provider
        // sends that webhook before this call returns, so the order may already be REFUNDED.)
        console.log(`[refund] ${provider} refund ${providerRefundId} requested for order ${orderId || '-'}; waiting for webhook`);
        return renderAfter('Refund requested. Access will be removed once the payment provider confirms it.', true);
      }

      // 5. No payment provider behind this purchase (e.g. dev-simulated events):
      //    nobody else will confirm it, so record the REFUND directly.
      return finish(await recordRefund((item) => `ref_${randomUUID()}:${item.item_id}`, { method: 'DIRECT_REFUND' }));
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
      key: ${JSON.stringify(process.env.RAZORPAY_KEY_ID || '').replace(/</g, '\\u003c')},
      order_id: ${JSON.stringify(String(orderId || '')).replace(/</g, '\\u003c')},
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
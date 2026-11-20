"use strict";

const router = require("express").Router();
const { randomUUID } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../auth");
const { PaymentService } = require("../payment/service");
const { createOrder } = require("../services/orders");
const { requestRefund } = require("../services/refunds");
const { courseCard, subscriptionCard } = require("../views");
const { validateCoupon, resolveSubscriptionPrice } = require("../services/pricingEngine");
const { isRenewal, renewBlocked, refundPass, passState, cardOpts } = require("../services/subscriptions");

router.post("/courses/:slug/checkout", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  let inTransaction = false;

  try {
    const { catalog, decisions } = req.app.locals.engine;

    const p = catalog.get(req.params.slug);
    if (!p) {
      return res.status(404).send("Course not found");
    }

    const productId = p.slug || p.id;
    const d = decisions.evaluateAccess(req.user.id, productId);

    if (d.allowed) {
      return res.send(courseCard(p, d, "You already own this course."));
    }
    // One renewal at a time (also checked on Renew and at cart checkout).
    if (p.type === "SUBSCRIPTION") {
      const blocked = await renewBlocked({ ledger: req.app.locals.engine.ledger, projection: req.app.locals.engine.projection, userId: req.user.id, scope: p.scope || "ALL_ACCESS" });
      if (blocked) return res.send(`<span style="color:#d32f2f;">${blocked}</span>`);
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

    const itemType = p.type || 'COURSE';
    const orderId = await createOrder(client, {
      userId: req.user.id, provider, subtotalCents, discountCents, finalCents: finalPayableCents, appliedRuleId,
      lines: [{
        itemType, itemId: productId, unitPriceCents: priceCents, durationDays: p.durationDays || null, scope: p.scope || null,
        paidCents: finalPayableCents, // single item: it carries the whole (discounted) payment
        renewal: itemType === 'SUBSCRIPTION' && isRenewal(req.app.locals.engine.projection, req.user.id, p.scope),
      }],
    });

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
      const p = catalog.get(req.params.slug);
      if (!p) return res.status(404).end();

      const productId = p.slug || p.id;
      const isSub = p.type === "SUBSCRIPTION" || productId.startsWith("sub");

      // 1. What is being refunded: the pass (subscription entitlement) or the course.
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

      // Is anything paid? A pass with only free periods, or a free course grant, has nothing to
      // refund. (A pass with paid periods is refunded as a whole just below, refundPass; for a
      // course, refundEventId is the purchase being undone.)
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

      // A pass is refunded as a whole: every paid period of the current pass (the one running now
      // and any renewal paid in advance), one provider refund per payment. When all are confirmed,
      // its free (admin / scholarship) periods end too. See services/subscriptions.refundPass.
      if (ent.type === "SUBSCRIPTION") {
        const out = await refundPass({ ledger, projection, catalog, user: req.user, scope: ent.scope || "ALL_ACCESS" });
        if (out.ok && !out.failed.length) return res.set("HX-Refresh", "true").send();
        const st = await passState({ ledger, projection, userId: req.user.id, scope: ent.scope || "ALL_ACCESS" });
        const subPriceInfo = await resolveSubscriptionPrice(req.user, productId, catalog);
        const message = !out.results
          ? out.message
          : out.ok
            ? `Refund requested for ${out.results.length - out.failed.length} of ${out.results.length} payments. Failed: ${out.failed.map((f) => f.error).join('; ')}`
            : `Refund failed: ${out.failed.map((f) => f.error).join('; ')}`;
        return res.send(subscriptionCard(false, subPriceInfo, Boolean(st.ent), st.ent || ent, { ...cardOpts(st), message }));
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
          const itemProduct = catalog.get(item.item_id);
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
        const out = await requestRefund({ catalog, userId: req.user.id, orderId, productId, provider, providerPaymentId, amount: refundAmount });
        if (out.status === 'ALREADY_PENDING') return renderAfter('Refund already in progress.', true);
        if (out.status === 'NOT_REFUNDABLE') return renderAfter(`Order is ${out.orderStatus.toLowerCase().replace('_', ' ')}, nothing to refund.`);
        if (out.status === 'REFUSED') return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, productId), `Refund failed: ${out.error}`));
        // Provider accepted the request. Nothing is written to the ledger here: the order stays
        // REFUND_PENDING until the provider's refund webhook confirms it. (The mock provider
        // sends that webhook before this call returns, so the order may already be REFUNDED.)
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
  const { orderId, ref } = req.query;
  // back=agent: an assistant purchase. Paid -> back to the chat. Closed without paying ->
  // /assistant/checkout-closed cancels that payment (never puts the course in the cart).
  const fromAgent = req.query.back === 'agent';
  const fromOrg = req.query.back === 'org'; // seat-pack checkout: back to /org
  res.send(`<!doctype html><html><head>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  </head><body><script>
    const options = {
      key: ${JSON.stringify(process.env.RAZORPAY_KEY_ID || '').replace(/</g, '\\u003c')},
      order_id: ${JSON.stringify(String(orderId || '')).replace(/</g, '\\u003c')},
      handler: function(response) {
        window.location.href = ${fromAgent ? "'/agent'" : fromOrg ? "'/org?checkout=paid'" : "'/courses'"};
      },
      // Closed without paying: a cart order puts its items back in the cart.
      modal: { ondismiss: function() {
        window.location.href = (${fromAgent ? "'/assistant/checkout-closed?ref='" : "'/checkout/cancelled?ref='"}) + encodeURIComponent(${JSON.stringify(String(ref || '')).replace(/</g, '\\u003c')})${fromOrg ? " + '&back=org'" : ''};
      } }
    };
    const rzp = new Razorpay(options);
    rzp.open();
  </script></body></html>`);
});


module.exports = router;
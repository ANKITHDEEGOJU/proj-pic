'use strict';

const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { subDurationLabel } = require('../domain/util');
const { isRenewal, renewBlocked } = require("../services/subscriptions");
const checkoutOnce = require("../services/checkoutOnce");
const { randomUUID } = require("node:crypto");
const { subscriptionCard, courseCard, layout, esc, navCart } = require('../views');
const cartError = (msg) => `<span style="color:#d32f2f;">${esc(msg)}</span>`;
const { resolveSubscriptionPrice, validateCoupon, allocatePaidCents } = require('../services/pricingEngine');
const { PaymentService } = require('../payment/service');
const { createOrder } = require('../services/orders');

async function getCartData(userId, user, catalog) {
  const cartRes = await pool.query(
    'SELECT product_id FROM cart_items WHERE user_id = $1',
    [userId]
  );
  const cartProducts = cartRes.rows.map((r) => r.product_id);

  const rawItems = cartProducts
    .map((key) => catalog.get(key))
    .filter(Boolean);

  const isSub = rawItems.some((item) => item.type === 'SUBSCRIPTION');

  let subtotalCents = 0;
  const cartItems = [];

  for (const item of rawItems) {
    let priceCents = 0;
    let durationDays = item.durationDays || null;
    let scope = item.scope || (item.type === 'SUBSCRIPTION' ? 'ALL_ACCESS' : null);

    if (item.type === 'SUBSCRIPTION') {
      const subPriceInfo = await resolveSubscriptionPrice(user, item.id || item.slug, catalog);
      priceCents = Number(
        subPriceInfo?.priceCents ??
          (subPriceInfo?.price ? Math.round(subPriceInfo.price * 100) : 0)
      );
      if (subPriceInfo?.durationDays) {
        durationDays = subPriceInfo.durationDays;
      }
    } else {
      priceCents = Number(
        item.priceCents ?? Math.round(Number(item.price || 0) * 100)
      );
    }

    if (Number.isNaN(priceCents)) priceCents = 0;

    subtotalCents += priceCents;

    // Enrich the item object so validateCoupon and view renderers receive valid numeric fields
    cartItems.push({
      ...item,
      product_id: item.slug || item.id,
      item_type: item.type || 'COURSE',
      priceCents,
      unit_price_cents: priceCents,
      duration_days: durationDays,
      durationDays,
      scope,
      quantity: 1,
    });
  }

  return { cartProducts, isSub, cartItems, subtotalCents };
}

function renderCartSummary(subtotalCents, couponResult, couponCode) {
  const safeSubtotalCents = Number(subtotalCents) || 0;
  const formattedSubtotal = (safeSubtotalCents / 100).toFixed(2);

  let discountCents = 0;
  let finalCents = safeSubtotalCents;
  let couponMsg = '';

  if (couponResult) {
    if (couponResult.valid) {
      discountCents = Number(couponResult.discountCents) || 0;
      finalCents = Number(couponResult.finalPayableCents ?? (safeSubtotalCents - discountCents));
      if (Number.isNaN(finalCents)) finalCents = safeSubtotalCents;
      couponMsg = `<div class="msg ok" style="margin-top:0.5rem; color: #2e7d32;">✓ Promo code '${esc(
        couponCode.toUpperCase()
      )}' applied successfully!</div>`;
    } else {
      couponMsg = `<div class="msg err" style="margin-top:0.5rem; color: #d32f2f;">❌ ${esc(
        couponResult.error || 'Invalid coupon'
      )}</div>`;
    }
  }

  const formattedDiscount = (discountCents / 100).toFixed(2);
  const formattedFinal = (finalCents / 100).toFixed(2);

  return `
    <div id="cart-summary" class="card" style="margin-top: 1.5rem;">
      <div style="margin-bottom: 1.5rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 1rem;">
        <label style="font-weight: bold; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Have a Promo Code?</label>
        <form hx-post="/cart/coupon" hx-target="#cart-summary" hx-swap="outerHTML" style="display: flex; gap: 0.5rem; align-items: center;">
          <input type="text" name="couponCode" placeholder="Enter coupon code" value="${esc(
            couponCode || ''
          )}" style="padding: 0.5rem; flex: 1; border: 1px solid #ccc; border-radius: 4px;" required>
          <button type="submit" class="alt" style="padding: 0.5rem 1rem;">Apply</button>
          ${
            couponCode && couponResult?.valid
              ? `
            <button hx-delete="/cart/coupon" hx-target="#cart-summary" hx-swap="outerHTML" style="padding: 0.5rem 1rem; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Remove</button>
          `
              : ''
          }
        </form>
        ${couponMsg}
      </div>

      <form hx-post="/cart/checkout" hx-target="#checkout-err" hx-swap="innerHTML" hx-disabled-elt="find button[type=submit]" style="text-align: right;">
        <input type="hidden" name="couponCode" value="${esc(couponCode || '')}">
        <input type="hidden" name="checkoutKey" value="${randomUUID()}">

        <p style="font-size: 1rem; margin-bottom: 0.25rem; color: #5B5F6E;">
          Subtotal: <strong>$${formattedSubtotal} USD</strong>
        </p>
        ${
          discountCents > 0
            ? `
          <p style="font-size: 1rem; margin-bottom: 0.25rem; color: #2e7d32;">
            Discount: <strong>-$${formattedDiscount} USD</strong>
          </p>
        `
            : ''
        }
        <p style="font-size: 1.25rem; color: #2743D8; margin-bottom: 1rem;">
          Final Payable Amount: <strong>$${formattedFinal} USD</strong>
        </p>

        <div style="margin-bottom: 1.25rem; text-align: right;">
          <label style="font-size: 0.9rem; font-weight: bold; margin-right: 0.5rem;">Payment Provider:</label>
          <select name="provider" style="padding: 0.5rem; border-radius: 4px; border: 1px solid #ccc;">
            <option value="mock">Mock Payment (Instant)</option>
            <option value="razorpay">Razorpay Gateway</option>
          </select>
        </div>

        <div id="checkout-err" style="margin-bottom: 0.5rem;"></div>

        <button type="submit" style="font-size: 1rem; padding: 0.8rem 2rem;">Proceed to Checkout →</button>
      </form>
    </div>
  `;
}

// POST /cart/remove
router.post('/cart/remove', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const body = req.body || {};
  const rawId = body.productId || body.product_id || body.slug;

  if (!rawId) {
    return res.status(400).send('Product ID is required');
  }

  const { catalog } = req.app.locals.engine;
  const catalogProduct = catalog.get(rawId);
  const storedProductId = catalogProduct ? catalogProduct.slug || catalogProduct.id : rawId;

  try {
    await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [
      userId,
      storedProductId,
    ]);

    // Fire cartUpdated only after the response has been swapped in: fired earlier (plain
    // HX-Trigger), every course card starts reloading itself, including the one this response
    // replaces, and that stale reload then fails with an htmx swapError ("o is null").
    res.setHeader('HX-Trigger-After-Settle', 'cartUpdated');
    return res.status(200).set('HX-Redirect', '/cart').end();
  } catch (err) {
    console.error('[cart/remove] Error removing item from cart:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// GET /cart
router.get('/cart', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { catalog } = req.app.locals.engine;

  try {
    const { cartProducts, isSub, cartItems, subtotalCents } = await getCartData(
      userId,
      req.user,
      catalog
    );
    const cartCount = cartProducts.length;

    if (cartCount === 0) {
      const body = `
        <h2>Your Cart</h2>
        <div class="card">
          <p style="margin-bottom: 1rem; color: #5B5F6E;">Your cart is currently empty.</p>
          <a href="/courses"><button>Browse Courses</button></a>
        </div>
      `;
      return res.send(layout('Your Cart', body, req.user, 0));
    }

    const itemsHtml = cartItems
      .map((item) => {
        const itemKey = item.slug || item.id;
        const isItemSub = item.type === 'SUBSCRIPTION';

        const displayType = isItemSub
          ? `Subscription Pass (${subDurationLabel(item.durationDays || 30)})`
          : 'One-Time Purchase';

        const formattedPrice = ((item.priceCents || 0) / 100).toFixed(2);

        return `
        <tr>
          <td>${esc(item.name || item.title)}</td>
          <td>${esc(displayType)}</td>
          <td>$${formattedPrice} ${esc(item.currency || 'USD')}</td>
          <td style="text-align: right;">
            <form hx-post="/cart/remove" style="display: inline;">
              <input type="hidden" name="productId" value="${esc(itemKey)}">
              <button type="submit" style="background: transparent; color: #2743D8; border: 1px solid #2743D8; padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px;">Remove</button>
            </form>
          </td>
        </tr>
      `;
      })
      .join('');

    let couponResult = null;
    const activeCoupon = req.session?.couponCode;
    if (activeCoupon) {
      couponResult = await validateCoupon(activeCoupon, req.user, isSub, cartItems);
      if (couponResult && !couponResult.valid && req.session) {
        delete req.session.couponCode;
      }
    }

    const summaryHtml = renderCartSummary(subtotalCents, couponResult, req.session?.couponCode);

    const body = `
      <h2>Your Cart</h2>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Type / Duration</th>
            <th>Price</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      ${summaryHtml}
    `;

    res.send(layout('Your Cart', body, req.user, cartCount));
  } catch (err) {
    console.error('Error rendering cart:', err);
    res.status(500).send('Internal Server Error');
  }
});

// POST /cart/coupon
router.post('/cart/coupon', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const body = req.body || {};
  const couponCode = (body.couponCode || '').trim();
  const { catalog } = req.app.locals.engine;

  try {
    const { isSub, cartItems, subtotalCents } = await getCartData(userId, req.user, catalog);
    const couponResult = await validateCoupon(couponCode, req.user, isSub, cartItems);

    if (couponResult && couponResult.valid && req.session) {
      req.session.couponCode = couponCode;
      await new Promise((resolve) => req.session.save(resolve));
    }

    res.send(renderCartSummary(subtotalCents, couponResult, couponCode));
  } catch (err) {
    console.error('Error applying coupon:', err);
    res.status(500).send('Internal Server Error');
  }
});

// DELETE /cart/coupon
router.delete('/cart/coupon', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { catalog } = req.app.locals.engine;

  try {
    if (req.session) delete req.session.couponCode;
    const { subtotalCents } = await getCartData(userId, req.user, catalog);

    res.send(renderCartSummary(subtotalCents, null, ''));
  } catch (err) {
    console.error('Error removing coupon:', err);
    res.status(500).send('Internal Server Error');
  }
});

// POST /cart/checkout
router.post('/cart/checkout', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).send('<span style="color:#d32f2f;">Unauthorized. Please log in.</span>');
  }

  const { catalog } = req.app.locals.engine;
  const body = req.body || {};
  const provider = body.provider === 'razorpay' ? 'razorpay' : 'mock';

  // A repeated submit of the same cart page (double click, retry) goes to the same checkout.
  const checkoutKey = checkoutOnce.validKey(body.checkoutKey);
  const earlier = await checkoutOnce.find(userId, checkoutKey);
  if (earlier) {
    return checkoutOnce.sendRepeat(res, earlier, cartError);
  }

  const client = await pool.connect();
  let inTransaction = false;

  try {
    const { isSub, cartItems, subtotalCents } = await getCartData(userId, req.user, catalog);

    if (cartItems.length === 0) {
      // The same click may have just emptied the cart (it is cleared with its order).
      const first = await checkoutOnce.find(userId, checkoutKey);
      if (first) {
        return checkoutOnce.sendRepeat(res, first, cartError);
      }
      return res.status(400).send('<span style="color:#d32f2f;">Your cart is empty.</span>');
    }

    // Re-check ownership at payment time: the course may have been bought in another tab
    // (or added before this check existed). Owned courses are dropped from the cart.
    const { decisions } = req.app.locals.engine;
    const owned = cartItems.filter((i) => i.item_type !== 'SUBSCRIPTION' && decisions?.evaluateAccess(userId, i.product_id)?.allowed);
    if (owned.length > 0) {
      await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = ANY($2::text[])', [userId, owned.map((i) => i.product_id)]);
      const names = owned.map((i) => esc(i.name || i.title || i.product_id)).join(', ');
      // 200 so htmx shows it in #checkout-err (htmx does not swap 4xx responses by default).
      return res.set('HX-Trigger', 'cartUpdated')
        .send(`<span style="color:#d32f2f;">You already own ${names}. It was removed from your cart and nothing was charged. <a href="/cart">Reload the cart</a></span>`);
    }

    // One renewal at a time: no second renewal while one is paid in advance or being paid.
    const subLine = cartItems.find((i) => i.item_type === 'SUBSCRIPTION');
    if (subLine) {
      const blocked = await renewBlocked({ ledger: req.app.locals.engine.ledger, projection: req.app.locals.engine.projection, userId, scope: subLine.scope || 'ALL_ACCESS' });
      if (blocked) return res.send(`<span style="color:#d32f2f;">${esc(blocked)} Nothing was charged.</span>`);
    }

    let discountCents = 0;
    let finalPayableCents = subtotalCents;
    let appliedRuleId = null;

    const activeCoupon = (body.couponCode || req.session?.couponCode || '').trim();
    if (activeCoupon && typeof validateCoupon === 'function') {
      const couponResult = await validateCoupon(activeCoupon, req.user, isSub, cartItems);
      if (couponResult && couponResult.valid) {
        discountCents = Number(couponResult.discountCents) || 0;
        finalPayableCents = Number(couponResult.finalPayableCents ?? (subtotalCents - discountCents));
        appliedRuleId = couponResult.rule ? couponResult.rule.id : null;
      } else if (req.session) {
        delete req.session.couponCode;
      }
    }

    await client.query('BEGIN');
    inTransaction = true;

    // Same key submitted at the same moment: the second one waits here, then finds the first order.
    const sameClick = await checkoutOnce.claim(client, userId, checkoutKey);
    if (sameClick) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return checkoutOnce.sendRepeat(res, sameClick, cartError);
    }

    const paidCents = allocatePaidCents(
      cartItems.map((i) => i.priceCents * (i.quantity || 1)),
      finalPayableCents
    );
    const orderId = await createOrder(client, {
      userId, provider, subtotalCents, discountCents, finalCents: finalPayableCents, appliedRuleId, checkoutKey,
      lines: cartItems.map((item, idx) => ({
        itemType: item.item_type, itemId: item.product_id, unitPriceCents: item.priceCents, quantity: item.quantity,
        durationDays: item.duration_days, scope: item.scope, paidCents: paidCents[idx],
        // M4: buying a pass while one is active extends it (SUBSCRIPTION_RENEWED).
        renewal: item.item_type === 'SUBSCRIPTION' && isRenewal(req.app.locals.engine.projection, userId, item.scope),
      })),
    });

    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');
    inTransaction = false;

    if (req.session) delete req.session.couponCode;

    const primaryProductId = cartItems.map((i) => i.product_id).join(',');
    const finalAmountMainCurrency = Number((finalPayableCents / 100).toFixed(2));

    const svc = new PaymentService({ catalog });
    const { redirectUrl } = await svc.initiatePayment({
      userId,
      productId: primaryProductId,
      amount: finalAmountMainCurrency,
      orderId,
      provider,
    });
    await checkoutOnce.rememberUrl(orderId, redirectUrl);

    res.status(200).set('HX-Redirect', redirectUrl || '/courses').end();
  } catch (err) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Checkout error:', err);
    res.status(500).send('<span style="color:#d32f2f;">Checkout failed. Nothing was charged. Please try again.</span>');
  } finally {
    client.release();
  }
});

// GET /cart/count
// GET /checkout/cancelled?ref=<orderId> - the customer left the provider's checkout without
// paying (mock "Cancel", Razorpay modal closed). The order is marked CANCELLED and its items go
// back into the cart so they can try again. A payment that still arrives later wins: the
// webhook sets the order COMPLETED regardless.
router.get('/checkout/cancelled', requireAuth, async (req, res) => {
  const ref = String(req.query.ref || '');
  if (/^[0-9a-f-]{36}$/i.test(ref)) {
    const { rows } = await pool.query(
      `UPDATE orders SET status='CANCELLED', updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status IN ('PENDING','FAILED') RETURNING id`,
      [ref, req.user.id]
    );
    if (rows[0]) {
      const { rowCount } = await pool.query(
        `INSERT INTO cart_items (user_id, product_id)
         SELECT $2, item_id FROM order_line_items WHERE order_id=$1 AND item_type IN ('COURSE','SUBSCRIPTION')
         ON CONFLICT DO NOTHING`,
        [ref, req.user.id]
      );
      if (rowCount) return res.redirect('/cart');
    }
  }
  // back=org: a seat-pack checkout, return to the organization page.
  if (req.query.back === 'org') return res.redirect('/org?checkout=cancelled');
  res.redirect('/courses');
});

router.get('/cart/count', requireAuth, async (req, res) => {
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM cart_items WHERE user_id = $1', [
      req.user.id,
    ]);
    const count = parseInt(countRes.rows[0].count, 10);
    res.send(navCart(count));
  } catch (err) {
    console.error('Error fetching cart count:', err);
    res.status(500).end();
  }
});

// POST /cart/add
router.post('/cart/add', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const body = req.body || {};
  const rawId = body.productId || body.product_id || body.slug;

  if (!rawId) {
    return res.status(400).send('Product ID is required');
  }

  const { catalog, decisions } = req.app.locals.engine;
  const catalogProduct = catalog.get(rawId);

  if (!catalogProduct) {
    return res.status(404).send('Product not found');
  }

  const storedProductId = catalogProduct.slug || catalogProduct.id;
  const isSubscription = catalogProduct.type === 'SUBSCRIPTION';

  // A course the user can already open must not be bought again (the page hides the button,
  // but a stale tab or a direct request can still post here). Passes are renewals, not repeats.
  if (!isSubscription && decisions?.evaluateAccess(userId, storedProductId)?.allowed) {
    return res.send(courseCard(catalogProduct, decisions.evaluateAccess(userId, storedProductId), 'You already own this course.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (isSubscription) {
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      await client.query(
        'INSERT INTO cart_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, storedProductId]
      );
    } else {
      const existingCart = await client.query(
        'SELECT product_id FROM cart_items WHERE user_id = $1',
        [userId]
      );

      const subIdsInCart = existingCart.rows
        .map((r) => r.product_id)
        .filter((id) => {
          const item = catalog.get(id);
          return item?.type === 'SUBSCRIPTION';
        });

      if (subIdsInCart.length > 0) {
        await client.query(
          'DELETE FROM cart_items WHERE user_id = $1 AND product_id = ANY($2::text[])',
          [userId, subIdsInCart]
        );
      }

      await client.query(
        'INSERT INTO cart_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, storedProductId]
      );
    }

    await client.query('COMMIT');

    // Fire cartUpdated only after the response has been swapped in: fired earlier (plain
    // HX-Trigger), every course card starts reloading itself, including the one this response
    // replaces, and that stale reload then fails with an htmx swapError ("o is null").
    res.setHeader('HX-Trigger-After-Settle', 'cartUpdated');

    if (isSubscription) {
      const subPriceInfo = await resolveSubscriptionPrice(req.user, storedProductId, catalog);
      return res.send(subscriptionCard(true, subPriceInfo));
    } else {
      const slug = catalogProduct.slug || catalogProduct.id;
      let decision = { allowed: false, reason: 'NONE', sourceEventIds: [] };

      try {
        if (decisions && typeof decisions.evaluateAccess === 'function') {
          const evalRes = decisions.evaluateAccess(userId, slug);
          if (evalRes) decision = evalRes;
        }
      } catch (evalErr) {
        console.warn(`[cart/add] Access evaluation fallback for user ${userId}:`, evalErr.message);
      }
      return res.send(courseCard(catalogProduct, decision, '', false, true));
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error adding item to cart:', err);
    res.status(500).send('Internal Server Error');
  } finally {
    client.release();
  }
});

module.exports = router;
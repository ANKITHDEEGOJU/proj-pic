const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { subscriptionCard, courseCard, layout, esc, navCart } = require('../views');
const { resolveSubscriptionPrice, validateCoupon } = require('../services/pricingEngine');
const { PaymentService } = require('../payment/service');

// Helper to look up catalog item by slug or UUID safely
function resolveCatalogProduct(catalog, key) {
  if (!catalog || !key) return null;
  if (catalog.has(key)) return catalog.get(key);
  for (const item of catalog.values()) {
    if (item.id === key || item.slug === key) return item;
  }
  return null;
}

async function getCartData(userId, user, catalog) {
  const cartRes = await pool.query(
    'SELECT product_id FROM cart_items WHERE user_id = $1',
    [userId]
  );
  const cartProducts = cartRes.rows.map(r => r.product_id);
  const isSub = cartProducts.includes('sub_monthly');

  let cartItems = [];
  let subtotalCents = 0;
  let subDurationDays = 30;

  if (isSub) {
    const subPrice = await resolveSubscriptionPrice(user);
    subtotalCents = subPrice.priceCents;
    subDurationDays = subPrice.durationDays;
  } else {
    // Resolve each DB key against catalog by slug or UUID
    cartItems = cartProducts
      .map(key => resolveCatalogProduct(catalog, key))
      .filter(Boolean);

    subtotalCents = cartItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
  }

  return { cartProducts, isSub, cartItems, subtotalCents, subDurationDays };
}

function renderCartSummary(subtotalCents, couponResult, couponCode) {
  const formattedSubtotal = (subtotalCents / 100).toFixed(2);
  let discountCents = 0;
  let finalCents = subtotalCents;
  let couponMsg = '';

  if (couponResult) {
    if (couponResult.valid) {
      discountCents = couponResult.discountCents;
      finalCents = couponResult.finalPayableCents;
      couponMsg = `<div class="msg ok" style="margin-top:0.5rem; color: #2e7d32;">✓ Promo code '${esc(couponCode.toUpperCase())}' applied successfully!</div>`;
    } else {
      couponMsg = `<div class="msg err" style="margin-top:0.5rem; color: #d32f2f;">❌ ${esc(couponResult.error)}</div>`;
    }
  }

  const formattedDiscount = (discountCents / 100).toFixed(2);
  const formattedFinal = (finalCents / 100).toFixed(2);

  return `
    <div id="cart-summary" class="card" style="margin-top: 1.5rem;">
      <div style="margin-bottom: 1.5rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 1rem;">
        <label style="font-weight: bold; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Have a Promo Code?</label>
        <form hx-post="/cart/coupon" hx-target="#cart-summary" hx-swap="outerHTML" style="display: flex; gap: 0.5rem; align-items: center;">
          <input type="text" name="couponCode" placeholder="Enter coupon code" value="${esc(couponCode || '')}" style="padding: 0.5rem; flex: 1; border: 1px solid #ccc; border-radius: 4px;" required>
          <button type="submit" class="alt" style="padding: 0.5rem 1rem;">Apply</button>
          ${couponCode && couponResult?.valid ? `
            <button hx-delete="/cart/coupon" hx-target="#cart-summary" hx-swap="outerHTML" style="padding: 0.5rem 1rem; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Remove</button>
          ` : ''}
        </form>
        ${couponMsg}
      </div>

      <form hx-post="/cart/checkout" hx-target="#checkout-err" hx-swap="innerHTML" style="text-align: right;">
            
        <input type="hidden" name="couponCode" value="${esc(couponCode || '')}">

        <p style="font-size: 1rem; margin-bottom: 0.25rem; color: #5B5F6E;">
          Subtotal: <strong>$${formattedSubtotal} USD</strong>
        </p>
        ${discountCents > 0 ? `
          <p style="font-size: 1rem; margin-bottom: 0.25rem; color: #2e7d32;">
            Discount: <strong>-$${formattedDiscount} USD</strong>
          </p>
        ` : ''}
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


// POST /cart/remove - Remove item from cart
router.post('/cart/remove', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const body = req.body || {};
  const rawId = body.productId || body.product_id || body.slug;

  if (!rawId) {
    return res.status(400).send('Product ID is required');
  }

  const { catalog } = req.app.locals.engine;
  const isSubscription = rawId === 'sub_monthly';

  let storedProductId = 'sub_monthly';
  if (!isSubscription) {
    const catalogProduct = resolveCatalogProduct(catalog, rawId);
    storedProductId = catalogProduct ? (catalogProduct.slug || catalogProduct.id) : rawId;
  }

  try {
    await pool.query(
      'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [userId, storedProductId]
    );

    // Sync navbar badge counter
    res.setHeader('HX-Trigger', 'cartUpdated');
    
    // Redirect browser window back to /cart to reload fresh summary & check for empty state
    return res.status(200).set('HX-Redirect', '/cart').end();
  } catch (err) {
    console.error('[cart/remove] Error removing item from cart:', err);
    return res.status(500).send('Internal Server Error');
  }
}); // Don't care 


// GET /cart - Renders itemized cart view with Remove actions
router.get('/cart', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { catalog } = req.app.locals.engine;

  try {
    const { cartProducts, isSub, cartItems, subtotalCents, subDurationDays } = await getCartData(userId, req.user, catalog);
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

    let itemsHtml = '';
    if (isSub) {
      const formattedSubPrice = (subtotalCents / 100).toFixed(2);
      itemsHtml = `
        <tr>
          <td>LearnX All-Access Pass</td>
          <td>${subDurationDays} Days Pass</td>
          <td>$${formattedSubPrice} USD</td>
          <td style="text-align: right;">
            <form hx-post="/cart/remove" style="display: inline;">
              <input type="hidden" name="productId" value="sub_monthly">
              <button type="submit" style="background: transparent; color: #2743D8; border: 1px solid #2743D8; padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px;">Remove</button>
            </form>
          </td>
        </tr>
      `;
    } else {
      itemsHtml = cartItems.map(item => {
        const itemKey = item.slug || item.id;
        return `
          <tr>
            <td>${esc(item.title || item.name)}</td>
            <td>One-Time Purchase</td>
            <td>$${item.price.toFixed(2)} ${esc(item.currency || 'USD')}</td>
            <td style="text-align: right;">
              <form hx-post="/cart/remove" style="display: inline;">
                <input type="hidden" name="productId" value="${esc(itemKey)}">
                <button type="submit" style="background: transparent; color: #2743D8; border: 1px solid #2743D8; padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px;">Remove</button>
              </form>
            </td>
          </tr>
        `;
      }).join('');
    }

    let couponResult = null;
    const activeCoupon = req.session?.couponCode;
    if (activeCoupon) {
      couponResult = await validateCoupon(activeCoupon, req.user, isSub, cartItems);
      if (!couponResult.valid && req.session) {
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
    if (couponResult.valid && req.session) {
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
router.post('/cart/checkout', requireAuth, async (req, res, next) => {
  const userId = req.user.id;
  const { catalog } = req.app.locals.engine;
  const body = req.body || {};
  const provider = body.provider === 'razorpay' ? 'razorpay' : 'mock';
  const client = await pool.connect();
  let inTransaction = false;
  
  try {
    const { isSub, cartItems, subtotalCents } = await getCartData(userId, req.user, catalog);
    
    if (subtotalCents === 0 && cartItems.length === 0 && !isSub) {
      return res.status(400).send('<span style="color:#d32f2f;">Your cart is empty.</span>');
    }

    let discountCents = 0;
    let finalPayableCents = subtotalCents;
    let appliedRuleId = null;
    const activeCoupon = req.body.couponCode;
    // console.log(activeCoupon);
    if (activeCoupon) {
      const couponResult = await validateCoupon(activeCoupon, req.user, isSub, cartItems);
      // console.log(couponResult)
      if (couponResult.valid) {
        discountCents = couponResult.discountCents;
        finalPayableCents = couponResult.finalPayableCents;
        appliedRuleId = couponResult.rule?couponResult.rule.id:null;
      } else {
        if(req.session) delete req.session.couponCode;
      }
    }

    await client.query('BEGIN');
    inTransaction = true; //Why are we doing this at all.

    const orderRes = await client.query(
      `INSERT INTO orders (
        user_id, subtotal_cents, discount_cents, final_payable_cents,
        applied_rule_id, provider, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
      RETURNING id`,
      [userId, subtotalCents, discountCents, finalPayableCents, appliedRuleId, provider]
    );
    const orderId = orderRes.rows[0].id;

    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');
    inTransaction =false;
    // Clean up session coupon after order is committed
    if (req.session) delete req.session.couponCode;
    const productId = isSub ? 'sub_monthly' : cartItems.map(i => i.slug || i.id).join(',');
    
    console.log(productId);
    const svc = new PaymentService({ catalog });
    
    const { redirectUrl } = await svc.initiatePayment({
      userId,
      productId,
      amount: finalPayableCents / 100,
      orderId,
      provider
    });

    res.status(200).set('HX-Redirect', redirectUrl || '/courses').end();
  } catch (err) {
    if(inTransaction)    await client.query('ROLLBACK').catch(() => {});
    console.error('Checkout error:', err);
    res.status(500).send(`<span style="color:#d32f2f;">Checkout error: ${esc(err.message)}</span>`);
  } finally {
    client.release();
  }
});

// GET /cart/count
router.get('/cart/count', requireAuth, async (req, res) => {
  try {
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );
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
  // Accept productId, product_id, or slug
  const rawId = body.productId || body.product_id || body.slug;

  if (!rawId) {
    return res.status(400).send('Product ID is required');
  }

  const { catalog, decisions } = req.app.locals.engine;
  const isSubscription = rawId === 'sub_monthly';
  const catalogProduct = null;
  let storedProductId = '';

  if (isSubscription) {
    storedProductId = 'sub_monthly';
  } else {
    const catalogProduct = resolveCatalogProduct(catalog, rawId);
    if (!catalogProduct) {
      // Abort early without checking out a DB pool connection
      return res.status(404).send('Product not found');
    }
    // Standardize to the product's primary canonical key
    storedProductId = catalogProduct.slug || catalogProduct.id;
  }
  // Canonicalize to slug so database strictly stores slugs (e.g., 'intro-to-sql')
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (isSubscription) {
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      await client.query(
        'INSERT INTO cart_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, 'sub_monthly']
      );
    } else {
      await client.query(
        'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [userId, 'sub_monthly']
      );
      await client.query(
        'INSERT INTO cart_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, storedProductId]
      );
    }

    await client.query('COMMIT');

    res.setHeader('HX-Trigger', 'cartUpdated');
    if (isSubscription) {
      const subPriceInfo = await resolveSubscriptionPrice(req.user);
      return res.send(subscriptionCard(true, subPriceInfo));
    } else {
      if (!catalogProduct) return res.status(404).send('Product not found');

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

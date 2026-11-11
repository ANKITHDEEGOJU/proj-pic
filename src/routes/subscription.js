'use strict';
// M4 subscription lifecycle: renew (pay for another period) and cancel renewal.
const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { cancelRenewal } = require('../services/subscriptions');

// Renew = put the pass in the cart (a pass replaces anything else in the cart, as usual)
// and go to checkout. The order line is marked as a renewal there, so the new period is
// stacked after the current end date.
router.post('/subscription/renew', requireAuth, async (req, res, next) => {
  try {
    const { catalog } = req.app.locals.engine;
    const id = String(req.body?.productId || 'sub_monthly');
    const product = catalog.get(id) || catalog.list().find((p) => p.slug === id);
    if (!product || product.type !== 'SUBSCRIPTION') return res.status(404).send('Unknown pass');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cart_items WHERE user_id=$1', [req.user.id]);
      await client.query('INSERT INTO cart_items (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        req.user.id,
        product.slug || product.id,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.set('HX-Redirect', '/cart').end();
  } catch (e) {
    next(e);
  }
});

// Cancel = stop renewing. Access stays until the paid-up end date (SUBSCRIPTION_CANCELLED).
router.post('/subscription/cancel', requireAuth, async (req, res, next) => {
  try {
    const { ledger, projection } = req.app.locals.engine;
    const out = await cancelRenewal({ ledger, projection, user: req.user });
    if (!out.ok) return res.send(`<div class="card" id="sub-card"><p class="err">${out.message}</p></div>`);
    res.set('HX-Refresh', 'true').end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;

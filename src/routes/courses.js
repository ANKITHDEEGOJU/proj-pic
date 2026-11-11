'use strict';

const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout, courseCard, subscriptionCard, accessFragment, activityPage } = require('../views');
const { resolveSubscriptionPrice } = require('../services/pricingEngine');
const { isRefundPending } = require('../services/refundStatus');

// Helper to look up catalog item by id or slug safely
function resolveCatalogProduct(catalog, key) {
  if (!catalog || !key) return null;
  if (typeof catalog.get === 'function') {
    const item = catalog.get(key);
    if (item) return item;
  }
  if (typeof catalog.list === 'function') {
    for (const item of catalog.list()) {
      if (item.id === key || item.slug === key) return item;
    }
  }
  return null;
}

// GET /courses/subscription-banner
router.get('/courses/subscription-banner', requireAuth, async (req, res) => {
  try {
    const { catalog, projection } = req.app.locals.engine;

    const cartRes = await pool.query(
      'SELECT product_id FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );

    const subInCart = cartRes.rows.some((r) =>
      catalog.isSubscription ? catalog.isSubscription(r.product_id) : false
    );
    const subPriceInfo = await resolveSubscriptionPrice(req.user, 'sub_monthly', catalog);

    // Evaluate user entitlement projection for subscription
    const subEnt = projection.getSubscription(req.user.id, 'ALL_ACCESS');
    const isSubActive =
      subEnt &&
      subEnt.status === 'ACTIVE' &&
      (!subEnt.expiresAt || new Date(subEnt.expiresAt).getTime() > Date.now());

    const { ledger } = req.app.locals.engine;
    const refundPending = isSubActive && (await isRefundPending(ledger, subEnt.refundableEventId));
    res.send(subscriptionCard(subInCart, subPriceInfo, isSubActive, subEnt, { refundPending }));
  } catch (err) {
    console.error('Error fetching subscription banner:', err);
    res.status(500).end();
  }
});

// GET /courses
router.get('/courses', requireAuth, async (req, res) => {
  const { catalog, decisions, projection } = req.app.locals.engine;

  try {
    const cartRes = await pool.query(
      'SELECT product_id FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );
    const cart = cartRes.rows.map((r) => r.product_id);

    const subInCart = cart.some((id) =>
      catalog.isSubscription ? catalog.isSubscription(id) : false
    );
    const subPriceInfo = await resolveSubscriptionPrice(req.user, 'sub_monthly', catalog);

    // Check projection for active subscription
    const subEnt = projection.getSubscription(req.user.id, 'ALL_ACCESS');
    const isSubActive =
      subEnt &&
      subEnt.status === 'ACTIVE' &&
      (!subEnt.expiresAt || new Date(subEnt.expiresAt).getTime() > Date.now());

    const { ledger } = req.app.locals.engine;
    const subRefundPending = isSubActive && (await isRefundPending(ledger, subEnt.refundableEventId));
    const subBanner = subscriptionCard(subInCart, subPriceInfo, isSubActive, subEnt, { refundPending: subRefundPending });

    const courseProducts =
      typeof catalog.listCourses === 'function'
        ? catalog.listCourses()
        : catalog.list().filter((p) => p.type === 'COURSE');

    const cards = (
      await Promise.all(
        courseProducts.map(async (p) => {
          const slug = p.slug || p.id;
          const d = decisions.evaluateAccess(req.user.id, slug);
          const inCart = cart.includes(slug);
          const pending = d.reason === 'ACTIVE_PURCHASE' && (await isRefundPending(ledger, d.sourceEventIds[0]));
          return courseCard(p, d, '', pending, inCart);
        })
      )
    ).join('');

    const body = `<h2>Courses</h2>${subBanner}${cards}`;
    res.send(layout('Courses', body, req.user, cart.length));
  } catch (err) {
    console.error('Error rendering courses page:', err);
    res.status(500).send('Internal Server Error');
  }
});

// GET /courses/:slug/card - HTMX Card status polling
router.get('/courses/:slug/card', requireAuth, async (req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  const p = resolveCatalogProduct(catalog, req.params.slug);
  if (!p) return res.status(404).end();

  try {
    const cartRes = await pool.query(
      'SELECT product_id FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );
    const cart = cartRes.rows.map((r) => r.product_id);
    const slug = p.slug || p.id;
    const d = decisions.evaluateAccess(req.user.id, slug);
    const inCart = cart.includes(slug);

    // "Refund pending" only while the order really is REFUND_PENDING (was: whenever owned).
    const pending = d.reason === 'ACTIVE_PURCHASE' && (await isRefundPending(req.app.locals.engine.ledger, d.sourceEventIds[0]));
    res.send(courseCard(p, d, '', pending, inCart));
  } catch (err) {
    console.error('Error polling card status:', err);
    res.status(500).end();
  }
});

// GET /courses/:slug/access - Content player access fragment
router.get('/courses/:slug/access', requireAuth, (req, res) => {
  const { decisions } = req.app.locals.engine;
  res.send(accessFragment(decisions.evaluateAccess(req.user.id, req.params.slug)));
});

// GET /activity - User entitlement history + ledger log
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const { ledger, projection } = req.app.locals.engine;
    const records = (await ledger.getAll()).filter((r) => r.event.userId === req.user.id);
    const ents = Object.values(projection.snapshot()).filter((e) => e.userId === req.user.id);
    res.send(layout('Activity', activityPage(records, ents), req.user));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
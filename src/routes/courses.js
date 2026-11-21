'use strict';

const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout, courseCard, subscriptionCard, accessFragment, activityPage, ledgerRows } = require('../views');
const { resolveSubscriptionPrice } = require('../services/pricingEngine');
const { isRefundPending } = require('../services/refundStatus');
const { passState, cardOpts } = require('../services/subscriptions');
const { createHash } = require('node:crypto');

// What this user can open right now, as a short fingerprint: for every product, allowed or not
// and why. An open page sends it back every few seconds (and when its tab becomes visible again);
// if it changed (an admin revoked or granted access, a refund or payment arrived, a pass ended),
// the page reloads, so a course that was revoked doesn't stay on screen as "Owned".
function accessFingerprint(engine, userId) {
  const { catalog, decisions } = engine;
  const state = catalog.list()
    .map((p) => p.slug || p.id)
    .sort()
    .map((slug) => { const d = decisions.evaluateAccess(userId, slug); return `${slug}:${d.allowed ? 1 : 0}:${d.reason}`; })
    .join('|');
  return createHash('sha256').update(state).digest('hex').slice(0, 16);
}
// Re-check every 5 s, and at once when the tab is shown again.
const RECHECK_TRIGGER = "every 5s, visibilitychange[document.visibilityState=='visible'] from:document";
const accessWatcher = (fp) =>
  `<div hx-get="/courses/access-state?fp=${fp}" hx-trigger="${RECHECK_TRIGGER}" hx-swap="none"></div>`;

// GET /courses/access-state?fp= - 204 while access is unchanged, otherwise reload the page.
router.get('/courses/access-state', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (accessFingerprint(req.app.locals.engine, req.user.id) === String(req.query.fp || '')) return res.status(204).end();
  res.set('HX-Refresh', 'true').status(200).end();
});

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
    const passOpts = isSubActive ? cardOpts(await passState({ ledger, projection, userId: req.user.id })) : {};
    // The card was waiting for a refund and it has finished: reload the page, so the course
    // cards (access through the pass) update too, not only this card.
    if (req.query.pending === '1' && !passOpts.refundPending) return res.set('HX-Refresh', 'true').end();
    res.send(subscriptionCard(subInCart, subPriceInfo, isSubActive, subEnt, passOpts));
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
    const passOpts = isSubActive ? cardOpts(await passState({ ledger, projection, userId: req.user.id })) : {};
    const subBanner = subscriptionCard(subInCart, subPriceInfo, isSubActive, subEnt, passOpts);

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

    const body = `<h2>Courses</h2>${accessWatcher(accessFingerprint(req.app.locals.engine, req.user.id))}${subBanner}${cards}`;
    res.send(layout('Courses', body, req.user, cart.length));
  } catch (err) {
    console.error('Error rendering courses page:', err);
    res.status(500).send('Internal Server Error');
  }
});

// GET /courses/:slug/card - HTMX Card status polling
router.get('/courses/:slug/card', requireAuth, async (req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  const p = catalog.get(req.params.slug);
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

// GET /activity/ledger?q=&offset= - htmx: next page / search results of the ledger table
router.get('/activity/ledger', requireAuth, async (req, res, next) => {
  try {
    const records = (await req.app.locals.engine.ledger.getAll()).filter((r) => r.event.userId === req.user.id);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.send(ledgerRows(records, { q: String(req.query.q || '').slice(0, 100), offset }));
  } catch (e) {
    next(e);
  }
});

module.exports = router;

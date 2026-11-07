const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout,courseCard,subscriptionCard, accessFragment, activityPage } = require('../views');
const { resolveSubscriptionPrice } = require('../services/pricingEngine');
const { randomUUID } = require('node:crypto');
const {DomainError} = require('../domain/util')



// GET /courses/subscription-banner - Re-fetched on cartUpdated
router.get('/courses/subscription-banner', requireAuth, async (req, res) => {
  try {
    const cartRes = await pool.query(
      'SELECT 1 FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [req.user.id, 'sub_monthly']
    );
    const subInCart = cartRes.rows.length > 0;
    const subPriceInfo = await resolveSubscriptionPrice(req.user);
    res.send(subscriptionCard(subInCart, subPriceInfo));
  } catch (err) {
    console.error('Error fetching subscription banner:', err);
    res.status(500).end();
  }
});

//New changes

router.get('/courses', requireAuth, async(req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  
  // Retrieve items currently in the user's session cart (defaults to empty array)
  try {
    const cartRes = await pool.query(
      'SELECT product_id FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );
    const cart = cartRes.rows.map(r => r.product_id);
  
  //const cart = req.session?.cart || [];
  
  // 1. Subscription Banner
  const subInCart = cart.includes('sub_monthly');
  const subPriceInfo = await resolveSubscriptionPrice(req.user);
  const subBanner = subscriptionCard(subInCart, subPriceInfo);
  
  const cards = catalog.list()
    .map(p => {
        const slug = p.slug || p.id;
        const d = decisions.evaluateAccess(req.user.id, slug);
        const inCart = cart.includes(slug);
        return courseCard(p, d, '', false, inCart);
      })
    .join('');

  const body = `<h2>Courses</h2>${subBanner}${cards}`;
  res.send(layout('Courses', body, req.user,cart.length));
  } catch (err) {
    console.error('Error rendering courses page:', err);
    res.status(500).send('Internal Server Error');
  }
});


router.get('/courses/:slug/card', requireAuth, async(req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  const p = catalog.get(req.params.slug);
  if (!p) return res.status(404).end();
try {
    const cartRes = await pool.query(
      'SELECT product_id FROM cart_items WHERE user_id = $1',
      [req.user.id]
    );
    const cart = cartRes.rows.map(r => r.product_id);
    const slug = p.slug || p.id;
    const d = decisions.evaluateAccess(req.user.id, slug);
    const inCart = cart.includes(slug);

    if (d.allowed) return res.send(courseCard(p, d, '', true, inCart));
    res.send(courseCard(p, d, '', false, inCart));
  } catch (err) {
    console.error('Error polling card status:', err);
    res.status(500).end();
  }
});

router.get('/courses/:slug/access', requireAuth, (req, res) =>
  res.send(accessFragment(req.app.locals.engine.decisions.evaluateAccess(req.user.id, req.params.slug))));

// Full page: this user's entitlements + ledger rows
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const { ledger, projection } = req.app.locals.engine;
    const records = (await ledger.getAll()).filter(r => r.event.userId === req.user.id);
    const ents = Object.values(projection.snapshot()).filter(e => e.userId === req.user.id);
    res.send(layout('Activity', activityPage(records, ents), req.user));
  } catch (e) { next(e); }
});

module.exports = router;

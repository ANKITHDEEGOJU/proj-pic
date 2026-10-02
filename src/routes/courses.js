const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout,courseCard, accessFragment, activityPage } = require('../views');
const { randomUUID } = require('node:crypto');
const {DomainError} = require('../domain/util')
// router.get('/', requireAuth, async (req, res) => {
//   const { rows } = await pool.query('SELECT * FROM courses ORDER BY price_cents');
//   res.send(layout('Courses'
//     // , 
//     // `<h2>Courses</h2>
//     // ${courseCard(rows)}`
//     , req.user));
// });

//New changes

router.get('/courses', requireAuth, (req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  const cards = catalog.list()
    .map(p => courseCard(p, decisions.evaluateAccess(req.user.id, p.id)))
    .join('');
  res.send(layout('Courses', `<h2>Courses</h2>${cards}`, req.user));
});


router.post('/courses/:slug/buy', requireAuth, (req, res) => {
  const { ledger, decisions, catalog } = req.app.locals.engine;
  const p = catalog.get(req.params.slug);
  if (!p) return res.status(404).end();
  const before = decisions.evaluateAccess(req.user.id, p.id);
  if (before.allowed) return res.send(courseCard(p, before, 'You already own this course.'));
  let msg = 'Purchase successful.';
  try {
    ledger.appendEvent({ eventId: `evt_${randomUUID()}`, eventType: 'PURCHASE_SUCCEEDED', userId: req.user.id,
      productId: p.id, quantity: 1, amount: p.price, currency: p.currency,
      occurredAt: new Date().toISOString(), referenceeventId: null }, { method: 'MOCK_CHECKOUT' });
  } catch (e) { if (!(e instanceof DomainError)) throw e; msg = `Rejected: ${e.code}`; }
  res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), msg));
});

router.post('/courses/:slug/refund', requireAuth, (req, res) => {
  const { ledger, projection, decisions, catalog } = req.app.locals.engine;
  const p = catalog.get(req.params.slug);
  if (!p) return res.status(404).end();
  const ent = projection.get(req.user.id, p.id);
  if (!ent || ent.status !== 'ACTIVE')
    return res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), 'Nothing to refund.'));
  let msg = 'Refund processed. Access revoked.';
  try {
    ledger.appendEvent({ eventId: `evt_${randomUUID()}`, eventType: 'REFUND', userId: req.user.id,
      productId: p.id, quantity: 1, amount: p.price, currency: p.currency,
      occurredAt: new Date().toISOString(), referenceeventId: ent.sourceEventId }, { method: 'MOCK_CHECKOUT' });
  } catch (e) { if (!(e instanceof DomainError)) throw e; msg = `Rejected: ${e.code}`; }
  res.send(courseCard(p, decisions.evaluateAccess(req.user.id, p.id), msg));
});

// Play button: access check + audit reason, returned as a fragment
router.get('/courses/:slug/access', requireAuth, (req, res) => {
  const { decisions } = req.app.locals.engine;
  res.send(accessFragment(decisions.evaluateAccess(req.user.id, req.params.slug)));
});

// Full page: this user's entitlements + ledger rows
router.get('/activity', requireAuth, (req, res) => {
  const { ledger, projection } = req.app.locals.engine;
  const records = ledger.getAll().filter(r => r.event.userId === req.user.id);
  const ents = Object.values(projection.snapshot()).filter(e => e.userId === req.user.id);
  res.send(layout('Activity', activityPage(records, ents), req.user));
});

module.exports = router;

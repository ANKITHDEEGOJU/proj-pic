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

// Shared by buy/refund: append a mock-provider event, then re-render the card.
// async function mockCheckout(req, res, type) {
//   const { ledger, projection, decisions, catalog } = req.app.locals.engine;
//   const p = catalog.get(req.params.slug);
//   if (!p) return res.status(404).end();
//   const ent = projection.get(req.user.id, p.id);
//   const decide = () => decisions.evaluateAccess(req.user.id, p.id);
//   if (type === 'PURCHASE_SUCCEEDED' && ent?.status === 'ACTIVE') return res.send(courseCard(p, decide(), 'You already own this course.'));
//   if (type === 'REFUND' && ent?.status !== 'ACTIVE') return res.send(courseCard(p, decide(), 'Nothing to refund.'));
//   let msg = type === 'REFUND' ? 'Refund processed. Access revoked.' : 'Purchase successful.';
//   try {
//     await ledger.appendEvent({ eventId: `evt_${randomUUID()}`, eventType: type, userId: req.user.id, productId: p.id,
//       quantity: 1, amount: p.price, currency: p.currency, occurredAt: new Date().toISOString(),
//       referenceeventId: type === 'REFUND' ? ent.sourceEventId : null }, { method: 'MOCK_CHECKOUT' });
//   } catch (e) { if (!(e instanceof DomainError)) throw e; msg = `Rejected: ${e.code}`; }
//   res.send(courseCard(p, decide(), msg));
// }

// router.post('/courses/:slug/buy',    requireAuth, (req, res, next) => mockCheckout(req, res, 'PURCHASE_SUCCEEDED').catch(next));
// router.post('/courses/:slug/refund', requireAuth, (req, res, next) => mockCheckout(req, res, 'REFUND').catch(next));

// router.get('/courses/:slug/access', requireAuth, (req, res) =>
//   res.send(accessFragment(req.app.locals.engine.decisions.evaluateAccess(req.user.id, req.params.slug))));

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

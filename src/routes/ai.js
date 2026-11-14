'use strict';
// M5 demo feature: "AI course summary", limited by a daily usage quota (see services/quotas.js).
// Each rendered Generate button carries a fresh requestId, so a double click or an htmx retry
// of the same request is counted once.

const router = require('express').Router();
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../auth');
const quotas = require('../services/quotas');
const { generateSummary } = require('../services/aiSummary');
const { aiSummaryPanel } = require('../views');

const FEATURE = 'AI_SUMMARY';

function findProduct(catalog, key) {
  return catalog.list().find((p) => (p.id === key || p.slug === key) && (p.type || 'COURSE') === 'COURSE') || null;
}

async function context(req) {
  const { catalog, decisions } = req.app.locals.engine;
  const product = findProduct(catalog, req.params.slug);
  if (!product) return { status: 404 };
  const decision = decisions.evaluateAccess(req.user.id, product.slug || product.id);
  if (!decision.allowed) return { status: 403, product };
  const quota = await quotas.resolveQuota({ userId: req.user.id, feature: FEATURE, decision });
  return { product, quota };
}

const panel = (product, quota, extra) =>
  aiSummaryPanel({ slug: product.slug || product.id, quota, requestId: randomUUID(), ...extra });

router.get('/courses/:slug/ai-summary', requireAuth, async (req, res, next) => {
  try {
    const c = await context(req);
    if (c.status === 404) return res.status(404).end();
    if (c.status === 403) return res.status(403).send(aiSummaryPanel({ denied: true }));
    const used = await quotas.usage(c.quota.scopeKey, FEATURE);
    res.send(panel(c.product, c.quota, { used, resetsAt: quotas.currentPeriod().resetsAt }));
  } catch (e) { next(e); }
});

router.post('/courses/:slug/ai-summary', requireAuth, async (req, res, next) => {
  try {
    const requestId = String(req.body.requestId || req.get('Idempotency-Key') || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return res.status(400).send('requestId is required');
    const c = await context(req);
    if (c.status === 404) return res.status(404).end();
    if (c.status === 403) return res.status(403).send(aiSummaryPanel({ denied: true }));

    const requestKey = `${FEATURE}:${req.user.id}:${requestId}`;
    const r = await quotas.consume({
      requestKey, quota: c.quota, feature: FEATURE, userId: req.user.id, productId: c.product.id,
    });
    if (!r.ok) {
      res.status(429).set('Retry-After', String(r.retryAfterSec));
      return res.send(panel(c.product, c.quota, { used: r.used, resetsAt: r.resetsAt, exhausted: r.status !== 'RELEASED',
        error: r.status === 'RELEASED' ? 'That request failed earlier; try again.' : null }));
    }
    let summary;
    try {
      summary = await generateSummary(c.product);
    } catch (e) {
      await quotas.release(requestKey); // the work failed: give the credit back
      const used = await quotas.usage(c.quota.scopeKey, FEATURE);
      return res.status(502).send(panel(c.product, c.quota, { used, resetsAt: r.resetsAt, error: `${e.message}. Your credit was not used.` }));
    }
    res.send(panel(c.product, c.quota, { used: r.used, resetsAt: r.resetsAt, summary, duplicate: r.duplicate }));
  } catch (e) { next(e); }
});

module.exports = router;

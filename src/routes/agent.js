'use strict';
// M7: agent-approved purchases (see services/agentPurchase.js).
//
// Browser pages (the user):
//   GET  /agent                       simulated agent + the user's purchase requests
//   GET  /agent/intents/:id           review a request: Approve / Cancel
//   POST /agent/intents/:id/approve   -> hand-off page showing the token the agent receives
//   POST /agent/intents/:id/cancel
// Agent side (the simulated agent's form posts, or JSON for a real agent):
//   POST /agent/propose               form: productId, provider
//   POST /agent/intents/:id/execute   form or JSON: token
//   POST /agent/api/intents           JSON: { productId, provider, agentName }
//   POST /agent/api/intents/:id/execute  JSON: { token }
// In this sandbox the agent acts with the user's login. A real agent would get its own
// credential that can propose / execute but never approve.

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { layout, esc } = require('../views');
const agent = require('../services/agentPurchase');
const { PaymentService } = require('../payment/service');
const { getAdapter } = require('../payment/registry');

const money = (cents, cur) => `${(cents / 100).toFixed(2)} ${esc(cur)}`;
const STATUS_COLOR = { PROPOSED: '#8a4b00', APPROVED: '#2743D8', EXECUTED: '#2e7d32', CANCELLED: '#5B5F6E', FAILED: '#d32f2f' };
const badge = (s) => `<strong style="color:${STATUS_COLOR[s] || '#1C1E26'}">${esc(s)}</strong>`;

function courseName(catalog, id) {
  const c = agent.findCourse(catalog, id);
  return c ? c.name || c.slug || c.id : id;
}

// Starts the payment for an executed intent: a server-side charge where the provider supports
// it (mock), otherwise the provider's normal checkout (Razorpay) for the approved amount.
function paymentStarter(req) {
  const { catalog } = req.app.locals.engine;
  return async ({ intent, orderId }) => {
    const svc = new PaymentService({ catalog });
    const amount = intent.amount_cents / 100;
    const { providerPaymentId, redirectUrl } = await svc.initiatePayment({
      userId: intent.user_id, productId: intent.item_id, amount, orderId, provider: intent.provider,
    });
    const adapter = getAdapter(intent.provider);
    if (adapter.supportsDirectCharge) {
      await adapter.charge({ providerPaymentId, orderRef: orderId, userId: intent.user_id, productId: intent.item_id, amount, currency: intent.currency });
      return { status: 'PAID' };
    }
    return { status: 'CHECKOUT', redirectUrl };
  };
}

// ---- pages ------------------------------------------------------------------------------

function agentPage(req, intents, { message = '', error = '' } = {}) {
  const { catalog } = req.app.locals.engine;
  const courses = catalog.list().filter((p) => (p.type || 'COURSE') === 'COURSE');
  const options = courses
    .map((c) => `<option value="${esc(c.slug || c.id)}">${esc(c.name || c.slug)} - ${money(c.priceCents, c.currency || 'USD')}</option>`)
    .join('');
  const rows = intents
    .map((i) => {
      const action =
        i.status === 'PROPOSED' ? `<a href="/agent/intents/${i.id}">Review &amp; approve →</a>`
        : i.status === 'APPROVED' ? `<a href="/agent/intents/${i.id}">Details</a>`
        : i.status === 'FAILED' ? `<small>${esc(i.failure_reason || '')}</small>`
        : '';
      return `<tr><td>${esc(new Date(i.created_at).toLocaleString())}</td><td>${esc(courseName(catalog, i.item_id))}</td>
        <td>${money(i.amount_cents, i.currency)}</td><td>${esc(i.provider)}</td><td>${badge(i.status)}</td><td>${action}</td></tr>`;
    })
    .join('');
  return `<h2>Agent purchases</h2>
${message ? `<p class="ok">${esc(message)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}
<div class="card">
  <h3>Simulated agent</h3>
  <p><small>Stands in for an AI agent. It can only <em>propose</em> a purchase; you approve it on the next page.
  The price comes from the catalog, not from the agent.</small></p>
  <form method="POST" action="/agent/propose">
    <label>Course <select name="productId">${options}</select></label>
    <label>Pay with <select name="provider"><option value="mock">Mock provider (agent pays on its own)</option>
      <option value="razorpay">Razorpay test mode (you pay on checkout)</option></select></label>
    <button type="submit">Agent: propose purchase</button>
  </form>
</div>
<h3>Your purchase requests</h3>
<table><tr><th>Created</th><th>Item</th><th>Amount</th><th>Provider</th><th>Status</th><th></th></tr>
${rows || '<tr><td colspan="6">None yet</td></tr>'}</table>`;
}

function reviewPage(req, i) {
  const { catalog } = req.app.locals.engine;
  const open = i.status === 'PROPOSED' || i.status === 'APPROVED';
  return `<h2>Purchase request</h2>
<div class="card">
  <p>An agent (<code>${esc(i.agent_name)}</code>) wants to buy this for you:</p>
  <table>
    <tr><th>Item</th><td>${esc(courseName(catalog, i.item_id))} (<code>${esc(i.item_id)}</code>)</td></tr>
    <tr><th>Merchant</th><td>${esc(i.merchant)}</td></tr>
    <tr><th>Amount</th><td><strong>${money(i.amount_cents, i.currency)}</strong></td></tr>
    <tr><th>Payment</th><td>${esc(i.provider)}</td></tr>
    <tr><th>Status</th><td>${badge(i.status)}${i.expires_at && i.status === 'APPROVED' ? ` · approval valid until ${esc(new Date(i.expires_at).toLocaleTimeString())}` : ''}</td></tr>
  </table>
  ${i.status === 'PROPOSED' ? `<form method="POST" action="/agent/intents/${i.id}/approve" style="display:inline"><button type="submit">Approve this purchase</button></form>` : ''}
  ${open ? `<form method="POST" action="/agent/intents/${i.id}/cancel" style="display:inline"><button type="submit" class="alt">Cancel</button></form>` : ''}
</div>
<p><a href="/agent">← Back to agent purchases</a></p>`;
}

// What the agent holds after approval. The token is shown (and editable) so the demo can
// try tampering with it, or send it twice.
function handoffPage(i, token, { title, result = '', error = '' }) {
  return `<h2>${esc(title)}</h2>
${result}${error ? `<p class="err">Rejected: ${esc(error)}</p>` : ''}
<div class="card">
  <h3>Simulated agent</h3>
  <p><small>The agent received this approval token (valid ${Math.round(Number(process.env.AGENT_APPROVAL_TTL_SECONDS || 300) / 60)} min, works once).
  Click "Agent: execute purchase" to let the agent complete the purchase. To test the checks: change a character in the token,
  send it a second time, or wait until it expires.</small></p>
  <form method="POST" action="/agent/intents/${i.id}/execute">
    <textarea name="token" rows="5" style="width:100%;font-family:monospace;font-size:.75rem">${esc(token)}</textarea>
    <button type="submit">Agent: execute purchase</button>
  </form>
</div>
<p><a href="/agent">← Back to agent purchases</a></p>`;
}

// ---- routes -----------------------------------------------------------------------------

const send = (req, res, title, body) => res.send(layout(title, body, req.user));

router.get('/agent', requireAuth, async (req, res, next) => {
  try {
    send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id)));
  } catch (e) { next(e); }
});

router.post('/agent/propose', requireAuth, async (req, res, next) => {
  try {
    const { catalog, decisions } = req.app.locals.engine;
    const i = await agent.propose({
      userId: req.user.id, productId: req.body.productId, provider: req.body.provider,
      agentName: 'simulated-agent', catalog, decisions,
    });
    res.redirect(`/agent/intents/${i.id}`);
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id), { error: e.message }));
  }
});

router.get('/agent/intents/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await agent.getIntent(req.params.id);
    if (!i || i.user_id !== req.user.id) return res.status(404).send(layout('Not found', '<p>Purchase request not found.</p>', req.user));
    send(req, res, 'Purchase request', reviewPage(req, i));
  } catch (e) { next(e); }
});

router.post('/agent/intents/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const { intent, token } = await agent.approve({ intentId: req.params.id, userId: req.user.id });
    send(req, res, 'Approved', handoffPage(intent, token, {
      title: 'Approved',
      result: `<p class="ok">You approved ${money(intent.amount_cents, intent.currency)} to ${esc(intent.merchant)}. The agent can now complete it.</p>`,
    }));
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id), { error: e.message }));
  }
});

router.post('/agent/intents/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    await agent.cancel({ intentId: req.params.id, userId: req.user.id });
    send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id), { message: 'Purchase request cancelled.' }));
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id), { error: e.message }));
  }
});

router.post('/agent/intents/:id/execute', requireAuth, async (req, res, next) => {
  const token = String(req.body.token || '');
  const intent = (await agent.getIntent(req.params.id).catch(() => null)) || { id: req.params.id };
  try {
    const out = await agent.execute({
      intentId: req.params.id, token, userId: req.user.id,
      catalog: req.app.locals.engine.catalog, startPayment: paymentStarter(req),
    });
    if (out.status === 'CHECKOUT') return res.redirect(out.redirectUrl); // Razorpay: user pays the approved amount
    send(req, res, 'Purchase completed', handoffPage(intent, token, {
      title: 'Purchase completed',
      result: `<p class="ok">The agent paid ${money(intent.amount_cents, intent.currency)} through the mock provider.
        Access appears when the provider's webhook arrives (usually at once). <a href="/courses">Go to Courses →</a></p>`,
    }));
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    res.status(e.code === 'PAYMENT_FAILED' ? 502 : 409);
    send(req, res, 'Purchase rejected', handoffPage(intent, token, { title: 'Purchase rejected', error: `${e.code} - ${e.message}` }));
  }
});

// ---- JSON API for a real agent ---------------------------------------------------------

const apiError = (res, e, next) =>
  e instanceof agent.AgentPurchaseError
    ? res.status(e.code === 'PAYMENT_FAILED' ? 502 : e.code === 'NOT_FOUND' ? 404 : 409).json({ error: e.code, message: e.message })
    : next(e);

router.post('/agent/api/intents', requireAuth, async (req, res, next) => {
  try {
    const { catalog, decisions } = req.app.locals.engine;
    const i = await agent.propose({
      userId: req.user.id, productId: req.body.productId, provider: req.body.provider || 'mock',
      agentName: req.body.agentName || 'api-agent', catalog, decisions,
    });
    res.status(201).json({ intentId: i.id, item: i.item_id, merchant: i.merchant, amountCents: i.amount_cents,
      currency: i.currency, status: i.status, approvalUrl: `/agent/intents/${i.id}` });
  } catch (e) { apiError(res, e, next); }
});

router.post('/agent/api/intents/:id/execute', requireAuth, async (req, res, next) => {
  try {
    const out = await agent.execute({
      intentId: req.params.id, token: req.body.token, userId: req.user.id,
      catalog: req.app.locals.engine.catalog, startPayment: paymentStarter(req),
    });
    res.json({ status: out.status, orderId: out.orderId, redirectUrl: out.redirectUrl || null });
  } catch (e) { apiError(res, e, next); }
});

module.exports = router;

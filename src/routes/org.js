'use strict';
// M4 enterprise seats: the organization page (buy seat packs, assign / unassign / reassign
// seats by member email, refund a pack) plus a read-only list of organizations for admins.
const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout, esc, money: amount, when } = require('../views');
const { PaymentService } = require('../payment/service');
const seats = require('../services/seats');
const checkoutOnce = require('../services/checkoutOnce');
const { randomUUID } = require('node:crypto');

// Seat prices are shown with a $ sign, like the course cards.
const money = (cents, cur = 'USD') => `$${amount(cents, cur)}`;
const err = (msg) => `<span class="err">${esc(msg)}</span>`;

// Only the organization's owner (the buyer) or a platform admin may manage it.
async function loadManagedOrg(req, orgId) {
  const org = orgId ? await seats.getOrg(orgId) : await seats.getOrgByOwner(req.user.id);
  if (!org) return null;
  if (org.owner_user_id !== req.user.id && !req.user.isAdmin) return null;
  return org;
}

async function loadManagedPool(req, poolId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(poolId))) return null; // a malformed id used to crash the server
  const p = await seats.getPool(poolId);
  if (!p) return null;
  if (p.owner_user_id !== req.user.id && !req.user.isAdmin) return null;
  return p;
}

// Answers an htmx action: reload the page on success, or show the reason in the form.
async function act(res, fn) {
  try {
    await fn();
    res.set('HX-Refresh', 'true').end();
  } catch (e) {
    if (e instanceof seats.SeatError) return res.send(err(e.message));
    console.error('[org] action failed:', e);
    res.status(500).send(err('Something went wrong. Check the server log.'));
  }
}

function courseOptions(catalog) {
  return catalog
    .list()
    .filter((c) => (c.type || 'COURSE') === 'COURSE')
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.title)} — $${Number(c.price).toFixed(2)} per seat</option>`)
    .join('');
}

function buyForm(catalog, { needsName }) {
  return `
  <form hx-post="/org/seats/checkout" hx-target="#buy-msg" hx-disabled-elt="find button[type=submit]" style="display:flex;flex-direction:column;gap:0.6rem;max-width:520px">
    <input type="hidden" name="checkoutKey" value="${randomUUID()}">
    ${needsName ? `<label>Organization name <input name="orgName" required maxlength="120" placeholder="e.g. Acme Data Team"></label>` : ''}
    <label>Course <select name="courseId" required>${courseOptions(catalog)}</select></label>
    <label>Seats <input name="seats" type="number" min="1" max="${seats.MAX_SEATS_PER_PACK}" value="5" required></label>
    <label>Payment provider
      <select name="provider"><option value="mock">Mock Payment (Instant)</option><option value="razorpay">Razorpay Gateway</option></select>
    </label>
    <button type="submit">Buy seats →</button>
    <div id="buy-msg" class="msg"></div>
    <small style="color:#5B5F6E">Price is seats × course price. Coupons don't apply to seat packs.</small>
  </form>`;
}

// A pack whose checkout was cancelled, failed or never paid: one muted line, nothing charged.
// (The pack row stays PENDING_PAYMENT: a payment that still arrives later activates it.)
const UNPAID = { CANCELLED: 'Payment cancelled', FAILED: 'Payment failed', EXPIRED: 'Not paid in time' };
// An unpaid checkout is only a short notice: shown for ORG_UNPAID_SHOW_SECONDS after it ended
// (default 120), and on the page it fades out after ORG_NOTICE_FADE_MS (default 6000). The pack row
// itself stays, so a payment that still arrives later activates it and it shows as a normal pack.
const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
const UNPAID_SHOW_MS = () => num('ORG_UNPAID_SHOW_SECONDS', 120) * 1000;
const NOTICE_FADE_MS = () => num('ORG_NOTICE_FADE_MS', 6000);
const isUnpaid = (p) => p.status === 'PENDING_PAYMENT' && Boolean(UNPAID[p.order_status]);
const recentlyEnded = (p) => Date.now() - new Date(p.order_updated_at || p.created_at).getTime() < UNPAID_SHOW_MS();

function poolCard(p, course) {
  if (isUnpaid(p)) {
    return `
  <div class="card org-notice" style="margin-bottom:1rem;opacity:0.7;padding:0.6rem 1rem">
    <small>${esc(course?.name || p.course_id)} · ${p.seats} seats · ${money(p.final_payable_cents)} via ${esc(p.provider)} · ${when(p.created_at)} ·
      <span class="err">${UNPAID[p.order_status]}</span>. Nothing was charged.</small>
  </div>`;
  }
  const used = p.assigned.length;
  const refundPending = p.order_status === 'REFUND_PENDING';
  const status =
    p.status === 'PENDING_PAYMENT' ? '<span style="color:#d29922">Waiting for payment</span>'
    : p.status === 'REVOKED' ? `<span class="err">${p.order_status === 'CHARGED_BACK' ? 'Charged back' : 'Refunded'}</span>`
    : refundPending ? '<span style="color:#d29922">⏳ Refund pending</span>'
    : '<span class="ok">Active</span>';
  const canAssign = p.status === 'ACTIVE' && !refundPending;
  const rows = p.assigned.map((s) => `
      <tr>
        <td>${esc(s.email)}</td><td><small>${when(s.occurred_at)}</small></td>
        <td>${canAssign ? `
          <form hx-post="/org/pools/${p.id}/seats/${esc(s.event_id)}/unassign" hx-target="#m-${esc(s.event_id)}" style="display:inline">
            <button class="alt" type="submit" style="padding:0.25rem 0.6rem;font-size:0.8rem">Unassign</button></form>
          <form hx-post="/org/pools/${p.id}/seats/${esc(s.event_id)}/reassign" hx-target="#m-${esc(s.event_id)}" style="display:inline-flex;gap:0.3rem;margin-left:0.3rem">
            <input name="email" type="email" required placeholder="new member email" style="width:12rem;font-size:0.8rem">
            <button class="alt" type="submit" style="padding:0.25rem 0.6rem;font-size:0.8rem">Reassign</button></form>
          <div id="m-${esc(s.event_id)}" class="msg"></div>` : ''}
        </td>
      </tr>`).join('');
  return `
  <div class="card" style="margin-bottom:1rem">
    <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:baseline">
      <h3 style="margin:0">${esc(course?.name || p.course_id)}</h3>
      <span>${status}</span>
    </div>
    <p style="margin:0.25rem 0 0.75rem;color:#5B5F6E">
      <strong>${used} of ${p.seats}</strong> seats in use · ${p.status === 'PENDING_PAYMENT' ? 'price' : 'paid'} ${money(p.final_payable_cents)} via ${esc(p.provider)} · ${p.status === 'PENDING_PAYMENT' ? 'ordered' : 'bought'} ${when(p.created_at)}
    </p>
    ${canAssign ? `
    <form hx-post="/org/pools/${p.id}/assign" hx-target="#a-${p.id}" style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <input name="email" type="email" required placeholder="member email" style="flex:1;min-width:12rem">
      <button type="submit" ${used >= p.seats ? 'disabled title="All seats are in use"' : ''}>Assign seat</button>
    </form>
    <div id="a-${p.id}" class="msg"></div>` : ''}
    ${rows ? `<table style="width:100%;margin-top:0.75rem;font-size:0.9rem"><thead><tr><th style="text-align:left">Member</th><th style="text-align:left">Since</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
           : p.status === 'ACTIVE' ? '<p style="color:#5B5F6E;margin-top:0.5rem">No seats assigned yet.</p>' : ''}
    ${p.status === 'ACTIVE' && !refundPending ? `
    <form hx-post="/org/pools/${p.id}/refund" hx-target="#r-${p.id}" style="margin-top:0.75rem">
      <button type="submit" style="background:#d32f2f;color:#fff">Refund this seat pack</button>
      <small style="color:#5B5F6E;margin-left:0.5rem">All ${used} assigned member(s) lose access once the provider confirms.</small>
    </form><div id="r-${p.id}" class="msg"></div>` : ''}
  </div>`;
}

// Result of a seat-pack checkout, shown once on /org (?checkout=paid|failed|cancelled).
const CHECKOUT_NOTES = {
  paid: ['ok', 'Payment received. Your new seats are below (they appear as soon as the provider confirms the payment).'],
  failed: ['err', 'The payment failed. Nothing was charged.'],
  cancelled: ['err', 'Payment cancelled. Nothing was charged.'],
};
const checkoutNote = (req) => {
  const n = CHECKOUT_NOTES[req.query.checkout];
  return n ? `<div class="card org-notice" style="border-left:4px solid ${n[0] === 'ok' ? '#2e7d32' : '#c62828'}"><p class="${n[0]}" style="margin:0">${n[1]}</p></div>` : '';
};

// Notices (checkout result, unpaid checkout lines) fade out and collapse after a few seconds;
// the ?checkout=... note is also taken out of the address bar so a reload doesn't repeat it.
const noticeScript = () => `<style>.org-notice{transition:opacity .6s ease,max-height .6s ease,margin .6s ease,padding .6s ease;overflow:hidden;max-height:20rem}
  .org-notice.gone{opacity:0!important;max-height:0;margin:0!important;padding-top:0!important;padding-bottom:0!important;border-width:0}</style>
<script>(function(){
  if (location.search.indexOf('checkout=') !== -1 && history.replaceState) history.replaceState(null, '', location.pathname);
  setTimeout(function(){
    document.querySelectorAll('.org-notice').forEach(function(el){ el.classList.add('gone'); setTimeout(function(){ el.remove(); }, 650); });
  }, ${NOTICE_FADE_MS()});
})();</script>`;

async function renderOrgPage(req, res, org) {
  const { catalog } = req.app.locals.engine;
  if (!org) {
    const body = `
      <h2>Organization</h2>
      ${checkoutNote(req)}
      <div class="card">
        <h3>Buy seats for your team</h3>
        <p style="color:#5B5F6E;margin-bottom:1rem">Create an organization and buy seats for a course. You can then give each seat to a teammate by email, take it back, or move it to someone else.</p>
        ${buyForm(catalog, { needsName: true })}
      </div>${noticeScript()}`;
    return res.send(layout('Organization', body, req.user));
  }
  const pools = await seats.listPools(org.id);
  const shown = pools.filter((p) => !isUnpaid(p) || recentlyEnded(p)); // old unpaid checkouts: not listed
  const isOwner = org.owner_user_id === req.user.id;
  const body = `
    <h2>${esc(org.name)}</h2>
    ${checkoutNote(req)}
    ${!isOwner ? '<p class="msg">You are viewing this organization as a platform admin.</p>' : ''}
    ${shown.map((p) => poolCard(p, catalog.get(p.course_id))).join('') || '<p>No seat packs yet.</p>'}
    ${isOwner ? `<div class="card"><h3>Buy more seats</h3>${buyForm(catalog, { needsName: false })}</div>` : ''}${noticeScript()}`;
  res.send(layout('Organization', body, req.user));
}

router.get('/org', requireAuth, async (req, res, next) => {
  try {
    await renderOrgPage(req, res, await seats.getOrgByOwner(req.user.id));
  } catch (e) {
    next(e);
  }
});

router.get('/org/:orgId([0-9a-f-]{36})', requireAuth, async (req, res, next) => {
  try {
    const org = await loadManagedOrg(req, req.params.orgId);
    if (!org) return res.redirect('/org');
    await renderOrgPage(req, res, org);
  } catch (e) {
    next(e);
  }
});

// Buy a seat pack: creates org (first time) + order + pool, then sends the buyer to pay.
router.post('/org/seats/checkout', requireAuth, async (req, res) => {
  try {
    const { catalog } = req.app.locals.engine;
    const b = req.body || {};
    const provider = b.provider === 'razorpay' ? 'razorpay' : 'mock';
    const course = catalog.get(String(b.courseId || ''));
    const checkoutKey = checkoutOnce.validKey(b.checkoutKey);
    const out = await seats.createSeatPackOrder({ userId: req.user.id, orgName: b.orgName, course, seats: b.seats, provider, checkoutKey });
    if (out.repeated) {
      // Same form submitted again (double click / retry): back to the first order's checkout.
      return checkoutOnce.sendRepeat(res, out.repeated, err);
    }
    const { redirectUrl } = await new PaymentService({ catalog }).initiatePayment({
      userId: req.user.id,
      productId: course.id,
      amount: out.amount,
      orderId: out.orderId,
      provider,
    });
    // back=org: after paying (or cancelling) on the provider's page the user returns to /org.
    const url = redirectUrl ? `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}back=org` : null;
    await checkoutOnce.rememberUrl(out.orderId, url);
    res.set('HX-Redirect', url || '/org').end();
  } catch (e) {
    if (e instanceof seats.SeatError) return res.send(err(e.message));
    console.error('[org] seat checkout failed:', e);
    res.status(500).send(err('Checkout failed. Nothing was charged. Please try again.'));
  }
});

router.post('/org/pools/:poolId/assign', requireAuth, async (req, res) => {
  const p = await loadManagedPool(req, req.params.poolId);
  if (!p) return res.status(404).send(err('Seat pack not found.'));
  await act(res, () =>
    seats.assignSeat({ ledger: req.app.locals.engine.ledger, poolId: p.id, email: req.body?.email, actor: `user:${req.user.id}` })
  );
});

router.post('/org/pools/:poolId/seats/:eventId/unassign', requireAuth, async (req, res) => {
  const p = await loadManagedPool(req, req.params.poolId);
  if (!p) return res.status(404).send(err('Seat pack not found.'));
  await act(res, () =>
    seats.unassignSeat({ ledger: req.app.locals.engine.ledger, poolId: p.id, assignmentEventId: req.params.eventId, actor: `user:${req.user.id}` })
  );
});

router.post('/org/pools/:poolId/seats/:eventId/reassign', requireAuth, async (req, res) => {
  const p = await loadManagedPool(req, req.params.poolId);
  if (!p) return res.status(404).send(err('Seat pack not found.'));
  await act(res, () =>
    seats.reassignSeat({
      ledger: req.app.locals.engine.ledger, poolId: p.id, assignmentEventId: req.params.eventId,
      email: req.body?.email, actor: `user:${req.user.id}`,
    })
  );
});

// Refund a whole seat pack. Like course refunds, this only asks the provider: the order is
// REFUND_PENDING until the provider's refund webhook arrives, which then unassigns every seat.
router.post('/org/pools/:poolId/refund', requireAuth, async (req, res) => {
  const p = await loadManagedPool(req, req.params.poolId);
  if (!p) return res.status(404).send(err('Seat pack not found.'));
  if (p.status !== 'ACTIVE' || !p.purchase_event_id) return res.send(err('Only a paid, active seat pack can be refunded.'));
  const { catalog, ledger } = req.app.locals.engine;
  const purchase = await ledger.getByEventId(p.purchase_event_id);
  const info = purchase?.paymentInfo || {};
  const claim = await pool.query(
    "UPDATE orders SET status='REFUND_PENDING', updated_at=now() WHERE id=$1 AND status='COMPLETED' RETURNING final_payable_cents, user_id",
    [p.order_id]
  );
  if (!claim.rows[0]) return res.send(err('A refund for this pack is already in progress or done.'));
  try {
    await new PaymentService({ catalog }).initiateRefund({
      userId: claim.rows[0].user_id,
      productId: p.course_id,
      orderId: p.order_id,
      amount: claim.rows[0].final_payable_cents / 100,
      providerPaymentId: info.providerPaymentId,
      provider: info.provider || 'mock',
    });
    res.set('HX-Refresh', 'true').end();
  } catch (e) {
    await pool.query("UPDATE orders SET status='COMPLETED', updated_at=now() WHERE id=$1 AND status='REFUND_PENDING'", [p.order_id]);
    const msg = e.message || e.error?.description || 'the payment provider refused the refund';
    console.error('[org] seat pack refund failed:', msg);
    res.send(err(`Refund failed: ${msg}`));
  }
});

// Admin: every organization, linking to its page.
router.get('/admin/orgs', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) return res.redirect('/courses');
  const orgs = await seats.listOrgs();
  const rows = orgs.map((o) => `
    <tr><td><a href="/org/${o.id}">${esc(o.name)}</a></td><td>${esc(o.owner_email)}</td><td>${o.packs}</td><td><small>${when(o.created_at)}</small></td></tr>`).join('');
  const body = `<h2>Organizations</h2><div class="card">${rows
    ? `<table style="width:100%"><thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Owner</th><th style="text-align:left">Seat packs</th><th style="text-align:left">Created</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No organizations yet.</p>'}</div>`;
  res.send(layout('Organizations', body, req.user));
});

module.exports = router;

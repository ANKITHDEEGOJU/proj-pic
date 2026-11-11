'use strict';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );

const money = (cents, cur = 'USD') => `${((cents || 0) / 100).toFixed(2)} ${esc(cur)}`;

const layout = (title, body, user, cartCount = 0) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · LEARNX</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Roboto:wght@400;500;700&display=swap');

  body {
    font-family:'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Courier New', monospace;;
    max-width: 850px;
    margin: 2rem auto;
    padding: 0 1.5rem;
    background: #F6F5F0;
    color: #1C1E26;
    line-height: 1.6;
  }
  
  h1, h2, h3, h4 { color: #2743D8; }
  
  nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2.5rem;
    background: #ffffff;
    padding: 1rem 1.5rem;
    border-radius: 12px;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
  }
  
  /* Make the logo stand out */
  nav strong {
    color: #2743D8;
    font-size: 1.5rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: -0.5px;
    margin-right: 1rem;
    text-transform: uppercase;
    text-shadow: 1px 1px 0 rgba(39,67,216,0.1);
  }
  
  nav a {
    color: #5B5F6E;
    margin-right: 1.5rem;
    text-decoration: none;
    font-weight: 500;
    transition: color 0.2s;
  }
  nav a:hover { color: #2743D8; }
  
  /* Inputs */
  input, select {
    padding: 0.8rem 1rem;
    margin: 0.5rem 0;
    border-radius: 8px;
    border: 1px solid rgba(91,95,110,0.3);
    background: #ffffff;
    color: #1C1E26;
    font-size: 1rem;
    font-family: 'Roboto', sans-serif;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);
  }
  input { width: 100%; box-sizing: border-box; }
  input:focus, select:focus {
    outline: none;
    border-color: #2743D8;
    box-shadow: 0 0 0 3px rgba(39,67,216,0.15);
  }
  
  /* Elevated 3D Buttons */
  button {
    padding: 0.75rem 1.5rem;
    margin: 0.5rem 0.5rem 0.5rem 0;
    border-radius: 8px;
    border: none;
    background: #2743D8;
    color: #ffffff;
    font-size: 1rem;
    font-weight: 500;
    font-family: 'Roboto', sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 0 #1A2D91, 0 5px 10px rgba(39,67,216,0.2);
    transform: translateY(-2px);
    transition: all 0.1s ease;
  }
  button:active {
    box-shadow: 0 0 0 #1A2D91, 0 2px 5px rgba(39,67,216,0.2);
    transform: translateY(2px);
  }
  button:disabled {
    background: #5B5F6E;
    box-shadow: 0 4px 0 #3e414c;
    cursor: not-allowed;
  }
  button:disabled:active {
    transform: translateY(-2px);
    box-shadow: 0 4px 0 #3e414c; 
  }
  
  /* Alt Button Styling */
  button.alt {
    background: #ffffff;
    color: #2743D8;
    border: 2px solid #2743D8;
    box-shadow: 0 4px 0 #1A2D91, 0 5px 10px rgba(0,0,0,0.05);
    padding: calc(0.75rem - 2px) calc(1.5rem - 2px);
  }
  button.alt:active {
    box-shadow: 0 0 0 #1A2D91;
    transform: translateY(2px);
  }
  
  /* Elevated Cards */
  .card {
    background: #ffffff;
    border: 1px solid rgba(91,95,110,0.15);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    box-shadow: 0 6px 12px -2px rgba(0,0,0,0.05);
  }
  .card h3 { margin-top: 0; margin-bottom: 1rem; }
  .card strong {
    font-family: 'JetBrains Mono', monospace;
    color: #1C1E26;
    font-size: 1.1rem;
    display: block;
    margin-bottom: 1.25rem;
  }
  
  /* Utilities & Text */
  .err { color: #d32f2f; font-weight: 500; }
  .ok { color: #2e7d32; font-weight: 500; }
  .msg { color: #5B5F6E; font-size: 0.9rem; margin-top: 0.75rem; }
  
  /* Tables */
  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    background: #ffffff;
    border-radius: 12px;
    margin-bottom: 2rem;
    box-shadow: 0 4px 6px rgba(0,0,0,0.03);
    overflow: hidden;
  }
  th {
    background: #f0f0f4;
    color: #5B5F6E;
    text-align: left;
    padding: 1rem;
    font-weight: 600;
    border-bottom: 2px solid rgba(91,95,110,0.1);
  }
  td {
    padding: 1rem;
    border-bottom: 1px solid rgba(91,95,110,0.1);
    color: #1C1E26;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
  }
</style></head><body>
<nav>
<span>
<strong style="font-family: 'monospace';"><i>LearnX</i></strong>
${user ? `<a href="/courses">Courses</a><a href="/activity">Activity</a>${user ? navCart(cartCount) : ''} ${user.isAdmin ? '<a href="/admin">Panel</a>' : ''}` : ''}</span>
${user ? `<span>${esc(user.email)} <button hx-post="/logout">Logout</button></span>` : ''}
</nav>
${body}</body></html>`;

const authForm = (kind) => `
<h2>${kind === 'login' ? 'Login' : 'Register'}</h2>
<form hx-post="/${kind}" hx-target="#msg">
  <input name="email" type="email" placeholder="email" required>
  <input name="password" type="password" placeholder="password (min 8)" required minlength="8">
  <button>${kind === 'login' ? 'Login' : 'Create account'}</button>
</form>
<div id="msg" class="err"></div>
<p>${kind === 'login' ? '<a href="/register">Need an account?</a>' : '<a href="/login">Have an account?</a>'}</p>`;

const FREE_GRANTS = ['MANUAL_GRANT', 'SEAT_ASSIGNED'];

const courseCard = (p, d, msg = '', pending = false, inCart = false) => {
  const s = esc(p.slug || p.id),
    id = `c-${s}`,
    t = `hx-target="#${id}" hx-swap="outerHTML"`;

  const priceVal = typeof p.price === 'number' ? p.price : ((p.priceCents || 0) / 100);
  const formattedPrice = priceVal.toFixed(2);
  const currencyStr = esc(p.currency || 'USD');

  const badge = d.allowed
    ? '<span class="ok">Owned</span>'
    : d.reason === 'PURCHASE_REFUNDED'
      ? '<span class="err">Refunded</span>'
      : d.reason === 'PURCHASE_CHARGED_BACK'
        ? '<span class="err">Charged back</span>'
        : d.reason === 'ACCESS_REVOKED' || d.reason === 'SEAT_UNASSIGNED'
          ? '<span class="err">Revoked</span>'
          : d.reason === 'SUBSCRIPTION_EXPIRED' || d.reason === 'ENTITLEMENT_EXPIRED'
            ? `<span class="err">Expired${d.expiresAt ? ' ' + esc(new Date(d.expiresAt).toLocaleDateString()) : ''}</span>`
            : '';

  const triggers = pending
    ? 'every 2s, cartUpdated from:body'
    : 'cartUpdated from:body';

  if (pending) {
    return `<div class="card" id="${id}"
  hx-get="/courses/${s}/card"
  hx-trigger="${triggers}"
  hx-swap="outerHTML">
  <h3>${esc(p.name || p.title)} <span style="color:#d29922">⏳ Refund pending…</span></h3>
  <strong>$${formattedPrice} ${currencyStr}</strong><br>
  <button disabled style="background:#5B5F6E">Refund pending</button>
  <button class="alt" disabled>Play</button>
  <div class="msg">Waiting for payment provider to confirm refund…</div>
</div>`;
  }

  return `<div class="card" id="${id}" hx-get="/courses/${s}/card" hx-trigger="cartUpdated from:body" hx-swap="outerHTML"><h3>${esc(p.name || p.title)} ${badge}</h3>
<strong>$${formattedPrice} ${currencyStr}</strong><br>
${
  d.allowed
    ? `${
        // Only a paid, directly bought course can be refunded from its own card.
        d.reason === 'ACTIVE_PURCHASE' && !FREE_GRANTS.includes(d.grantedVia)
          ? `<button hx-post="/courses/${s}/checkout/refund" ${t}>Refund</button>`
          : d.reason === 'ACTIVE_SUBSCRIPTION_PASS'
            ? '<small style="color:#2e7d32">Included in your All-Access Pass</small>'
            : '<small style="color:#2e7d32">Granted access (not refundable)</small>'
      } <button class="alt" hx-get="/courses/${s}/access" hx-target="#a-${s}">Access</button>
<div id="a-${s}" class="msg"></div><div class="msg">${esc(msg)}</div>`
    : (inCart
      ? `<a href="/cart" style="text-decoration:none"><button class="alt">In Cart · View Cart →</button></a>`
      : `<button hx-post="/cart/add" hx-vals='{"productId": "${s}"}' ${t}>Add to Cart</button>`)
      + (msg ? `<div class="msg">${esc(msg)}</div>` : '') // e.g. "Refund processed. Access revoked."
}
</div>`;
};

const subscriptionCard = (
  inCart = false,
  subPriceInfo = null,
  isSubActive = false,
  subEnt = null,
  opts = {} // { refundPending, message }
) => {
  const id = 'sub-card';
  const targetAttr = `hx-target="#${id}" hx-swap="outerHTML"`;

  const subProductId = esc(subPriceInfo?.productId || subPriceInfo?.id || 'sub_monthly');
  const planTitle = esc(subPriceInfo?.name || subPriceInfo?.title || 'LearnX All-Access Pass');
  const priceCents = subPriceInfo?.priceCents ?? 2999;
  const durationDays = subPriceInfo?.durationDays ?? 30;
  const currencyStr = esc(subPriceInfo?.currency || 'USD');
  const ruleName = subPriceInfo?.rule?.rule_name;
  const formattedPrice = (priceCents / 100).toFixed(2);

  // Active Subscription View (Post-Purchase)
  if (isSubActive) {
    const expStr = subEnt?.expiresAt
      ? new Date(subEnt.expiresAt).toLocaleDateString()
      : 'Lifetime';

    // Not refundable only when no period was paid for (all free grants).
    const isFree = subEnt?.refundableEventId === null || (subEnt?.refundableEventId === undefined && FREE_GRANTS.includes(subEnt?.grantedVia));
    const freeLabel = subEnt?.source === 'SCHOLARSHIP' ? 'Scholarship access' : 'Granted by admin';
    const action = isFree
      ? `<p style="margin-top:0.5rem;color:#33691e;font-size:0.85rem;">${freeLabel} &middot; not refundable</p>`
      : opts.refundPending
        ? `<button disabled style="margin-top:0.5rem;background:#5B5F6E;color:#fff;border:none;padding:0.5rem 1.2rem;border-radius:4px;">⏳ Refund pending…</button>
  <div style="font-size:0.85rem;color:#5B5F6E;">Waiting for the payment provider to confirm. Access stays until then.</div>`
        : `<form hx-post="/courses/${subProductId}/checkout/refund" ${targetAttr} style="margin-top: 0.5rem;">
    <button type="submit" style="background: #d32f2f; color: #ffffff; border: none; padding: 0.5rem 1.2rem; border-radius: 4px; font-weight: bold; cursor: pointer;">
      Refund Subscription
    </button>
  </form>`;
    const trigger = opts.refundPending ? 'every 2s, cartUpdated from:body' : 'cartUpdated from:body';

    return `
<div class="card" id="${id}" hx-get="/courses/subscription-banner" hx-trigger="${trigger}" hx-swap="outerHTML" style="border: 2px solid #2e7d32; background: #f1f8e9;">
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h3 style="margin-bottom: 0.25rem; color: #1b5e20;">✓ ${planTitle} (Active)</h3>
      <p style="color: #33691e; margin: 0 0 0.75rem 0; font-size: 0.9rem;">
        You have unlimited streaming access to all courses. Expires: <strong>${expStr}</strong>
      </p>
    </div>
    <span style="background: #2e7d32; color: #ffffff; padding: 0.25rem 0.6rem; border-radius: 6px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase;">
      Active Pass
    </span>
  </div>
  ${action}
  ${opts.message ? `<div style="font-size:0.85rem;color:#c62828;margin-top:0.4rem;">${esc(opts.message)}</div>` : ''}
</div>`;
  }

  const customBadge =
    ruleName && subPriceInfo?.rule?.application_mode === 'AUTOMATIC_IDENTITY'
      ? `<div style="color: #2e7d32; font-size: 0.85rem; font-weight: bold; margin-top: 0.25rem;">★ Special Plan Applied: ${esc(
          ruleName
        )}</div>`
      : '';

  // Standard Subscription View (Unpurchased)
  return `
<div class="card" id="${id}" hx-get="/courses/subscription-banner" hx-trigger="cartUpdated from:body" hx-swap="outerHTML" style="border: 2px solid #2743D8; background: #ffffff;">
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h3 style="margin-bottom: 0.25rem;">${planTitle}</h3>
      <p style="color: #5B5F6E; margin: 0 0 0.75rem 0; font-size: 0.9rem;">
        Unlimited streaming access to all current and future courses.
      </p>
      ${customBadge}
    </div>
    <span style="background: #2e3140; color: #ffffff; padding: 0.25rem 0.6rem; border-radius: 6px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase;">
      Best Value
    </span>
  </div>
  <strong style="font-size: 1.1rem; color: #111;">$${formattedPrice} ${currencyStr} / ${durationDays} days</strong><br><br>
  ${
    inCart
      ? `<a href="/cart" style="text-decoration: none;"><button class="alt">In Cart · View Cart →</button></a>
        <div class="msg ok">✓ Added to your cart</div>`
      : `<button hx-post="/cart/add" hx-vals='{"productId": "${subProductId}"}' ${targetAttr}>
          Add Subscription to Cart
        </button>`
  }
</div>`;
};
const navCart = (count) => `
  <a href="/cart" id="nav-cart" hx-get="/cart/count" hx-trigger="cartUpdated from:body" hx-swap="outerHTML">Cart (${count})</a>
`;

const accessFragment = (d) =>
  d.allowed
    ? `<span class="ok">▶ Allowed</span> · ${esc(d.reason)} · source: ${d.sourceEventIds.map(esc).join(', ')}`
    : `<span class="err">⛔ Denied</span> · ${esc(d.reason)}${d.sourceEventIds.length ? ' · source: ' + d.sourceEventIds.map(esc).join(', ') : ''}`;

const activityPage = (records, ents) => `<h2>Entitlements</h2>
<table><tr><th>Product / Scope</th><th>Status</th><th>Source Event</th><th>Granted</th><th>Expires</th></tr>
${
  ents
    .map((e) => {
      const expirationText = e.expiresAt ? new Date(e.expiresAt).toLocaleDateString() : 'Perpetual';
      const productOrScope = e.scope ? `${esc(e.productId || 'Subscription')} (${esc(e.scope)})` : esc(e.productId);
      return `<tr><td>${productOrScope}</td><td>${esc(e.status)}</td><td>${esc(e.sourceEventId)}</td><td>${esc(e.grantedAt || '')}</td><td>${esc(expirationText)}</td></tr>`;
    })
    .join('') || '<tr><td colspan="5">None</td></tr>'
}</table>
<h2>Ledger (append-only)</h2>
<table><tr><th>#</th><th>Type</th><th>Source</th><th>Product</th><th>Amount</th><th>Event</th><th>Refs</th></tr>
${
  records
    .map(
      (r) =>
        `<tr><td>${r.ledgerSequenceId}</td><td>${esc(r.event.eventType)}</td><td>${esc(r.event.source || 'PAYMENT')}${r.event.reason ? `<br><small>${esc(r.event.reason)}</small>` : ''}</td><td>${esc(r.event.productId)}</td><td>${(r.event.amount || 0).toFixed(2)} ${esc(r.event.currency || 'USD')}</td><td>${esc(r.event.eventId)}</td><td>${esc(r.event.referenceeventId || '')}</td></tr>`
    )
    .join('') || '<tr><td colspan="7">No events</td></tr>'
}</table>`;

const errorFragment = (msg) => `<span class="err">${esc(msg)}</span>`;

module.exports = {
  layout,
  authForm,
  courseCard,
  subscriptionCard,
  navCart,
  accessFragment,
  activityPage,
  errorFragment,
  esc,
};
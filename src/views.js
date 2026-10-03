const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (cents, cur) => `${(cents / 100).toFixed(2)} ${esc(cur)}`;

const layout = (title, body, user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · StreamFlix</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<style>
 body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}
 nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
 nav a{color:#9cf;margin-right:1rem}
 input,button{padding:.6rem;margin:.25rem 0;border-radius:6px;border:1px solid #444;background:#222;color:#eee}
 input{width:100%;box-sizing:border-box} button{cursor:pointer;background:#e50914;border:0}
 button.alt{background:#333}
 .card{border:1px solid #333;border-radius:8px;padding:1rem;margin-bottom:1rem}
 .err{color:#ff6b6b} .ok{color:#5fd38d} .msg{color:#ccc;font-size:.9rem;margin-top:.4rem}
 table{width:100%;border-collapse:collapse;font-size:.85rem;margin-bottom:1.5rem} td,th{border-bottom:1px solid #333;padding:.4rem;text-align:left}
</style></head><body>
<nav><span><strong>LearnX</strong> ${user ? '<a href="/courses">Courses</a><a href="/activity">Activity</a>' : ''}</span>
${user ? `<span>${esc(user.email)} <button hx-post="/logout">Logout</button></span>` : ''}</nav>
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

// One course card; `d` is the EntitlementDecision for this user. Swapped in place by HTMX.
const courseCard = (p, d, msg = '') => {
  const s = esc(p.id), id = `c-${s}`, t = `hx-target="#${id}" hx-swap="outerHTML"`;
  const badge = d.allowed ? '<span class="ok">Owned</span>'
    : d.reason === 'PURCHASE_REFUNDED' ? '<span class="err">Refunded</span>' : '';
  return `<div class="card" id="${id}"><h3>${esc(p.name)} ${badge}</h3>
<strong>${p.price.toFixed(2)} ${esc(p.currency)}</strong><br>
${d.allowed
  ? `<button hx-post="/courses/${s}/checkout/refund" ${t}>Refund</button>`
  : `<button hx-post="/courses/${s}/checkout" ${t}>Buy (mock checkout)</button>`}
<button class="alt" hx-get="/courses/${s}/access" hx-target="#a-${s}">Play</button>
<div id="a-${s}" class="msg"></div><div class="msg">${esc(msg)}</div></div>`;
};

const accessFragment = d => d.allowed
  ? `<span class="ok">▶ Allowed</span> · ${esc(d.reason)} · source: ${d.sourceEventIds.map(esc).join(', ')}`
  : `<span class="err">⛔ Denied</span> · ${esc(d.reason)}${d.sourceEventIds.length ? ' · source: ' + d.sourceEventIds.map(esc).join(', ') : ''}`;

const activityPage = (records, ents) => `<h2>Entitlements</h2>
<table><tr><th>Product</th><th>Status</th><th>Source event</th><th>Granted</th><th>Revoked</th></tr>
${ents.map(e => `<tr><td>${esc(e.productId)}</td><td>${esc(e.status)}</td><td>${esc(e.sourceEventId)}</td><td>${esc(e.grantedAt || '')}</td><td>${esc(e.revokedAt || '')}</td></tr>`).join('') || '<tr><td colspan="5">None</td></tr>'}</table>
<h2>Ledger (append-only)</h2>
<table><tr><th>#</th><th>Type</th><th>Product</th><th>Amount</th><th>Event</th><th>Refs</th></tr>
${records.map(r => `<tr><td>${r.ledgerSequenceId}</td><td>${esc(r.event.eventType)}</td><td>${esc(r.event.productId)}</td><td>${r.event.amount} ${esc(r.event.currency)}</td><td>${esc(r.event.eventId)}</td><td>${esc(r.event.referenceeventId || '')}</td></tr>`).join('') || '<tr><td colspan="6">No events</td></tr>'}</table>`;

const errorFragment = msg => `<span class="err">${esc(msg)}</span>`;

module.exports = { layout, authForm, courseCard, accessFragment, activityPage, errorFragment };
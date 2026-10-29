const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (cents, cur) => `${(cents / 100).toFixed(2)} ${esc(cur)}`;

const layout = (title, body, user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · StreamFlix</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Roboto:wght@400;500;700&display=swap');

  body {
    font-family:'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Courier New', monospace;;
    max-width: 800px;
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
<nav><span><strong style="font-family: 'monospace';"><i>LearnX</i></strong>${user ? '<a href="/courses">Courses</a><a href="/activity">Activity</a>' : ""}</span>
${user ? `<span>${esc(user.email)} <button hx-post="/logout">Logout</button></span>` : ""}</nav>
${body}</body></html>`;

const authForm = (kind) => `
<h2>${kind === "login" ? "Login" : "Register"}</h2>
<form hx-post="/${kind}" hx-target="#msg">
  <input name="email" type="email" placeholder="email" required>
  <input name="password" type="password" placeholder="password (min 8)" required minlength="8">
  <button>${kind === "login" ? "Login" : "Create account"}</button>
</form>
<div id="msg" class="err"></div>
<p>${kind === "login" ? '<a href="/register">Need an account?</a>' : '<a href="/login">Have an account?</a>'}</p>`;

// One course card; `d` is the EntitlementDecision for this user. Swapped in place by HTMX.
const courseCard = (p, d, msg = "", pending = false) => {
  const s = esc(p.id),
    id = `c-${s}`,
    t = `hx-target="#${id}" hx-swap="outerHTML"`;
  const badge = d.allowed
    ? '<span class="ok">Owned</span>'
    : d.reason === "PURCHASE_REFUNDED"
      ? '<span class="err">Refunded</span>'
      : "";

  // Pending state: Razorpay refund webhook not yet received.
  // Poll GET /courses/:slug/card every 2s. Server returns normal card once PURCHASE_REFUNDED,
  // which has no hx-trigger, so polling stops automatically.
  if (pending) {
    return `<div class="card" id="${id}"
  hx-get="/courses/${s}/card"
  hx-trigger="every 2s"
  hx-swap="outerHTML">
  <h3>${esc(p.name)} <span style="color:#d29922">⏳ Refund pending…</span></h3>
  <strong>${p.price.toFixed(2)} ${esc(p.currency)}</strong><br>
  <button disabled style="background:#5B5F6E">Refund pending</button>
  <button class="alt" disabled>Play</button>
  <div class="msg">Waiting for Razorpay to confirm the refund…</div>
</div>`;
  }

  return `<div class="card" id="${id}"><h3>${esc(p.name)} ${badge}</h3>
<strong>${p.price.toFixed(2)} ${esc(p.currency)}</strong><br>
${
  d.allowed
    ? `<button hx-post="/courses/${s}/checkout/refund" ${t}>Refund</button>`
    : `<form hx-post="/courses/${s}/checkout" ${t} style="display:inline">
       <select name="provider" style="margin-right:.4rem">
         <option value="mock">Mock Provider</option>
         <option value="razorpay">Razorpay</option>
       </select>
       <button type="submit">Buy</button>
     </form>`
}
<button class="alt" hx-get="/courses/${s}/access" hx-target="#a-${s}">Play</button>
<div id="a-${s}" class="msg"></div><div class="msg">${esc(msg)}</div></div>`;
};

const accessFragment = (d) =>
  d.allowed
    ? `<span class="ok">▶ Allowed</span> · ${esc(d.reason)} · source: ${d.sourceEventIds.map(esc).join(", ")}`
    : `<span class="err">⛔ Denied</span> · ${esc(d.reason)}${d.sourceEventIds.length ? " · source: " + d.sourceEventIds.map(esc).join(", ") : ""}`;

const activityPage = (records, ents) => `<h2>Entitlements</h2>
<table><tr><th>Product</th><th>Status</th><th>Source event</th><th>Granted</th><th>Revoked</th></tr>
${ents.map((e) => `<tr><td>${esc(e.productId)}</td><td>${esc(e.status)}</td><td>${esc(e.sourceEventId)}</td><td>${esc(e.grantedAt || "")}</td><td>${esc(e.revokedAt || "")}</td></tr>`).join("") || '<tr><td colspan="5">None</td></tr>'}</table>
<h2>Ledger (append-only)</h2>
<table><tr><th>#</th><th>Type</th><th>Product</th><th>Amount</th><th>Event</th><th>Refs</th></tr>
${records.map((r) => `<tr><td>${r.ledgerSequenceId}</td><td>${esc(r.event.eventType)}</td><td>${esc(r.event.productId)}</td><td>${r.event.amount} ${esc(r.event.currency)}</td><td>${esc(r.event.eventId)}</td><td>${esc(r.event.referenceeventId || "")}</td></tr>`).join("") || '<tr><td colspan="6">No events</td></tr>'}</table>`;

const errorFragment = (msg) => `<span class="err">${esc(msg)}</span>`;

module.exports = {
  layout,
  authForm,
  courseCard,
  accessFragment,
  activityPage,
  errorFragment,
};
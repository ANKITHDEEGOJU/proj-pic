const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (cents, cur) => `${(cents / 100).toFixed(2)} ${esc(cur)}`;

const layout = (title, body, user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · StreamFlix</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}
nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
input,button{padding:.6rem;margin:.25rem 0;border-radius:6px;border:1px solid #444;background:#222;color:#eee}
input{width:100%;box-sizing:border-box} button{cursor:pointer;background:#e50914;border:0}
button:disabled{background:#444;cursor:not-allowed}
.card{border:1px solid #333;border-radius:8px;padding:1rem;margin-bottom:1rem}
.err{color:#ff6b6b}
</style></head><body>
<nav><strong>StreamFlix</strong>
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

const courseCards = courses => courses.map(c => `
<div class="card"><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p>
<strong>${money(c.price_cents, c.currency)}</strong>
<button disabled title="Payments arrive in the next step">Buy</button></div>`).join('');

const errorFragment = msg => `<span class="err">${esc(msg)}</span>`;

module.exports = { layout, authForm, courseCards, errorFragment };

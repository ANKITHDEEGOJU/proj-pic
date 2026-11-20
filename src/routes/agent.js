'use strict';
// M7: agent-approved purchases, made by LEARNX Assistant (a real AI agent: Groq / Gemini, see
// services/assistant.js). The purchase rules themselves are in services/agentPurchase.js.
//
// Pages (login session only):
//   GET  /agent                        assistant chat + your purchase requests
//   GET  /agent/intents/:id            one request with its history: Approve / Cancel
//   POST /agent/intents/:id/approve    password step-up above AGENT_STEPUP_ABOVE_CENTS; then the
//                                      assistant is asked to complete the purchase
//   POST /agent/intents/:id/cancel
// Chat (htmx fragments appended to the chat log; always HTTP 200, htmx doesn't swap errors):
//   POST /assistant/chat               form: message
//   POST /assistant/approve/:id        Approve button on a purchase card (+ password above the threshold)
//   POST /assistant/continue/:id       "Complete purchase" button on an approved card
//   POST /assistant/cancel/:id         Cancel button on a card
//   POST /assistant/coupon/:id         coupon field on a card (apply / remove, only before approval)
//   GET  /assistant/pay/:id            "Pay with Razorpay" on a card: the request's checkout link
//   GET  /assistant/card/:id           one card (cards waiting for payment refresh themselves with it)
//   GET  /assistant/checkout-closed    Razorpay checkout closed without paying: cancels that payment
//   POST /assistant/cancel-payment/:id "Cancel payment" on a card waiting for payment (same effect)
//   POST /assistant/clear              forget the conversation
//
// Purchase cards are drawn by the server from the request's current state in the database, never
// from the model's text, so the model can't fake a button or a price.

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('../services/rateLimit');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout, esc, money, when } = require('../views');
const agent = require('../services/agentPurchase');
const assistant = require('../services/assistant');
const { PaymentService } = require('../payment/service');
const { getAdapter } = require('../payment/registry');

const amountLabel = (i) => money(i.amount_cents, i.currency);
// Price with its coupon: "<s>50.00</s> 40.00 USD (coupon SAVE10)", or just the amount.
const priceLabel = (i) => i.coupon_code
  ? `<s style="color:#5B5F6E">${money(i.list_amount_cents ?? i.amount_cents, i.currency)}</s> ${amountLabel(i)} <small>(coupon <code>${esc(i.coupon_code)}</code>)</small>`
  : amountLabel(i);
// The amount the user sees when clicking Approve: approving is refused if the price changed since.
const seenAmount = (i) => `<input type="hidden" name="amount" value="${Number(i.amount_cents)}">`;
// Coupon on a request that is still waiting for approval: Apply a code, or Remove the one applied.
const couponForm = (i) => i.coupon_code
  ? chatForm(`/assistant/coupon/${i.id}`, `<input type="hidden" name="coupon" value=""><small>Coupon <code>${esc(i.coupon_code)}</code>: -${money(i.discount_cents || 0, i.currency)}</small>
      <button type="submit" class="alt" style="padding:0.15rem 0.6rem;font-size:0.8rem;margin-left:0.3rem">Remove</button>`, 'display:block;margin:0 0 0.5rem 0')
  : chatForm(`/assistant/coupon/${i.id}`, `<input name="coupon" maxlength="40" placeholder="Coupon code (optional)" autocomplete="off" style="max-width:12rem;margin:0 0.3rem 0 0;padding:0.25rem 0.5rem;font-size:0.85rem">
      <button type="submit" class="alt" style="padding:0.2rem 0.7rem;font-size:0.85rem">Apply</button>`, 'display:block;margin:0 0 0.5rem 0');
const PROVIDER_LABEL = { razorpay: 'Razorpay (test mode)', mock: 'Mock provider' };
const payLabel = (i) => esc(PROVIDER_LABEL[i.provider] || i.provider);
const STATUS_COLOR = {
  PROPOSED: '#8a4b00', APPROVED: '#2743D8', EXECUTED: '#2e7d32', CANCELLED: '#5B5F6E', FAILED: '#d32f2f', EXPIRED: '#5B5F6E',
  PAID: '#2e7d32', PENDING: '#8a4b00', REFUNDED: '#5B5F6E', REFUND_PENDING: '#8a4b00', CHARGED_BACK: '#d32f2f', REFUND_FAILED: '#d32f2f',
};
const badge = (s) => (s ? `<b style="color:${STATUS_COLOR[s] || '#1C1E26'}">${esc(s)}</b>` : '');
const STEPUP_ABOVE = () => {
  const v = process.env.AGENT_STEPUP_ABOVE_CENTS;
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? 3000 : Number(v);
};
const needsStepUp = (i) => i.amount_cents > STEPUP_ABOVE();
const ttlMinutes = () => Math.round(Number(process.env.AGENT_APPROVAL_TTL_SECONDS || 300) / 60);
const userCtx = (req) => ({ actor: 'user', ip: req.ip });
const CARD_DONE_MS = () => Math.max(0, Number(process.env.ASSISTANT_CARD_DONE_MS ?? 5000) || 0);
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));

function courseName(catalog, id) {
  const c = agent.findCourse(catalog, id);
  return c ? c.name || c.slug || c.id : id;
}

// Starts the payment for an executed intent: the provider's checkout page (Razorpay, or the mock
// provider's Pay / Simulate Failure / Cancel page) for the approved amount. The user pays there
// with the card's Pay button, as with any purchase; nothing is charged server-side.
// back=agent brings the user back to the chat. Tests may replace it with app.locals.agentStartPayment.
function paymentStarter(req) {
  if (req.app.locals.agentStartPayment) return req.app.locals.agentStartPayment;
  const { catalog } = req.app.locals.engine;
  return async ({ intent, orderId }) => {
    const svc = new PaymentService({ catalog });
    const amount = intent.amount_cents / 100;
    const { redirectUrl } = await svc.initiatePayment({
      userId: intent.user_id, productId: intent.item_id, amount, orderId, provider: intent.provider,
    });
    return { status: 'CHECKOUT', redirectUrl: redirectUrl && `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}back=agent` };
  };
}

// ---- chat rendering ------------------------------------------------------------------------

// Assistant text -> safe HTML: escaped first, then **bold**, [label](link) and bare app/http
// links become anchors (only http(s) and same-site paths), newlines become <br>.
function renderText(t) {
  // Request ids mean nothing to the user (the cards have the buttons): drop them, with any "(intent ID ...)" around them.
  t = String(t || '').replace(/\s*\((?:[a-z ]*id[: ]*)?[0-9a-f]{8}[\u2010-\u2011-][0-9a-f-\u2010\u2011]{27}\)/gi, '')
    .replace(/ ?[0-9a-f]{8}[\u2010\u2011-][0-9a-f\u2010\u2011-]{27}/gi, '');
  let out = mdTables(esc(t));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/(^|[\s(])((?:https?:\/\/[^\s<)]+)|(?:\/(?:agent|razorpay|courses|cart|library)[^\s<,)]*))/g,
    (m, pre, url) => `${pre}<a href="${url.replace(/[.]$/, '')}">${url.replace(/[.]$/, '')}</a>${url.endsWith('.') ? '.' : ''}`);
  return out.replace(/\n/g, '<br>').replace(/<br>(<table|<\/table>)/g, '$1').replace(/(<\/table>)<br>/g, '$1');
}

// Simple Markdown tables (| a | b | rows with a |---| separator) -> <table>. Input is already escaped.
function mdTables(text) {
  return text.replace(/(^|\n)(\|[^\n]*\|)\n\|[\s:|-]+\|\n((?:\|[^\n]*\|(?:\n|$))+)/g, (m, pre, head, body) => {
    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const th = cells(head).map((c) => `<th>${c}</th>`).join('');
    const trs = body.trim().split('\n').map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `${pre}<table style="margin:0.3rem 0;font-size:0.9rem"><tr>${th}</tr>${trs}</table>\n`;
  });
}

const bubble = (who, html) => who === 'user'
  ? `<div style="margin:0.6rem 0;text-align:right"><span style="display:inline-block;background:#2743D8;color:#fff;padding:0.45rem 0.75rem;border-radius:10px;max-width:85%;text-align:left;overflow-wrap:anywhere">${html}</span></div>`
  : `<div style="margin:0.6rem 0"><span style="display:inline-block;background:#F1F2F6;padding:0.45rem 0.75rem;border-radius:10px;max-width:85%;overflow-wrap:anywhere">${html}</span></div>`;

// An outcome line written by the app (paid / failed / cancelled), see assistant.noteOutcomes.
const noteBubble = (tone, text) => bubble('assistant', `<span class="${tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : 'msg'}">${esc(text)}</span>`);

// The message the Approve / Complete buttons send to the assistant on the user's behalf.
const approvedText = (id) => `I approved purchase request ${id}. Please complete it now.`;
const APPROVED_RE = /^I approved purchase request ([0-9a-f-]{36})\. Please complete it now\.$/;

const chatForm = (action, inner, style = 'display:inline;margin:0') =>
  `<form hx-post="${action}" hx-target="#chat-log" hx-swap="beforeend" hx-indicator="#chat-wait" hx-on::after-request="scrollChat()" style="${style}">${inner}</form>`;

// How to pay, chosen by the user before approving (preselected: the request's provider).
const providerChoice = (i) => `<div style="margin-bottom:0.5rem">Pay with:
  ${['razorpay', 'mock'].map((p) => `<label style="display:inline-flex;align-items:center;gap:0.3rem;margin-right:1rem;font-weight:normal">
    <input type="radio" name="provider" value="${p}"${i.provider === p ? ' checked' : ''} style="width:auto;margin:0">${esc(PROVIDER_LABEL[p])}</label>`).join('')}
</div>`;

// A purchase request as a card with the buttons that fit its current state.
const cardState = (i) => `${i.status}.${agent.paymentState(i) || '-'}`;

function purchaseCard(catalog, i, { error = '', oob = false } = {}) {
  const pay = agent.paymentState(i);
  let actions = '';
  if (i.status === 'PROPOSED') {
    actions = couponForm(i) + chatForm(`/assistant/approve/${i.id}`, `${seenAmount(i)}${providerChoice(i)}${needsStepUp(i)
      ? `<input type="password" name="password" autocomplete="new-password" placeholder="Your password (over ${money(STEPUP_ABOVE(), i.currency)})" required style="max-width:15rem;margin-right:0.4rem">` : ''}
      <button type="submit">Approve ${amountLabel(i)}</button>`) + ' ' +
      chatForm(`/assistant/cancel/${i.id}`, '<button type="submit" class="alt">Cancel</button>');
  } else if (i.status === 'APPROVED') {
    actions = chatForm(`/assistant/continue/${i.id}`, '<button type="submit">Complete purchase</button>') + ' ' +
      chatForm(`/assistant/cancel/${i.id}`, '<button type="submit" class="alt">Cancel</button>');
  } else if (i.status === 'EXECUTED' && pay === 'PENDING') {
    actions = `<a href="/assistant/pay/${i.id}" style="text-decoration:none"><button type="button">Pay ${amountLabel(i)} with ${i.provider === 'razorpay' ? 'Razorpay' : 'Mock provider'}</button></a>
         ${chatForm(`/assistant/cancel-payment/${i.id}`, '<button type="submit" class="alt">Cancel payment</button>')}
         <div class="msg" style="margin-top:0.3rem">${i.provider === 'razorpay'
           ? 'Test card 5267 3181 8797 5449, any future expiry, any CVV, any OTP.'
           : 'Opens the mock checkout: Pay, Simulate Failure or Cancel. The card updates when the payment result arrives.'}</div>`;
  } else if (pay === 'PAID') {
    actions = '<span class="ok">Paid. The course is in your library.</span> <a href="/courses">Go to Courses</a>';
  } else if (pay === 'FAILED') {
    actions = '<span class="err">Payment failed. Nothing was charged.</span> <span class="msg">Ask the assistant to buy it again.</span>';
  } else if (pay === 'UNDERPAID') {
    actions = '<span class="err">The payment did not match the price, so the course was not unlocked.</span> <span class="msg">The support team will review it.</span>';
  } else if (pay === 'CANCELLED') {
    actions = '<span class="err">Payment cancelled at checkout. Nothing was charged.</span> <span class="msg">Ask the assistant to buy it again.</span>';
  } else if (pay === 'UNPAID' || (i.status === 'FAILED' && pay === 'PENDING')) {
    actions = '<span class="err">Not paid in time. Nothing was charged.</span> <span class="msg">Ask the assistant to buy it again.</span>';
  } else if (i.status === 'FAILED') {
    actions = `<span class="err">${esc(i.failure_reason || 'The purchase failed.')}</span>`;
  } else if (i.status === 'EXPIRED') {
    actions = '<span class="msg">Not approved in time.</span>';
  }
  // While the payment is pending the card refreshes itself, so Paid / Failed shows without a reload.
  // The poll sends the state it shows; the server answers 204 (nothing to swap) while it is unchanged,
  // so the Pay button isn't replaced under the user's mouse every few seconds.
  const poll = i.status === 'EXECUTED' && pay === 'PENDING'
    ? ` hx-get="/assistant/card/${i.id}?shown=${cardState(i)}" hx-trigger="every 4s" hx-swap="outerHTML"` : '';
  const done = !assistant.isOpenRequest(i);
  return `<div id="pc-${i.id}"${done ? ' class="pc-done"' : ''}${oob ? ' hx-swap-oob="true"' : ''}${poll} style="margin:0 0 0.6rem 0;padding:0.6rem 0.8rem;border:1px solid #D7DAE5;border-radius:8px;background:#fff">
  <div style="display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap">
    <span><b>${esc(courseName(catalog, i.item_id))}</b> · ${priceLabel(i)}${i.status === 'PROPOSED' ? '' : ` · ${payLabel(i)}`}</span>
    <span>${badge(i.status)}${pay ? ` · ${badge(pay)}` : ''} · <a href="/agent/intents/${i.id}">details</a></span>
  </div>
  ${error ? `<div class="err" style="margin-top:0.4rem">${esc(error)}</div>` : ''}
  ${actions ? `<div style="margin-top:0.5rem">${actions}</div>` : ''}
</div>`;
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Stored chat -> { log, cards }. log: the messages (tool calls and results are not shown).
// cards: one purchase card per open request the assistant proposed, in the order proposed,
// drawn from the request's current state. Cards are shown in their own area below all messages,
// so the buttons (Approve / Pay) are always at the bottom of the chat.
async function chatHtml(catalog, userId, rows) {
  const results = rows.filter((r) => r.message.role === 'tool').map((r) => parseJson(r.message.content)).filter(Boolean);
  const ids = [...new Set(results.filter((x) => x.card && isUuid(x.intentId)).map((x) => x.intentId))];
  const intents = new Map();
  for (const id of ids) {
    const i = await agent.getIntent(id);
    if (i && i.user_id === userId) intents.set(id, i);
  }
  const log = rows.map(({ message: m }) => {
    if (m.role === 'user') {
      const ap = APPROVED_RE.exec(m.content || '');
      return bubble('user', ap ? `Approved ${esc(intents.has(ap[1]) ? courseName(catalog, intents.get(ap[1]).item_id) : 'the purchase')}` : esc(m.content));
    }
    if (m.role === 'assistant' && m.note) return noteBubble(m.tone || 'ok', m.content); // written by the app
    if (m.role === 'assistant' && m.content) return bubble('assistant', renderText(assistant.cleanReply(m.content))); // older rows may be uncleaned
    return '';
  }).join('');
  // Finished requests have no card: their outcome line (noteOutcomes) is in the log instead.
  const cards = [...intents.values()].filter(assistant.isOpenRequest).map((i) => purchaseCard(catalog, i)).join('');
  return { log, cards };
}

// One assistant turn as a fragment for the chat log: the user's line and the reply. A new
// proposal's card is added to the card area below the messages, and an executed purchase
// updates its card in place (both as htmx out-of-band swaps).
async function turnHtml(catalog, userLine, out) {
  let cards = '';
  for (const st of out.steps) {
    const id = st.result?.intentId;
    if (st.ok && isUuid(id) && (st.result.card || st.tool === 'execute_purchase')) {
      const i = await agent.getIntent(id);
      if (!i) continue;
      cards += st.result.card
        ? `<div hx-swap-oob="beforeend:#chat-cards">${purchaseCard(catalog, i)}</div>`
        : purchaseCard(catalog, i, { oob: true });
    }
  }
  return userLine + bubble('assistant', renderText(out.reply)) + cards;
}

// A card's live update (poll, button). If the request just finished, its outcome line is
// written to the chat and appended to the log in the same response; the card shows the final
// state for a few seconds and is then removed by the page script (class pc-done).
// inLog: the response itself is appended to #chat-log (the card buttons), so the line is plain
// content at its end. htmx applies out-of-band parts before the main content, so an
// out-of-band line would land above the messages of the same response.
async function cardUpdate(req, i, { inLog = false, ...opts } = {}) {
  const { catalog } = req.app.locals.engine;
  const card = purchaseCard(catalog, i, opts);
  if (assistant.isOpenRequest(i)) return card;
  // Written once; but every page that sees the card finish gets the line (two open /agent tabs
  // both show it; each page receives a finished card only once, since polling then stops).
  await assistant.noteOutcomes(req.user.id, (id) => courseName(catalog, id), i.id);
  const note = await assistant.outcomeNote(req.user.id, i.id);
  if (!note) return card;
  const line = noteBubble(note.tone, note.content);
  return card + (inLog ? line : `<div hx-swap-oob="beforeend:#chat-log">${line}</div>`);
}

function assistantCard(chat = { log: '', cards: '' }) {
  const ready = assistant.isConfigured();
  return `<div class="card">
  <h3>LEARNX Assistant <small style="font-weight:normal">(AI agent${ready ? `, ${esc(assistant.providers().map((p) => p.name[0].toUpperCase() + p.name.slice(1)).join(' with fallback to '))}` : ''})</small></h3>
  <p><small>Tell the assistant what you want. It looks up courses and <em>proposes</em> a purchase at the catalog price (minus a coupon, if you give it one or enter one on the card);
  you approve it with the button on the card; then it completes the purchase. It can't approve or change a price.</small></p>
  ${ready ? '' : '<p class="err">Not set up: put GROQ_API_KEY (free at console.groq.com) in .env and restart the app.</p>'}
  <div id="chat-log" style="max-height:420px;overflow-y:auto;overflow-x:hidden;border:1px solid #E3E5EC;border-radius:8px;padding:0.5rem 0.75rem;margin-bottom:0.75rem">${chat.log
    || '<p class="msg" style="margin:0">Try: <em>"Which courses can I buy?"</em> or <em>"Buy me the SQL course"</em>.</p>'}</div>
  <div id="chat-cards">${chat.cards}</div>
  ${chatForm('/assistant/chat', `<input name="message" maxlength="1000" placeholder="Ask the assistant to find or buy a course…" autocomplete="off" required style="flex:1"${ready ? '' : ' disabled'}>
    <button type="submit"${ready ? '' : ' disabled'}>Send</button>`, 'display:flex;gap:0.5rem;margin:0').replace('hx-on::after-request="scrollChat()"', 'hx-on::after-request="this.reset(); scrollChat()"')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem">
    <small id="chat-wait" class="htmx-indicator">Assistant is working…</small>
    <form method="POST" action="/assistant/clear" style="margin:0"><button type="submit" class="alt" style="font-size:0.8rem;padding:0.2rem 0.6rem">Clear chat</button></form>
  </div>
</div>
<style>
  #chat-cards > div { transition: opacity .5s ease, max-height .5s ease, margin .5s ease, padding .5s ease, border-width .5s ease; max-height: 600px; overflow: hidden; }
  #chat-cards > div.pc-gone { opacity: 0; max-height: 0; margin: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; border-width: 0 !important; }
</style>
<script>
function scrollChat(){const l=document.getElementById('chat-log'); if(l) l.scrollTop=l.scrollHeight;}
scrollChat();
// A finished card (paid / failed / cancelled) keeps its final state on screen for a few seconds,
// then fades and collapses (no jump in the layout) and is removed. Its outcome line stays in the log.
(function(){
  const cards = document.getElementById('chat-cards'), log = document.getElementById('chat-log');
  if (!cards) return;
  const retire = () => cards.querySelectorAll(':scope > .pc-done:not([data-retiring])').forEach((c) => {
    c.setAttribute('data-retiring', '1');
    setTimeout(() => { c.classList.add('pc-gone'); setTimeout(() => c.remove(), 600); }, ${CARD_DONE_MS()});
  });
  // htmx swaps a card in with its old attributes and sets the new class ~20 ms later (settle),
  // so class changes are watched too, not only added cards.
  new MutationObserver(retire).observe(cards, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  if (log) new MutationObserver(scrollChat).observe(log, { childList: true });
  retire();
})();
</script>`;
}

// ---- pages ------------------------------------------------------------------------------

function agentPage(req, intents, chat, { message = '', error = '' } = {}) {
  const { catalog } = req.app.locals.engine;
  const rows = intents
    .map((i) => `<tr><td>${when(i.created_at)}</td><td>${esc(courseName(catalog, i.item_id))}</td>
        <td>${amountLabel(i)}</td><td>${payLabel(i)}</td><td>${badge(i.status)}</td><td>${badge(agent.paymentState(i)) || ''}</td>
        <td><a href="/agent/intents/${i.id}">Details</a>${i.status === 'FAILED' ? `<br><small>${esc(i.failure_reason || '')}</small>` : ''}</td></tr>`)
    .join('');
  return `<h2>Agent purchases</h2>
${message ? `<p class="ok">${esc(message)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}
${assistantCard(chat)}
<h3>Your purchase requests</h3>
<table><tr><th>Created</th><th>Item</th><th>Amount</th><th>Payment via</th><th>Request</th><th>Payment</th><th></th></tr>
${rows || '<tr><td colspan="7">None yet</td></tr>'}</table>`;
}

function historyTable(events) {
  if (!events.length) return '';
  const rows = events
    .map((e) => `<tr><td>${when(e.created_at)}</td><td>${esc(e.actor)}</td><td>${e.event === 'REJECTED' || e.event === 'APPROVE_DENIED' ? `<b style="color:#d32f2f">${esc(e.event)}</b>` : esc(e.event)}</td>
      <td>${e.code ? `<code>${esc(e.code)}</code> ` : ''}${esc(e.detail || '')}</td></tr>`)
    .join('');
  return `<h3>History</h3><table><tr><th>Time</th><th>By</th><th>Event</th><th>Details</th></tr>${rows}</table>`;
}

function reviewPage(req, i, events, { error = '' } = {}) {
  const { catalog } = req.app.locals.engine;
  const open = i.status === 'PROPOSED' || i.status === 'APPROVED';
  const pay = agent.paymentState(i);
  const stepUp = i.status === 'PROPOSED' && needsStepUp(i);
  return `<h2>Purchase request</h2>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<div class="card">
  <p>The agent <code>${esc(i.agent_name)}</code> wants to buy this for you:</p>
  <table>
    <tr><th>Item</th><td>${esc(courseName(catalog, i.item_id))} (<code>${esc(i.item_id)}</code>)</td></tr>
    <tr><th>Merchant</th><td>${esc(i.merchant)}</td></tr>
    <tr><th>Amount</th><td><b>${priceLabel(i)}</b>${i.coupon_code ? ` <small>(list price minus ${money(i.discount_cents || 0, i.currency)})</small>` : ''}</td></tr>
    <tr><th>Payment</th><td>${payLabel(i)}${pay ? ` · ${badge(pay)}` : ''}</td></tr>
    <tr><th>Status</th><td>${badge(i.status)}${i.expires_at && i.status === 'APPROVED' ? ` · approval valid until ${esc(new Date(i.expires_at).toLocaleTimeString())}` : ''}
      ${i.failure_reason ? `<br><small>${esc(i.failure_reason)}</small>` : ''}</td></tr>
  </table>
  ${i.status === 'PROPOSED' ? `<form method="POST" action="/agent/intents/${i.id}/approve" style="display:inline">
    ${seenAmount(i)}${providerChoice(i)}${stepUp ? `<label>Amount is over ${money(STEPUP_ABOVE(), i.currency)}: enter your password to approve
      <input type="password" name="password" autocomplete="new-password" required></label>` : ''}
    <button type="submit">Approve this purchase</button></form>` : ''}
  ${open ? `<form method="POST" action="/agent/intents/${i.id}/cancel" style="display:inline"><button type="submit" class="alt">Cancel</button></form>` : ''}
</div>
${historyTable(events)}
<p><a href="/agent">Back to the assistant</a></p>`;
}

// ---- routes -------------------------------------------------------------------------------

const send = (req, res, title, body) => res.send(layout(title, body, req.user));
const showAgentPage = async (req, res, opts = {}) => {
  res.set('Cache-Control', 'no-store');
  const { catalog } = req.app.locals.engine;
  await assistant.noteOutcomes(req.user.id, (id) => courseName(catalog, id)); // "Payment received" / failed lines
  const chat = await chatHtml(catalog, req.user.id, await assistant.listMessages(req.user.id));
  send(req, res, 'Agent purchases', agentPage(req, await agent.listIntents(req.user.id), chat, opts));
};

const NOTICE = {
  NOT_CONFIGURED: 'The assistant is not set up: put GROQ_API_KEY in .env and restart the app.',
  RATE_LIMITED: "You reached today's limit of assistant messages.",
  MODEL_BUSY: 'The AI model is busy (rate limit). Try again in a minute.',
  PAY_LINK: 'The payment link for that purchase could not be found. It will expire on its own; then ask the assistant again.',
};

router.get('/agent', requireAuth, async (req, res, next) => {
  try { await showAgentPage(req, res, NOTICE[req.query.e] ? { error: NOTICE[req.query.e] } : {}); } catch (e) { next(e); }
});

const ownIntent = async (req) => {
  const i = await agent.getIntent(req.params.id);
  return i && i.user_id === req.user.id ? i : null;
};

// The provider the user picked on the card / request page (only before approval).
async function applyProviderChoice(req, i) {
  const p = req.body.provider;
  if (i.status !== 'PROPOSED' || !p || p === i.provider) return i;
  return agent.setProvider({ intentId: i.id, userId: req.user.id, provider: String(p), ctx: userCtx(req) });
}

// What approving must still hold at the moment of the database update: the amount the user saw
// (required; a form without it is refused as out of date) and, when no password was checked, that
// the amount is still below the password threshold (a coupon removed in another tab can't slip a
// bigger amount through without the password).
const approveGuards = (req, i) => ({
  expectAmountCents: req.body.amount === undefined || req.body.amount === '' ? 'missing' : req.body.amount,
  noPasswordMaxCents: needsStepUp(i) ? null : STEPUP_ABOVE(),
});

// Step-up check for approving. Returns an error message, or null when approving may go ahead.
async function stepUpError(req, i) {
  if (i.status !== 'PROPOSED' || !needsStepUp(i)) return null;
  // STEPUP_MAX_FAILS attempts per user per window, counted before the password is checked (so
  // parallel requests get no extra guesses); a correct password clears the count.
  const limited = rateLimit.hit('stepUpFail', req.user.id);
  if (limited.blocked) {
    await agent.approveDenied({ intentId: i.id, userId: req.user.id, code: 'STEP_UP_LOCKED', message: 'Too many wrong passwords', ctx: userCtx(req) });
    return `Too many wrong passwords. Try again in ${rateLimit.waitText(limited.retryAfterSec)}.`;
  }
  const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  const ok = u && req.body.password && (await bcrypt.compare(String(req.body.password).slice(0, 200), u.password_hash).catch(() => false));
  if (ok) { rateLimit.reset('stepUpFail', req.user.id); return null; }
  await agent.approveDenied({ intentId: i.id, userId: req.user.id, code: 'STEP_UP_FAILED', message: 'Wrong or missing password', ctx: userCtx(req) });
  return 'Password is wrong or missing. The purchase was not approved.';
}

// Ask the assistant to complete an approved request. Returns the chat fragment.
async function completeViaAssistant(req, i) {
  const { catalog, decisions } = req.app.locals.engine;
  const userLine = bubble('user', `Approved ${esc(courseName(catalog, i.item_id))}`);
  try {
    const out = await assistant.chat({ user: req.user, text: approvedText(i.id), catalog, decisions, startPayment: paymentStarter(req), ip: req.ip });
    // Whatever the model did, the card ends up showing the request's real state.
    return (await turnHtml(catalog, userLine, out)) + await cardUpdate(req, await agent.getIntent(i.id), { oob: true, inLog: true });
  } catch (e) {
    if (!(e instanceof assistant.AssistantError)) throw e;
    // Only the message; the card itself shows what to do next (Complete purchase / Pay).
    const fresh = await agent.getIntent(i.id);
    return userLine + `<p class="err" style="margin:0.4rem 0">${esc(e.message)}</p>` + await cardUpdate(req, fresh, { oob: true, inLog: true });
  }
}

router.get('/agent/intents/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.status(404).send(layout('Not found', '<p>Purchase request not found.</p>', req.user));
    send(req, res, 'Purchase request', reviewPage(req, i, await agent.listEvents(i.id)));
  } catch (e) { next(e); }
});

// Approve on the request page: then the assistant completes it, and you land on /agent.
router.post('/agent/intents/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.status(404).send(layout('Not found', '<p>Purchase request not found.</p>', req.user));
    const err = await stepUpError(req, i);
    if (err) return res.status(403).send(layout('Purchase request', reviewPage(req, i, await agent.listEvents(i.id), { error: err }), req.user));
    await applyProviderChoice(req, i);
    await agent.approve({ intentId: i.id, userId: req.user.id, ...approveGuards(req, i), ctx: userCtx(req) });
    if (i.agent_name === assistant.AGENT_NAME) await completeViaAssistant(req, i);
    res.redirect(303, '/agent');
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    await showAgentPage(req, res, { error: e.message }).catch(next);
  }
});

router.post('/agent/intents/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    await agent.cancel({ intentId: req.params.id, userId: req.user.id, ctx: userCtx(req) });
    await showAgentPage(req, res, { message: 'Purchase request cancelled.' });
  } catch (e) {
    if (!(e instanceof agent.AgentPurchaseError)) return next(e);
    await showAgentPage(req, res, { error: e.message }).catch(next);
  }
});

// ---- chat routes ----------------------------------------------------------------------------

router.post('/assistant/chat', requireAuth, async (req, res, next) => {
  const text = String(req.body.message || '');
  try {
    const { catalog, decisions } = req.app.locals.engine;
    const out = await assistant.chat({ user: req.user, text, catalog, decisions, startPayment: paymentStarter(req), ip: req.ip });
    // A purchase that finished during this turn (mock pays at once) gets its outcome line now.
    const added = await assistant.noteOutcomes(req.user.id, (id) => courseName(catalog, id));
    res.send(await turnHtml(catalog, bubble('user', esc(text)), out) + added.map((x) => noteBubble(x.tone, x.content)).join(''));
  } catch (e) {
    if (!(e instanceof assistant.AssistantError)) return next(e);
    res.send(bubble('user', esc(text)) + `<p class="err" style="margin:0.4rem 0">${esc(e.message)}</p>`);
  }
});

// Card buttons. The approval is the user's own click (with the password above the threshold);
// the assistant is then asked to complete the purchase.
router.post('/assistant/approve/:id', requireAuth, async (req, res, next) => {
  try {
    const { catalog } = req.app.locals.engine;
    const i = await ownIntent(req);
    if (!i) return res.send('<p class="err">Purchase request not found.</p>');
    const err = await stepUpError(req, i);
    if (err) return res.send(purchaseCard(catalog, i, { error: err, oob: true }));
    try {
      await applyProviderChoice(req, i);
      await agent.approve({ intentId: i.id, userId: req.user.id, ...approveGuards(req, i), ctx: userCtx(req) });
    } catch (e) {
      if (!(e instanceof agent.AgentPurchaseError)) throw e;
      return res.send(await cardUpdate(req, (await agent.getIntent(i.id)) || i, { error: e.message, oob: true, inLog: true }));
    }
    res.send(await completeViaAssistant(req, i));
  } catch (e) { next(e); }
});

// Coupon field on a card (only while the request waits for approval): apply a code, or remove it
// (empty code). The card is redrawn with the new price, or with the reason the code was refused.
router.post('/assistant/coupon/:id', requireAuth, async (req, res, next) => {
  try {
    const { catalog } = req.app.locals.engine;
    const i = await ownIntent(req);
    if (!i) return res.send('<p class="err">Purchase request not found.</p>');
    try {
      const updated = await agent.setCoupon({ intentId: i.id, userId: req.user.id, couponCode: String(req.body.coupon ?? '').slice(0, 60), catalog, ctx: userCtx(req) });
      res.send(purchaseCard(catalog, updated, { oob: true }));
    } catch (e) {
      if (!(e instanceof agent.AgentPurchaseError)) throw e;
      res.send(purchaseCard(catalog, (await agent.getIntent(i.id)) || i, { error: e.message, oob: true }));
    }
  } catch (e) { next(e); }
});

router.post('/assistant/continue/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.send('<p class="err">Purchase request not found.</p>');
    if (i.status !== 'APPROVED') return res.send(await cardUpdate(req, i, { error: `This request is ${i.status.toLowerCase()}.`, oob: true, inLog: true }));
    res.send(await completeViaAssistant(req, i));
  } catch (e) { next(e); }
});

router.post('/assistant/cancel/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.send('<p class="err">Purchase request not found.</p>');
    let error = '';
    try { await agent.cancel({ intentId: i.id, userId: req.user.id, ctx: userCtx(req) }); }
    catch (e) { if (!(e instanceof agent.AgentPurchaseError)) throw e; error = e.message; }
    res.send(await cardUpdate(req, (await agent.getIntent(i.id)) || i, { error, oob: true, inLog: true }));
  } catch (e) { next(e); }
});

// "Pay with Razorpay" on a card: the checkout link stored when the request was executed. If it
// is missing (older requests), the unpaid Razorpay order is looked up by our order id.
router.get('/assistant/pay/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i || i.status !== 'EXECUTED' || agent.paymentState(i) !== 'PENDING') return res.redirect(303, '/agent');
    let url = i.pay_url;
    if (!url && i.provider === 'razorpay') {
      const found = await getAdapter('razorpay').findCheckoutUrl({ orderRef: i.order_id, userId: i.user_id, productId: i.item_id })
        .catch((e) => { console.warn('[assistant] checkout link lookup failed:', e?.error?.description || e.message); return null; });
      if (found) {
        url = `${found}&back=agent`;
        await pool.query('UPDATE purchase_intents SET pay_url=$2 WHERE id=$1', [i.id, url]);
      }
    }
    res.redirect(303, url || '/agent?e=PAY_LINK');
  } catch (e) { next(e); }
});

// One card, for the self-refresh of a card whose payment is pending.
router.get('/assistant/card/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.send('');
    res.set('Cache-Control', 'no-store');
    if (req.query.shown === cardState(i)) return res.status(204).end(); // unchanged: htmx keeps the card
    res.send(await cardUpdate(req, i));
  } catch (e) { next(e); }
});

// "Cancel payment" on a card waiting for payment: same as closing the checkout without paying.
router.post('/assistant/cancel-payment/:id', requireAuth, async (req, res, next) => {
  try {
    const i = await ownIntent(req);
    if (!i) return res.send('<p class="err">Purchase request not found.</p>');
    if (i.order_id) await agent.cancelUnpaid({ orderId: i.order_id, userId: req.user.id, ctx: userCtx(req) });
    res.send(await cardUpdate(req, await agent.getIntent(i.id), { oob: true, inLog: true }));
  } catch (e) { next(e); }
});

// Razorpay checkout closed without paying (ref = our order id): that payment is cancelled and
// the card says so; then back to the chat.
router.get('/assistant/checkout-closed', requireAuth, async (req, res, next) => {
  try {
    await agent.cancelUnpaid({ orderId: String(req.query.ref || ''), userId: req.user.id, ctx: userCtx(req) });
    res.redirect(303, '/agent');
  } catch (e) { next(e); }
});

router.post('/assistant/clear', requireAuth, async (req, res, next) => {
  try {
    await assistant.clear(req.user.id);
    res.redirect(303, '/agent');
  } catch (e) { next(e); }
});

module.exports = router;

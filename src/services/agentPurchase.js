'use strict';
// M7 agent-approved purchases.
//
//   propose  - an agent asks to buy a course for a user. The server fills in the item,
//              merchant and price from the catalog: the agent cannot choose the amount.
//              Refused when the course is owned, a request for it is already open, or the
//              agent hit its daily proposal limit (AGENT_PROPOSALS_PER_DAY, via M5 quotas).
//   approve  - only the user (in the browser) can approve. Approval creates a one-time nonce
//              and a signed token (JWT) binding intent id, user, agent key, item, merchant,
//              amount and currency, valid AGENT_APPROVAL_TTL_SECONDS (default 300).
//              Simulated (browser) agent: the token is returned at once and shown on the page.
//              API agent (agent key): the token is NOT shown to the browser; the agent picks it
//              up exactly once with its own key (pickupToken).
//   execute  - the agent sends the token back. Rejected when tampered, expired, for another
//              intent / user / agent, not matching the approved item/merchant/amount,
//              cancelled, the catalog price changed, the user owns the course by now, or the
//              approval was already used. APPROVED -> EXECUTED happens in one conditional
//              UPDATE, so only one execution can ever win.
//   payment  - a normal order + provider payment. The webhook records an ordinary purchase;
//              this module never touches the ledger. paymentState() reads the outcome back
//              from the order (PENDING / PAID / REFUNDED ...).
//   sweep    - expires old proposals and lapsed approvals, and fails executed requests whose
//              payment never completed (abandoned checkout, crash before the payment started).
//
// Every step, and every rejected attempt, is written to intent_events.

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { createOrder } = require('./orders');
const quotas = require('./quotas');

class AgentPurchaseError extends Error {
  constructor(code, message, info = {}) { super(message); this.code = code; Object.assign(this, info); }
}

const AUDIENCE = 'learnx-agent-purchase';
const MERCHANT = () => process.env.MERCHANT_ID || 'LEARNX';
const num = (name, dflt) => {
  const v = process.env[name];
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? dflt : Number(v);
};
const TTL = () => num('AGENT_APPROVAL_TTL_SECONDS', 300);
const PROPOSAL_TTL_HOURS = () => num('AGENT_PROPOSAL_TTL_HOURS', 24);
const UNPAID_MINUTES = () => num('AGENT_UNPAID_MINUTES', 30);
const PROPOSALS_PER_DAY = () => num('AGENT_PROPOSALS_PER_DAY', 20);
// Separate key from the login JWTs, so a session token can never pass as an approval.
const SECRET = () =>
  process.env.AGENT_APPROVAL_SECRET ||
  crypto.createHash('sha256').update(`agent-approval:${process.env.JWT_SECRET}`).digest('hex');

// Provider when the caller doesn't name one (one-click button, assistant):
// AGENT_DEFAULT_PROVIDER, else Razorpay when it has test keys, else mock.
const defaultProvider = () => {
  const p = process.env.AGENT_DEFAULT_PROVIDER;
  if (p === 'mock' || p === 'razorpay') return p;
  return /^rzp_test_/.test(process.env.RAZORPAY_KEY_ID || '') ? 'razorpay' : 'mock';
};

const findCourse = (catalog, key) =>
  catalog.list().find((p) => (p.id === key || p.slug === key) && (p.type || 'COURSE') === 'COURSE') || null;

// ---- audit -------------------------------------------------------------------------------

// ctx = { actor: 'user' | 'agent:<name>' | 'system', ip }
async function logEvent(intentRef, event, { userId = null, code = null, detail = null, ctx = {} } = {}, db = pool) {
  await db.query(
    'INSERT INTO intent_events (intent_ref, user_id, actor, event, code, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [String(intentRef).slice(0, 80), userId, ctx.actor || 'system', event, code, detail ? String(detail).slice(0, 500) : null, ctx.ip || null]
  ).catch((e) => console.error('[agent] audit write failed:', e.message)); // never block the flow on the audit write
}

async function listEvents(intentId) {
  return (await pool.query('SELECT * FROM intent_events WHERE intent_ref=$1 ORDER BY id', [String(intentId)])).rows;
}

// ---- reads -------------------------------------------------------------------------------

const SELECT_INTENT = `SELECT pi.*, o.status AS order_status, k.name AS agent_key_name
  FROM purchase_intents pi
  LEFT JOIN orders o ON o.id = pi.order_id
  LEFT JOIN agent_keys k ON k.id = pi.agent_key_id`;

async function getIntent(id, db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  return (await db.query(`${SELECT_INTENT} WHERE pi.id=$1`, [id])).rows[0] || null;
}

async function listIntents(userId, { agentKeyId = null } = {}) {
  const { rows } = agentKeyId
    ? await pool.query(`${SELECT_INTENT} WHERE pi.user_id=$1 AND pi.agent_key_id=$2 ORDER BY pi.created_at DESC LIMIT 20`, [userId, agentKeyId])
    : await pool.query(`${SELECT_INTENT} WHERE pi.user_id=$1 ORDER BY pi.created_at DESC LIMIT 20`, [userId]);
  return rows;
}

// What happened to the money after the approval was used, read from the normal order.
const ORDER_TO_PAYMENT = {
  PENDING: 'PENDING', COMPLETED: 'PAID', REFUND_PENDING: 'REFUND_PENDING', REFUNDED: 'REFUNDED',
  REFUND_FAILED: 'REFUND_FAILED', CHARGED_BACK: 'CHARGED_BACK', FAILED: 'FAILED', EXPIRED: 'UNPAID', CANCELLED: 'CANCELLED',
  UNDERPAID: 'UNDERPAID',
};
function paymentState(i) {
  if (!i.order_id) return null;
  return ORDER_TO_PAYMENT[i.order_status] || i.order_status || null;
}

// ---- sweeper -----------------------------------------------------------------------------

// Closes requests nobody will act on any more. Optional userId limits it to one user (used
// before a new proposal so a stale request doesn't block it).
async function sweep({ userId = null } = {}) {
  const who = userId ? 'AND user_id = $2' : '';
  const args = (x) => (userId ? [x, userId] : [x]);
  const expired = (await pool.query(
    `UPDATE purchase_intents SET status='EXPIRED'
      WHERE ((status='APPROVED' AND expires_at <= now())
          OR (status='PROPOSED' AND created_at <= now() - make_interval(hours => $1))) ${who}
      RETURNING id, user_id, status`,
    args(PROPOSAL_TTL_HOURS())
  )).rows;
  for (const r of expired) await logEvent(r.id, 'EXPIRED', { userId: r.user_id, detail: 'Not approved / not used in time' });

  // Executed, but the order is still unpaid long after: checkout abandoned, or the server
  // stopped between using the approval and starting the payment. The order is left alone:
  // if the provider does take the money later, the normal webhook / reconciliation still
  // records it and paymentState() shows PAID.
  const unpaid = (await pool.query(
    `UPDATE purchase_intents pi SET status='FAILED',
            failure_reason = 'Payment not completed within ' || $1 || ' min'
       FROM orders o
      WHERE o.id = pi.order_id AND pi.status='EXECUTED' AND o.status='PENDING'
        AND pi.executed_at <= now() - make_interval(mins => $1) ${userId ? 'AND pi.user_id = $2' : ''}
      RETURNING pi.id, pi.user_id`,
    args(UNPAID_MINUTES())
  )).rows;
  for (const r of unpaid) await logEvent(r.id, 'FAILED', { userId: r.user_id, code: 'UNPAID', detail: `Payment not completed within ${UNPAID_MINUTES()} min` });

  // The money arrived after all (paid after the checkout was closed or the request timed out):
  // the request is a completed purchase again.
  const late = (await pool.query(
    `UPDATE purchase_intents pi SET status='EXECUTED', failure_reason=NULL
       FROM orders o
      WHERE o.id = pi.order_id AND pi.status='FAILED' AND o.status IN ('COMPLETED','REFUND_PENDING','REFUNDED','REFUND_FAILED')
        ${userId ? 'AND pi.user_id = $1' : ''}
      RETURNING pi.id, pi.user_id`,
    userId ? [userId] : []
  )).rows;
  for (const r of late) await logEvent(r.id, 'PAID_LATE', { userId: r.user_id, detail: 'Payment arrived after the request was failed; purchase completed' });
  return { expired: expired.length, unpaid: unpaid.length, late: late.length };
}

// ---- price and coupon -----------------------------------------------------------------------
// The price of one course for this user, with an optional coupon, by the same rules as the cart
// (pricingEngine.validateCoupon, the course as a one-item cart). Throws BAD_COUPON with the reason.
// A coupon that makes the course free is refused: a purchase request needs an amount above 0.
async function quote({ userId, course, couponCode }) {
  const listCents = course.priceCents;
  const code = String(couponCode ?? '').trim();
  if (!code) return { listCents, discountCents: 0, finalCents: listCents, code: null, ruleId: null };
  if (code.length > 40 || !/^[\x21-\x7E]+$/.test(code)) throw new AgentPurchaseError('BAD_COUPON', 'That coupon code is not valid.');
  const user = (await pool.query('SELECT id, email FROM users WHERE id = $1', [userId])).rows[0];
  const item = { id: course.id, slug: course.slug || course.id, unit_price_cents: listCents, price: listCents / 100 };
  const v = await require('./pricingEngine').validateCoupon(code, user, false, [item]);
  if (!v.valid) throw new AgentPurchaseError('BAD_COUPON', v.error || 'That coupon code is not valid.');
  const discountCents = Math.max(0, Math.min(listCents, Number(v.discountCents) || 0));
  const finalCents = listCents - discountCents;
  if (finalCents <= 0) throw new AgentPurchaseError('BAD_COUPON', "This coupon makes the course free, which can't be bought through the assistant.");
  return { listCents, discountCents, finalCents, code: String(v.rule?.code || code).toUpperCase(), ruleId: v.rule?.id || null };
}
const priceDetail = (q, currency) => `${q.finalCents} ${currency}${q.code ? ` (list ${q.listCents}, coupon ${q.code} -${q.discountCents})` : ''}`;

// ---- propose / approve / cancel ------------------------------------------------------------

async function propose({ userId, productId, provider = 'mock', couponCode = null, agentName = 'keyless-agent', agentKeyId = null, catalog, decisions, ctx = {} }) {
  ctx = { actor: `agent:${agentName}`, ...ctx };
  const reject = async (code, message, info) => {
    await logEvent('-', 'REJECTED', { userId, code, detail: `propose ${productId}: ${message}`, ctx });
    return new AgentPurchaseError(code, message, info);
  };
  const course = findCourse(catalog, productId);
  if (!course) throw await reject('UNKNOWN_ITEM', 'The agent asked for a course that does not exist.');
  if (!['mock', 'razorpay'].includes(provider)) throw await reject('BAD_PROVIDER', 'Unknown payment provider.');
  const itemId = course.slug || course.id;
  if (decisions?.evaluateAccess(userId, itemId).allowed)
    throw await reject('ALREADY_OWNED', 'You already have access to this course.');

  await sweep({ userId }); // a lapsed request for the same course must not block this one

  // A request for this course that was executed but is still waiting for its payment (e.g. the
  // Razorpay checkout is open) blocks a new one: paying both would charge twice. It stops
  // blocking once it is paid (then ALREADY_OWNED) or the sweeper fails it (AGENT_UNPAID_MINUTES).
  const waiting = (await pool.query(
    `SELECT pi.id FROM purchase_intents pi JOIN orders o ON o.id = pi.order_id
      WHERE pi.user_id=$1 AND pi.item_id=$2 AND pi.status='EXECUTED' AND o.status='PENDING' LIMIT 1`,
    [userId, itemId]
  )).rows[0];
  if (waiting) throw await reject('PAYMENT_PENDING', 'A purchase of this course is already waiting for payment. Pay it on its card, or wait for it to expire.');

  // Price (and coupon) before the daily limit is used up: a bad coupon costs no proposal.
  let price;
  try {
    price = await quote({ userId, course, couponCode });
  } catch (e) {
    if (e instanceof AgentPurchaseError) throw await reject(e.code, e.message);
    throw e;
  }

  // Daily proposal limit per agent key (or per user for an agent without a key), via M5 quotas.
  const requestKey = `agent-propose:${crypto.randomUUID()}`;
  const quota = { scopeKey: agentKeyId ? `agentkey:${agentKeyId}` : `user:${userId}:agent`, limit: PROPOSALS_PER_DAY() };
  const q = await quotas.consume({ requestKey, quota, feature: 'AGENT_PROPOSE', userId, productId: itemId });
  if (!q.ok) throw await reject('RATE_LIMITED', `Too many purchase requests today (limit ${q.limit}). Try again later.`, { retryAfterSec: q.retryAfterSec });

  try {
    const { rows } = await pool.query(
      `INSERT INTO purchase_intents (user_id, agent_name, agent_key_id, item_id, merchant, amount_cents, currency, provider,
                                     list_amount_cents, discount_cents, coupon_code, coupon_rule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, String(agentName).slice(0, 60), agentKeyId, itemId, MERCHANT(), price.finalCents, course.currency || 'USD', provider,
        price.listCents, price.discountCents, price.code, price.ruleId]
    );
    await logEvent(rows[0].id, 'PROPOSED', { userId, detail: `${itemId} ${priceDetail(price, course.currency || 'USD')} via ${provider}`, ctx });
    return rows[0];
  } catch (e) {
    await quotas.release(requestKey).catch(() => {});
    if (e.code === '23505') throw await reject('DUPLICATE_REQUEST', 'There is already an open purchase request for this course.');
    throw e;
  }
}

function signToken(i) {
  return jwt.sign(
    { iid: i.id, item: i.item_id, merchant: i.merchant, amount: i.amount_cents, currency: i.currency,
      list: i.list_amount_cents ?? i.amount_cents, coupon: i.coupon_code || null,
      nonce: i.nonce, agk: i.agent_key_id || null, exp: Math.floor(new Date(i.expires_at).getTime() / 1000) },
    SECRET(),
    { subject: i.user_id, audience: AUDIENCE }
  );
}

// Only the owner, only from PROPOSED. Returns { intent, token }; token is null for an API
// agent (it collects the token itself with pickupToken, so it never passes through the browser).
// expectAmountCents: the amount the user saw when clicking Approve. If the price changed meanwhile
// (a coupon applied or removed in another tab), nothing is approved: the user must see the new price.
// noPasswordMaxCents: set when the user did not enter the step-up password; approving then requires
// the amount to still be at or below it (checked in the same UPDATE).
async function approve({ intentId, userId, ttlSeconds = TTL(), expectAmountCents = null, noPasswordMaxCents = null, ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  const nonce = crypto.randomBytes(16).toString('hex');
  const expect = expectAmountCents === null || expectAmountCents === undefined || expectAmountCents === '' ? null : Number(expectAmountCents);
  if (expect !== null && !Number.isInteger(expect)) throw new AgentPurchaseError('PRICE_CHANGED', 'The price on the card is out of date. Check the new price and approve again.');
  const { rows } = await pool.query(
    `UPDATE purchase_intents
        SET status='APPROVED', nonce=$3, approved_at=now(), expires_at=now() + make_interval(secs => $4)
      WHERE id=$1 AND user_id=$2 AND status='PROPOSED' AND ($5::int IS NULL OR amount_cents = $5)
        AND ($6::int IS NULL OR amount_cents <= $6) RETURNING *`,
    [intentId, userId, nonce, ttlSeconds, expect, noPasswordMaxCents]
  );
  if (!rows[0]) {
    const cur = await getIntent(intentId);
    if (noPasswordMaxCents !== null && cur && cur.user_id === userId && cur.status === 'PROPOSED' && cur.amount_cents > noPasswordMaxCents
        && (expect === null || cur.amount_cents === expect)) {
      await logEvent(intentId, 'APPROVE_DENIED', { userId, code: 'STEP_UP_REQUIRED', detail: `approve without password at ${cur.amount_cents}`, ctx });
      throw new AgentPurchaseError('STEP_UP_REQUIRED', 'This amount needs your password. Enter it and approve again.');
    }
    if (expect !== null && cur && cur.user_id === userId && cur.status === 'PROPOSED' && cur.amount_cents !== expect) {
      await logEvent(intentId, 'REJECTED', { userId, code: 'PRICE_CHANGED', detail: `approve: card showed ${expect}, price is ${cur.amount_cents}`, ctx });
      throw new AgentPurchaseError('PRICE_CHANGED', 'The price changed (a coupon was applied or removed). Check the new price and approve again.');
    }
    const err = await stateError(intentId, userId, 'approve');
    await logEvent(intentId, 'REJECTED', { userId, code: err.code, detail: `approve: ${err.message}`, ctx });
    throw err;
  }
  const i = rows[0];
  await logEvent(i.id, 'APPROVED', { userId, detail: `valid ${ttlSeconds}s`, ctx });
  return { intent: i, token: i.agent_key_id ? null : signToken(i) };
}

// The API agent collects its approval token: only with the key that proposed the request,
// only while APPROVED and unexpired, and only once.
async function pickupToken({ intentId, agentKeyId, ctx = {} }) {
  const { rows } = await pool.query(
    `UPDATE purchase_intents SET token_issued_at=now()
      WHERE id=$1 AND agent_key_id=$2 AND status='APPROVED' AND expires_at > now() AND token_issued_at IS NULL
      RETURNING *`,
    [intentId, agentKeyId]
  );
  if (!rows[0]) return null;
  await logEvent(intentId, 'TOKEN_ISSUED', { userId: rows[0].user_id, ctx });
  return signToken(rows[0]);
}

async function cancel({ intentId, userId, ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  const { rows } = await pool.query(
    `UPDATE purchase_intents SET status='CANCELLED', cancelled_at=now()
      WHERE id=$1 AND user_id=$2 AND status IN ('PROPOSED','APPROVED') RETURNING *`,
    [intentId, userId]
  );
  if (!rows[0]) {
    const err = await stateError(intentId, userId, 'cancel');
    await logEvent(intentId, 'REJECTED', { userId, code: err.code, detail: `cancel: ${err.message}`, ctx });
    throw err;
  }
  await logEvent(intentId, 'CANCELLED', { userId, ctx });
  return rows[0];
}

async function stateError(intentId, userId, action) {
  const i = await getIntent(intentId);
  if (!i || i.user_id !== userId) return new AgentPurchaseError('NOT_FOUND', 'Purchase request not found.');
  return new AgentPurchaseError(`ALREADY_${i.status}`, `This request is ${i.status.toLowerCase()}; it can't be ${action === 'approve' ? 'approved' : 'cancelled'} now.`);
}

// The user closed the provider's checkout without paying (an executed request whose order is
// still PENDING): the order becomes CANCELLED and the request FAILED, so its card stops offering
// Pay and a new request for the course is allowed. If the provider does take the money later,
// the normal webhook still completes the order (CANCELLED -> COMPLETED) and the card shows PAID.
async function cancelUnpaid({ orderId, userId, ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  const i = (await pool.query(
    `SELECT pi.id FROM purchase_intents pi JOIN orders o ON o.id = pi.order_id
      WHERE pi.order_id::text=$1 AND pi.user_id=$2 AND pi.status='EXECUTED' AND o.status='PENDING'`,
    [String(orderId), userId]
  )).rows[0];
  if (!i) return null;
  await pool.query("UPDATE orders SET status='CANCELLED', updated_at=now() WHERE id=$1 AND status='PENDING'", [orderId]);
  await pool.query("UPDATE purchase_intents SET status='FAILED', failure_reason='Payment cancelled at checkout' WHERE id=$1 AND status='EXECUTED'", [i.id]);
  await logEvent(i.id, 'FAILED', { userId, code: 'CHECKOUT_CLOSED', detail: 'Checkout closed without paying', ctx });
  return i.id;
}

// The user picks how to pay on a request that is still waiting for approval (the price, item
// and the approval rules don't depend on the provider). Only the owner, only while PROPOSED.
async function setProvider({ intentId, userId, provider, ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  if (!['mock', 'razorpay'].includes(provider)) throw new AgentPurchaseError('BAD_PROVIDER', 'Unknown payment provider.');
  const before = await getIntent(intentId);
  const { rows } = await pool.query(
    `UPDATE purchase_intents SET provider=$3 WHERE id=$1 AND user_id=$2 AND status='PROPOSED' RETURNING *`,
    [intentId, userId, provider]
  );
  if (!rows[0]) throw await stateError(intentId, userId, 'approve');
  if (before && before.provider !== provider)
    await logEvent(intentId, 'PROVIDER_CHANGED', { userId, detail: `${before.provider} -> ${provider}`, ctx });
  return rows[0];
}

// The user applies (or removes, couponCode = null / '') a coupon on a request that is still waiting
// for approval. Only the owner, only while PROPOSED. Throws BAD_COUPON (request unchanged) if invalid.
async function setCoupon({ intentId, userId, couponCode, catalog, ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  const i = await getIntent(intentId);
  if (!i || i.user_id !== userId) throw new AgentPurchaseError('NOT_FOUND', 'Purchase request not found.');
  if (i.status !== 'PROPOSED') throw await stateError(intentId, userId, 'approve');
  const course = findCourse(catalog, i.item_id);
  if (!course) throw new AgentPurchaseError('UNKNOWN_ITEM', 'This course is no longer sold.');
  let q;
  try {
    q = await quote({ userId, course, couponCode });
  } catch (e) {
    if (e instanceof AgentPurchaseError) await logEvent(intentId, 'COUPON_REJECTED', { userId, code: e.code, detail: `${String(couponCode).slice(0, 40)}: ${e.message}`, ctx });
    throw e;
  }
  const { rows } = await pool.query(
    `UPDATE purchase_intents SET amount_cents=$3, list_amount_cents=$4, discount_cents=$5, coupon_code=$6, coupon_rule_id=$7
      WHERE id=$1 AND user_id=$2 AND status='PROPOSED' RETURNING *`,
    [intentId, userId, q.finalCents, q.listCents, q.discountCents, q.code, q.ruleId]
  );
  if (!rows[0]) throw await stateError(intentId, userId, 'approve');
  if ((i.coupon_code || null) !== q.code || i.amount_cents !== q.finalCents)
    await logEvent(intentId, q.code ? 'COUPON_APPLIED' : 'COUPON_REMOVED', { userId, detail: priceDetail(q, i.currency), ctx });
  return rows[0];
}

// Records a step-up (password) failure on approve.
async function approveDenied({ intentId, userId, code, message, ctx = {} }) {
  await logEvent(intentId, 'APPROVE_DENIED', { userId, code, detail: message, ctx: { actor: 'user', ...ctx } });
}

// ---- execute -----------------------------------------------------------------------------

// startPayment({ intent, orderId, course }) -> { status: 'PAID'|'CHECKOUT', redirectUrl? }
// agentKeyId: the key the caller authenticated with (null = an agent without its own key, whose
// approval token is handed back to the approver).
async function execute({ intentId, token, userId, agentKeyId = null, catalog, decisions, startPayment, ctx = {} }) {
  ctx = { actor: 'agent', ...ctx };
  try {
    return await executeChecked({ intentId, token, userId, agentKeyId, catalog, decisions, startPayment, ctx });
  } catch (e) {
    if (e instanceof AgentPurchaseError && e.code !== 'PAYMENT_FAILED')
      await logEvent(intentId, 'REJECTED', { userId, code: e.code, detail: `execute: ${e.message}`, ctx });
    throw e;
  }
}

async function executeChecked({ intentId, token, userId, agentKeyId, catalog, decisions, startPayment, ctx }) {
  let claims;
  try {
    claims = jwt.verify(String(token || '').trim(), SECRET(), { audience: AUDIENCE, algorithms: ['HS256'] });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw new AgentPurchaseError('EXPIRED', 'The approval has expired. Ask the user to approve again.');
    throw new AgentPurchaseError('TAMPERED', 'The approval token is invalid or was changed.');
  }
  if (claims.iid !== intentId) throw new AgentPurchaseError('WRONG_INTENT', 'This approval belongs to a different purchase request.');
  if (userId && claims.sub !== userId) throw new AgentPurchaseError('WRONG_USER', 'This approval belongs to another user.');

  const i = await getIntent(intentId);
  if (!i || i.user_id !== claims.sub) throw new AgentPurchaseError('NOT_FOUND', 'Purchase request not found.');
  // The request can only be completed by the agent that proposed it (its key, or the
  // keyless agent when it was proposed without a key).
  if ((i.agent_key_id || null) !== (agentKeyId || null) || (claims.agk || null) !== (i.agent_key_id || null))
    throw new AgentPurchaseError('WRONG_AGENT', 'This approval was given to a different agent.');
  if (i.status === 'CANCELLED') throw new AgentPurchaseError('CANCELLED', 'The user cancelled this purchase.');
  if (i.status === 'EXECUTED' || i.status === 'FAILED') throw new AgentPurchaseError('REPLAYED', 'This approval was already used.');
  if (i.status === 'EXPIRED') throw new AgentPurchaseError('EXPIRED', 'The approval has expired.');
  if (i.status !== 'APPROVED') throw new AgentPurchaseError('NOT_APPROVED', 'The user has not approved this purchase.');
  if (claims.nonce !== i.nonce) throw new AgentPurchaseError('REPLAYED', 'This approval was replaced or already used.');
  const listCents = i.list_amount_cents ?? i.amount_cents;
  if (claims.item !== i.item_id || claims.merchant !== i.merchant || claims.amount !== i.amount_cents || claims.currency !== i.currency
      || (claims.list ?? claims.amount) !== listCents || (claims.coupon ?? null) !== (i.coupon_code || null))
    throw new AgentPurchaseError('MISMATCH', 'Item, merchant, amount or coupon differ from what the user approved.');
  if (new Date(i.expires_at) <= new Date()) throw new AgentPurchaseError('EXPIRED', 'The approval has expired.');
  const course = findCourse(catalog, i.item_id);
  if (!course || course.priceCents !== listCents || (course.currency || 'USD') !== i.currency)
    throw new AgentPurchaseError('PRICE_CHANGED', 'The price changed after approval. Ask the user to approve again.');
  // The coupon must still give exactly the approved price (it may have expired or been disabled since).
  if (i.coupon_code) {
    let q = null, why = null;
    try { q = await quote({ userId: i.user_id, course, couponCode: i.coupon_code }); } catch (e) { if (!(e instanceof AgentPurchaseError)) throw e; why = e.message; }
    if (!q || q.finalCents !== i.amount_cents) {
      const reason = why ? `Coupon ${i.coupon_code} is no longer valid: ${why}` : `Coupon ${i.coupon_code} now gives a different price`;
      await pool.query("UPDATE purchase_intents SET status='FAILED', failure_reason=$2 WHERE id=$1 AND status='APPROVED'", [intentId, reason]);
      throw new AgentPurchaseError('COUPON_INVALID', `${reason}. Nothing was charged; ask the assistant to buy it again.`);
    }
  }
  // The user may have bought the course another way since approving: don't buy it twice.
  if (decisions?.evaluateAccess(i.user_id, i.item_id).allowed) {
    await pool.query(
      "UPDATE purchase_intents SET status='FAILED', failure_reason='Already owned when the agent tried to buy it' WHERE id=$1 AND status='APPROVED'",
      [intentId]
    );
    throw new AgentPurchaseError('ALREADY_OWNED', 'You already own this course; nothing was bought.');
  }

  // Use the approval exactly once, and create the order, in one transaction.
  const client = await pool.connect();
  let orderId;
  try {
    await client.query('BEGIN');
    const won = await client.query(
      `UPDATE purchase_intents SET status='EXECUTED', executed_at=now()
        WHERE id=$1 AND status='APPROVED' AND nonce=$2 AND expires_at > now() RETURNING id`,
      [intentId, claims.nonce]
    );
    if (!won.rowCount) throw new AgentPurchaseError('REPLAYED', 'This approval was already used.');
    orderId = await createOrder(client, {
      userId: i.user_id, provider: i.provider, subtotalCents: listCents, discountCents: listCents - i.amount_cents,
      finalCents: i.amount_cents, appliedRuleId: i.coupon_rule_id || null,
      lines: [{ itemType: 'COURSE', itemId: i.item_id, unitPriceCents: listCents, paidCents: i.amount_cents }],
    });
    await client.query('UPDATE purchase_intents SET order_id=$2 WHERE id=$1', [intentId, orderId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logEvent(intentId, 'EXECUTED', { userId: i.user_id, detail: `order ${orderId}`, ctx });

  try {
    const pay = await startPayment({ intent: i, orderId, course });
    if (pay?.redirectUrl) await pool.query('UPDATE purchase_intents SET pay_url=$2 WHERE id=$1', [intentId, pay.redirectUrl]);
    return { intent: { ...i, status: 'EXECUTED', order_id: orderId }, orderId, ...pay };
  } catch (e) {
    // The approval is spent either way; record why the payment did not start.
    await pool.query("UPDATE purchase_intents SET status='FAILED', failure_reason=$2 WHERE id=$1", [intentId, e.message]);
    await pool.query("UPDATE orders SET status='FAILED', updated_at=now() WHERE id=$1 AND status='PENDING'", [orderId]);
    await logEvent(intentId, 'FAILED', { userId: i.user_id, code: 'PAYMENT_FAILED', detail: e.message, ctx });
    throw new AgentPurchaseError('PAYMENT_FAILED', `Payment could not be started: ${e.message}`);
  }
}

module.exports = {
  AgentPurchaseError, propose, approve, approveDenied, setProvider, setCoupon, quote, cancelUnpaid, pickupToken, cancel, execute, sweep,
  getIntent, listIntents, listEvents, paymentState, findCourse, defaultProvider, AUDIENCE,
};

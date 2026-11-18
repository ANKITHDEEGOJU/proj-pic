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
const quotas = require('./quotas');

class AgentPurchaseError extends Error {
  constructor(code, message, info = {}) { super(message); this.code = code; Object.assign(this, info); }
}

const AUDIENCE = 'learnx-agent-purchase';
const MERCHANT = () => process.env.MERCHANT_ID || 'LEARNX';
const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' && process.env[name] != null ? v : dflt; };
const TTL = () => num('AGENT_APPROVAL_TTL_SECONDS', 300);
const PROPOSAL_TTL_HOURS = () => num('AGENT_PROPOSAL_TTL_HOURS', 24);
const UNPAID_MINUTES = () => num('AGENT_UNPAID_MINUTES', 30);
const PROPOSALS_PER_DAY = () => num('AGENT_PROPOSALS_PER_DAY', 20);
// Separate key from the login JWTs, so a session token can never pass as an approval.
const SECRET = () =>
  process.env.AGENT_APPROVAL_SECRET ||
  crypto.createHash('sha256').update(`agent-approval:${process.env.JWT_SECRET}`).digest('hex');

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
  REFUND_FAILED: 'REFUND_FAILED', CHARGED_BACK: 'CHARGED_BACK', FAILED: 'FAILED',
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
  return { expired: expired.length, unpaid: unpaid.length };
}

// ---- propose / approve / cancel ------------------------------------------------------------

async function propose({ userId, productId, provider = 'mock', agentName = 'simulated-agent', agentKeyId = null, catalog, decisions, ctx = {} }) {
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

  // Daily proposal limit per agent key (or per user for the simulated agent), via M5 quotas.
  const requestKey = `agent-propose:${crypto.randomUUID()}`;
  const quota = { scopeKey: agentKeyId ? `agentkey:${agentKeyId}` : `user:${userId}:agent`, limit: PROPOSALS_PER_DAY() };
  const q = await quotas.consume({ requestKey, quota, feature: 'AGENT_PROPOSE', userId, productId: itemId });
  if (!q.ok) throw await reject('RATE_LIMITED', `Too many purchase requests today (limit ${q.limit}). Try again later.`, { retryAfterSec: q.retryAfterSec });

  try {
    const { rows } = await pool.query(
      `INSERT INTO purchase_intents (user_id, agent_name, agent_key_id, item_id, merchant, amount_cents, currency, provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, String(agentName).slice(0, 60), agentKeyId, itemId, MERCHANT(), course.priceCents, course.currency || 'USD', provider]
    );
    await logEvent(rows[0].id, 'PROPOSED', { userId, detail: `${itemId} ${course.priceCents} ${course.currency || 'USD'} via ${provider}`, ctx });
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
      nonce: i.nonce, agk: i.agent_key_id || null, exp: Math.floor(new Date(i.expires_at).getTime() / 1000) },
    SECRET(),
    { subject: i.user_id, audience: AUDIENCE }
  );
}

// Only the owner, only from PROPOSED. Returns { intent, token }; token is null for an API
// agent (it collects the token itself with pickupToken, so it never passes through the browser).
async function approve({ intentId, userId, ttlSeconds = TTL(), ctx = {} }) {
  ctx = { actor: 'user', ...ctx };
  const nonce = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `UPDATE purchase_intents
        SET status='APPROVED', nonce=$3, approved_at=now(), expires_at=now() + make_interval(secs => $4)
      WHERE id=$1 AND user_id=$2 AND status='PROPOSED' RETURNING *`,
    [intentId, userId, nonce, ttlSeconds]
  );
  if (!rows[0]) {
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

// Records a step-up (password) failure on approve.
async function approveDenied({ intentId, userId, code, message, ctx = {} }) {
  await logEvent(intentId, 'APPROVE_DENIED', { userId, code, detail: message, ctx: { actor: 'user', ...ctx } });
}

// ---- execute -----------------------------------------------------------------------------

// startPayment({ intent, orderId, course }) -> { status: 'PAID'|'CHECKOUT', redirectUrl? }
// agentKeyId: the key the caller authenticated with (null = simulated browser agent).
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
    claims = jwt.verify(String(token || '').trim(), SECRET(), { audience: AUDIENCE });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw new AgentPurchaseError('EXPIRED', 'The approval has expired. Ask the user to approve again.');
    throw new AgentPurchaseError('TAMPERED', 'The approval token is invalid or was changed.');
  }
  if (claims.iid !== intentId) throw new AgentPurchaseError('WRONG_INTENT', 'This approval belongs to a different purchase request.');
  if (userId && claims.sub !== userId) throw new AgentPurchaseError('WRONG_USER', 'This approval belongs to another user.');

  const i = await getIntent(intentId);
  if (!i || i.user_id !== claims.sub) throw new AgentPurchaseError('NOT_FOUND', 'Purchase request not found.');
  // The request can only be completed by the agent that proposed it (its key, or the
  // simulated browser agent when it was proposed without a key).
  if ((i.agent_key_id || null) !== (agentKeyId || null) || (claims.agk || null) !== (i.agent_key_id || null))
    throw new AgentPurchaseError('WRONG_AGENT', 'This approval was given to a different agent.');
  if (i.status === 'CANCELLED') throw new AgentPurchaseError('CANCELLED', 'The user cancelled this purchase.');
  if (i.status === 'EXECUTED' || i.status === 'FAILED') throw new AgentPurchaseError('REPLAYED', 'This approval was already used.');
  if (i.status === 'EXPIRED') throw new AgentPurchaseError('EXPIRED', 'The approval has expired.');
  if (i.status !== 'APPROVED') throw new AgentPurchaseError('NOT_APPROVED', 'The user has not approved this purchase.');
  if (claims.nonce !== i.nonce) throw new AgentPurchaseError('REPLAYED', 'This approval was replaced or already used.');
  if (claims.item !== i.item_id || claims.merchant !== i.merchant || claims.amount !== i.amount_cents || claims.currency !== i.currency)
    throw new AgentPurchaseError('MISMATCH', 'Item, merchant or amount differ from what the user approved.');
  if (new Date(i.expires_at) <= new Date()) throw new AgentPurchaseError('EXPIRED', 'The approval has expired.');
  const course = findCourse(catalog, i.item_id);
  if (!course || course.priceCents !== i.amount_cents || (course.currency || 'USD') !== i.currency)
    throw new AgentPurchaseError('PRICE_CHANGED', 'The price changed after approval. Ask the user to approve again.');
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
    orderId = (await client.query(
      `INSERT INTO orders (user_id, subtotal_cents, discount_cents, final_payable_cents, provider, status)
       VALUES ($1,$2,0,$2,$3,'PENDING') RETURNING id`,
      [i.user_id, i.amount_cents, i.provider]
    )).rows[0].id;
    await client.query(
      `INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents)
       VALUES ($1,'COURSE',$2,$3,1,NULL,NULL,$3)`,
      [orderId, i.item_id, i.amount_cents]
    );
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
  AgentPurchaseError, propose, approve, approveDenied, pickupToken, cancel, execute, sweep,
  getIntent, listIntents, listEvents, paymentState, findCourse, AUDIENCE,
};

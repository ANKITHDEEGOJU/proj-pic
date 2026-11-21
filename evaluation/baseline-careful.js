'use strict';
// CAREFUL BASELINE: what a careful developer builds by following the usual webhook advice, without
// LEARNX's ledger, inbox/retry and reconciliation.
//
// It has:
//   - deduplication: one row per provider payment id (UNIQUE + ON CONFLICT DO NOTHING);
//   - order matching: a payment grants only if it matches a stored order in amount and currency;
//   - race-safe limits: quota as one conditional UPDATE, seats under a row lock (SELECT ... FOR
//     UPDATE), one-time approval as a conditional UPDATE (approved and not yet executed).
// It does not have:
//   - an event history: access is still a flag, overwritten by each webhook;
//   - a way to handle a refund that arrives before its payment: the refund finds no payment and is
//     ignored (answered 200, the common choice). Answering "retry later" and processing it again
//     later is what LEARNX's webhook inbox and retry worker do;
//   - reconciliation: a webhook that never arrives is never noticed.
// Same interface as baseline.js; own schema (eval_careful) on the same PostgreSQL server.
const pool = require('../src/db');

const SCHEMA = 'eval_careful';

async function setup() {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.orders    (order_ref TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, amount_cents INT, currency TEXT);
    CREATE TABLE ${SCHEMA}.payments  (payment_id TEXT PRIMARY KEY, order_ref TEXT, user_id TEXT, product_id TEXT, amount_cents INT, refunded BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE ${SCHEMA}.access    (user_id TEXT, product_id TEXT, has_access BOOLEAN NOT NULL, PRIMARY KEY (user_id, product_id));
    CREATE TABLE ${SCHEMA}.quota     (scope TEXT PRIMARY KEY, used INT NOT NULL);
    CREATE TABLE ${SCHEMA}.seat_pools(pool_id TEXT PRIMARY KEY, seats INT NOT NULL);
    CREATE TABLE ${SCHEMA}.seats     (pool_id TEXT, email TEXT, PRIMARY KEY (pool_id, email));
    CREATE TABLE ${SCHEMA}.approvals (intent_id TEXT PRIMARY KEY, approved BOOLEAN, executed BOOLEAN);
    CREATE TABLE ${SCHEMA}.ord_exec  (id BIGSERIAL PRIMARY KEY, intent_id TEXT);`);
}
async function teardown() {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}

// The order the user placed at checkout (what the payment must match).
async function createOrder({ orderRef, userId, productId, amountCents, currency = 'USD' }) {
  await pool.query(`INSERT INTO ${SCHEMA}.orders VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [orderRef, userId, productId, amountCents, currency]);
}

// purchase: grant only for a matching order, once per payment id.
// refund: revoke if the payment is known; otherwise ignore it.
async function handleWebhook(ev) {
  if (ev.type === 'purchase') {
    await pool.query(
      `WITH o AS (SELECT user_id, product_id FROM ${SCHEMA}.orders WHERE order_ref = $2 AND amount_cents = $3 AND currency = $4),
            ins AS (INSERT INTO ${SCHEMA}.payments (payment_id, order_ref, user_id, product_id, amount_cents)
                    SELECT $1, $2, user_id, product_id, $3 FROM o ON CONFLICT (payment_id) DO NOTHING RETURNING user_id, product_id)
       INSERT INTO ${SCHEMA}.access SELECT user_id, product_id, true FROM ins
       ON CONFLICT (user_id, product_id) DO UPDATE SET has_access = true`,
      [ev.paymentId, ev.orderRef, ev.amountCents, ev.currency || 'USD']);
  } else if (ev.type === 'refund') {
    await pool.query(
      `WITH p AS (UPDATE ${SCHEMA}.payments SET refunded = true WHERE payment_id = $1 RETURNING user_id, product_id)
       UPDATE ${SCHEMA}.access a SET has_access = false FROM p WHERE a.user_id = p.user_id AND a.product_id = p.product_id`,
      [ev.paymentId]);
  }
}

async function hasAccess(userId, productId) {
  const r = await pool.query(`SELECT has_access FROM ${SCHEMA}.access WHERE user_id=$1 AND product_id=$2`, [userId, productId]);
  return Boolean(r.rows[0]?.has_access);
}
async function revenue(paymentIds) {
  const r = await pool.query(`SELECT count(*)::int n, coalesce(sum(amount_cents),0)::int cents FROM ${SCHEMA}.payments WHERE payment_id = ANY($1)`, [paymentIds]);
  return r.rows[0];
}

// Quota: one conditional UPDATE, so two requests can't both take the last unit.
async function consumeQuota(scope, limit) {
  await pool.query(`INSERT INTO ${SCHEMA}.quota VALUES ($1, 0) ON CONFLICT DO NOTHING`, [scope]);
  const r = await pool.query(`UPDATE ${SCHEMA}.quota SET used = used + 1 WHERE scope = $1 AND used < $2 RETURNING used`, [scope, limit]);
  return r.rowCount === 1;
}

// Seat: lock the pack row, count, insert, commit.
async function assignSeat(poolId, seats, email) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO ${SCHEMA}.seat_pools VALUES ($1,$2) ON CONFLICT DO NOTHING`, [poolId, seats]);
    const cap = (await c.query(`SELECT seats FROM ${SCHEMA}.seat_pools WHERE pool_id=$1 FOR UPDATE`, [poolId])).rows[0].seats;
    const n = (await c.query(`SELECT count(*)::int n FROM ${SCHEMA}.seats WHERE pool_id=$1`, [poolId])).rows[0].n;
    if (n >= cap) { await c.query('ROLLBACK'); return false; }
    await c.query(`INSERT INTO ${SCHEMA}.seats VALUES ($1,$2)`, [poolId, email]);
    await c.query('COMMIT');
    return true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function seatsInUse(poolId) {
  return (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.seats WHERE pool_id=$1`, [poolId])).rows[0].n;
}

// One-time approval: only the request that flips executed false -> true creates the order.
async function approve(intentId) {
  await pool.query(`INSERT INTO ${SCHEMA}.approvals VALUES ($1, true, false)`, [intentId]);
}
async function execute(intentId) {
  const r = await pool.query(`UPDATE ${SCHEMA}.approvals SET executed = true WHERE intent_id=$1 AND approved AND NOT executed`, [intentId]);
  if (r.rowCount !== 1) return false;
  await pool.query(`INSERT INTO ${SCHEMA}.ord_exec (intent_id) VALUES ($1)`, [intentId]);
  return true;
}
async function ordersFor(intentId) {
  return (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.ord_exec WHERE intent_id=$1`, [intentId])).rows[0].n;
}

module.exports = { setup, teardown, createOrder, handleWebhook, hasAccess, revenue, consumeQuota, assignSeat, seatsInUse, approve, execute, ordersFor };

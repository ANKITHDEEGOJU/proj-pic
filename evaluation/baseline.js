'use strict';
// BASELINE: the straightforward design this project is compared against.
//
// A typical first implementation of "payments unlock courses": every webhook directly flips an
// access flag and records revenue; there is no inbox, no ledger, no deduplication, no order
// matching, no amount check and no reconciliation. Limits (quota, seats, one-time approval) are
// enforced with "read, then write" in application code. It runs on the same PostgreSQL server,
// in its own schema (eval_baseline), so both systems face the same database and workloads.
const pool = require('../src/db');

const SCHEMA = 'eval_baseline';

async function setup() {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.access   (user_id TEXT, product_id TEXT, has_access BOOLEAN NOT NULL, PRIMARY KEY (user_id, product_id));
    CREATE TABLE ${SCHEMA}.payments (id BIGSERIAL PRIMARY KEY, payment_id TEXT, user_id TEXT, product_id TEXT, amount_cents INT);
    CREATE TABLE ${SCHEMA}.quota    (scope TEXT PRIMARY KEY, used INT NOT NULL);
    CREATE TABLE ${SCHEMA}.seats    (pool_id TEXT, email TEXT);
    CREATE TABLE ${SCHEMA}.approvals(intent_id TEXT PRIMARY KEY, approved BOOLEAN, executed BOOLEAN);
    CREATE TABLE ${SCHEMA}.orders   (id BIGSERIAL PRIMARY KEY, intent_id TEXT);`);
}
async function teardown() {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}

// A webhook: purchase -> record revenue + access on; refund -> access off. Nothing else is checked.
async function handleWebhook(ev) {
  if (ev.type === 'purchase') {
    await pool.query(`INSERT INTO ${SCHEMA}.payments (payment_id, user_id, product_id, amount_cents) VALUES ($1,$2,$3,$4)`,
      [ev.paymentId, ev.userId, ev.productId, ev.amountCents]);
    await pool.query(`INSERT INTO ${SCHEMA}.access VALUES ($1,$2,true) ON CONFLICT (user_id, product_id) DO UPDATE SET has_access = true`,
      [ev.userId, ev.productId]);
  } else if (ev.type === 'refund') {
    await pool.query(`INSERT INTO ${SCHEMA}.access VALUES ($1,$2,false) ON CONFLICT (user_id, product_id) DO UPDATE SET has_access = false`,
      [ev.userId, ev.productId]);
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

// Quota: read the counter, and if under the limit, write it back + 1 (two separate statements).
async function consumeQuota(scope, limit) {
  await pool.query(`INSERT INTO ${SCHEMA}.quota VALUES ($1, 0) ON CONFLICT DO NOTHING`, [scope]);
  const used = (await pool.query(`SELECT used FROM ${SCHEMA}.quota WHERE scope=$1`, [scope])).rows[0].used;
  if (used >= limit) return false;
  await pool.query(`UPDATE ${SCHEMA}.quota SET used = $2 WHERE scope=$1`, [scope, used + 1]);
  return true;
}

// Seat: count the seats in use, and if one is free, insert the member.
async function assignSeat(poolId, seats, email) {
  const n = (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.seats WHERE pool_id=$1`, [poolId])).rows[0].n;
  if (n >= seats) return false;
  await pool.query(`INSERT INTO ${SCHEMA}.seats VALUES ($1,$2)`, [poolId, email]);
  return true;
}
async function seatsInUse(poolId) {
  return (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.seats WHERE pool_id=$1`, [poolId])).rows[0].n;
}

// One-time approval: check "approved and not yet executed", create the order, mark executed.
async function approve(intentId) {
  await pool.query(`INSERT INTO ${SCHEMA}.approvals VALUES ($1, true, false)`, [intentId]);
}
async function execute(intentId) {
  const a = (await pool.query(`SELECT approved, executed FROM ${SCHEMA}.approvals WHERE intent_id=$1`, [intentId])).rows[0];
  if (!a?.approved || a.executed) return false;
  await pool.query(`INSERT INTO ${SCHEMA}.orders (intent_id) VALUES ($1)`, [intentId]);
  await pool.query(`UPDATE ${SCHEMA}.approvals SET executed = true WHERE intent_id=$1`, [intentId]);
  return true;
}
async function ordersFor(intentId) {
  return (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.orders WHERE intent_id=$1`, [intentId])).rows[0].n;
}

module.exports = { setup, teardown, handleWebhook, hasAccess, revenue, consumeQuota, assignSeat, seatsInUse, approve, execute, ordersFor };

'use strict';
// One order per checkout click. The cart and seat-pack forms carry a one-time checkoutKey
// (rendered with the page). Creating the order takes a transaction lock on (user, key) and
// stores the key on the order; a repeated submit with the same key (double click, back
// button, network retry) finds that order and is sent to the same checkout page instead of
// creating a second order. Unique index orders(user_id, checkout_key) backs this up.
const pool = require('../db');

const validKey = (k) => (/^[0-9a-f-]{36}$/i.test(String(k || '')) ? String(k) : null);

// Inside the order's transaction, before anything is written. Returns the order already made
// with this key, or null (then the caller creates the order with checkout_key = key).
async function claim(client, userId, key) {
  if (!key) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkout:${userId}:${key}`]);
  const { rows } = await client.query(
    'SELECT id, status, checkout_url FROM orders WHERE user_id = $1 AND checkout_key = $2', [userId, key]
  );
  return rows[0] || null;
}

// Outside a transaction: quick look-up before doing any work.
async function find(userId, key) {
  if (!key) return null;
  const { rows } = await pool.query(
    'SELECT id, status, checkout_url FROM orders WHERE user_id = $1 AND checkout_key = $2', [userId, key]
  );
  return rows[0] || null;
}

async function rememberUrl(orderId, url) {
  if (url) await pool.query('UPDATE orders SET checkout_url = $2 WHERE id = $1', [orderId, url]);
}

// What a repeated submit gets: the same checkout page (waiting briefly while the first submit
// is still talking to the provider), or a message once that order is no longer open.
async function repeatAnswer(order, { waitMs = 8000 } = {}) {
  let o = order;
  for (let waited = 0; ; waited += 400) {
    if (o.status !== 'PENDING') {
      return { message: `This checkout was already used (order ${String(o.status).toLowerCase().replace('_', ' ')}). Nothing new was charged.` };
    }
    if (o.checkout_url) return { redirectUrl: o.checkout_url };
    if (waited >= waitMs) return { message: 'This checkout is already starting. Please wait a moment.' };
    await new Promise((r) => setTimeout(r, 400));
    o = (await pool.query('SELECT id, status, checkout_url FROM orders WHERE id = $1', [o.id])).rows[0];
  }
}

module.exports = { validKey, claim, find, rememberUrl, repeatAnswer };

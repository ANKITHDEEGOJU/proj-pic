'use strict';
const pool = require('../db');
// Builds engine Products from the Postgres `courses` table so UI catalog == engine catalog.
// product.id = course slug. Only P2-safe fields are produced.
async function loadProducts() {
  const { rows } = await pool.query('SELECT slug, title, price_cents, currency FROM courses ORDER BY price_cents');
  return rows.map(r => ({ id: r.slug, name: r.title, price: r.price_cents / 100, currency: r.currency.trim() }));
}

module.exports = { loadProducts };
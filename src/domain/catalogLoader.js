'use strict';

const pool = require('../db');

/**
 * Loads engine Products from the Postgres `products` table.
 * Serves as the single source of truth for both Course items and Subscription plans.
 */
async function loadProducts() {
  const { rows } = await pool.query(`
    SELECT 
      id,
      slug,
      name,
      price_cents,
      currency,
      type,
      duration_days,
      scope
    FROM courses
    ORDER BY price_cents ASC
  `);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    priceCents: r.price_cents,
    price: r.price_cents / 100,
    currency: r.currency ? r.currency.trim() : 'USD',
    type: r.type || 'COURSE',
    durationDays: r.duration_days ?? null,
    scope: r.scope ?? null,
  }));
}

module.exports = { loadProducts };
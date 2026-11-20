'use strict';
// Creating an order: the one place that writes `orders` + `order_line_items`.
// Used by the cart checkout, the single-item checkout, seat packs and agent purchases, so every
// order has the same columns filled the same way (the webhook processor, refunds, reconciliation and
// the underpayment check all read them).
//
// createOrder(client, {
//   userId, provider,
//   subtotalCents,            sum of list prices (unit price x quantity)
//   discountCents = 0,        coupon / promotion
//   finalCents,               what the customer pays (provider amount must match it)
//   appliedRuleId = null,     pricing rule behind the discount
//   checkoutKey = null,       one-time form key (services/checkoutOnce.js)
//   lines: [{ itemType, itemId, unitPriceCents, quantity = 1, durationDays = null, scope = null,
//             paidCents, renewal = false }]   paidCents: this line's share of finalCents
// }) -> orderId
//
// Runs on the caller's transaction client: the caller decides what else belongs in the same
// transaction (clearing the cart, the seat pool row, using an approval).
async function createOrder(client, o) {
  if (!o.lines?.length) throw new Error('createOrder: an order needs at least one line');
  const paid = o.lines.reduce((s, l) => s + Number(l.paidCents), 0);
  if (paid !== Number(o.finalCents)) throw new Error(`createOrder: line amounts (${paid}) must add up to the order total (${o.finalCents})`);
  const { rows } = await client.query(
    `INSERT INTO orders (user_id, subtotal_cents, discount_cents, final_payable_cents, applied_rule_id, provider, status, checkout_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) RETURNING id`,
    [o.userId, o.subtotalCents, o.discountCents || 0, o.finalCents, o.appliedRuleId || null, o.provider, o.checkoutKey || null]
  );
  const orderId = rows[0].id;
  for (const l of o.lines) {
    await client.query(
      `INSERT INTO order_line_items (order_id, item_type, item_id, unit_price_cents, quantity, duration_days, scope, paid_cents, renewal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orderId, l.itemType, l.itemId, l.unitPriceCents, l.quantity || 1, l.durationDays || null, l.scope || null, l.paidCents, Boolean(l.renewal)]
    );
  }
  return orderId;
}

module.exports = { createOrder };

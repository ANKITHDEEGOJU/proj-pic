"use strict";
const pool = require("../db");

async function addToCart(userId, productId, catalog) {
  const targetItem = catalog.get(productId);
  if (!targetItem) throw new Error(`Product '${productId}' not found in catalog.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const isAddingSubscription = targetItem.type === "SUBSCRIPTION";

    if (isAddingSubscription) {
      // 1. If adding ANY subscription, wipe all existing items from the cart
      await client.query("DELETE FROM cart_items WHERE user_id = $1", [userId]);
    } else {
      // 2. If adding a course/bundle, remove any active subscription items from the cart
      const { rows } = await client.query(
        "SELECT product_id FROM cart_items WHERE user_id = $1",
        [userId]
      );

      // Filter product IDs against catalog metadata dynamically
      const subProductIdsInCart = rows
        .map((r) => r.product_id)
        .filter((id) => catalog.get(id)?.type === "SUBSCRIPTION");

      if (subProductIdsInCart.length > 0) {
        await client.query(
          "DELETE FROM cart_items WHERE user_id = $1 AND product_id = ANY($2::text[])",
          [userId, subProductIdsInCart]
        );
      }
    }

    // 3. Insert or update item quantity
    await client.query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + 1`,
      [userId, productId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { addToCart };
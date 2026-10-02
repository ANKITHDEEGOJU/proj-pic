"use strict";
const { DomainError, deepFreeze } = require("./util");
const ALLOWED_FIELDS = ["id", "name", "price", "currency"];

class CatalogStore 
{
  
  #products = new Map();
  
  constructor(products = []) {
    products.forEach((p) => this.add(p));
  }

  add(p) {
    // Enforcing P2: only provider-agnostic fields; no stripe_price_id etc.
    const extra = Object.keys(p).filter((k) => !ALLOWED_FIELDS.includes(k));
    if (extra.length)
      throw new DomainError(
        "P2_PROVIDER_DATA",
        `Product has non-catalog fields: ${extra.join(", ")}`,
      );
    if (typeof p.id !== "string" || !p.id)
      throw new DomainError(
        "P1_INVALID_ID",
        "Product id must be a non-empty string",
      );
    if (typeof p.name !== "string" || !p.name)
      throw new DomainError("P1_INVALID_NAME", "Product name required");
    if (typeof p.price !== "number" || !(p.price >= 0))
      throw new DomainError(
        "P1_INVALID_PRICE",
        "Product price must be a number >= 0",
      );
    if (typeof p.currency !== "string" || !p.currency)
      throw new DomainError("P1_INVALID_CURRENCY", "Product currency required");
    // Enforcing P1: unique product IDs
    if (this.#products.has(p.id))
      throw new DomainError(
        "P1_DUPLICATE_PRODUCT",
        `Duplicate product id: ${p.id}`,
      );
    this.#products.set(p.id, deepFreeze({ ...p }));
  }
  get(id) {
    return this.#products.get(id) ?? null;
  }
  has(id) {
    return this.#products.has(id);
  }
  list() {
    return [...this.#products.values()];
  }
}
module.exports = { CatalogStore };

"use strict";
const { DomainError, deepFreeze } = require("./util");

const ALLOWED_FIELDS = [
  "id",
  "name",
  "price",
  "priceCents",
  "price_cents",
  "currency",
  "slug",
  "type",
  "durationDays",
  "scope",
];
const VALID_TYPES = ["COURSE", "SUBSCRIPTION", "BUNDLE"];

class CatalogStore {
  #products = new Map();
  #slugMap = new Map();

  constructor(products = []) {
    products.forEach((p) => this.add(p));
  }

  add(p) {
    // 1. Enforce P2: Only provider-agnostic fields allowed
    const extra = Object.keys(p).filter((k) => !ALLOWED_FIELDS.includes(k));
    if (extra.length) {
      throw new DomainError(
        "P2_PROVIDER_DATA",
        `Product has non-catalog fields: ${extra.join(", ")}`,
      );
    }

    // 2. Core Field Validations
    if (typeof p.id !== "string" || !p.id) {
      throw new DomainError("P1_INVALID_ID", "Product id must be a non-empty string");
    }
    if (typeof p.name !== "string" || !p.name) {
      throw new DomainError("P1_INVALID_NAME", "Product name required");
    }

    // Standardize price to main currency units (e.g. 20.00) and priceCents (e.g. 2000)
    let priceCents;
    if (typeof p.priceCents === "number") {
      priceCents = p.priceCents;
    } else if (typeof p.price_cents === "number") {
      priceCents = p.price_cents;
    } else if (typeof p.price === "number") {
      // If price is passed as integer >= 100, treat as cents; otherwise convert main unit to cents
      priceCents = p.price >= 100 && Number.isInteger(p.price) ? p.price : Math.round(p.price * 100);
    } else {
      throw new DomainError("P1_INVALID_PRICE", "Product price must be a valid number >= 0");
    }

    if (priceCents < 0) {
      throw new DomainError("P1_INVALID_PRICE", "Product price must be >= 0");
    }

    const priceMainUnit = Number((priceCents / 100).toFixed(2));
    const currency = p.currency || "USD";
    
// 3. Domain Metadata Defaults & Validation
    const type = p.type || "COURSE";
    if (!VALID_TYPES.includes(type)) {
      throw new DomainError(
        "P1_INVALID_TYPE",
        `Invalid product type '${type}'. Allowed: ${VALID_TYPES.join(", ")}`
      );
    }

    if (type === "SUBSCRIPTION") {
      if (typeof p.durationDays !== "number" || p.durationDays <= 0) {
        throw new DomainError(
          "P1_INVALID_DURATION",
          "Subscription product requires durationDays as a positive number"
        );
      }
    }

    // 4. Unique ID Guard
    if (this.#products.has(p.id)) {
      throw new DomainError("P1_DUPLICATE_PRODUCT", `Duplicate product id: ${p.id}`);
    }

    // 5. Build Normalized Immutably Frozen Item
    const slug = p.slug || p.id;
    const normalizedProduct = deepFreeze({
      id: p.id,
      slug,
      name: p.name,
      price: priceMainUnit,
      priceCents,
      currency,
      type,
      durationDays: p.durationDays || null,
      scope: p.scope || (type === "SUBSCRIPTION" ? "ALL_ACCESS" : null),
    });

    this.#products.set(p.id, normalizedProduct);
    this.#slugMap.set(slug, normalizedProduct);
  }

  get(idOrSlug) {
    if (!idOrSlug) return null;
    return this.#products.get(idOrSlug) ?? this.#slugMap.get(idOrSlug) ?? null;
  }

  has(idOrSlug) {
    return this.#products.has(idOrSlug) || this.#slugMap.has(idOrSlug);
  }

  isSubscription(idOrSlug) {
    const item = this.get(idOrSlug);
    return item?.type === "SUBSCRIPTION";
  }

  list() {
    return [...this.#products.values()];
  }

  listCourses() {
    return this.list().filter((p) => p.type === "COURSE");
  }

  listSubscriptions() {
    return this.list().filter((p) => p.type === "SUBSCRIPTION");
  }
}

module.exports = { CatalogStore };
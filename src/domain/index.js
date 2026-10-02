'use strict';
const { CatalogStore } = require('./catalog');
const { CommerceLedgerService } = require('./ledger');
const { EntitlementProjectionEngine } = require('./projection');
const { EntitlementDecisionEngine } = require('./decision');

// Wires the four services. `userExists` is injected so the domain stays independent of Postgres.
function createEngine({ products, userExists = id => typeof id === 'string' && id.length > 0 }) {
  const catalog = new CatalogStore(products);
  const ledger = new CommerceLedgerService({ catalog, userExists });
  const projection = new EntitlementProjectionEngine(ledger);
  const decisions = new EntitlementDecisionEngine(projection);
  return { catalog, ledger, projection, decisions };
}
module.exports = { createEngine };
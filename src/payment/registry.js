'use strict';
const { MockPaymentAdapter } = require('./adapters/mock');

// To add a provider: import its adapter and add one line here.
const registry = {
  mock: new MockPaymentAdapter(),
  // stripe: new StripePaymentAdapter(),
};

function getAdapter(name) {
  const a = registry[name];
  if (!a) throw new Error(`No payment adapter registered for provider: ${name}`);
  return a;
}

module.exports = { registry, getAdapter };
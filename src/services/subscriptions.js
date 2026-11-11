'use strict';
// M4 subscription lifecycle helpers (manual renewal model).
//   - Renew: the customer pays for another period through the normal checkout. If a pass of the
//     same scope is still active at checkout, the line is a renewal (SUBSCRIPTION_RENEWED) and
//     the new period starts when the current one ends.
//   - Cancel: SUBSCRIPTION_CANCELLED (source CUSTOMER). Access stays until the paid-up end date;
//     the renewal reminder stops. Paying for another period turns renewal back on.

const { randomUUID } = require('node:crypto');

const REMINDER_DAYS = Number(process.env.SUB_RENEWAL_REMINDER_DAYS || 7);

function activePass(projection, userId, scope = 'ALL_ACCESS') {
  const ent = projection.getSubscription(userId, scope || 'ALL_ACCESS');
  if (!ent || ent.status !== 'ACTIVE') return null;
  if (ent.expiresAt && Date.parse(ent.expiresAt) <= Date.now()) return null;
  return ent;
}

// True when buying this subscription line now would extend an active pass.
function isRenewal(projection, userId, scope) {
  return Boolean(activePass(projection, userId, scope));
}

// Days until the pass ends, when a renewal reminder should be shown (not cancelled, ending soon).
function renewalReminder(ent) {
  if (!ent || ent.cancelledAt || !ent.expiresAt) return null;
  const days = Math.ceil((Date.parse(ent.expiresAt) - Date.now()) / 86400e3);
  return days > 0 && days <= REMINDER_DAYS ? days : null;
}

async function cancelRenewal({ ledger, projection, user, scope = 'ALL_ACCESS' }) {
  const ent = activePass(projection, user.id, scope);
  if (!ent) return { ok: false, message: 'You have no active pass to cancel.' };
  if (ent.cancelledAt) return { ok: true, already: true, ent };
  await ledger.appendEvent(
    {
      eventId: `cancel_${randomUUID()}`,
      eventType: 'SUBSCRIPTION_CANCELLED',
      userId: user.id,
      productId: ent.productId,
      quantity: 1,
      amount: 0,
      currency: 'USD',
      occurredAt: new Date().toISOString(),
      referenceeventId: ent.sourceEventId, // the period currently at the end of the pass
      source: 'CUSTOMER',
      actor: `user:${user.id}`,
      reason: 'Customer turned off renewal',
    },
    { method: 'CUSTOMER_CANCEL' }
  );
  return { ok: true, ent: activePass(projection, user.id, scope) };
}

module.exports = { activePass, isRenewal, renewalReminder, cancelRenewal, REMINDER_DAYS };

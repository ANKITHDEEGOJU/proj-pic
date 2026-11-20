'use strict';
// M4 subscription lifecycle helpers (manual renewal model).
//   - Renew: the customer pays for another period through the normal checkout. If a pass of the
//     same scope is still active at checkout, the line is a renewal (SUBSCRIPTION_RENEWED) and
//     the new period starts when the current one ends.
//   - Cancel: SUBSCRIPTION_CANCELLED (source CUSTOMER). Access stays until the paid-up end date;
//     the renewal reminder stops. Paying for another period turns renewal back on.

const { randomUUID } = require('node:crypto');
const pool = require('../db');

// Periods that cost nothing (admin / scholarship grant, org seat): never refunded.
const FREE = ['MANUAL_GRANT', 'SEAT_ASSIGNED'];
// A renewal checkout that is still open blocks another Renew for this long.
const RENEW_PENDING_MINUTES = () => Number(process.env.RENEW_PENDING_MINUTES || 30);

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

// ---- the current pass -------------------------------------------------------------------------
// The current pass is every period that has not ended yet (the one running now and any paid
// in advance). Old periods that already ran out are history, not part of it.
const livePeriods = (ent, now = Date.now()) => (ent?.periods || []).filter((p) => Date.parse(p.endsAt) > now);
const livePaidPeriods = (ent, now = Date.now()) => livePeriods(ent, now).filter((p) => !FREE.includes(p.grantedVia));
// Renewals already paid for: paid periods that start in the future.
const queuedRenewals = (ent, now = Date.now()) => livePaidPeriods(ent, now).filter((p) => Date.parse(p.startsAt) > now);

// The order behind a ledger event (period), with what a provider refund needs.
async function periodOrder(ledger, eventId) {
  const rec = await ledger.getByEventId(eventId);
  const info = rec?.paymentInfo || {};
  return {
    eventId,
    record: rec,
    orderId: info.orderId || info.orderRef || null,
    provider: info.provider || null,
    providerPaymentId: info.providerPaymentId || null,
  };
}

// A renewal checkout started but not paid yet (only recent ones: an abandoned checkout must not
// block renewing forever).
async function pendingRenewalOrder(userId) {
  const { rows } = await pool.query(
    `SELECT o.id FROM orders o JOIN order_line_items li ON li.order_id = o.id
      WHERE o.user_id = $1 AND o.status = 'PENDING' AND li.item_type = 'SUBSCRIPTION' AND li.renewal
        AND o.created_at > now() - make_interval(mins => $2)
      LIMIT 1`,
    [userId, RENEW_PENDING_MINUTES()]
  );
  return rows[0]?.id || null;
}

// Everything the pass card needs to choose its buttons.
async function passState({ ledger, projection, userId, scope = 'ALL_ACCESS' }) {
  const ent = activePass(projection, userId, scope);
  if (!ent) return { ent: null, queued: [], paid: [], renewalPending: false, refundPending: false, canRenew: false };
  const paid = livePaidPeriods(ent);
  const queued = queuedRenewals(ent);
  const orderIds = [];
  for (const p of paid) {
    const o = await periodOrder(ledger, p.eventId);
    if (o.orderId) orderIds.push(String(o.orderId));
  }
  const refundPending = orderIds.length > 0 && (await pool.query(
    "SELECT 1 FROM orders WHERE id::text = ANY($1::text[]) AND status = 'REFUND_PENDING' LIMIT 1", [orderIds]
  )).rowCount > 0;
  const renewalPending = Boolean(await pendingRenewalOrder(userId));
  return {
    ent, paid, queued, renewalPending, refundPending,
    // One renewal at a time: no Renew while one is paid in advance, being paid, or a refund runs.
    canRenew: !queued.length && !renewalPending && !refundPending,
  };
}

// Why a new renewal is refused right now (null = allowed). Used by every way into a pass checkout.
async function renewBlocked({ ledger, projection, userId, scope = 'ALL_ACCESS' }) {
  const st = await passState({ ledger, projection, userId, scope });
  if (!st.ent) return null; // no active pass: this is a new purchase, not a renewal
  if (st.refundPending) return 'A refund of your pass is in progress.';
  if (st.queued.length) return `You have already renewed your pass (paid up to ${new Date(st.ent.expiresAt).toLocaleString()}).`;
  if (st.renewalPending) return 'A renewal payment is already in progress. Finish or cancel it first.';
  return null;
}

// ---- refunds ------------------------------------------------------------------------------------
// Refunds the orders behind the given paid periods. Each period was its own payment (possibly at a
// different provider), so each order gets its own provider refund. The order is claimed
// (REFUND_PENDING, refund_scope) first; the provider's refund webhook then writes the REFUND and
// marks it REFUNDED, exactly like any other refund. Purchases with no provider are refunded directly.
//   kind: 'PASS_FULL' (Refund: the whole pass) or 'RENEWAL_CANCEL' (Cancel renewal: queued periods)
async function refundPeriods({ ledger, catalog, user, periods, kind }) {
  const { PaymentService } = require('../payment/service');
  const byOrder = new Map();
  for (const p of periods) {
    const o = await periodOrder(ledger, p.eventId);
    const key = o.orderId ? `o:${o.orderId}` : `e:${p.eventId}`;
    if (!byOrder.has(key)) byOrder.set(key, { ...o, periods: [] });
    byOrder.get(key).periods.push(p);
  }
  const results = [];
  for (const o of byOrder.values()) {
    if (o.orderId && o.providerPaymentId) {
      const claim = await pool.query(
        `UPDATE orders SET status = 'REFUND_PENDING', refund_scope = $2, updated_at = now()
          WHERE id::text = $1 AND status IN ('COMPLETED','PENDING') RETURNING final_payable_cents`,
        [String(o.orderId), kind]
      );
      if (!claim.rowCount) {
        const st = (await pool.query('SELECT status FROM orders WHERE id::text = $1', [String(o.orderId)])).rows[0]?.status;
        results.push({ orderId: o.orderId, ok: st === 'REFUND_PENDING' || st === 'REFUNDED', status: st || 'MISSING' });
        continue;
      }
      try {
        const { providerRefundId } = await new PaymentService({ catalog }).initiateRefund({
          userId: user.id,
          productId: o.periods[0].productId,
          orderId: o.orderId,
          amount: claim.rows[0].final_payable_cents / 100,
          providerPaymentId: o.providerPaymentId,
          provider: o.provider || 'mock',
        });
        console.log(`[refund] ${kind}: ${o.provider} refund ${providerRefundId} requested for order ${o.orderId}; waiting for webhook`);
        results.push({ orderId: o.orderId, ok: true, status: 'REFUND_PENDING' });
      } catch (e) {
        await pool.query(
          "UPDATE orders SET status = 'COMPLETED', refund_scope = NULL, updated_at = now() WHERE id::text = $1 AND status = 'REFUND_PENDING'",
          [String(o.orderId)]
        );
        const msg = e.message || e.error?.description || (e.statusCode ? `provider returned HTTP ${e.statusCode}` : 'payment provider refused the refund');
        console.error(`[refund] ${kind}: provider refused order ${o.orderId}:`, msg);
        results.push({ orderId: o.orderId, ok: false, error: msg });
      }
    } else {
      // No provider behind it (e.g. dev-simulated events): nobody else will confirm, record it now.
      for (const p of o.periods) {
        try {
          await ledger.appendEvent(
            {
              eventId: `ref_${randomUUID()}:${p.productId}`,
              eventType: 'REFUND',
              userId: user.id,
              productId: p.productId,
              quantity: 1,
              amount: o.record?.event?.amount ?? 0,
              currency: o.record?.event?.currency || 'USD',
              occurredAt: new Date().toISOString(),
              referenceeventId: p.eventId,
              source: 'PAYMENT',
              actor: `user:${user.id}`,
              reason: kind === 'PASS_FULL' ? 'Pass refunded in full' : 'Renewal cancelled',
            },
            { ...(o.record?.paymentInfo || {}), method: 'DIRECT_REFUND' }
          );
        } catch (e) {
          if (e.code !== 'E1_ALREADY_REVERSED') { results.push({ eventId: p.eventId, ok: false, error: e.message }); continue; }
        }
        results.push({ eventId: p.eventId, ok: true, status: 'REFUNDED' });
      }
      if (o.orderId) {
        await pool.query("UPDATE orders SET status = 'REFUNDED', refund_scope = $2, updated_at = now() WHERE id::text = $1", [String(o.orderId), kind]);
      }
    }
  }
  if (kind === 'PASS_FULL') await finishPassRefund({ ledger, userId: user.id });
  return results;
}

// Refund (button): every paid period of the current pass, the running one and any renewal.
async function refundPass({ ledger, projection, catalog, user, scope = 'ALL_ACCESS' }) {
  const ent = activePass(projection, user.id, scope);
  const paid = livePaidPeriods(ent);
  if (!paid.length) return { ok: false, message: 'Nothing to refund.' };
  const results = await refundPeriods({ ledger, catalog, user, periods: paid, kind: 'PASS_FULL' });
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length < results.length, results, failed, periods: paid.length };
}

// Once every part of a full pass refund is done (no order of it still pending, no paid period
// left), the free periods of the pass (admin / scholarship grants) end too. Called after each
// refund webhook of a PASS_FULL order and after refundPeriods; safe to call repeatedly.
async function finishPassRefund({ ledger, userId, scope = 'ALL_ACCESS' }) {
  const projection = ledger.projection;
  if (!projection) return { ended: 0 };
  const pending = await pool.query(
    "SELECT 1 FROM orders WHERE user_id = $1 AND refund_scope = 'PASS_FULL' AND status = 'REFUND_PENDING' LIMIT 1", [userId]
  );
  if (pending.rowCount) return { ended: 0, waiting: true };
  const ent = activePass(projection, userId, scope);
  if (!ent || livePaidPeriods(ent).length) return { ended: 0 }; // a part failed: keep the rest
  let ended = 0;
  for (const p of livePeriods(ent).filter((x) => x.grantedVia === 'MANUAL_GRANT')) {
    try {
      const out = await ledger.appendEvent(
        {
          eventId: `pass_refund_end_${p.eventId}`, // one per free period, so repeats are duplicates
          eventType: 'MANUAL_REVOKE',
          userId,
          productId: p.productId,
          quantity: 1,
          amount: 0,
          currency: 'USD',
          occurredAt: new Date().toISOString(),
          referenceeventId: p.eventId,
          source: 'SYSTEM',
          actor: 'system',
          reason: `Pass refunded in full: ${p.source === 'SCHOLARSHIP' ? 'scholarship' : 'free'} period ended`,
        },
        { method: 'PASS_REFUND_END_FREE' }
      );
      if (out?.appended !== false) ended += 1;
    } catch (e) {
      if (e.code !== 'E1_ALREADY_REVERSED') throw e;
    }
  }
  return { ended };
}

// Cancel renewal. With a renewal already paid for (queued period), that renewal is refunded in
// full (nothing of it was used) and the current period stays. Without one it only turns the
// renewal reminder off. Either way the pass shows "Not renewing" and access lasts to the end.
async function cancelRenewal({ ledger, projection, catalog, user, scope = 'ALL_ACCESS' }) {
  const ent = activePass(projection, user.id, scope);
  if (!ent) return { ok: false, message: 'You have no active pass to cancel.' };
  const queued = queuedRenewals(ent);
  let refunded = null;
  if (queued.length) {
    refunded = await refundPeriods({ ledger, catalog, user, periods: queued, kind: 'RENEWAL_CANCEL' });
    if (!refunded.some((r) => r.ok)) {
      return { ok: false, message: `Could not refund the renewal: ${refunded.map((r) => r.error || r.status).join('; ')}` };
    }
  }
  const now = Date.now();
  const current = livePeriods(ent).find((p) => Date.parse(p.startsAt) <= now) || ent.periods[ent.periods.length - 1];
  if (ent.cancelledAt) return { ok: true, already: true, refunded, ent };
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
      referenceeventId: current.eventId, // the period running now (a queued renewal is being refunded)
      source: 'CUSTOMER',
      actor: `user:${user.id}`,
      reason: queued.length ? 'Customer cancelled the renewal (renewal refunded)' : 'Customer turned off renewal',
    },
    { method: 'CUSTOMER_CANCEL' }
  );
  return { ok: true, refunded, ent: activePass(projection, user.id, scope) };
}

// The pass card's options from passState.
const cardOpts = (st) => ({
  refundPending: st.refundPending,
  renewalPending: st.renewalPending,
  queuedUntil: st.queued.length ? st.ent.expiresAt : null,
  paidPeriods: st.paid.length,
});

module.exports = {
  cardOpts, activePass, isRenewal, renewalReminder, cancelRenewal, REMINDER_DAYS,
  livePeriods, livePaidPeriods, queuedRenewals, passState, renewBlocked, pendingRenewalOrder,
  refundPeriods, refundPass, finishPassRefund,
};

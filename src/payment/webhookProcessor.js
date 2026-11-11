'use strict';

const pool = require('../db');
const { EVENT_EFFECT } = require('../domain/util');

class WebhookProcessor {
  constructor({ ledger }) {
    this.ledger = ledger;
  }

  // Robust helper to resolve internal Postgres Order UUID from diverse gateway payloads
  #resolveOrderId(_raw) {
    if (!_raw) return null;
    const id = (
      _raw.orderId ||
      _raw.orderRef ||
      _raw.order_id ||
      _raw.notes?.orderId ||
      _raw.notes?.order_id ||
      _raw.receipt ||
      null
    );
    // orders.id is a UUID: ignore anything else instead of crashing the SQL query.
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)) ? String(id) : null;
  }

  // Provider-neutral description of the access an item gives (stored on the ledger event).
  #entitlementFor(productId, itemRow = null) {
    const product = this.ledger.catalog?.get(productId);
    const kind = itemRow?.item_type === 'SUBSCRIPTION' || product?.type === 'SUBSCRIPTION' ? 'SUBSCRIPTION' : 'COURSE';
    if (kind === 'COURSE') return { kind, scope: null, durationDays: null, expiresAt: null };
    return {
      kind,
      scope: itemRow?.scope || product?.scope || 'ALL_ACCESS',
      durationDays: Number(itemRow?.duration_days || product?.durationDays || 30),
      expiresAt: null,
    };
  }

  // What was really paid for a line (after coupons); older orders have no paid_cents.
  #lineAmount(itemRow) {
    const cents = itemRow.paid_cents ?? itemRow.unit_price_cents * (itemRow.quantity || 1);
    return Number(cents) / 100;
  }

  // A paid subscription is recorded as SUBSCRIPTION_STARTED, not a generic purchase.
  #grantType(entitlement) {
    return entitlement.kind === 'SUBSCRIPTION' ? 'SUBSCRIPTION_STARTED' : 'PURCHASE_SUCCEEDED';
  }

  // Appends an event. A provider confirming a reversal we already recorded ourselves
  // (e.g. the refund route wrote REFUND, then the refund webhook arrives) is a no-op.
  // A *different* reversal (refund already done, now a chargeback) still fails loudly.
  async #append(event, paymentInfo) {
    if (EVENT_EFFECT[event.eventType] === 'REVOKE' && event.referenceeventId) {
      const prior = await this.ledger.store.findReversalOf(event.referenceeventId);
      if (prior === event.eventType) return { appended: false, reason: 'ALREADY_REVERSED_SAME_TYPE' };
    }
    return this.ledger.appendEvent(event, paymentInfo);
  }

  // True when this event id is in the ledger, so the inbox row can point at it (FK).
  // Covers a refund the app already recorded under the same id as the provider's webhook.
  async #inLedger(result, eventId) {
    if (result.appended || result.reason === 'DUPLICATE_EVENT') return true;
    return result.reason === 'ALREADY_REVERSED_SAME_TYPE' && Boolean(await this.ledger.getByEventId(eventId));
  }

  async process(inboxRow, adapter) {
    const { id, raw_body } = inboxRow;

    await pool.query(
      `UPDATE webhook_inbox SET status='PROCESSING' WHERE id=$1`,
      [id]
    );

    let payload;
    try {
      payload = JSON.parse(raw_body);
    } catch {
      await this.#fail(id, 'INVALID_JSON');
      return { outcome: 'FAILED', reason: 'INVALID_JSON' };
    }

    const event = adapter.normalize(payload);
    if (!event) {
      await pool.query(
        `UPDATE webhook_inbox SET status='IGNORED', processed_at=now() WHERE id=$1`,
        [id]
      );
      return { outcome: 'IGNORED' };
    }

    // refund.failed is not a ledger event. Refunds count as done once the provider accepts
    // them, so a later failure means access was removed but the money did not go back:
    // flag the order for admin review (M6 reconciliation) instead of silently re-granting.
    if (event.eventType === 'REFUND_FAILED') {
      const orderId = this.#resolveOrderId(event._raw);
      let note = null;
      if (orderId) {
        const { rows } = await pool.query(
          `UPDATE orders SET status = CASE WHEN status='REFUND_PENDING' THEN 'COMPLETED' ELSE 'REFUND_FAILED' END,
                  updated_at=now()
            WHERE id=$1 AND status IN ('REFUND_PENDING','REFUNDED') RETURNING status`,
          [orderId]
        );
        if (rows[0]?.status === 'REFUND_FAILED') {
          note = 'Refund failed at provider after access was removed: needs admin review';
          console.warn(`[webhook] order ${orderId}: ${note}`);
        }
      }
      await pool.query(
        `UPDATE webhook_inbox SET status='PROCESSED', processed_at=now(), failure_reason=$2 WHERE id=$1`,
        [id, note]
      );
      return { outcome: 'REFUND_FAILED', orderId, needsReview: Boolean(note) };
    }

    const normalizedEvents = Array.isArray(event) ? event : [event];
    let lastLedgerEventId = null;
    let appendedAny = false;

    for (const singleEvent of normalizedEvents) {
      const { _raw, ...normalized } = singleEvent;
      const commerceEvent = { ...normalized, source: 'PAYMENT', actor: `provider:${adapter.name}` };
      const paymentInfo = { provider: adapter.name, ..._raw };
      const effect = EVENT_EFFECT[commerceEvent.eventType];
      const orderId = this.#resolveOrderId(_raw);

      try {
        let processedLineItems = false;

        // 1. Primary Path: Query DB order line items if orderId is resolved.
        //    A failed payment of a cart order is recorded per item too (no access change);
        //    its productId is the comma-joined cart, which is not a catalog product.
        const isFailed = commerceEvent.eventType === 'PURCHASE_FAILED';
        if (orderId && (commerceEvent.eventType === 'PURCHASE_SUCCEEDED' || isFailed)) {
          const itemsRes = await pool.query(
            `SELECT item_id, item_type, unit_price_cents, quantity, duration_days, scope, paid_cents
             FROM order_line_items 
             WHERE order_id = $1`,
            [orderId]
          );

          if (itemsRes.rows.length > 0) {
            processedLineItems = true;

            for (const itemRow of itemsRes.rows) {
              const entitlement = this.#entitlementFor(itemRow.item_id, itemRow);
              const lineItemEvent = {
                ...commerceEvent,
                eventType: isFailed ? 'PURCHASE_FAILED' : this.#grantType(entitlement),
                ...(isFailed ? {} : { entitlement }),
                eventId: `${commerceEvent.eventId}:${itemRow.item_id}`, // Unique, deterministic per item
                productId: itemRow.item_id,
                quantity: Number(itemRow.quantity || 1),
                amount: this.#lineAmount(itemRow),
              };

              // Attach line-item metadata so projection engine can process subscription scopes
              const linePaymentInfo = {
                ...paymentInfo,
                itemType: itemRow.item_type,
                durationDays: itemRow.duration_days,
                scope: itemRow.scope,
              };

              const result = await this.ledger.appendEvent(lineItemEvent, linePaymentInfo);
              if (result.appended) appendedAny = true;
              lastLedgerEventId = result.appended ? result.record.event.eventId : lineItemEvent.eventId;
            }

            // Mark order header as COMPLETED (a failed attempt leaves it PENDING: the
            // customer can still retry and pay the same Razorpay order).
            if (!isFailed) {
              await pool.query(
                "UPDATE orders SET status='COMPLETED', updated_at=now() WHERE id=$1",
                [orderId]
              );
            }
          }
        }

        // 2. Fallback Path: If DB line items aren't found but product ID is comma-separated
        if (!processedLineItems && (commerceEvent.eventType === 'PURCHASE_SUCCEEDED' || isFailed) && commerceEvent.productId?.includes(',')) {
          const productIds = commerceEvent.productId.split(',').map((s) => s.trim());
          const splitAmount = Number((commerceEvent.amount / productIds.length).toFixed(2));

          for (const pId of productIds) {
            const entitlement = this.#entitlementFor(pId);
            const splitEvent = {
              ...commerceEvent,
              eventType: isFailed ? 'PURCHASE_FAILED' : this.#grantType(entitlement),
              ...(isFailed ? {} : { entitlement }),
              eventId: `${commerceEvent.eventId}:${pId}`,
              productId: pId,
              amount: splitAmount,
            };

            const result = await this.ledger.appendEvent(splitEvent, paymentInfo);
            if (result.appended) appendedAny = true;
            lastLedgerEventId = result.appended ? result.record.event.eventId : splitEvent.eventId;
          }
          processedLineItems = true;
        }

        // 3. Refund / chargeback of an order: purchases were stored per item
        //    (`<paymentEventId>:<itemId>`), so reverse each item the same way.
        if (!processedLineItems && effect === 'REVOKE' && orderId) {
          const refExists = await this.ledger.getByEventId(commerceEvent.referenceeventId);
          if (!refExists) {
            const itemsRes = await pool.query(
              `SELECT item_id, unit_price_cents, quantity, paid_cents FROM order_line_items WHERE order_id = $1`,
              [orderId]
            );
            for (const itemRow of itemsRes.rows) {
              const itemEvent = {
                ...commerceEvent,
                eventId: `${commerceEvent.eventId}:${itemRow.item_id}`,
                referenceeventId: `${commerceEvent.referenceeventId}:${itemRow.item_id}`,
                productId: itemRow.item_id,
                quantity: Number(itemRow.quantity || 1),
                amount: this.#lineAmount(itemRow),
              };
              const result = await this.#append(itemEvent, paymentInfo);
              if (result.appended) appendedAny = true;
              // Only point the inbox row at events that really exist in the ledger (FK).
              if (await this.#inLedger(result, itemEvent.eventId)) lastLedgerEventId = itemEvent.eventId;
            }
            processedLineItems = itemsRes.rows.length > 0;
          }
        }

        // 4. Single Product / REFUND Path
        if (!processedLineItems) {
          if (effect === 'GRANT' && !commerceEvent.entitlement) {
            commerceEvent.entitlement = this.#entitlementFor(commerceEvent.productId);
            commerceEvent.eventType = this.#grantType(commerceEvent.entitlement);
          }
          const result = await this.#append(commerceEvent, paymentInfo);
          if (result.appended) appendedAny = true;
          if (await this.#inLedger(result, commerceEvent.eventId)) lastLedgerEventId = commerceEvent.eventId;
        }

        // Option A: the provider's confirmation is what finishes a refund/chargeback,
        // so this is where the order header changes state (not the refund button).
        if (effect === 'REVOKE' && orderId) {
          await pool.query(
            "UPDATE orders SET status=$2, updated_at=now() WHERE id=$1",
            [orderId, commerceEvent.eventType === 'CHARGEBACK' ? 'CHARGED_BACK' : 'REFUNDED']
          );
        }
      } catch (e) {
        await this.#fail(id, e.message);
        return { outcome: 'FAILED', reason: e.message };
      }
    }

    await pool.query(
      `UPDATE webhook_inbox SET status='PROCESSED', processed_at=now(), ledger_event_id=$2, failure_reason=NULL WHERE id=$1`,
      [id, lastLedgerEventId]
    );

    return {
      outcome: appendedAny ? 'APPENDED' : 'DUPLICATE',
      ledgerEventId: lastLedgerEventId,
    };
  }

  async #fail(id, reason) {
    await pool.query(
      `UPDATE webhook_inbox SET status='FAILED', processed_at=now(), failure_reason=$2 WHERE id=$1`,
      [id, reason]
    );
  }
}

module.exports = { WebhookProcessor };
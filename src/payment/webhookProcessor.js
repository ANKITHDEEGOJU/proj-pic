'use strict';

const pool = require('../db');

class WebhookProcessor {
  constructor({ ledger }) {
    this.ledger = ledger;
  }

  // Robust helper to resolve internal Postgres Order UUID from diverse gateway payloads
  #resolveOrderId(_raw) {
    if (!_raw) return null;
    return (
      _raw.orderId ||
      _raw.orderRef ||
      _raw.order_id ||
      _raw.notes?.orderId ||
      _raw.notes?.order_id ||
      _raw.receipt ||
      null
    );
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

    const normalizedEvents = Array.isArray(event) ? event : [event];
    let lastLedgerEventId = null;
    let appendedAny = false;

    for (const singleEvent of normalizedEvents) {
      const { _raw, ...commerceEvent } = singleEvent;
      const paymentInfo = { provider: adapter.name, ..._raw };
      const orderId = this.#resolveOrderId(_raw);

      try {
        let processedLineItems = false;

        // 1. Primary Path: Query DB order line items if orderId is resolved
        if (orderId && commerceEvent.eventType === 'PURCHASE_SUCCEEDED') {
          const itemsRes = await pool.query(
            `SELECT item_id, item_type, unit_price_cents, quantity, duration_days, scope 
             FROM order_line_items 
             WHERE order_id = $1`,
            [orderId]
          );

          if (itemsRes.rows.length > 0) {
            processedLineItems = true;

            for (const itemRow of itemsRes.rows) {
              const lineItemEvent = {
                ...commerceEvent,
                eventId: `${commerceEvent.eventId}:${itemRow.item_id}`, // Unique, deterministic per item
                productId: itemRow.item_id,
                quantity: Number(itemRow.quantity || 1),
                amount: Number((itemRow.unit_price_cents * (itemRow.quantity || 1)) / 100),
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

            // Mark order header as COMPLETED
            await pool.query(
              "UPDATE orders SET status='COMPLETED', updated_at=now() WHERE id=$1",
              [orderId]
            );
          }
        }

        // 2. Fallback Path: If DB line items aren't found but product ID is comma-separated
        if (!processedLineItems && commerceEvent.eventType === 'PURCHASE_SUCCEEDED' && commerceEvent.productId.includes(',')) {
          const productIds = commerceEvent.productId.split(',').map((s) => s.trim());
          const splitAmount = Number((commerceEvent.amount / productIds.length).toFixed(2));

          for (const pId of productIds) {
            const splitEvent = {
              ...commerceEvent,
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

        // 3. Single Product / REFUND Path
        if (!processedLineItems) {
          const result = await this.ledger.appendEvent(commerceEvent, paymentInfo);
          if (result.appended) appendedAny = true;
          lastLedgerEventId = result.appended ? result.record.event.eventId : commerceEvent.eventId;
        }
      } catch (e) {
        await this.#fail(id, e.message);
        return { outcome: 'FAILED', reason: e.message };
      }
    }

    await pool.query(
      `UPDATE webhook_inbox SET status='PROCESSED', processed_at=now(), ledger_event_id=$2 WHERE id=$1`,
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
'use strict';
// M6: compares what the payment provider says happened with the ledger / orders and
// repairs or escalates the differences.
//
// Safe repairs are made by REPLAYING the event the provider should have delivered (see
// adapter.recoveryEvent) through the normal webhook pipeline: same normalizer, same
// deterministic ledger ids, so a real webhook arriving later is just a duplicate, and the
// replay leaves an inbox row ("recon:<event>") as its audit trail.
//
//   auto-fixed (recon_issues.status = AUTO_FIXED)
//     MISSING_PURCHASE         paid at provider, no purchase in ledger (lost payment webhook)
//     MISSING_REFUND           refunded at provider, access still active (lost refund webhook)
//     STUCK_REFUND_FINALIZED   order REFUND_PENDING too long, provider has the refund
//     STUCK_REFUND_REOPENED    order REFUND_PENDING too long, provider has NO refund:
//                              nothing moved, so the order is reopened (customer can retry)
//     ORDER_STATUS             order header disagrees with the ledger (e.g. PENDING but paid)
//   escalated (OPEN, for an admin)
//     AMOUNT_MISMATCH, PARTIAL_REFUND, REFUNDED_NOT_AT_PROVIDER, LEDGER_PAYMENT_NOT_AT_PROVIDER,
//     UNKNOWN_PAYMENT, STUCK_REFUND_PENDING, REFUND_FAILED, WEBHOOK_DEAD, REPLAY_FAILED
//
// Run it inside the server (scheduler / admin page): fixes go through the server's ledger
// instance so the in-memory projection sees them.

const pool = require('../db');
const { registry } = require('./registry');
const { WebhookProcessor } = require('./webhookProcessor');

const GRANT_TYPES = ['PURCHASE_SUCCEEDED', 'SUBSCRIPTION_STARTED', 'SUBSCRIPTION_RENEWED'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Kinds whose whole population is checked on every run, so an OPEN issue that is no longer
// found has really gone away and can be closed automatically.
const SELF_RESOLVING = ['REFUND_FAILED', 'WEBHOOK_DEAD', 'STUCK_REFUND_PENDING'];

class Reconciler {
  constructor({
    ledger,
    adapters = registry,
    lookbackDays = Number(process.env.RECON_LOOKBACK_DAYS || 7),
    stuckMinutes = Number(process.env.RECON_STUCK_REFUND_MINUTES || 15),
    // Events younger than this are left alone: their webhook is probably still on its way.
    graceSeconds = Number(process.env.RECON_GRACE_SECONDS || 120),
    log = console,
  }) {
    this.ledger = ledger;
    this.adapters = adapters;
    this.providers = Object.keys(adapters);
    this.lookbackDays = lookbackDays;
    this.stuckMinutes = stuckMinutes;
    this.graceSeconds = graceSeconds;
    this.log = log;
    this.processor = new WebhookProcessor({ ledger });
  }

  async run({ trigger = 'script', since = null } = {}) {
    since = since ? new Date(since) : new Date(Date.now() - this.lookbackDays * 86400e3);
    const { rows } = await pool.query(
      'INSERT INTO recon_runs (trigger, since) VALUES ($1, $2) RETURNING id',
      [trigger, since]
    );
    const ctx = { runId: rows[0].id, since, fixed: [], issues: [], seen: new Set(), checked: {} };

    let error = null;
    try {
      for (const name of this.providers) {
        const adapter = this.adapters[name];
        if (adapter.supportsReconciliation) await this.#reconcileProvider(adapter, ctx);
      }
      await this.#stuckRefundPending(ctx);
      await this.#databaseChecks(ctx);
      await this.#autoResolve(ctx);
    } catch (e) {
      error = e.message || String(e);
      this.log.error?.('[recon] run failed:', e);
    }

    const summary = {
      checked: ctx.checked,
      fixed: ctx.fixed.length,
      openIssues: ctx.issues.length,
      byKind: [...ctx.fixed, ...ctx.issues].reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {}),
    };
    await pool.query('UPDATE recon_runs SET finished_at=now(), summary=$2, error=$3 WHERE id=$1', [
      ctx.runId,
      summary,
      error,
    ]);
    this.log.log?.(`[recon] run ${ctx.runId}: ${summary.fixed} fixed, ${summary.openIssues} open issue(s)${error ? `, error: ${error}` : ''}`);
    return { runId: ctx.runId, error, summary, fixed: ctx.fixed, issues: ctx.issues };
  }

  // ---- provider -> ledger -------------------------------------------------------------

  async #reconcileProvider(adapter, ctx) {
    const txns = await adapter.listTransactions({ since: ctx.since });
    // Payments with a refund in the window. The provider's payment list can lag behind its
    // refunds, so this (not txn.amountRefundedMinor) decides whose refunds get checked; it
    // also brings in older payments that were refunded inside the window.
    const refundedPids = new Set((await adapter.listRefunds({ since: ctx.since })).map((r) => r.providerPaymentId));
    const listed = new Set(txns.map((t) => t.providerPaymentId));
    for (const pid of refundedPids) {
      if (listed.has(pid)) continue;
      const t = await adapter.fetchPayment(pid);
      if (t) txns.push(t);
    }
    ctx.checked[adapter.name] = { payments: txns.length, refundedPayments: refundedPids.size };
    const youngLimit = Date.now() - this.graceSeconds * 1000;
    const orders = await this.#ordersById(txns.map((t) => t.orderRef));
    const seenPaymentIds = new Set();

    for (const txn of txns) {
      const hasRefund = refundedPids.has(txn.providerPaymentId);
      if (!txn.paid && !hasRefund) continue; // created / authorized / failed: no money taken
      seenPaymentIds.add(txn.providerPaymentId); // only PAID payments vouch for ledger purchases
      if (!hasRefund && new Date(txn.occurredAt).getTime() > youngLimit) continue;

      const order = orders.get(String(txn.orderRef));
      if (!order) {
        await this.#issue(ctx, 'UNKNOWN_PAYMENT', txn.providerPaymentId, {
          provider: adapter.name,
          details: { orderRef: txn.orderRef, amountMinor: txn.amountMinor, currency: txn.currency, status: txn.status },
        });
        continue;
      }
      await this.#reconcilePayment(adapter, txn, order, ctx, hasRefund);
    }

    // ledger -> provider: purchases we granted for payments the provider does not show as paid.
    const { rows } = await pool.query(
      `SELECT DISTINCT payment_info->>'providerPaymentId' AS pid, payment_info->>'orderId' AS order_id
         FROM commerce_ledger
        WHERE payment_info->>'provider' = $1 AND event_type = ANY($2)
          AND occurred_at >= $3 AND payment_info->>'providerPaymentId' IS NOT NULL`,
      [adapter.name, GRANT_TYPES, ctx.since]
    );
    for (const r of rows) {
      if (seenPaymentIds.has(r.pid)) continue;
      const txn = await adapter.fetchPayment(r.pid);
      if (!txn || !txn.paid) {
        await this.#issue(ctx, 'LEDGER_PAYMENT_NOT_AT_PROVIDER', r.pid, {
          provider: adapter.name,
          orderId: UUID_RE.test(r.order_id || '') ? r.order_id : null,
          details: { providerStatus: txn?.status || 'NOT_FOUND' },
        });
      }
    }
  }

  async #reconcilePayment(adapter, txn, order, ctx, hasRefund = false) {
    const pid = txn.providerPaymentId;
    const base = { provider: adapter.name, orderId: order.id };

    if (txn.amountMinor !== order.final_payable_cents) {
      await this.#issue(ctx, 'AMOUNT_MISMATCH', pid, {
        ...base,
        details: { providerAmountMinor: txn.amountMinor, orderAmountMinor: order.final_payable_cents, currency: txn.currency },
      });
    }

    // 1. Paid but never recorded -> replay the lost payment webhook.
    let purchases = await this.#purchasesFor(adapter.name, pid);
    if (purchases.length === 0) {
      const ok = await this.#replay(ctx, adapter, adapter.recoveryEvent('purchase', txn), 'MISSING_PURCHASE', pid, base);
      if (!ok) return;
      purchases = await this.#purchasesFor(adapter.name, pid);
    }

    // 2. Refunds: compare provider refunds with ledger reversals.
    const reversals = await this.#reversalsOf(purchases.map((p) => p.event_id));
    const unreversed = purchases.filter((p) => !reversals.has(p.event_id));
    const refunds = hasRefund || txn.amountRefundedMinor > 0 || txn.status === 'refunded' ? await adapter.fetchRefunds(pid) : [];
    const liveRefunds = refunds.filter((r) => r.status !== 'failed');

    if (liveRefunds.length > 0) {
      const refundedMinor = liveRefunds.reduce((s, r) => s + r.amountMinor, 0);
      if (refundedMinor < txn.amountMinor) {
        await this.#issue(ctx, 'PARTIAL_REFUND', pid, {
          ...base,
          details: { refundedMinor, paidMinor: txn.amountMinor, refunds: liveRefunds.map((r) => r.providerRefundId) },
        });
      }
      if (unreversed.length > 0) {
        const refund = liveRefunds[0];
        const created = Number(refund.raw?.created_at || 0) * 1000;
        if (!created || created <= Date.now() - this.graceSeconds * 1000) {
          await this.#replay(ctx, adapter, adapter.recoveryEvent('refund', txn, refund), 'MISSING_REFUND', refund.providerRefundId, {
            ...base,
            details: { providerPaymentId: pid, unreversedItems: unreversed.map((p) => p.product_id) },
          });
        }
      }
    } else {
      // Provider has no refund, but the ledger says this payment was refunded: the customer
      // lost access without getting the money back (or a dev/manual refund was recorded).
      const refundedHere = [...reversals.values()].filter((t) => t === 'REFUND').length;
      if (refundedHere > 0) {
        await this.#issue(ctx, 'REFUNDED_NOT_AT_PROVIDER', pid, {
          ...base,
          details: { refundEventsInLedger: refundedHere, providerStatus: txn.status },
        });
      }
    }

    // 3. Order header vs ledger.
    await this.#syncOrderStatus(ctx, adapter.name, order.id, pid);
  }

  // Sets the order header from the ledger when they disagree in a safe direction.
  async #syncOrderStatus(ctx, provider, orderId, pid) {
    const purchases = await this.#purchasesFor(provider, pid);
    if (purchases.length === 0) return;
    const reversals = await this.#reversalsOf(purchases.map((p) => p.event_id));
    const types = purchases.map((p) => reversals.get(p.event_id) || null);
    let expected = null;
    if (types.every((t) => t === null)) expected = 'COMPLETED';
    else if (types.every((t) => t === 'REFUND')) expected = 'REFUNDED';
    else if (types.every((t) => t === 'CHARGEBACK')) expected = 'CHARGED_BACK';
    if (!expected) return; // mixed: leave it to a human

    // Only move PENDING -> COMPLETED and COMPLETED/PENDING/REFUND_PENDING -> REFUNDED/CHARGED_BACK.
    // REFUND_PENDING with nothing reversed is the stuck-refund check's job; REFUND_FAILED needs a human.
    const from = expected === 'COMPLETED' ? ['PENDING'] : ['PENDING', 'COMPLETED', 'REFUND_PENDING'];
    const { rows } = await pool.query(
      `UPDATE orders o SET status=$2, updated_at=now()
         FROM (SELECT status AS old FROM orders WHERE id=$1) prev
        WHERE o.id=$1 AND o.status = ANY($3) RETURNING prev.old`,
      [orderId, expected, from]
    );
    if (rows[0]) {
      await this.#fixed(ctx, 'ORDER_STATUS', `${orderId}:${expected}`, {
        provider,
        orderId,
        details: { from: rows[0].old, to: expected },
      });
    }
  }

  // ---- orders stuck in REFUND_PENDING ---------------------------------------------------

  async #stuckRefundPending(ctx) {
    const { rows: stuck } = await pool.query(
      `SELECT id, provider, updated_at FROM orders
        WHERE status='REFUND_PENDING' AND provider = ANY($1)
          AND updated_at < now() - make_interval(mins => $2)`,
      [this.providers, this.stuckMinutes]
    );
    for (const order of stuck) {
      const adapter = this.adapters[order.provider];
      const base = { provider: order.provider, orderId: order.id };
      const { rows } = await pool.query(
        `SELECT DISTINCT payment_info->>'providerPaymentId' AS pid FROM commerce_ledger
          WHERE payment_info->>'orderId' = $1 AND event_type = ANY($2)`,
        [order.id, GRANT_TYPES]
      );
      const pid = rows[0]?.pid;
      if (!adapter?.supportsReconciliation || !pid) {
        await this.#issue(ctx, 'STUCK_REFUND_PENDING', order.id, {
          ...base,
          details: { since: order.updated_at, reason: !pid ? 'no paid purchase for this order' : 'provider cannot be queried' },
        });
        continue;
      }

      const txn = await adapter.fetchPayment(pid);
      const refunds = txn ? (await adapter.fetchRefunds(pid)).filter((r) => r.status !== 'failed') : [];
      if (txn && refunds.length > 0) {
        // The refund exists, its webhook was lost: replay it (finishes the order).
        await this.#replay(ctx, adapter, adapter.recoveryEvent('refund', txn, refunds[0]), 'STUCK_REFUND_FINALIZED', order.id, {
          ...base,
          details: { providerPaymentId: pid, providerRefundId: refunds[0].providerRefundId },
        });
      } else if (txn) {
        // The provider never got the refund (e.g. crash between claim and API call):
        // nothing moved, so reopen the order and let the customer try again.
        const r = await pool.query(
          "UPDATE orders SET status='COMPLETED', updated_at=now() WHERE id=$1 AND status='REFUND_PENDING'",
          [order.id]
        );
        if (r.rowCount) {
          await this.#fixed(ctx, 'STUCK_REFUND_REOPENED', `${order.id}:${order.updated_at.toISOString()}`, {
            ...base,
            details: { providerPaymentId: pid, pendingSince: order.updated_at },
          });
        }
      } else {
        await this.#issue(ctx, 'STUCK_REFUND_PENDING', order.id, {
          ...base,
          details: { since: order.updated_at, reason: 'payment not found at provider', providerPaymentId: pid },
        });
      }
    }
  }

  // ---- provider-independent checks ------------------------------------------------------

  async #databaseChecks(ctx) {
    const { rows: failedRefunds } = await pool.query(
      `SELECT id, provider, updated_at FROM orders WHERE status='REFUND_FAILED' AND provider = ANY($1)`,
      [this.providers]
    );
    for (const o of failedRefunds) {
      await this.#issue(ctx, 'REFUND_FAILED', o.id, {
        provider: o.provider,
        orderId: o.id,
        details: { since: o.updated_at, hint: 'Refund failed at the provider after access was removed' },
      });
    }

    // DEAD rows, plus FAILED rows that will never be retried (failed before M2 existed).
    const { rows: dead } = await pool.query(
      `SELECT id, provider, provider_event_id, failure_reason, attempts, status FROM webhook_inbox
        WHERE provider = ANY($1)
          AND (status='DEAD' OR (status='FAILED' AND next_retry_at IS NULL))`,
      [this.providers]
    );
    for (const w of dead) {
      await this.#issue(ctx, 'WEBHOOK_DEAD', String(w.id), {
        provider: w.provider,
        details: { providerEventId: w.provider_event_id, reason: w.failure_reason, attempts: w.attempts, status: w.status },
      });
    }
  }

  async #autoResolve(ctx) {
    const seen = [...ctx.seen];
    await pool.query(
      `UPDATE recon_issues SET status='RESOLVED', resolved_at=now(), resolved_by='recon:auto',
              note='No longer detected'
        WHERE status='OPEN' AND kind = ANY($1) AND provider = ANY($2)
          AND NOT ((kind || '|' || ref) = ANY($3))`,
      [SELF_RESOLVING, this.providers, seen]
    );
  }

  // ---- helpers -------------------------------------------------------------------------

  async #ordersById(ids) {
    const valid = [...new Set(ids.filter((id) => id && UUID_RE.test(String(id))).map(String))];
    if (valid.length === 0) return new Map();
    const { rows } = await pool.query(
      'SELECT id, provider, status, final_payable_cents FROM orders WHERE id = ANY($1::uuid[])',
      [valid]
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  async #purchasesFor(provider, providerPaymentId) {
    const { rows } = await pool.query(
      `SELECT event_id, product_id FROM commerce_ledger
        WHERE payment_info->>'provider' = $1 AND payment_info->>'providerPaymentId' = $2
          AND event_type = ANY($3)`,
      [provider, providerPaymentId, GRANT_TYPES]
    );
    return rows;
  }

  // Map of purchase event id -> type of the event that reversed it.
  async #reversalsOf(eventIds) {
    if (eventIds.length === 0) return new Map();
    const { rows } = await pool.query(
      'SELECT reference_event_id, event_type FROM commerce_ledger WHERE reference_event_id = ANY($1)',
      [eventIds]
    );
    return new Map(rows.map((r) => [r.reference_event_id, r.event_type]));
  }

  // Feeds a rebuilt provider event through the webhook pipeline. Returns true on success.
  async #replay(ctx, adapter, { eventKey, payload }, kind, ref, meta) {
    const { rows } = await pool.query(
      `INSERT INTO webhook_inbox (provider, provider_event_id, raw_body, headers)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_event_id) DO UPDATE SET status = webhook_inbox.status
       RETURNING *`,
      [adapter.name, `recon:${eventKey}`, JSON.stringify(payload), JSON.stringify({ 'x-recon-run': String(ctx.runId) })]
    );
    const row = rows[0];
    const result = row.status === 'PROCESSED' ? { outcome: 'DUPLICATE' } : await this.processor.process(row, adapter);
    if (result.outcome === 'FAILED' || result.outcome === 'IN_PROGRESS') {
      await this.#issue(ctx, 'REPLAY_FAILED', `${kind}:${ref}`, {
        ...meta,
        details: { ...(meta.details || {}), inboxId: row.id, reason: result.reason || result.outcome },
      });
      return false;
    }
    await this.#fixed(ctx, kind, ref, {
      ...meta,
      details: { ...(meta.details || {}), inboxId: row.id, outcome: result.outcome, ledgerEventId: result.ledgerEventId || null },
    });
    return true;
  }

  async #issue(ctx, kind, ref, { provider = null, orderId = null, details = {} } = {}) {
    ctx.seen.add(`${kind}|${ref}`);
    await pool.query(
      `INSERT INTO recon_issues (kind, provider, ref, order_id, details, status, first_run_id, last_run_id)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $6)
       ON CONFLICT (kind, ref) WHERE status = 'OPEN'
       DO UPDATE SET last_seen_at=now(), last_run_id=EXCLUDED.last_run_id, details=EXCLUDED.details`,
      [kind, provider, ref, orderId, details, ctx.runId]
    );
    ctx.issues.push({ kind, ref, provider, orderId, details });
  }

  async #fixed(ctx, kind, ref, { provider = null, orderId = null, details = {} } = {}) {
    const { rowCount } = await pool.query(
      `INSERT INTO recon_issues (kind, provider, ref, order_id, details, status, first_run_id, last_run_id, resolved_at, resolved_by)
       VALUES ($1, $2, $3, $4, $5, 'AUTO_FIXED', $6, $6, now(), 'recon:auto')
       ON CONFLICT (kind, ref) WHERE status = 'AUTO_FIXED' DO NOTHING`,
      [kind, provider, ref, orderId, details, ctx.runId]
    );
    if (rowCount) {
      ctx.fixed.push({ kind, ref, provider, orderId, details });
      this.log.log?.(`[recon] fixed ${kind} ${ref}`);
    }
  }
}

module.exports = { Reconciler };

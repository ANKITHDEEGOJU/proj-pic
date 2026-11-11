'use strict';
// M2: re-processes webhook inbox rows that did not finish, from the stored raw body.
//   - FAILED rows whose backoff time (next_retry_at) has passed
//   - PROCESSING rows whose lease expired (the process died mid-attempt)
//   - RECEIVED rows that were stored but never processed (crash right after the insert)
// Rows that run out of attempts become DEAD (see WebhookProcessor.markFailed) and are
// reported by reconciliation; an admin can re-queue them from /admin/reconciliation.

const pool = require('../db');
const { getAdapter } = require('./registry');
const { WebhookProcessor } = require('./webhookProcessor');

// `ids` (optional) restricts the run to those inbox rows (used by tests).
async function retryDueWebhooks({ ledger, limit = 25, ids = null, log = console } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM webhook_inbox
      WHERE ((status IN ('FAILED','PROCESSING') AND next_retry_at <= now())
          OR (status = 'RECEIVED' AND received_at < now() - interval '2 minutes'))
        AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
      ORDER BY received_at
      LIMIT $1`,
    [limit, ids]
  );

  const processor = new WebhookProcessor({ ledger });
  const results = [];
  for (const row of rows) {
    let adapter;
    try {
      adapter = getAdapter(row.provider);
    } catch (e) {
      await processor.markFailed(row.id, e.message);
      results.push({ id: row.id, outcome: 'FAILED', reason: e.message });
      continue;
    }
    try {
      // process() claims the row first, so a provider redelivery handled by the webhook
      // route at the same moment cannot double-process it.
      const r = await processor.process(row, adapter);
      results.push({ id: row.id, providerEventId: row.provider_event_id, ...r });
    } catch (e) {
      await processor.markFailed(row.id, e.message).catch(() => {});
      results.push({ id: row.id, outcome: 'FAILED', reason: e.message });
    }
  }
  const done = results.filter((r) => r.outcome !== 'FAILED' && r.outcome !== 'IN_PROGRESS').length;
  if (results.length) log.log?.(`[retry] ${results.length} inbox row(s) retried, ${done} finished`);
  return results;
}

// Puts a DEAD (or FAILED) row back in the queue for an immediate retry with a fresh budget.
async function requeueWebhook(id) {
  const { rowCount } = await pool.query(
    `UPDATE webhook_inbox SET status='FAILED', attempts=0, next_retry_at=now()
      WHERE id=$1 AND status IN ('DEAD','FAILED')`,
    [id]
  );
  return rowCount === 1;
}

// Runs fn every intervalMs without overlapping runs; returns a stop() function.
function startInterval(name, intervalMs, fn) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}] run failed:`, e.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { retryDueWebhooks, requeueWebhook, startInterval };

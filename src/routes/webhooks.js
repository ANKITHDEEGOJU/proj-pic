"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { getAdapter } = require("../payment/registry");
const { WebhookProcessor } = require("../payment/webhookProcessor");

// Webhooks need the raw body for signature verification.
// This route is mounted BEFORE express.json() in server.js so req.body is a raw Buffer.
// express.raw() here handles any Content-Type (providers send application/json but we verify bytes).
router.post(
  "/webhooks/:provider",
  express.raw({ type: () => true }), // capture raw bytes regardless of Content-Type
  async (req, res) => {
    const adapter = (() => {
      try {
        return getAdapter(req.params.provider);
      } catch {
        return null;
      }
    })();
    if (!adapter) return res.status(404).json({ error: "Unknown provider" });

    // 1. Signature check on RAW bytes before any parsing.
    if (!adapter.verifyWebhook(req.body, req.headers)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body);
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const providerEventId =
      payload.providerRefundId || payload.providerPaymentId;
    if (!providerEventId)
      return res.status(400).json({ error: "Missing providerPaymentId" });

    // 2. Write raw payload to inbox first (idempotent via ON CONFLICT).
    const { rows } = await pool.query(
      `INSERT INTO webhook_inbox (provider, provider_event_id, raw_body, headers)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_event_id) DO UPDATE SET status=webhook_inbox.status
       RETURNING *`,
      [adapter.name, providerEventId, rawBody, JSON.stringify(req.headers)],
    );
    const row = rows[0];

    // 3. Already handled - return 200 so provider stops retrying.
    if (row.status === "PROCESSED" || row.status === "IGNORED") {
      return res.json({ received: true, outcome: row.status });
    }

    // 4. Normalize → append to ledger → update inbox status.
    const processor = new WebhookProcessor({
      ledger: req.app.locals.engine.ledger,
    });
    const result = await processor.process(row, adapter);
    res.json({ received: true, ...result });
  },
);

module.exports = router;

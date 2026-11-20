'use strict';

require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require('./db');
const { attachUser } = require("./auth");
const { createEngine } = require("./domain");
const { loadProducts } = require("./domain/catalogLoader");
const { PgLedgerStore } = require('./domain/stores/pgLedgerStore');

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");

// Secrets still equal to the public example values in .env.example can be used by anyone to sign
// sessions (become admin) or forge mock payment webhooks. Warn loudly; refuse in production.
{
  const fs = require('fs');
  const example = (() => { try { return fs.readFileSync(require('path').join(__dirname, '..', '.env.example'), 'utf8'); } catch { return ''; } })();
  const exampleValue = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(example)?.[1] || '').trim();
  const weak = ['JWT_SECRET', 'MOCK_WEBHOOK_SECRET', 'AGENT_APPROVAL_SECRET']
    .filter((k) => process.env[k] && (process.env[k].trim() === exampleValue(k) || process.env[k].trim().length < 16));
  // Unset MOCK_WEBHOOK_SECRET: the mock provider's webhooks are all rejected (no built-in default).
  if (!process.env.MOCK_WEBHOOK_SECRET) console.warn('\n[security] MOCK_WEBHOOK_SECRET is not set: every mock-provider webhook will be rejected.\n');
  if (weak.length) {
    const msg = `[security] ${weak.join(', ')} still use the example value from .env.example (or are shorter than 16 characters). Anyone who knows it can forge sessions or payments. Set new random values: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    console.warn('\n' + msg + '\n');
  }
}
// An unexpected async error must not take the whole server down (Express 4 does not catch them).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

(async () => {
  const app = express();
  // Behind a tunnel or proxy on this machine (ngrok), every request comes from 127.0.0.1; trusting a
  // local proxy makes req.ip the real visitor (X-Forwarded-For), so per-IP limits are per visitor.
  // Only a proxy on this machine is trusted, so a remote client can't fake its IP with that header.
  // TRUST_PROXY overrides it (e.g. "false", a hop count like "1", or an address list).
  {
    const tp = process.env.TRUST_PROXY ?? 'loopback';
    app.set('trust proxy', tp === 'false' ? false : tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
  }
    // Ledger lives in Postgres (set LEDGER_STORE=memory only for throwaway runs).
  const store = new PgLedgerStore(pool);
  const engine = createEngine({ products: await loadProducts(), store }); // catalog mirrors Postgres courses

  await engine.projection.rebuildFromLedger();           // EN4: projection is recovered from the ledger at boot
  app.locals.engine = engine;

  // Webhooks MUST come before express.json() so express.raw() can capture the raw bytes.
  app.use(require('./routes/webhooks'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(require('./services/cartSession')); // keeps the applied coupon across page loads
  app.use(attachUser);
  // Debug only (LOG_REQUESTS=1): log every POST with its form fields. Passwords, secrets and
  // tokens are never written to the log.
  if (process.env.LOG_REQUESTS === '1') {
    app.use((req, res, next) => {
      if (req.method === 'POST') {
        const body = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
        if (body && typeof body === 'object') for (const k of Object.keys(body)) if (/pass(word)?|secret|token/i.test(k)) body[k] = '[redacted]';
        console.log(`[${new Date().toISOString()}] POST ${req.path}`, body);
      }
      next();
    });
  }
  app.use(require("./routes/auth"));
  app.use(require("./routes/admin"));
  app.use(require("./routes/content"));       // course guides (admin publishes, access-checked)
  app.use(require("./routes/courses"));
  app.use(require("./routes/cart"));
  app.use(require("./routes/commerce"));
  app.use(require("./routes/checkout"));
  app.use(require("./routes/subscription")); // M4: renew / cancel renewal
  app.use(require("./routes/org"));          // M4: organizations and seat packs
  app.use(require("./routes/ai"));           // M5: quota-limited AI summary
  app.use(require("./routes/agent"));        // M7: agent-approved purchases
  const port = 3000;

  app.use(require('./errorHandler')); // generic message + reference; details only in the log

  // M2: retry webhook inbox rows that failed or were interrupted (backoff per row).
  // M6: reconcile provider state with the ledger. Both run in this process so their
  // ledger writes reach the in-memory projection. Set an interval to 0 to disable it.
  const { retryDueWebhooks, startInterval } = require('./payment/retryWorker');
  const { Reconciler } = require('./payment/reconcile');
  app.locals.reconciler = new Reconciler({ ledger: engine.ledger });
  const retryMs = Number(process.env.WEBHOOK_RETRY_INTERVAL_MS ?? 30_000);
  const reconMs = Number(process.env.RECON_INTERVAL_MS ?? 15 * 60_000);
  if (retryMs > 0) startInterval('retry', retryMs, () => retryDueWebhooks({ ledger: engine.ledger }));
  if (reconMs > 0) startInterval('recon', reconMs, () => app.locals.reconciler.run({ trigger: 'scheduled' }));
  // M7: expire stale agent purchase requests, fail executed ones whose payment never completed.
  const agentSweepMs = Number(process.env.AGENT_SWEEP_INTERVAL_MS ?? 60_000);
  if (agentSweepMs > 0) startInterval('agent-sweep', agentSweepMs, () => require('./services/agentPurchase').sweep());
  // Assistant log retention (ASSISTANT_LOG_DAYS, default 90; 0 keeps everything): checked hourly.
  startInterval('assistant-log-purge', 60 * 60_000, () => require('./services/assistant').purgeLog());

  await require('./services/courseDocs').refresh(); // which courses have a published guide (course cards)
  app.listen(port, () => console.log("LEARNX :- " + port));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

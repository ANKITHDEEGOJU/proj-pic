require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require('./db');
const { attachUser } = require("./auth");
const { createEngine } = require("./domain");
const { loadProducts } = require("./domain/catalogLoader");
const { PgLedgerStore } = require('./domain/stores/pgLedgerStore');

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");

(async () => {
  const app = express();
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
  app.use(attachUser);
  app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`\n[${new Date().toISOString()}] POST ${req.path}`);
    console.log('Headers:', { 'content-type': req.headers['content-type'], 'hx-request': req.headers['hx-request'] });
    console.log('Body:', req.body);
  }
  next();
});
  app.use(require("./routes/auth"));
  app.use(require("./routes/admin"));
  app.use(require("./routes/courses"));
  app.use(require("./routes/cart"));
  app.use(require("./routes/commerce"));
  app.use(require("./routes/checkout"));
  const port = 3000;

  app.use((err, req, res, _next) => {
    console.error(err);
    if (req.get('HX-Request')) return res.status(500).send('<span class="err">Server error. Check logs.</span>');
    res.status(500).json({ error: err.message });
  });

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

  app.listen(port, () => console.log("LEARNX :- " + port));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

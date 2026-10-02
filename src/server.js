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
  const store = process.env.LEDGER_STORE === 'memory' ? undefined : new PgLedgerStore(pool);
  const engine = createEngine({ products: await loadProducts(), store }); // catalog mirrors Postgres courses
  await engine.projection.rebuildFromLedger();           // EN4: projection is recovered from the ledger at boot
  app.locals.engine = engine;
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.use(require("./routes/auth"));
  app.use(require("./routes/commerce"));
  app.use(require("./routes/courses"));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("LearnX on :" + port));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

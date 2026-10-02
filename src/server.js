require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const { attachUser } = require("./auth");
const { createEngine } = require("./domain");
const { loadProducts } = require("./domain/catalogLoader");

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");

(async () => {
  const app = express();
  app.locals.engine = createEngine({ products: await loadProducts() }); // catalog mirrors Postgres courses
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.use(require("./routes/auth"));
  app.use(require("./routes/commerce"));
  app.use(require("./routes/courses"));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("StreamFlix on :" + port));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

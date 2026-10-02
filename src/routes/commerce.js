const router = require("express").Router();
const { randomUUID } = require("node:crypto");
const { requireAuth } = require("../auth");
const { DomainError } = require("../domain/util");

// GET /api/access/:productId -> EntitlementDecision for the logged-in user
router.get("/api/access/:productId", requireAuth, (req, res) =>
  res.json(
    req.app.locals.engine.decisions.evaluateAccess(
      req.user.id,
      req.params.productId,
    ),
  ),
);

// GET /api/ledger -> this user's ledger rows (audit view)
router.get("/api/ledger", requireAuth, (req, res) =>
  res.json(
    req.app.locals.engine.ledger
      .getAll()
      .filter((r) => r.event.userId === req.user.id),
  ),
);

// DEV ONLY: simulate provider events until the real provider is integrated.
router.post("/api/dev/events", requireAuth, (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).end();
  const { catalog, ledger } = req.app.locals.engine;
  const b = req.body || {};
  const product = catalog.get(b.productId);
  const quantity = b.quantity ?? 1;
  try {
    const out = ledger.appendEvent(
      {
        eventId: b.eventId || `evt_${randomUUID()}`,
        eventType: b.eventType,
        userId: req.user.id,
        productId: b.productId,
        quantity,
        amount: b.amount ?? (product ? product.price * quantity : 0),
        currency: b.currency || product?.currency || "INR",
        occurredAt: new Date().toISOString(),
        referenceeventId: b.referenceeventId ?? null,
      },
      { method: "DEV_SIMULATOR" },
    );
    res.status(out.appended ? 201 : 200).json(out);
  } catch (e) {
    if (e instanceof DomainError)
      return res.status(400).json({ code: e.code, message: e.message });
    throw e;
  }
});

module.exports = router;

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

// DEV ONLY: simulate provider events. Writing ledger events directly bypasses payment, so the
// route exists only when ENABLE_DEV_EVENTS=1 and only for the admin (it used to let any logged-in
// user grant themselves any course or pass).
router.post("/api/dev/events", requireAuth, async (req, res) => {
  if (process.env.ENABLE_DEV_EVENTS !== "1" || !req.user.isAdmin) return res.status(404).end();
  const { catalog, ledger } = req.app.locals.engine;
  const b = req.body || {};
  const product = catalog.get(b.productId);
  const quantity = b.quantity ?? 1;
  try {
    const out = await ledger.appendEvent(
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
        source: b.source,
        actor: b.actor ?? `dev:${req.user.id}`,
        reason: b.reason,
        entitlement: b.entitlement,
      },
      { method: "DEV_SIMULATOR" },
    );
    res.status(out.appended ? 201 : 200).json(out);
  } catch (e) {
    if (e instanceof DomainError)
      return res.status(400).json({ code: e.code, message: e.message });
    console.error("[dev-events]", e);
    res.status(500).json({ error: "could not record the event" });
  }
});

module.exports = router;

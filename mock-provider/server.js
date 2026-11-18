"use strict";
/**
 * Mock Payment Provider – a completely separate Express process on port 3001.
 * StreamFlix knows nothing about this file.
 * It receives redirects from the browser, shows a fake payment page, and fires
 * a real HTTP POST webhook back to StreamFlix on approval or failure.
 */
require("dotenv").config({ path: "../.env" });
const express = require("express");
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const STREAMFLIX_URL = process.env.STREAMFLIX_URL 
const MOCK_SECRET = process.env.MOCK_WEBHOOK_SECRET 
const PORT = process.env.MOCK_PROVIDER_PORT 

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// ---- provider-side records ------------------------------------------------------------
// What the provider itself knows about payments and refunds. StreamFlix's reconciliation
// reads these through /api/* (like Razorpay's payments API), so an event whose webhook was
// lost can still be found and repaired. Saved to data.json so a restart keeps them.
const DATA_FILE = path.join(__dirname, "data.json");
let store = { payments: {} };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* first run */ }
const save = () => fs.writeFile(DATA_FILE, JSON.stringify(store, null, 1), () => {});

function recordPayment(id, fields) {
  const p = store.payments[id] || { id, refunds: [], createdAt: new Date().toISOString() };
  store.payments[id] = Object.assign(p, fields);
  save();
  return p;
}
function recordRefund(paymentId, refund) {
  const p = store.payments[paymentId];
  p.refunds.push(refund);
  const refunded = p.refunds.reduce((sum, r) => sum + r.amount, 0);
  if (refunded >= p.amount - 1e-9) p.status = "refunded";
  save();
}

// ---- failure switches (M8) --------------------------------------------------------------
// Set on /admin. Each switch applies to the next `count` matching calls (0 = until turned off).
//   duplicate   every webhook is sent 3 times (2 at once, 1 more after 3 s)
//   delay       webhooks are sent `delaySec` seconds late
//   reorder     payment webhooks are held; a refund of that payment is sent first, then the
//               held payment (use "Refund at provider" on /admin, or "Release")
//   drop        webhooks are never sent (reconciliation must find them)
//   refund_500  the refund API answers HTTP 500 and records nothing
const MODES = {
  off: "Off (normal)",
  duplicate: "Duplicate webhooks",
  delay: "Delay webhooks",
  reorder: "Reorder: hold payment webhooks until a refund",
  drop: "Drop webhooks",
  refund_500: "Refund API returns HTTP 500",
};
const failure = { mode: "off", remaining: 0, delaySec: 20 };

// Returns the active mode if it applies to this call (and counts it), else "off".
function takeFailure(applies) {
  if (failure.mode === "off" || !applies(failure.mode)) return "off";
  const mode = failure.mode;
  if (failure.remaining > 0 && --failure.remaining === 0) failure.mode = "off";
  return mode;
}

// Webhooks sent (or deliberately not sent) - shown on /admin.
const webhookLog = [];
const held = new Map(); // paymentId -> held payment webhook payload (reorder)
const RETRY_DELAYS_SEC = (process.env.MOCK_WEBHOOK_RETRY_DELAYS || "5,15,45").split(",").map(Number);
const log = (payload, status, note, response = "") =>
  webhookLog.push({ at: new Date().toISOString(), payload, status, note, response: String(response).slice(0, 200) });

// One HTTP delivery. Like Razorpay, a 5xx or network error is re-sent later (RETRY_DELAYS_SEC).
async function deliver(payload, note = "", attempt = 0) {
  const target = `${STREAMFLIX_URL}/webhooks/mock`;
  let status, text;
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mock-secret": MOCK_SECRET },
      body: JSON.stringify(payload),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    status = "NETWORK_ERROR";
    text = e.message;
  }
  const tag = [note, attempt ? `retry ${attempt}` : ""].filter(Boolean).join(", ");
  log(payload, status, tag, text);
  console.log(`[mock-provider] webhook ${payload.eventType} -> ${status}${tag ? ` (${tag})` : ""}`);
  const retryable = status === "NETWORK_ERROR" || status >= 500;
  if (retryable && attempt < RETRY_DELAYS_SEC.length) {
    setTimeout(() => deliver(payload, note, attempt + 1), RETRY_DELAYS_SEC[attempt] * 1000);
  }
  return status;
}

const isPaymentEvent = (p) => p.eventType === "payment.succeeded" || p.eventType === "payment.failed";

// Sends a webhook, applying the active failure switch.
async function fireWebhook(payload) {
  const mode = takeFailure((m) =>
    ["duplicate", "delay", "drop"].includes(m) || (m === "reorder" && isPaymentEvent(payload)));

  if (mode === "drop") return log(payload, "DROPPED", "failure switch: drop");
  if (mode === "delay") {
    log(payload, "HELD", `failure switch: delay ${failure.delaySec}s`);
    setTimeout(() => deliver(payload, `delayed ${failure.delaySec}s`), failure.delaySec * 1000);
    return;
  }
  if (mode === "reorder") {
    held.set(payload.providerPaymentId, payload);
    return log(payload, "HELD", "failure switch: reorder (waiting for a refund)");
  }
  if (mode === "duplicate") {
    await Promise.all([deliver(payload, "copy 1/3"), deliver(payload, "copy 2/3")]);
    setTimeout(() => deliver(payload, "copy 3/3"), 3000);
    return;
  }
  await deliver(payload);

  // Reorder: the refund went out first; now the held payment follows.
  const waiting = !isPaymentEvent(payload) && held.get(payload.providerPaymentId);
  if (waiting) {
    held.delete(payload.providerPaymentId);
    setTimeout(() => deliver(waiting, "released after refund (reorder)"), 1000);
  }
}

// /refund and /api/* are called by StreamFlix's server, not a browser: check the secret.
function requireSecret(req, res, next) {
  if (req.get("x-mock-secret") !== MOCK_SECRET) return res.status(401).json({ error: "bad secret" });
  next();
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const page = (
  title,
  body,
  width = 520,
) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Roboto:wght@400;500;700&display=swap');

  body {
    font-family: 'Roboto', system-ui, sans-serif;
    max-width: ${width}px;
    margin: 4rem auto;
    background: #F6F5F0;
    color: #1C1E26;
    padding: 1rem;
    line-height: 1.5;
  }
  
  .card {
    border: 1px solid rgba(91, 95, 110, 0.15);
    border-radius: 12px;
    padding: 2rem;
    background: #ffffff;
    box-shadow: 0 8px 16px -2px rgba(0,0,0,0.06);
  }

  h2 {
    color: #2743D8;
    font-size: 1.5rem;
    margin-top: 0;
    margin-bottom: 1.25rem;
    font-family: 'JetBrains Mono', monospace;
  }

  p {
    color: #5B5F6E;
    font-size: 0.95rem;
    margin: 0.6rem 0;
  }

  p strong {
    color: #1C1E26;
  }

  hr {
    border: 0;
    border-top: 1px solid rgba(91, 95, 110, 0.15);
    margin: 1.5rem 0;
  }

  button {
    padding: 0.75rem 1.25rem;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 500;
    font-family: 'Roboto', sans-serif;
    margin: 0.5rem 0.4rem 0.5rem 0;
    transition: all 0.1s ease;
  }

  /* Raised 3D Buttons */
  .pay {
    background: #2743D8;
    color: #ffffff;
    box-shadow: 0 4px 0 #1A2D91, 0 5px 10px rgba(39, 67, 216, 0.2);
    transform: translateY(-2px);
  }
  .pay:active {
    box-shadow: 0 0 0 #1A2D91;
    transform: translateY(2px);
  }

  .fail {
    background: #d32f2f;
    color: #ffffff;
    box-shadow: 0 4px 0 #9a0007, 0 5px 10px rgba(211, 47, 47, 0.2);
    transform: translateY(-2px);
  }
  .fail:active {
    box-shadow: 0 0 0 #9a0007;
    transform: translateY(2px);
  }

  .cancel {
    background: #ffffff;
    color: #5B5F6E;
    border: 1px solid rgba(91, 95, 110, 0.3);
    box-shadow: 0 4px 0 #d0cfca;
    transform: translateY(-2px);
  }
  .cancel:active {
    box-shadow: 0 0 0 #d0cfca;
    transform: translateY(2px);
  }
</style></head><body>${body}</body></html>`;

// The page a user lands on after clicking Buy in StreamFlix.
app.get("/pay/:providerPaymentId", (req, res) => {
  const { providerPaymentId } = req.params;
  const { amount, currency, product, ref, userId } = req.query;
  res.send(
    page(
      "Mock Payment",
      `<div class="card">
      <h2>🎬 MockPay Checkout</h2>
      <p><strong>Product:</strong> ${esc(product)}</p>
      <p><strong>Amount:</strong> ${esc(amount)} ${esc(currency)}</p>
      <p><strong>Order:</strong> ${esc(ref)}</p>
      <p><strong>Payment ID:</strong> ${esc(providerPaymentId)}</p>
      <hr>
      <form method="POST" action="/pay/${esc(providerPaymentId)}/confirm">
        <input type="hidden" name="userId" value="${esc(req.query.userId || "")}">
        <input type="hidden" name="productId" value="${esc(product)}">
        <input type="hidden" name="amount" value="${esc(amount)}">
        <input type="hidden" name="currency" value="${esc(currency)}">
        <input type="hidden" name="orderRef" value="${esc(ref || "")}">
        <button class="pay" name="action" value="pay">✅ Pay ${esc(amount)} ${esc(currency)}</button>
        <button class="fail" name="action" value="fail">❌ Simulate Failure</button>
        <button class="cancel" name="action" value="cancel">Cancel</button>
      </form>
    </div>`,
    ),
  );
});

// User clicks Pay / Fail / Cancel.
app.post("/pay/:providerPaymentId/confirm", async (req, res) => {
  const { providerPaymentId } = req.params;
  const { action, userId, productId, amount, currency, orderRef } = req.body;
  if (action === "cancel") return res.redirect(`${STREAMFLIX_URL}/courses`);
  const eventType = action === "pay" ? "payment.succeeded" : "payment.failed";
  recordPayment(providerPaymentId, {
    status: action === "pay" ? "paid" : "failed",
    amount: Number(amount), currency, userId, productId, orderRef: orderRef || null,
  });
  // Fire webhook asynchronously; don't block the redirect.
  await fireWebhook({
    eventType,
    providerPaymentId,
    userId,
    productId,
    amount: Number(amount),
    currency,
    orderRef: orderRef || undefined, // lets StreamFlix find the order without in-memory state
    occurredAt: new Date().toISOString(),
  });
 
 
  // res.send(
  //   page(
  //     "Payment " + (action === "pay" ? "Successful" : "Failed"),
  //     `
  //   <div class="card">
  //     <h2>${action === "pay" ? "✅ Payment Successful" : "❌ Payment Failed"}</h2>
  //     <p>Webhook fired to StreamFlix. Your access will update momentarily.</p>
  //     <p><a href="${esc(STREAMFLIX_URL)}/" style="color:#58a6ff">← Return to StreamFlix</a></p>
  //   </div>`,
  //   ),
  // );

  res.redirect(`${STREAMFLIX_URL}/courses`);
});



// Refund API (called by StreamFlix's adapter.refund()). Records the refund, then sends the
// refund webhook.
app.post("/refund/:providerPaymentId", requireSecret, async (req, res) => {
  const { providerPaymentId } = req.params;
  const { userId, productId, amount, currency, providerRefundId, orderRef } = req.body;
  if (takeFailure((m) => m === "refund_500") === "refund_500") {
    log({ eventType: "refund API", providerPaymentId }, 500, "failure switch: refund API returned 500");
    return res.status(500).json({ error: "mock provider internal error (failure switch)" });
  }
  // Payments made before the provider kept records: create one from what StreamFlix sends.
  if (!store.payments[providerPaymentId]) {
    recordPayment(providerPaymentId, { status: "paid", amount: Number(amount), currency, userId, productId, orderRef: orderRef || null });
  }
  const p = store.payments[providerPaymentId];
  if (p.status === "refunded") return res.status(400).json({ error: "already refunded" });
  const refundId = providerRefundId || `mock_ref_${randomUUID()}`;
  recordRefund(providerPaymentId, { id: refundId, amount: Number(amount), status: "processed", createdAt: new Date().toISOString() });
  await fireWebhook(refundPayload(p, refundId, Number(amount)));
  res.json({ providerRefundId: refundId });
});

function refundPayload(p, refundId, amount) {
  return {
    eventType: "refund.succeeded",
    providerPaymentId: p.id,
    providerRefundId: refundId,
    orderRef: p.orderRef || undefined, // lets StreamFlix map the refund to every item of the order
    userId: p.userId,
    productId: p.productId,
    amount,
    currency: p.currency,
    occurredAt: new Date().toISOString(),
  };
}

// Refund started from the provider's side (like Razorpay's dashboard): full amount.
app.post("/admin/refund/:providerPaymentId", async (req, res) => {
  const p = store.payments[req.params.providerPaymentId];
  if (!p || p.status !== "paid") return res.status(400).send("Only a paid, not yet refunded payment can be refunded.");
  const refundId = `mock_ref_${randomUUID()}`;
  recordRefund(p.id, { id: refundId, amount: p.amount, status: "processed", createdAt: new Date().toISOString() });
  await fireWebhook(refundPayload(p, refundId, p.amount));
  res.redirect("/admin");
});

// Simulate a chargeback: the customer's bank takes the money back after a successful payment.
app.post("/chargeback/:providerPaymentId", async (req, res) => {
  const { providerPaymentId } = req.params;
  const p = store.payments[providerPaymentId];
  if (!p || p.status !== "paid") return res.status(404).send("Unknown or unsuccessful payment");
  await fireWebhook({
    eventType: "chargeback.created",
    providerPaymentId,
    providerChargebackId: `mock_cb_${providerPaymentId}`, // one chargeback per payment
    userId: p.userId,
    productId: p.productId,
    amount: p.amount,
    currency: p.currency,
    occurredAt: new Date().toISOString(),
  });
  res.redirect("/admin");
});

// ---- failure switch controls ----
app.post("/admin/failure-mode", (req, res) => {
  const mode = String(req.body.mode || "off");
  if (!MODES[mode]) return res.status(400).send("unknown mode");
  failure.mode = mode;
  failure.remaining = Math.max(0, parseInt(req.body.count, 10) || 0);
  failure.delaySec = Math.min(3600, Math.max(1, parseInt(req.body.delaySec, 10) || failure.delaySec));
  console.log(`[mock-provider] failure switch: ${mode}${failure.remaining ? ` (next ${failure.remaining})` : ""}`);
  if (req.is("json")) return res.json(failure);
  res.redirect("/admin");
});

app.post("/admin/release/:providerPaymentId", async (req, res) => {
  const payload = held.get(req.params.providerPaymentId);
  if (payload) {
    held.delete(req.params.providerPaymentId);
    await deliver(payload, "released by hand");
  }
  res.redirect("/admin");
});

// ---- M7: server-to-server charge ----
// StreamFlix charges an agent purchase the user already approved. No checkout page: the
// payment is recorded as paid and the normal payment.succeeded webhook is sent.
app.post("/api/charge/:providerPaymentId", requireSecret, async (req, res) => {
  const { providerPaymentId } = req.params;
  const { userId, productId, amount, currency, orderRef } = req.body;
  if (store.payments[providerPaymentId]?.status === "paid") return res.status(409).json({ error: "already charged" });
  recordPayment(providerPaymentId, {
    status: "paid", amount: Number(amount), currency, userId, productId, orderRef: orderRef || null, via: "direct charge",
  });
  await fireWebhook({
    eventType: "payment.succeeded",
    providerPaymentId,
    userId,
    productId,
    amount: Number(amount),
    currency,
    orderRef: orderRef || undefined,
    occurredAt: new Date().toISOString(),
  });
  res.json({ status: "paid", providerPaymentId });
});

// ---- provider API read by StreamFlix's reconciliation ----
const since = (req) => new Date(req.query.since || 0).getTime();
app.get("/api/payments", requireSecret, (req, res) => {
  res.json(Object.values(store.payments).filter((p) => new Date(p.createdAt).getTime() >= since(req)));
});
app.get("/api/payments/:id", requireSecret, (req, res) => {
  const p = store.payments[req.params.id];
  return p ? res.json(p) : res.status(404).json({ error: "not found" });
});
app.get("/api/refunds", requireSecret, (req, res) => {
  const out = [];
  for (const p of Object.values(store.payments))
    for (const r of p.refunds) if (new Date(r.createdAt).getTime() >= since(req)) out.push({ ...r, paymentId: p.id });
  res.json(out);
});

// Admin view: failure switches, payments at the provider, recent webhook deliveries.
app.get("/admin", (_req, res) => {
  const btn = (action, label, cls = "cancel") =>
    `<form method="POST" action="${esc(action)}" style="display:inline;margin:0"><button class="${cls}" style="padding:.3rem .6rem;font-size:.75rem;margin:0 .2rem">${esc(label)}</button></form>`;
  const status = failure.mode === "off"
    ? "Off (normal)"
    : `<strong style="color:#d32f2f">${esc(MODES[failure.mode])}</strong>${failure.remaining ? ` - next ${failure.remaining} call(s)` : " - until turned off"}${failure.mode === "delay" ? ` - ${failure.delaySec}s` : ""}`;
  const options = Object.entries(MODES)
    .map(([k, v]) => `<option value="${k}"${k === failure.mode ? " selected" : ""}>${esc(v)}</option>`).join("");

  const heldRows = [...held.values()]
    .map((p) => `<tr><td>${esc(p.eventType)}</td><td><code>${esc(p.providerPaymentId)}</code></td><td>${btn(`/admin/release/${p.providerPaymentId}`, "Release")}</td></tr>`)
    .join("");

  const payRows = Object.values(store.payments)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15)
    .map((p) => `<tr><td>${esc(p.createdAt.slice(0, 19).replace("T", " "))}</td><td><code>${esc(p.id)}</code></td><td>${esc(p.amount)} ${esc(p.currency)}</td><td>${esc(p.status)}</td><td>${
      p.status === "paid" ? btn(`/admin/refund/${p.id}`, "Refund at provider") + btn(`/chargeback/${p.id}`, "Chargeback", "fail") : ""
    }</td></tr>`).join("");

  const hookRows = webhookLog.slice(-25).reverse()
    .map((w) => `<tr><td>${esc(w.at.slice(11, 19))}</td><td>${esc(w.payload?.eventType)}</td><td>${esc(w.status)}</td><td>${esc(w.note || "")}</td><td><code>${esc(w.response)}</code></td></tr>`)
    .join("");

  const table = (head, rows, cols) =>
    `<table style="width:100%;border-collapse:collapse;font-size:.8rem;margin-bottom:1.5rem"><tr>${head.map((h) => `<th align="left">${h}</th>`).join("")}</tr>${rows || `<tr><td colspan=${cols}>None</td></tr>`}</table>`;

  res.send(page("Mock Provider Admin", `
    <h2>Failure switch</h2>
    <p>Now: ${status}</p>
    <form method="POST" action="/admin/failure-mode" style="margin-bottom:1.5rem">
      <select name="mode">${options}</select>
      for next <input name="count" type="number" min="0" value="1" style="width:4rem"> call(s) (0 = until off)
      &nbsp; delay <input name="delaySec" type="number" min="1" value="${failure.delaySec}" style="width:4rem"> s
      <button class="pay" style="padding:.4rem .8rem;font-size:.85rem">Apply</button>
    </form>
    <h2>Held webhooks</h2>${table(["Event", "Payment", ""], heldRows, 3)}
    <h2>Payments at provider</h2>${table(["Created", "Payment", "Amount", "Status", ""], payRows, 5)}
    <h2>Webhook deliveries</h2>${table(["Time", "Event", "Status", "Note", "Response"], hookRows, 5)}
  `, 1000));
});

app.listen(PORT, () => console.log(`Mock provider on :${PORT}`));

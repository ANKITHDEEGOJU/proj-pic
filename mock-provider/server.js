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

// In-memory log of outgoing webhooks (for /admin view).
const webhookLog = [];
async function fireWebhook(payload) {
  const body = JSON.stringify(payload);
  const target = `${STREAMFLIX_URL}/webhooks/mock`;
  let status;
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mock-secret": MOCK_SECRET,
      },
      body,
    });
    status = r.status;
    const text = await r.text();
    webhookLog.push({
      at: new Date().toISOString(),
      target,
      payload,
      status,
      response: text.slice(0, 200),
    });
    console.log(`[mock-provider] webhook -> ${target} status=${status}`);
  } catch (e) {
    webhookLog.push({
      at: new Date().toISOString(),
      target,
      payload,
      status: "NETWORK_ERROR",
      response: e.message,
    });
    console.error(`[mock-provider] webhook failed:`, e.message);
  }
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
) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Roboto:wght@400;500;700&display=swap');

  body {
    font-family: 'Roboto', system-ui, sans-serif;
    max-width: 520px;
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
  const { action, userId, productId, amount, currency } = req.body;
  if (action === "cancel") return res.redirect(`${STREAMFLIX_URL}/courses`);
  const eventType = action === "pay" ? "payment.succeeded" : "payment.failed";
  // Fire webhook asynchronously; don't block the redirect.
  await fireWebhook({
    eventType,
    providerPaymentId,
    userId,
    productId,
    amount: Number(amount),
    currency,
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



// Refund webhook (called by StreamFlix checkout/refund route via adapter.refund()).
// The mock adapter calls this internally, but a real provider would POST here themselves.
app.post("/refund/:providerPaymentId", async (req, res) => {
  const { providerPaymentId } = req.params;
  const { userId, productId, amount, currency, providerRefundId } = req.body;
  await fireWebhook({
    eventType: "refund.succeeded",
    providerPaymentId,
    providerRefundId,
    userId,
    productId,
    amount: Number(amount),
    currency,
    occurredAt: new Date().toISOString(),
  });
  res.json({ providerRefundId });
});

// Admin view: recent webhook deliveries.
app.get("/admin", (_req, res) => {
  const rows = webhookLog
    .slice(-20)
    .reverse()
    .map(
      (w) =>
        `<tr><td>${w.at}</td><td>${esc(w.payload?.eventType)}</td><td>${w.status}</td><td><code>${esc(w.response)}</code></td></tr>`,
    )
    .join("");
  res.send(
    page(
      "Mock Provider Admin",
      `<h2>Recent webhook deliveries</h2>
    <table style="width:100%;border-collapse:collapse;font-size:.8rem">
    <tr><th>Time</th><th>Event</th><th>Status</th><th>Response</th></tr>${rows || "<tr><td colspan=4>None</td></tr>"}</table>`,
    ),
  );
});

app.listen(PORT, () => console.log(`Mock provider on :${PORT}`));

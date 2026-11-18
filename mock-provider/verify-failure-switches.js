'use strict';
// M8: end-to-end check of the mock provider failure switches (duplicate, delay, drop,
// reorder, refund API 500). Needs both servers running against localhost, with
// reconciliation allowed to act on fresh events:
//   STREAMFLIX_URL=http://localhost:3000 MOCK_PROVIDER_URL=http://localhost:3001 \
//   RECON_GRACE_SECONDS=0 RECON_STUCK_REFUND_MINUTES=0 npm start
//   cd mock-provider && STREAMFLIX_URL=http://localhost:3000 npm start
//   npm run verify:failures
// Creates its own @test.local users; their ledger rows stay (append-only by design).
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const assert = require('node:assert/strict');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const APP = process.env.APP_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_URL || 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (o) => new URLSearchParams(o).toString();
const FH = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function newUser(tag) {
  const email = `fs_${tag}_${Date.now()}@test.local`;
  const r = await fetch(APP + '/register', { method: 'POST', headers: FH, body: form({ email, password: 'password123' }), redirect: 'manual' });
  const token = /token=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  return { email, cookie: `token=${token}` };
}
const app = (u, method, p, body) => fetch(APP + p, { method, headers: { ...FH, Cookie: u.cookie, 'HX-Request': 'true' }, body: body && form(body), redirect: 'manual' });
async function buy(u, slug) {
  await app(u, 'POST', '/cart/add', { productId: slug });
  const r = await app(u, 'POST', '/cart/checkout', { provider: 'mock' });
  const url = new URL(r.headers.get('hx-redirect'));
  const pid = url.pathname.split('/').pop(); const q = url.searchParams;
  await fetch(`${MOCK}/pay/${pid}/confirm`, { method: 'POST', headers: FH, redirect: 'manual',
    body: form({ action: 'pay', userId: q.get('userId'), productId: q.get('product'), amount: q.get('amount'), currency: q.get('currency'), orderRef: q.get('ref') }) });
  return { pid, orderId: q.get('ref') };
}
const allowed = async (u, slug) => (await (await app(u, 'GET', `/courses/${slug}/access`)).text()).includes('Allowed');
const setMode = (mode, count = 1, delaySec = 4) => fetch(MOCK + '/admin/failure-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, count, delaySec }) });
const events = async (pid) => (await db.query(`SELECT event_type, count(*)::int n FROM commerce_ledger WHERE payment_info->>'providerPaymentId'=$1 GROUP BY 1 ORDER BY 1`, [pid])).rows.map((r) => `${r.event_type}x${r.n}`).join(',');
const orderStatus = async (id) => (await db.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status;

(async () => {
  const adminRow = (await db.query('SELECT id,email FROM users WHERE email=$1', [process.env.ADMIN_EMAIL])).rows[0];
  const admin = { cookie: `token=${jwt.sign({ sub: adminRow.id, email: adminRow.email }, process.env.JWT_SECRET)}` };
  const recon = async () => { const r = await app(admin, 'POST', '/admin/reconciliation/run'); const j = await r.json(); console.log('    recon:', JSON.stringify(j.summary.byKind), j.error ? `error: ${j.error}` : ''); return j; };
  const slug = (await db.query("SELECT slug FROM courses WHERE coalesce(type,'COURSE')='COURSE' ORDER BY price_cents LIMIT 1")).rows[0].slug;

  // duplicate
  let u = await newUser('dup'); await setMode('duplicate');
  let o = await buy(u, slug); await sleep(4000);
  assert.equal(await events(o.pid), 'PURCHASE_SUCCEEDEDx1'); assert.ok(await allowed(u, slug));
  console.log('[ok] duplicate: 3 copies sent, 1 purchase recorded, access granted');

  // delay
  u = await newUser('delay'); await setMode('delay', 1, 4);
  o = await buy(u, slug); await sleep(500);
  assert.equal(await allowed(u, slug), false, 'no access before the late webhook');
  await sleep(5000); assert.ok(await allowed(u, slug));
  console.log('[ok] delay: no access at first, access once the late webhook arrives');

  // drop (payment) -> reconciliation
  u = await newUser('drop'); await setMode('drop');
  o = await buy(u, slug); await sleep(1000);
  assert.equal(await allowed(u, slug), false);
  await recon();
  assert.ok(await allowed(u, slug)); assert.equal(await events(o.pid), 'PURCHASE_SUCCEEDEDx1');
  console.log('[ok] drop payment webhook: reconciliation replays it, access granted');

  // drop (refund) -> stuck REFUND_PENDING -> reconciliation finalizes
  await setMode('drop');
  await app(u, 'POST', `/courses/${slug}/checkout/refund`); await sleep(500);
  assert.equal(await orderStatus(o.orderId), 'REFUND_PENDING'); assert.ok(await allowed(u, slug), 'access kept while refund pending');
  await recon();
  assert.equal(await allowed(u, slug), false); assert.equal(await orderStatus(o.orderId), 'REFUNDED');
  assert.equal(await events(o.pid), 'PURCHASE_SUCCEEDEDx1,REFUNDx1');
  console.log('[ok] drop refund webhook: order stuck REFUND_PENDING, reconciliation finalizes it, access removed');
  await recon(); // second run must change nothing
  assert.equal(await events(o.pid), 'PURCHASE_SUCCEEDEDx1,REFUNDx1');

  // reorder
  u = await newUser('reorder'); await setMode('reorder');
  o = await buy(u, slug); await sleep(500);
  assert.equal(await allowed(u, slug), false, 'payment webhook held');
  await fetch(`${MOCK}/admin/refund/${o.pid}`, { method: 'POST', redirect: 'manual' });
  await sleep(8000); // refund (503) -> payment released -> refund re-sent by the mock after 5 s
  assert.equal(await events(o.pid), 'PURCHASE_SUCCEEDEDx1,REFUNDx1'); assert.equal(await allowed(u, slug), false);
  console.log('[ok] reorder: refund before payment gets 503, re-sent after the payment, both applied once');

  // refund API 500
  u = await newUser('r500'); await setMode('off');
  o = await buy(u, slug); await sleep(800);
  await setMode('refund_500');
  const rr = await (await app(u, 'POST', `/courses/${slug}/checkout/refund`)).text();
  assert.equal(await orderStatus(o.orderId), 'COMPLETED', 'order reopened'); assert.ok(await allowed(u, slug));
  await app(u, 'POST', `/courses/${slug}/checkout/refund`); await sleep(800);
  assert.equal(await allowed(u, slug), false); assert.equal(await orderStatus(o.orderId), 'REFUNDED');
  console.log('[ok] refund API 500: refund fails cleanly (access kept, order reopened); retry succeeds. Message:', rr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120));

  console.log('\nFAILURE SWITCH CHECKS PASSED');
  await setMode('off'); await db.end();
})().catch(async (e) => { console.error('FAILED:', e); await setMode('off').catch(() => {}); process.exit(1); });

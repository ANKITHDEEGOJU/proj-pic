'use strict';
// Baselines-versus-LEARNX evaluation. Runs the same workloads against
//   - NAIVE baseline   (evaluation/baseline.js): webhooks flip access flags directly, read-then-write limits
//   - CAREFUL baseline (evaluation/baseline-careful.js): deduplication by payment id, order/amount/
//                      currency check, race-safe limits; no event history, retry or reconciliation
//   - LEARNX           (the real code: webhook inbox + processor, ledger, projection, reconciliation,
//                      quotas, seats, agent purchase service)
// and writes raw results, a CSV summary, SVG charts and RESULTS.md to evaluation/results/.
//
//   node evaluation/run-evaluation.js [--runs 5] [--size 10] [--seed 42]
//
// Needs DATABASE_URL (same database as the app; nothing external is called: the payment
// provider is simulated in-process, like the test suites). It removes its own rows afterwards;
// ledger rows of the generated eval_*@test.local users stay (the ledger is append-only).
require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db');
const { createEngine } = require('../src/domain');
const { loadProducts } = require('../src/domain/catalogLoader');
const { PgLedgerStore } = require('../src/domain/stores/pgLedgerStore');
const { registry } = require('../src/payment/registry');
const { RazorpayPaymentAdapter } = require('../src/payment/adapters/razorpay');
const { WebhookProcessor } = require('../src/payment/webhookProcessor');
const { retryDueWebhooks } = require('../src/payment/retryWorker');
const { Reconciler } = require('../src/payment/reconcile');
const { createOrder } = require('../src/services/orders');
const quotas = require('../src/services/quotas');
const seats = require('../src/services/seats');
const agent = require('../src/services/agentPurchase');
const BASES = { naive: require('./baseline'), careful: require('./baseline-careful') };
const SIDES = [['naive', 'Naive baseline'], ['careful', 'Careful baseline'], ['system', 'LEARNX']];

// ---- arguments, seeded randomness ----------------------------------------------------------------
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const RUNS = arg('runs', 5), SIZE = arg('size', 10), SEED = arg('seed', 42);
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(SEED);
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const quiet = { log() {}, warn() {}, error() {}, info() {} };

// ---- simulated payment provider (same approach as test/verify-m2-m6.js) --------------------------
const PROVIDER = 'evalprov';
const provider = { payments: new Map(), refunds: new Map() };
class EvalProvider extends RazorpayPaymentAdapter {
  get name() { return PROVIDER; }
  #txn(p) {
    return { providerPaymentId: p.id, amount: p.amount / 100, amountMinor: p.amount, currency: p.currency, status: p.status,
      paid: ['captured', 'refunded'].includes(p.status), amountRefundedMinor: p.amount_refunded || 0,
      orderRef: p.notes?.orderId || null, occurredAt: new Date(p.created_at * 1000).toISOString(), raw: p };
  }
  async listTransactions({ since }) { return [...provider.payments.values()].filter((p) => p.created_at * 1000 >= new Date(since).getTime()).map((p) => this.#txn(p)); }
  async listRefunds({ since }) { return [...provider.refunds.values()].flat().filter((r) => r.created_at * 1000 >= new Date(since).getTime()).map((r) => ({ providerRefundId: r.id, providerPaymentId: r.payment_id, amountMinor: r.amount, status: r.status, raw: r })); }
  async fetchPayment(id) { const p = provider.payments.get(id); return p ? this.#txn(p) : null; }
  async fetchRefunds(id) { return (provider.refunds.get(id) || []).map((r) => ({ providerRefundId: r.id, amountMinor: r.amount, status: r.status, raw: r })); }
}
const fake = new EvalProvider();
registry[PROVIDER] = fake;
const rid = (p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
const now = () => Math.floor(Date.now() / 1000);

// ---- helpers -------------------------------------------------------------------------------------
const userIds = [], orgIds = [];
let engine, processor, course;
async function newUser(tag) {
  const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email",
    [`eval_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`])).rows[0];
  userIds.push(u.id);
  return u;
}
async function newOrder(user, cents = course.priceCents) {
  const c = await pool.connect();
  try {
    return await createOrder(c, { userId: user.id, provider: PROVIDER, subtotalCents: cents, finalCents: cents,
      lines: [{ itemType: 'COURSE', itemId: course.id, unitPriceCents: cents, paidCents: cents }] })
      .then(async (orderId) => {
        // The baselines see the same checkout (the careful one stores it to match payments against).
        for (const b of Object.values(BASES)) await b.createOrder({ orderRef: orderId, userId: user.id, productId: course.id, amountCents: cents, currency: 'USD' });
        return orderId;
      });
  } finally { c.release(); }
}
// The webhook as a baseline receives it.
const ev = (x, type) => ({ type, paymentId: x.p.id, orderRef: x.p.notes.orderId, userId: x.u.id, productId: course.id, amountCents: x.p.amount, currency: x.p.currency });
// A captured payment as the provider sees it (registered at the provider for reconciliation).
function payment(orderId, user, amountMinor, currency = 'USD', productId = course.id) {
  const p = { id: rid('pay'), entity: 'payment', amount: amountMinor, currency, status: 'captured', captured: true, amount_refunded: 0,
    order_id: rid('order'), created_at: now(), notes: { orderId, orderRef: orderId, userId: user.id, productId } };
  provider.payments.set(p.id, p);
  return p;
}
function refundAtProvider(p) {
  const r = { id: rid('rfnd'), entity: 'refund', amount: p.amount, currency: p.currency, payment_id: p.id, notes: {}, status: 'processed', created_at: now() };
  p.status = 'refunded'; p.amount_refunded = p.amount;
  provider.refunds.set(p.id, [r]);
  return r;
}
const captured = (p) => ({ key: `payment.captured:${p.id}`, body: { event: 'payment.captured', payload: { payment: { entity: p } } } });
const refunded = (p, r) => ({ key: `refund.created:${r.id}`, body: { event: 'refund.created', payload: { refund: { entity: r }, payment: { entity: p } } } });
// Exactly what the webhook route does: store in the inbox (dedup on provider event id), then process.
async function deliver({ key, body }) {
  const row = (await pool.query(
    `INSERT INTO webhook_inbox (provider, provider_event_id, raw_body) VALUES ($1,$2,$3)
     ON CONFLICT (provider, provider_event_id) DO UPDATE SET status = webhook_inbox.status RETURNING *`,
    [PROVIDER, key, JSON.stringify(body)])).rows[0];
  if (row.status === 'PROCESSED' || row.status === 'IGNORED') return { outcome: 'DUPLICATE', id: row.id };
  return { ...(await processor.process(row, fake)), id: row.id };
}
const allowed = (u) => engine.decisions.evaluateAccess(u.id, course.slug || course.id).allowed;
const ledgerPurchases = async (payIds) => (await pool.query(
  `SELECT count(*)::int n, coalesce(round(sum(amount)*100),0)::int cents FROM commerce_ledger
    WHERE event_type='PURCHASE_SUCCEEDED' AND payment_info->>'providerPaymentId' = ANY($1)`, [payIds])).rows[0];
const pct = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0; };
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ---- scenarios -------------------------------------------------------------------------------------
// Each returns { naive: {...}, careful: {...}, system: {...} } for one run; `errors` is the number of
// incorrect outcomes (what the charts compare). The baselines run after LEARNX on the same inputs.
const eachBase = async (fn) => { const out = {}; for (const [k, b] of Object.entries(BASES)) out[k] = await fn(b); return out; };
const SCENARIOS = [
  { id: 'S1', name: 'Duplicate webhook delivery (each payment delivered 3x, shuffled, concurrent)', expected: 'one purchase and one charge per payment',
    async run() {
      const users = await Promise.all(Array.from({ length: SIZE }, () => newUser('dup')));
      const pays = [];
      for (const u of users) pays.push({ u, p: payment(await newOrder(u), u, course.priceCents) });
      const copies = shuffle(pays.flatMap((x) => [x, x, x]));
      const want = SIZE * course.priceCents;
      const m = (r) => ({ recordedPurchases: r.n, recordedRevenueCents: r.cents, revenueErrorPct: Math.round(((r.cents - want) / want) * 1000) / 10, errors: r.n - SIZE });
      await Promise.all(copies.map((x) => deliver(captured(x.p))));
      const system = m(await ledgerPurchases(pays.map((x) => x.p.id)));
      const bases = await eachBase(async (b) => {
        await Promise.all(copies.map((x) => b.handleWebhook(ev(x, 'purchase'))));
        return m(await b.revenue(pays.map((x) => x.p.id)));
      });
      return { ...bases, system };
    } },
  { id: 'S2', name: 'Reordered events (refund arrives before its purchase)', expected: 'no access after a refund',
    async run() {
      const users = await Promise.all(Array.from({ length: SIZE }, () => newUser('reorder')));
      const items = [];
      for (const u of users) { const p = payment(await newOrder(u), u, course.priceCents); items.push({ u, p, r: refundAtProvider(p) }); }
      const early = [];
      for (const x of shuffle(items)) early.push(await deliver(refunded(x.p, x.r))); // refund first: answered "retry later"
      for (const x of shuffle(items)) await deliver(captured(x.p));
      await pool.query("UPDATE webhook_inbox SET next_retry_at = now() WHERE id = ANY($1)", [early.map((e) => e.id)]);
      await retryDueWebhooks({ ledger: engine.ledger, ids: early.map((e) => e.id), log: quiet }); // the background retry
      const sysWrong = items.filter((x) => allowed(x.u)).length;
      const bases = await eachBase(async (b) => {
        for (const x of items) await b.handleWebhook(ev(x, 'refund'));
        for (const x of items) await b.handleWebhook(ev(x, 'purchase'));
        let wrong = 0;
        for (const x of items) if (await b.hasAccess(x.u.id, course.id)) wrong++;
        return { usersWithAccessAfterRefund: wrong, errors: wrong };
      });
      return { ...bases, system: { usersWithAccessAfterRefund: sysWrong, earlyRefundsDeferred: early.filter((e) => e.outcome === 'FAILED').length, errors: sysWrong } };
    } },
  { id: 'S3', name: 'Lost webhooks (30 % of payment webhooks dropped), then reconciliation', expected: 'every paying user has access after recovery',
    async run() {
      const users = await Promise.all(Array.from({ length: SIZE }, () => newUser('drop')));
      const items = [];
      for (const u of users) items.push({ u, p: payment(await newOrder(u), u, course.priceCents) });
      const dropped = new Set(shuffle(items).slice(0, Math.round(SIZE * 0.3)).map((x) => x.p.id));
      const delivered = items.filter((x) => !dropped.has(x.p.id));
      for (const x of delivered) await deliver(captured(x.p));
      const missingBefore = items.filter((x) => !allowed(x.u)).length;
      const recon = new Reconciler({ ledger: engine.ledger, adapters: { [PROVIDER]: fake }, graceSeconds: 0, stuckMinutes: 15, lookbackDays: 1, log: quiet });
      const run = await recon.run({ trigger: 'eval' });
      const missingAfter = items.filter((x) => !allowed(x.u)).length;
      const bases = await eachBase(async (b) => {
        for (const x of delivered) await b.handleWebhook(ev(x, 'purchase'));
        let missing = 0;
        for (const x of items) if (!(await b.hasAccess(x.u.id, course.id))) missing++;
        return { dropped: dropped.size, payingUsersWithoutAccess: missing, errors: missing };
      });
      return { ...bases, system: { dropped: dropped.size, withoutAccessBeforeRecon: missingBefore, payingUsersWithoutAccess: missingAfter, reconFixed: (run.fixed || []).filter((f) => f.kind === 'MISSING_PURCHASE').length, errors: missingAfter } };
    } },
  { id: 'S4', name: 'Tampered payments (half pay 0.01, half pay the right number in JPY)', expected: 'no access for an underpayment',
    async run() {
      const users = await Promise.all(Array.from({ length: SIZE }, () => newUser('tamper')));
      const items = [];
      for (const [i, u] of users.entries()) {
        const p = i % 2 === 0 ? payment(await newOrder(u), u, 1) : payment(await newOrder(u), u, course.priceCents, 'JPY');
        items.push({ u, p });
      }
      for (const x of items) await deliver(captured(x.p));
      const sysWrong = items.filter((x) => allowed(x.u)).length;
      const bases = await eachBase(async (b) => {
        for (const x of items) await b.handleWebhook(ev(x, 'purchase'));
        let wrong = 0;
        for (const x of items) if (await b.hasAccess(x.u.id, course.id)) wrong++;
        return { wronglyGranted: wrong, errors: wrong };
      });
      return { ...bases, system: { wronglyGranted: sysWrong, errors: sysWrong } };
    } },
  { id: 'S5', name: 'Quota under concurrency (50 parallel requests, limit 10)', expected: 'exactly 10 accepted',
    async run() {
      const u = await newUser('quota');
      const scope = `eval:${randomUUID()}`;
      const sys = await Promise.all(Array.from({ length: 50 }, () => quotas.consume({ requestKey: `eval:${randomUUID()}`, quota: { scopeKey: scope, limit: 10 }, feature: 'EVAL', userId: u.id })));
      const s = sys.filter((r) => r.ok).length;
      const bases = await eachBase(async (b) => {
        const n = (await Promise.all(Array.from({ length: 50 }, () => b.consumeQuota(scope, 10)))).filter(Boolean).length;
        return { accepted: n, errors: Math.abs(n - 10) };
      });
      return { ...bases, system: { accepted: s, errors: Math.abs(s - 10) } };
    } },
  { id: 'S6', name: 'Last seat race (1-seat pack, 6 parallel assignments)', expected: 'exactly 1 seat in use',
    async run() {
      const owner = await newUser('seatowner');
      // 6, not 10: with 10 simultaneous assignments the app ran out of database connections
      // and froze (known defect, see evaluation/README.md). 6 stays below the pool of 10.
      const members = await Promise.all(Array.from({ length: 6 }, () => newUser('member')));
      const pack = await seats.createSeatPackOrder({ userId: owner.id, orgName: `Eval Org ${randomUUID().slice(0, 4)}`, course, seats: 1, provider: PROVIDER });
      orgIds.push(pack.org.id);
      await deliver(captured(payment(pack.orderId, owner, course.priceCents)));
      await Promise.all(members.map((m) => seats.assignSeat({ ledger: engine.ledger, poolId: pack.pool.id, email: m.email, actor: `user:${owner.id}` }).catch(() => null)));
      const sysInUse = (await seats.activeSeats(pack.pool.id)).length;
      const bases = await eachBase(async (b) => {
        const poolKey = `eval-pool-${randomUUID()}`;
        await Promise.all(members.map((m) => b.assignSeat(poolKey, 1, m.email)));
        const n = await b.seatsInUse(poolKey);
        return { seatsInUse: n, errors: Math.max(0, n - 1) };
      });
      return { ...bases, system: { seatsInUse: sysInUse, errors: Math.max(0, sysInUse - 1) } };
    } },
  { id: 'S7', name: 'Approval replay (one approval executed 5x in parallel)', expected: 'exactly 1 order',
    async run() {
      const u = await newUser('replay');
      const { catalog, decisions } = engine;
      const i = await agent.propose({ userId: u.id, productId: course.slug || course.id, provider: 'mock', agentName: 'eval-agent', catalog, decisions });
      const { token } = await agent.approve({ intentId: i.id, userId: u.id, expectAmountCents: i.amount_cents });
      const startPayment = async () => ({ status: 'CHECKOUT', redirectUrl: 'http://eval.test/pay' });
      const sys = await Promise.all(Array.from({ length: 5 }, () => agent.execute({ intentId: i.id, token, userId: u.id, catalog, decisions, startPayment }).then(() => 1, () => 0)));
      const sOrders = sys.reduce((a, b) => a + b, 0);
      const bases = await eachBase(async (b) => {
        const key = `eval-intent-${randomUUID()}`;
        await b.approve(key);
        await Promise.all(Array.from({ length: 5 }, () => b.execute(key)));
        const n = await b.ordersFor(key);
        return { ordersCreated: n, errors: Math.max(0, n - 1) };
      });
      return { ...bases, system: { ordersCreated: sOrders, errors: Math.max(0, sOrders - 1) } };
    } },
  { id: 'S8', name: 'Cost of the safety: time to process one payment webhook', expected: 'informational (ms)',
    async run() {
      const users = await Promise.all(Array.from({ length: SIZE }, () => newUser('latency')));
      const t = { naive: [], careful: [], system: [] };
      for (const u of users) {
        const x = { u, p: payment(await newOrder(u), u, course.priceCents) };
        let t0 = process.hrtime.bigint(); await deliver(captured(x.p)); t.system.push(ms(t0));
        for (const [k, b] of Object.entries(BASES)) { t0 = process.hrtime.bigint(); await b.handleWebhook(ev(x, 'purchase')); t[k].push(ms(t0)); }
      }
      const r = (v) => Math.round(v * 10) / 10;
      const m = (xs) => ({ p50ms: r(pct(xs, 0.5)), p95ms: r(pct(xs, 0.95)), errors: 0 });
      return { naive: m(t.naive), careful: m(t.careful), system: m(t.system) };
    } },
];

// ---- output: summary, CSV, SVG charts, RESULTS.md ------------------------------------------------
const mean = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
function svgBars(title, labels, series, unit) {
  const W = 760, H = 360, L = 60, B = 70, T = 40, R = 20, gw = (W - L - R) / labels.length, bw = Math.min(28, gw / (series.length + 1));
  const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.15;
  const y = (v) => H - B - ((H - B - T) * v) / max;
  const colors = ['#c62828', '#2e7d32', '#2743d8'];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#ffffff"/><text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">${title}</text>
<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#333"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#333"/>
<text x="16" y="${(H - B + T) / 2}" transform="rotate(-90 16 ${(H - B + T) / 2})" text-anchor="middle">${unit}</text>`;
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; out += `<line x1="${L - 4}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#eee"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 10) / 10}</text>`; }
  labels.forEach((lab, i) => {
    const x0 = L + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i], x = x0 + j * bw;
      out += `<rect x="${x}" y="${y(v)}" width="${bw - 3}" height="${H - B - y(v)}" fill="${colors[j]}"/><text x="${x + (bw - 3) / 2}" y="${y(v) - 4}" text-anchor="middle" font-size="11">${v}</text>`;
    });
    out += `<text x="${L + i * gw + gw / 2}" y="${H - B + 18}" text-anchor="middle">${lab}</text>`;
  });
  series.forEach((s, j) => { out += `<rect x="${L + j * 170}" y="${H - 28}" width="12" height="12" fill="${colors[j]}"/><text x="${L + j * 170 + 18}" y="${H - 18}">${s.name}</text>`; });
  return `${out}\n</svg>\n`;
}

async function cleanup() {
  const intents = (await pool.query('SELECT id FROM purchase_intents WHERE user_id = ANY($1::uuid[])', [userIds])).rows.map((r) => r.id);
  await pool.query('DELETE FROM intent_events WHERE user_id = ANY($1::uuid[]) OR intent_ref = ANY($2::text[])', [userIds, intents]);
  await pool.query('DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])', [userIds]);
  await pool.query("DELETE FROM usage_counters WHERE scope_key LIKE 'eval:%' OR scope_key = ANY($1::text[])", [userIds.map((id) => `user:${id}:agent`)]);
  await pool.query('DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])', [userIds]);
  if (orgIds.length) {
    await pool.query('DELETE FROM org_seat_pools WHERE org_id = ANY($1::uuid[])', [orgIds]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgIds]);
  }
  const orders = (await pool.query('SELECT id FROM orders WHERE user_id = ANY($1::uuid[])', [userIds])).rows.map((r) => r.id);
  await pool.query('DELETE FROM order_line_items WHERE order_id = ANY($1::uuid[])', [orders]);
  await pool.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orders]);
  await pool.query('DELETE FROM recon_issues WHERE provider=$1', [PROVIDER]);
  await pool.query("DELETE FROM recon_runs WHERE trigger='eval'");
  await pool.query('DELETE FROM webhook_inbox WHERE provider=$1', [PROVIDER]);
  for (const b of Object.values(BASES)) await b.teardown();
}

(async () => {
  const products = await loadProducts();
  engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  processor = new WebhookProcessor({ ledger: engine.ledger });
  course = engine.catalog.list().find((p) => (p.type || 'COURSE') === 'COURSE');
  for (const b of Object.values(BASES)) await b.setup();

  const results = {};
  for (const s of SCENARIOS) {
    results[s.id] = { name: s.name, expected: s.expected, naive: [], careful: [], system: [] };
    for (let r = 0; r < RUNS; r++) {
      const out = await s.run();
      for (const [k] of SIDES) results[s.id][k].push(out[k]);
    }
    const e = (side) => mean(results[s.id][side].map((x) => x.errors));
    console.log(`${s.id} ${s.name}: errors/run naive ${e('naive')}, careful ${e('careful')}, LEARNX ${e('system')}`);
  }

  const sha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { return 'unknown'; } })();
  const dirty = (() => { try { return execSync('git status --porcelain -- src db', { cwd: path.join(__dirname, '..') }).toString().trim() !== ''; } catch { return false; } })();
  const pg = (await pool.query('SHOW server_version')).rows[0].server_version;
  const meta = { date: new Date().toISOString(), commit: sha, uncommittedSourceChanges: dirty, runs: RUNS, size: SIZE, seed: SEED, node: process.version, postgres: pg,
    os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cpus: os.cpus().length, course: { id: course.id, priceCents: course.priceCents } };

  // Summary: every numeric metric, mean (min-max) over runs, per side.
  const rows = [];
  for (const [id, sc] of Object.entries(results)) {
    const keys = [...new Set(SIDES.flatMap(([k]) => sc[k].flatMap((m) => Object.keys(m))))];
    for (const key of keys) {
      const row = { scenario: id, metric: key };
      for (const [k] of SIDES) {
        const v = sc[k].map((m) => m[key]).filter((x) => typeof x === 'number');
        row[k] = v.length ? { mean: mean(v), min: Math.min(...v), max: Math.max(...v) } : null;
      }
      rows.push(row);
    }
  }
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = meta.date.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `raw-${stamp}.json`), JSON.stringify({ meta, results }, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ meta, results }, null, 2));
  const c = (x, f) => (x ? x[f] : '');
  fs.writeFileSync(path.join(dir, 'summary.csv'), ['scenario,metric,' + SIDES.map(([k]) => `${k}_mean,${k}_min,${k}_max`).join(','),
    ...rows.map((r) => [r.scenario, r.metric, ...SIDES.flatMap(([k]) => [c(r[k], 'mean'), c(r[k], 'min'), c(r[k], 'max')])].join(','))].join('\n') + '\n');

  const errIds = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
  const errMean = (id, side) => mean(results[id][side].map((x) => x.errors));
  fs.writeFileSync(path.join(dir, 'chart-incorrect-outcomes.svg'), svgBars(`Incorrect outcomes per run (mean of ${RUNS} runs, lower is better)`, errIds,
    SIDES.map(([k, label]) => ({ name: label, values: errIds.map((id) => errMean(id, k)) })), 'incorrect outcomes'));
  const lat = (side, k) => mean(results.S8[side].map((x) => x[k]));
  fs.writeFileSync(path.join(dir, 'chart-webhook-latency.svg'), svgBars('Time to process one payment webhook (ms)', ['p50', 'p95'],
    SIDES.map(([k, label]) => ({ name: label, values: [lat(k, 'p50ms'), lat(k, 'p95ms')] })), 'milliseconds'));

  const fmt = (x) => (x ? (x.min === x.max ? `${x.mean}` : `${x.mean} (${x.min}–${x.max})`) : '—');
  const md = [`# Evaluation results`, ``,
    `Generated by \`node evaluation/run-evaluation.js --runs ${RUNS} --size ${SIZE} --seed ${SEED}\` on ${meta.date}`,
    `(commit \`${sha}\`${dirty ? ' plus uncommitted source changes' : ''}, Node ${meta.node}, PostgreSQL ${pg}, ${meta.os}, ${meta.cpus}× ${meta.cpu}). Raw data: \`latest.json\`, \`raw-${stamp}.json\`; table: \`summary.csv\`.`, ``,
    `![Incorrect outcomes](chart-incorrect-outcomes.svg)`, ``, `![Webhook latency](chart-webhook-latency.svg)`, ``,
    `| Scenario | Expected | Incorrect outcomes per run: naive | careful | LEARNX |`, `|---|---|---|---|---|`,
    ...errIds.map((id) => `| ${id}: ${results[id].name} | ${results[id].expected} | ${errMean(id, 'naive')} | ${errMean(id, 'careful')} | ${errMean(id, 'system')} |`), ``,
    `| Metric | Naive | Careful | LEARNX |`, `|---|---|---|---|`,
    ...rows.filter((r) => r.metric !== 'errors').map((r) => `| ${r.scenario} ${r.metric} | ${fmt(r.naive)} | ${fmt(r.careful)} | ${fmt(r.system)} |`), ``,
    `A single number means every run gave the same value; otherwise mean (min–max).`, ``,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'RESULTS.md'), md + '\n');
  console.log(`\nWritten: evaluation/results/RESULTS.md, latest.json, raw-${stamp}.json, summary.csv, 2 charts`);
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error('cleanup:', e.message)); await pool.end(); });

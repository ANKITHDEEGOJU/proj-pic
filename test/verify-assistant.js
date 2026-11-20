"use strict";
// LEARNX Assistant (M7 AI agent) checks against Postgres, with a FAKE model: a local
// OpenAI-compatible server that answers with scripted tool calls. No Groq/Gemini key or
// network is needed and the results are the same every run.
//   - full cycle: list_courses -> propose_purchase -> (user approves) -> execute_purchase -> PAID
//   - the assistant is an ordinary agent: own agent key, catalog price, can't execute before
//     approval, approval token never reaches the model or the chat history
//   - bad tool arguments / unknown course / unknown tool come back as errors, not crashes
//   - provider fallback (Groq rate-limited -> Gemini), daily message limit, not configured
//   - HTTP: POST /assistant/chat answers 200 with the chat fragment
// Payment is stubbed. Removes its own rows at the end; its @test.local users stay.
require("dotenv").config();
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("../src/db");
const { createEngine } = require("../src/domain");
const { loadProducts } = require("../src/domain/catalogLoader");
const { PgLedgerStore } = require("../src/domain/stores/pgLedgerStore");
const { attachUser } = require("../src/auth");
const agent = require("../src/services/agentPurchase");

// The assistant reads its model settings from the environment on every call: point it at
// the fake model only, whatever .env says.
for (const k of ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "GROQ_API_KEY", "GEMINI_API_KEY", "GROQ_BASE_URL", "GEMINI_BASE_URL", "ASSISTANT_MESSAGES_PER_DAY"])
  delete process.env[k];
const assistant = require("../src/services/assistant");

const userIds = [];
const servers = [];
async function cleanup() {
  for (const s of servers) s.close();
  if (!userIds.length) return;
  const intents = (await pool.query("SELECT id, order_id FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  const keys = (await pool.query("SELECT id FROM agent_keys WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  await pool.query("DELETE FROM intent_events WHERE user_id = ANY($1::uuid[]) OR intent_ref = ANY($2::text[])", [userIds, intents.map((i) => i.id)]);
  await pool.query("DELETE FROM purchase_intents WHERE user_id = ANY($1::uuid[])", [userIds]);
  const orders = intents.map((i) => i.order_id).filter(Boolean);
  if (orders.length) await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orders]);
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM usage_counters WHERE scope_key = ANY($1::text[])", [
    [...userIds.flatMap((id) => [`user:${id}:agent`, `user:${id}:assistant`]), ...keys.map((k) => `agentkey:${k.id}`)],
  ]);
  await pool.query("DELETE FROM assistant_messages WHERE user_id = ANY($1::uuid[])", [userIds]);
  await purgeTestLog();
  await pool.query("DELETE FROM agent_keys WHERE user_id = ANY($1::uuid[])", [userIds]);
}

// assistant_log is append-only; tests remove their own rows the way the retention purge does.
async function purgeTestLog() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('learnx.assistant_log_purge', 'on', true)");
    await c.query("DELETE FROM assistant_log WHERE user_id = ANY($1::uuid[])", [userIds]);
    await c.query("COMMIT");
  } finally { c.release(); }
}
const logOf = async (uid) => (await pool.query("SELECT * FROM assistant_log WHERE user_id=$1 ORDER BY id", [uid])).rows;

// ---- fake model -----------------------------------------------------------------------------
// script(messages) -> { tool: [name, args] } | { text } | { status } (HTTP error)
function fakeModel(script) {
  const seen = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(body);
      const { messages, tools } = JSON.parse(body);
      const out = script(messages, tools);
      if (out.status) { res.writeHead(out.status, { "Content-Type": "application/json" }); return res.end('{"error":"fake"}'); }
      const message = out.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${++n}`, type: "function", function: { name: out.tool[0], arguments: typeof out.tool[1] === "string" ? out.tool[1] : JSON.stringify(out.tool[1] || {}) } }] }
        : { role: "assistant", content: out.text };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  servers.push(srv);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, seen })));
}

const last = (msgs) => msgs[msgs.length - 1];
const lastUser = (msgs) => [...msgs].reverse().find((m) => m.role === "user")?.content || "";
const toolResult = (msgs) => (last(msgs).role === "tool" ? JSON.parse(last(msgs).content) : null);
// Which tool the last tool result answers.
const lastToolName = (msgs) => {
  const id = last(msgs).tool_call_id;
  for (const m of msgs) for (const c of m.tool_calls || []) if (c.id === id) return c.function.name;
  return null;
};
const findIntentId = (msgs) => {
  for (const m of [...msgs].reverse()) if (m.role === "tool") { const r = JSON.parse(m.content); if (r.intentId) return r.intentId; }
  return null;
};

(async () => {
  const products = await loadProducts();
  const engine = createEngine({ products, store: new PgLedgerStore(pool) });
  await engine.projection.rebuildFromLedger();
  const { catalog, decisions, ledger } = engine;
  const courses = catalog.list().filter((p) => (p.type || "COURSE") === "COURSE");
  const C = courses[courses.length - 1];
  const cId = C.slug || C.id;
  const ledgerBefore = (await ledger.getAll()).length;

  const newUser = async (tag) => {
    const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'x') RETURNING id, email", [
      `asst_${tag}_${Date.now()}_${randomUUID().slice(0, 6)}@test.local`,
    ])).rows[0];
    userIds.push(u.id);
    return u;
  };
  const payments = [];
  const startPayment = async ({ intent, orderId }) => { payments.push({ intentId: intent.id, orderId }); return { status: "PAID" }; };
  const say = (user, text) => assistant.chat({ user, text, catalog, decisions, startPayment, ip: "127.0.0.1" });

  // ------------------------------------------------------------ not configured
  const u0 = await newUser("none");
  assert.equal(assistant.isConfigured(), false);
  await assert.rejects(say(u0, "hi"), (e) => e.code === "NOT_CONFIGURED");
  console.log("[ok] assistant without a model key -> NOT_CONFIGURED (nothing else breaks)");

  // ------------------------------------------------------------ full cycle with the fake model
  const shop = await fakeModel((msgs) => {
    const r = toolResult(msgs);
    if (!r) {
      const u = lastUser(msgs);
      if (/approved/i.test(u)) return { tool: ["execute_purchase", { intentId: findIntentId(msgs) }] };
      if (/buy/i.test(u)) return { tool: ["list_courses", {}] };
      return { text: "I can find and buy courses for you." };
    }
    switch (lastToolName(msgs)) {
      case "list_courses": {
        const asked = /productId ([\w-]+)\)/.exec(lastUser(msgs))?.[1] || cId; // a message can name the id
        return { tool: ["propose_purchase", { productId: r.find((c) => c.productId === asked).productId, provider: "mock" }] };
      }
      case "propose_purchase": return { text: "Please approve it with the button on the card." };
      case "execute_purchase": return { text: r.error ? `Not yet: ${r.message}` : `Done: ${r.status}.` };
      default: return { text: "ok" };
    }
  });
  process.env.LLM_BASE_URL = shop.url;
  const ua = await newUser("shop");

  const r1 = await say(ua, `Please buy ${C.name}`);
  assert.deepEqual(r1.steps.map((s) => [s.tool, s.ok]), [["list_courses", true], ["propose_purchase", true]]);
  const intents = await agent.listIntents(ua.id);
  assert.equal(intents.length, 1);
  const i1 = intents[0];
  assert.deepEqual([i1.item_id, i1.amount_cents, i1.status, i1.agent_name, i1.provider], [cId, C.priceCents, "PROPOSED", assistant.AGENT_NAME, "mock"]);
  assert.ok(i1.agent_key_id, "the assistant proposes with its own agent key");
  assert.equal(r1.steps[1].result.card, true, "the proposal is shown as a card");
  const firstCall = JSON.parse(shop.seen[0]).messages;
  const state = firstCall.find((m) => m.role === "system" && /^Current state/.test(m.content)); // after the user's new message
  assert.ok(firstCall.indexOf(state) > firstCall.map((m) => m.role).lastIndexOf("user"), "placed after the user's new message");
  assert.match(state.content, new RegExp(`Current state[\\s\\S]*\\(${cId}\\): not owned`), "every turn carries the current ownership, after the history");
  console.log("[ok] assistant: list_courses -> propose_purchase at the catalog price, with its own agent key; shown as a card");

  const r2 = await say(ua, "I approved it");   // not true yet
  assert.deepEqual(r2.steps.map((s) => [s.tool, s.ok]), [["execute_purchase", false]]);
  assert.match(r2.reply, /only an APPROVED request/);
  assert.equal((await agent.getIntent(i1.id)).status, "PROPOSED", "nothing executed before the user approves");
  console.log("[ok] assistant cannot complete a purchase the user has not approved (it has no approve tool)");

  const ap = await agent.approve({ intentId: i1.id, userId: ua.id }); // the user approves in the browser
  assert.equal(ap.token, null, "an agent-key request's token is not handed to the browser");
  const r3 = await say(ua, "approved, go ahead");
  assert.deepEqual(r3.steps.map((s) => [s.tool, s.ok]), [["execute_purchase", true]]);
  assert.match(r3.reply, /PAID/);
  const done = await agent.getIntent(i1.id);
  assert.equal(done.status, "EXECUTED");
  assert.equal(payments.filter((p) => p.intentId === i1.id).length, 1, "exactly one payment started");
  console.log("[ok] after approval: execute_purchase -> PAID, one payment, request EXECUTED");

  const r4 = await say(ua, "approved, go ahead");
  assert.equal(r4.steps[0].ok, false, "a second execute is refused");
  assert.equal(payments.filter((p) => p.intentId === i1.id).length, 1, "still one payment");
  console.log("[ok] asking again does not pay twice");

  const allSent = shop.seen.join("\n");
  const stored = JSON.stringify((await assistant.listMessages(ua.id)).map((r) => r.message));
  assert.ok(!/eyJ[\w-]+\.eyJ[\w-]+\./.test(allSent), "no approval token ever sent to the model");
  assert.ok(!/eyJ[\w-]+\.eyJ[\w-]+\./.test(stored), "no approval token in the chat history");
  assert.ok((await assistant.listMessages(ua.id)).some((r) => r.message.role === "tool"), "tool results are kept for the model's context");
  console.log("[ok] the approval token never reaches the model or the stored chat");

  // Admin log: one row per turn with the message, reply, tools and model.
  const la = await logOf(ua.id);
  assert.equal(la.length, 4, "one assistant_log row per turn");
  assert.deepEqual(la.map((r) => r.status), ["OK", "OK", "OK", "OK"]);
  assert.equal(la[0].user_message, `Please buy ${C.name}`);
  assert.equal(la[0].reply, r1.reply);
  assert.deepEqual(la[0].tools.map((t) => [t.tool, t.ok]), [["list_courses", true], ["propose_purchase", true]]);
  assert.equal(la[0].tools[1].intentId, i1.id);
  assert.ok(la[1].tools[0].ok === false && la[1].tools[0].error, "a refused tool call is logged with its error code");
  assert.ok(la[0].provider && la[0].model_calls >= 1 && la[0].user_email === ua.email);
  assert.ok(!/eyJ[\w-]+\.eyJ[\w-]+\./.test(JSON.stringify(la)), "no approval token in the admin log");
  await assert.rejects(pool.query("UPDATE assistant_log SET reply='x' WHERE id=$1", [la[0].id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM assistant_log WHERE id=$1", [la[0].id]), /append-only/);
  await pool.query("INSERT INTO assistant_log (user_id, status, user_message, created_at) VALUES ($1,'OK','old', now() - interval '100 days')", [ua.id]);
  assert.ok(await assistant.purgeLog(90) >= 1, "the retention purge removes old rows");
  assert.equal((await logOf(ua.id)).length, 4, "and keeps recent ones");
  console.log("[ok] assistant_log: one row per turn (message, reply, tools, model); no token; no UPDATE/DELETE except the retention purge");

  // ------------------------------------------------------------ bad tool calls
  let step = 0;
  const bad = await fakeModel((msgs) => {
    if (!toolResult(msgs)) step = 0;
    step += 1;
    if (step === 1) return { tool: ["propose_purchase", { productId: "no-such-course" }] };
    if (step === 2) return { tool: ["propose_purchase", "{not json"] };
    if (step === 3) return { tool: ["approve_purchase", { intentId: i1.id }] };
    if (step === 4) return { tool: ["check_request", { intentId: randomUUID() }] };
    return { text: "Sorry, I could not do that." };
  });
  process.env.LLM_BASE_URL = bad.url;
  const ub = await newUser("bad");
  const rb = await say(ub, "do something odd");
  assert.deepEqual(rb.steps.map((s) => s.ok), [false, false, false, false]);
  const results = (await assistant.listMessages(ub.id)).filter((r) => r.message.role === "tool").map((r) => JSON.parse(r.message.content).error);
  assert.deepEqual(results, ["UNKNOWN_ITEM", "BAD_ARGUMENTS", "UNKNOWN_TOOL", "NOT_FOUND"]);
  assert.equal((await agent.listIntents(ub.id)).length, 0, "nothing proposed");
  console.log("[ok] unknown course / bad JSON / made-up approve tool / someone else's request -> errors to the model, nothing done");

  // A model that claims a request it never created is corrected once (and the claim is not kept).
  const liar = await fakeModel((msgs) => {
    const l = last(msgs);
    if (l.role === "system" && /^Correction:/.test(l.content)) return { tool: ["propose_purchase", { productId: cId, provider: "mock" }] };
    if (l.role === "tool" && lastToolName(msgs) === "propose_purchase") return { text: "Done: the card is ready for your approval." };
    return { text: "I've created a purchase request for you: /agent/intents/<new-intent-id>" };
  });
  process.env.LLM_BASE_URL = liar.url;
  const ul = await newUser("liar");
  const rc = await say(ul, "buy it");
  assert.deepEqual(rc.steps.map((st) => [st.tool, st.ok]), [["list_courses", true], ["propose_purchase", true]], "corrected into a real proposal");
  assert.equal(rc.reply, "Done: the card is ready for your approval.");
  const kept = JSON.stringify((await assistant.listMessages(ul.id)).map((r) => r.message));
  assert.ok(!kept.includes("new-intent-id") && !kept.includes("Correction:"), "false claim and correction are not stored");
  const nofix = await fakeModel(() => ({ text: "I have created a purchase request." }));
  process.env.LLM_BASE_URL = nofix.url;
  const rn = await say(ul, "buy it again");
  assert.deepEqual(rn.steps.map((st) => st.tool), ["list_courses"], "only the server-side lookup ran");
  assert.equal(nofix.seen.length, 2, "only one correction round");
  assert.match(rn.reply, /couldn't create that purchase request/, "a repeated false claim is replaced by the truth");
  console.log("[ok] a reply claiming a request that wasn't created is corrected once; if it insists, the user is told the truth");

  // The model fails part-way (e.g. rate limit). Without a started payment the user gets only the
  // message: nothing is stored and a request proposed in that turn is withdrawn.
  const flaky = await fakeModel((msgs) => (toolResult(msgs) ? { status: 429 } : { tool: ["list_my_requests", {}] }));
  process.env.LLM_BASE_URL = flaky.url;
  const uf = await newUser("flaky");
  await assert.rejects(say(uf, "what did I ask for?"), (e) => e.code === "MODEL_BUSY" && /usage limit for now \(Fake free tier\)|usage limit for now/.test(e.message));
  assert.equal((await assistant.listMessages(uf.id)).length, 0, "read-only steps: nothing stored");
  const halfway = await fakeModel((msgs) => (lastToolName(msgs) === "propose_purchase" ? { status: 429 }
    : toolResult(msgs) ? { tool: ["propose_purchase", { productId: cId, provider: "mock" }] } : { text: "?" }));
  process.env.LLM_BASE_URL = halfway.url;
  await assert.rejects(say(uf, "Buy me the course"), (e) => e.code === "MODEL_BUSY");
  const withdrawn = (await agent.listIntents(uf.id)).filter((x) => x.item_id === cId);
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].status, "CANCELLED", "the request proposed in the failed turn is withdrawn (no hidden open request)");
  assert.equal((await assistant.listMessages(uf.id)).length, 0, "and nothing is stored");
  const lf = await logOf(uf.id);
  assert.deepEqual(lf.map((r) => [r.status, r.error_code]), [["ERROR", "MODEL_BUSY"], ["ERROR", "MODEL_BUSY"]], "failed turns are in the admin log");
  assert.ok(lf[1].flags.includes("REQUEST_WITHDRAWN") && lf[1].tools.some((t) => t.tool === "propose_purchase"));
  assert.ok(lf[0].flags.some((f) => /^FALLBACK .*MODEL_BUSY/.test(f)));
  // Once a purchase was executed (payment started), the steps are kept so the card shows it.
  const ue = await newUser("flaky-exec");
  const kp = await agent.propose({ userId: ue.id, productId: cId, provider: "mock", agentName: assistant.AGENT_NAME, agentKeyId: await assistant.assistantKeyId(ue.id), catalog, decisions });
  await agent.approve({ intentId: kp.id, userId: ue.id });
  const afterExec = await fakeModel((msgs) => (toolResult(msgs) ? { status: 503 } : { tool: ["execute_purchase", { intentId: kp.id }] }));
  process.env.LLM_BASE_URL = afterExec.url;
  await assert.rejects(say(ue, `I approved purchase request ${kp.id}. Please complete it now.`), (e) => e.code === "MODEL_ERROR");
  assert.equal((await agent.getIntent(kp.id)).status, "EXECUTED");
  assert.deepEqual((await assistant.listMessages(ue.id)).map((r) => r.message.role), ["user", "assistant", "tool"], "executed purchase: steps kept");
  console.log("[ok] model fails part-way -> only the message (nothing stored, a half-made request withdrawn); after a started payment the steps are kept");

  // A buy request: the server looks the courses up first and hands the result to the model.
  const seenFirst = await fakeModel(() => ({ text: "Here is what I found." }));
  process.env.LLM_BASE_URL = seenFirst.url;
  const uz = await newUser("prefetch");
  const rz = await say(uz, "Buy me the course");
  const msgs0 = JSON.parse(seenFirst.seen[0]).messages;
  const call = msgs0[msgs0.length - 2], res0 = msgs0[msgs0.length - 1];
  assert.equal(call.tool_calls?.[0]?.function?.name, "list_courses", "a fresh list_courses is already in the conversation");
  assert.ok(JSON.parse(res0.content).some((c) => c.productId === cId && c.owned === false && c.openRequest === "none"), "with current ownership and open requests");
  assert.equal(rz.steps[0].tool, "list_courses");
  const quiet = await fakeModel(() => ({ text: "Hello." }));
  process.env.LLM_BASE_URL = quiet.url;
  await say(uz, "hello there");
  assert.ok(!JSON.parse(quiet.seen[0]).messages.slice(-2).some((m) => m.tool_calls), "no lookup for a message that isn't a buy request");
  console.log("[ok] a buy request starts with a server-side list_courses (fresh facts), other messages don't");

  // A degenerate reply (invisible characters, runs of "...") is cleaned before it is shown or stored.
  const junk = await fakeModel(() => ({ text: "Your ​​ ​ …… … ……  ... … …\n\n...\n\nThe course list is above." }));
  process.env.LLM_BASE_URL = junk.url;
  const rj = await say(uz, "hello again");
  assert.equal(rj.reply, "The course list is above.");
  const allJunk = await fakeModel(() => ({ text: "​​ … … … ... …" }));
  process.env.LLM_BASE_URL = allJunk.url;
  assert.match((await say(uz, "and now?")).reply, /couldn't put that answer into words/);
  assert.ok(!(await assistant.listMessages(uz.id)).some((r) => /​/.test(r.message.content || "")), "nothing invisible is stored");
  assert.equal(assistant.cleanReply("Hi!"), "Hi!", "normal short replies are left alone");
  const leak = "Please approve\n\nThe system is confused. Need to correct. The user wants to buy it. We already proposed. We need to ask user to approve. So respond.Please approve.";
  assert.equal(assistant.cleanReply(leak, [{ tool: "propose_purchase", ok: true }]), "I created the purchase request. Approve it on the card below.", "leaked planning text is not shown");
  assert.equal(assistant.cleanReply("You already own Intro to SQL. We can look at the other courses."), "You already own Intro to SQL. We can look at the other courses.", "one such phrase alone is fine");
  assert.equal(assistant.cleanReply("Please click ****\n\nThe response is broken. Need to correct: instruct user to click Pay.Please click the Pay button.",
    [{ tool: "execute_purchase", ok: true, result: { status: "CHECKOUT" } }]), "The purchase is approved. Use the Pay button on the card below to pay.", "a clear self-correction phrase alone is enough");
  console.log("[ok] degenerate model output (zero-width characters, ellipsis runs) is cleaned; unreadable -> a plain fallback");

  // A model that never stops calling tools is cut off.
  const loop = await fakeModel(() => ({ tool: ["list_courses", {}] }));
  process.env.LLM_BASE_URL = loop.url;
  const rl = await say(ub, "loop forever");
  assert.equal(rl.steps.length, 6);
  assert.match(rl.reply, /too many steps/);
  console.log("[ok] a model that keeps calling tools is stopped after 6 steps");

  // ------------------------------------------------------------ provider fallback
  delete process.env.LLM_BASE_URL;
  const busy = await fakeModel(() => ({ status: 429 }));
  const backup = await fakeModel(() => ({ text: "Hello from the backup model." }));
  Object.assign(process.env, { GROQ_API_KEY: "fake", GROQ_BASE_URL: busy.url, GEMINI_API_KEY: "fake", GEMINI_BASE_URL: backup.url });
  const rf = await say(ub, "hello");
  assert.match(rf.provider, /^gemini\//);
  assert.equal(rf.reply, "Hello from the backup model.");
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(say(ub, "hello"), (e) => e.code === "MODEL_BUSY");
  console.log("[ok] Groq rate-limited -> Gemini answers; with no backup -> MODEL_BUSY");

  // ------------------------------------------------------------ daily message limit
  process.env.LLM_BASE_URL = backup.url;
  process.env.ASSISTANT_MESSAGES_PER_DAY = "2";
  const uq = await newUser("quota");
  await say(uq, "one");
  await say(uq, "two");
  await assert.rejects(say(uq, "three"), (e) => e.code === "RATE_LIMITED");
  await assert.rejects(say(uq, "four"), (e) => /today's limit of 2 assistant messages\. Please try again tomorrow\./.test(e.message));
  delete process.env.ASSISTANT_MESSAGES_PER_DAY;
  assert.deepEqual((await logOf(uq.id)).map((r) => r.error_code), [null, null, "RATE_LIMITED", "RATE_LIMITED"], "limit hits are logged");
  console.log("[ok] daily assistant message limit -> RATE_LIMITED (logged for the admin)");

  // ------------------------------------------------------------ purchase-request limit: just the message
  process.env.AGENT_PROPOSALS_PER_DAY = "0";
  let asked = 0;
  const lim = await fakeModel((msgs) => {
    if (lastToolName(msgs) === "propose_purchase") { asked++; return { text: "Something the model made up." }; }
    return toolResult(msgs) ? { tool: ["propose_purchase", { productId: cId }] } : { text: "?" };
  });
  process.env.LLM_BASE_URL = lim.url;
  const upl = await newUser("proplimit");
  const rpl = await say(upl, "Buy me the course");
  assert.match(rpl.reply, /^Too many purchase requests today \(limit 0\)\. Try again later\.$/, "the limit message itself");
  assert.equal(asked, 0, "the model is not asked to explain the limit");
  assert.equal((await agent.listIntents(upl.id)).length, 0, "no request created");
  assert.ok((await logOf(upl.id))[0].flags.includes("LIMIT_REACHED"));
  delete process.env.AGENT_PROPOSALS_PER_DAY;
  console.log("[ok] purchase-request limit -> the turn ends with exactly the limit message (no model guesswork, no request)");

  // ------------------------------------------------------------ HTTP route
  process.env.LLM_BASE_URL = shop.url;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(attachUser);
  app.locals.engine = engine;
  app.locals.agentStartPayment = startPayment;
  app.use(require("../src/routes/agent"));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).send(err.message); });
  const web = app.listen(0);
  servers.push(web);
  await new Promise((r) => web.once("listening", r));
  const uh = await newUser("http");
  const cookie = `token=${jwt.sign({ sub: uh.id, email: uh.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
  const post = async (path, form) => {
    const r = await fetch(`http://127.0.0.1:${web.address().port}${path}`, { method: "POST", redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { status: r.status, text: await r.text() };
  };
  const h1 = await post("/assistant/chat", { message: `buy ${C.name} <script>x</script>` });
  assert.equal(h1.status, 200);
  assert.ok(!/propose_purchase|list_courses|🔧/.test(h1.text), "tool calls are not shown in the chat");
  assert.ok(!h1.text.includes("<script>x</script>"), "user text is escaped");
  const hi = (await agent.listIntents(uh.id))[0];
  assert.match(h1.text, new RegExp(`id="pc-${hi.id}"`), "the proposal comes back as a purchase card");
  assert.match(h1.text, new RegExp(`hx-swap-oob="beforeend:#chat-cards"><div id="pc-${hi.id}"`), "a new card goes to the card area below the messages");
  assert.match(h1.text, new RegExp(`hx-post="/assistant/approve/${hi.id}"`), "with an Approve button");
  assert.match(h1.text, new RegExp(`hx-post="/assistant/cancel/${hi.id}"`), "and a Cancel button");
  assert.match(h1.text, /name="provider" value="razorpay"/, "and a choice of Razorpay");
  assert.match(h1.text, /name="provider" value="mock" checked/, "or Mock (preselected: what was proposed)");
  console.log("[ok] HTTP: chat answer shows the proposal as a card with Razorpay / Mock choice, Approve and Cancel (text escaped)");

  // Approve button: the user's click approves, then the assistant completes the purchase.
  // (Password step-up is checked in verify-m7; test users have no real password.)
  process.env.AGENT_STEPUP_ABOVE_CENTS = "1000000";
  const ha = await post(`/assistant/approve/${hi.id}`, { password: "", provider: "razorpay", amount: String((await agent.getIntent(hi.id)).amount_cents) });
  assert.equal(ha.status, 200);
  assert.match(ha.text, /Approved /);
  assert.ok(!/execute_purchase|✅/.test(ha.text), "no tool lines or emoji");
  assert.match(ha.text, new RegExp(`id="pc-${hi.id}" hx-swap-oob="true"`), "the card updates in place");
  const hd = await agent.getIntent(hi.id);
  assert.equal(hd.status, "EXECUTED");
  assert.equal(hd.provider, "razorpay", "the provider the user picked on the card is used");
  assert.equal(payments.filter((p) => p.intentId === hi.id).length, 1);
  assert.match((await post(`/assistant/approve/${hi.id}`, {})).text, /already_approved|executed/i, "a second click does nothing");
  assert.equal(payments.filter((p) => p.intentId === hi.id).length, 1, "still one payment");
  delete process.env.AGENT_STEPUP_ABOVE_CENTS;
  console.log("[ok] HTTP: Approve with Razorpay picked -> provider switched, approved by the user, completed by the assistant; second click refused");

  // Pay button: a Razorpay request waiting for payment links to /assistant/pay/:id, which sends
  // the user to the checkout link stored at execute time.
  {
    const up = await newUser("pay");
    const ck = `token=${jwt.sign({ sub: up.id, email: up.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
    const keyId = await assistant.assistantKeyId(up.id);
    const ip = await agent.propose({ userId: up.id, productId: cId, provider: "razorpay", agentName: assistant.AGENT_NAME, agentKeyId: keyId, catalog, decisions });
    await agent.approve({ intentId: ip.id, userId: up.id });
    const tk = await agent.pickupToken({ intentId: ip.id, agentKeyId: keyId });
    await agent.execute({ intentId: ip.id, token: tk, userId: up.id, agentKeyId: keyId, catalog, decisions,
      startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "/razorpay/checkout?orderId=order_test&back=agent" }) });
    await pool.query("INSERT INTO assistant_messages (user_id, message) VALUES ($1,$2)", [up.id, { role: "tool", tool_call_id: "x", content: JSON.stringify({ intentId: ip.id, card: true }) }]);
    const pg2 = await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: ck } }).then((r) => r.text());
    assert.match(pg2, new RegExp(`href="/assistant/pay/${ip.id}"`), "the card's Pay button");
    assert.match(pg2, new RegExp(`hx-get="/assistant/card/${ip.id}\\?shown=EXECUTED\\.PENDING" hx-trigger="every 4s"`), "a card waiting for payment refreshes itself");
    const same = await fetch(`http://127.0.0.1:${web.address().port}/assistant/card/${ip.id}?shown=EXECUTED.PENDING`, { headers: { Cookie: ck } });
    assert.equal(same.status, 204, "unchanged -> nothing to swap");
    const go = await fetch(`http://127.0.0.1:${web.address().port}/assistant/pay/${ip.id}`, { headers: { Cookie: ck }, redirect: "manual" });
    assert.equal(go.status, 303);
    assert.equal(go.headers.get("location"), "/razorpay/checkout?orderId=order_test&back=agent");
    const notMine = await fetch(`http://127.0.0.1:${web.address().port}/assistant/pay/${ip.id}`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(notMine.headers.get("location"), "/agent", "another user's request: back to /agent");
    console.log("[ok] HTTP: Pay button -> /assistant/pay/:id -> the stored Razorpay checkout link (owner only); pending card polls");

    assert.match(pg2, new RegExp(`hx-post="/assistant/cancel-payment/${ip.id}"`), "and a Cancel payment button");
    // Closing checkout without paying: that payment is cancelled and the card says so.
    const orderId = (await agent.getIntent(ip.id)).order_id;
    const other = await fetch(`http://127.0.0.1:${web.address().port}/assistant/checkout-closed?ref=${orderId}`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(other.status, 303);
    assert.equal((await agent.getIntent(ip.id)).status, "EXECUTED", "another user can't cancel it");
    const closed = await fetch(`http://127.0.0.1:${web.address().port}/assistant/checkout-closed?ref=${orderId}`, { headers: { Cookie: ck }, redirect: "manual" });
    assert.equal(closed.headers.get("location"), "/agent");
    const ic = await agent.getIntent(ip.id);
    assert.deepEqual([ic.status, ic.order_status], ["FAILED", "CANCELLED"]);
    const card = await fetch(`http://127.0.0.1:${web.address().port}/assistant/card/${ip.id}`, { headers: { Cookie: ck } }).then((r) => r.text());
    assert.match(card, /Payment cancelled at checkout\. Nothing was charged/);
    assert.ok(!/assistant\/pay\/|hx-trigger/.test(card), "no Pay button and no more polling");
    // A finished card is marked for removal and its outcome line is added to the chat, once.
    assert.match(card, new RegExp(`id="pc-${ip.id}" class="pc-done"`), "finished card is marked so the page removes it");
    assert.match(card, /hx-swap-oob="beforeend:#chat-log">[\s\S]*was cancelled at checkout\. Nothing was charged/, "outcome line appended to the log");
    const card2 = await fetch(`http://127.0.0.1:${web.address().port}/assistant/card/${ip.id}`, { headers: { Cookie: ck } }).then((r) => r.text());
    assert.match(card2, /hx-swap-oob="beforeend:#chat-log">[\s\S]*was cancelled at checkout/, "a second open /agent tab also gets the line when its card finishes");
    assert.ok(!/hx-trigger/.test(card2), "a finished card stops polling, so each page gets it once");
    assert.equal((await assistant.listMessages(up.id)).filter((r) => r.message.note === `done:${ip.id}`).length, 1, "but it is stored once");
    const pgDone = await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: ck } }).then((r) => r.text());
    assert.ok(!pgDone.includes(`id="pc-${ip.id}"`), "a finished request has no card on /agent");
    assert.match(pgDone, /class="err">[^<]*was cancelled at checkout/, "its outcome line stays in the log");
    assert.match(pgDone, /pc-gone/, "the page has the fade-out rule");
    const again = await agent.propose({ userId: up.id, productId: cId, provider: "razorpay", agentName: assistant.AGENT_NAME, agentKeyId: keyId, catalog, decisions });
    assert.equal(again.status, "PROPOSED", "the course can be requested again");
    console.log("[ok] HTTP: checkout closed without paying -> order CANCELLED, request FAILED, card says so (no Pay), outcome line once, card removed; can ask again");

    // A declined payment (payment.failed webhook marks the order FAILED) shows on the card.
    await agent.approve({ intentId: again.id, userId: up.id });
    const tk2 = await agent.pickupToken({ intentId: again.id, agentKeyId: keyId });
    await agent.execute({ intentId: again.id, token: tk2, userId: up.id, agentKeyId: keyId, catalog, decisions,
      startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "/razorpay/checkout?orderId=order_test2&back=agent" }) });
    await pool.query("UPDATE orders SET status='FAILED' WHERE id=$1", [(await agent.getIntent(again.id)).order_id]);
    const failedCard = await fetch(`http://127.0.0.1:${web.address().port}/assistant/card/${again.id}`, { headers: { Cookie: ck } }).then((r) => r.text());
    assert.match(failedCard, /Payment failed\. Nothing was charged/);
    // Cancel payment button on a pending card
    const again2 = await agent.propose({ userId: up.id, productId: cId, provider: "razorpay", agentName: assistant.AGENT_NAME, agentKeyId: keyId, catalog, decisions });
    await agent.approve({ intentId: again2.id, userId: up.id });
    const tk3 = await agent.pickupToken({ intentId: again2.id, agentKeyId: keyId });
    await agent.execute({ intentId: again2.id, token: tk3, userId: up.id, agentKeyId: keyId, catalog, decisions,
      startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "/razorpay/checkout?orderId=order_test3&back=agent" }) });
    const cp = await fetch(`http://127.0.0.1:${web.address().port}/assistant/cancel-payment/${again2.id}`, { method: "POST", headers: { Cookie: ck } }).then((r) => r.text());
    assert.match(cp, /Payment cancelled at checkout/);
    assert.equal((await agent.getIntent(again2.id)).order_status, "CANCELLED");
    assert.ok(!/assistant\/pay\//.test(failedCard), "no Pay button after a failed payment");
    console.log("[ok] HTTP: failed payment -> card shows 'Payment failed', no Pay button; Cancel payment button cancels a pending payment");
  }

  // Mock provider through the assistant: a checkout page like Razorpay, not an instant charge.
  {
    const um = await newUser("mockpay");
    const ckm = `token=${jwt.sign({ sub: um.id, email: um.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
    const km = await assistant.assistantKeyId(um.id);
    const im = await agent.propose({ userId: um.id, productId: cId, provider: "mock", agentName: assistant.AGENT_NAME, agentKeyId: km, catalog, decisions });
    await agent.approve({ intentId: im.id, userId: um.id });
    await agent.execute({ intentId: im.id, token: await agent.pickupToken({ intentId: im.id, agentKeyId: km }), userId: um.id, agentKeyId: km, catalog, decisions,
      startPayment: async () => ({ status: "CHECKOUT", redirectUrl: "http://mock.test/pay/mock_pay_x?ref=o&back=agent" }) });
    await pool.query("INSERT INTO assistant_messages (user_id, message) VALUES ($1,$2)", [um.id, { role: "tool", tool_call_id: "m", content: JSON.stringify({ intentId: im.id, card: true }) }]);
    const pgm = await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: ckm } }).then((r) => r.text());
    assert.match(pgm, /Pay 20\.00 USD with Mock provider|Pay [\d.]+ USD with Mock provider/, "a Pay button for the mock checkout");
    assert.match(pgm, /Simulate Failure or Cancel/);
    assert.ok(!/Payment processing/.test(pgm), "not paid automatically");
    const gom = await fetch(`http://127.0.0.1:${web.address().port}/assistant/pay/${im.id}`, { headers: { Cookie: ckm }, redirect: "manual" });
    assert.equal(gom.headers.get("location"), "http://mock.test/pay/mock_pay_x?ref=o&back=agent", "Pay opens the mock checkout page");
    assert.equal((await agent.getIntent(im.id)).order_status, "PENDING", "nothing paid until the user pays on the mock page");
    console.log("[ok] HTTP: mock purchases through the assistant go through the mock checkout page (Pay button, back to /agent), not an instant charge");
  }

  // Cancel button
  const B = courses.find((c) => (c.slug || c.id) !== cId && !decisions.evaluateAccess(uh.id, c.slug || c.id).allowed);
  const bId = B.slug || B.id;
  await post("/assistant/chat", { message: `Please buy ${B.name} (productId ${bId})` });
  const bi = (await agent.listIntents(uh.id)).find((x) => x.item_id === bId);
  assert.ok(bi && bi.status === "PROPOSED");
  const hc = await post(`/assistant/cancel/${bi.id}`, {});
  assert.match(hc.text, /CANCELLED/);
  assert.match(hc.text, /class="pc-done"/, "a cancelled card is removed after a few seconds");
  assert.match(hc.text, new RegExp(`Purchase request for ${B.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cancelled`));
  assert.equal((await agent.getIntent(bi.id)).status, "CANCELLED");
  assert.equal((await post("/assistant/buy", { productId: bId })).status, 404, "Buy via assistant (course cards) is gone");
  console.log("[ok] HTTP: Cancel button cancels the request; /assistant/buy is gone");

  const page = await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.match(page, /LEARNX Assistant/);
  const logPart = page.slice(page.indexOf('id="chat-log"'), page.indexOf('id="chat-cards"'));
  const cardPart = page.slice(page.indexOf('id="chat-cards"'), page.indexOf('hx-post="/assistant/chat"'));
  assert.ok(page.indexOf('id="chat-log"') < page.indexOf('id="chat-cards"') && page.indexOf('id="chat-cards"') < page.indexOf('hx-post="/assistant/chat"'),
    "order: messages, then cards, then the input");
  assert.ok(!logPart.includes('id="pc-') && cardPart.includes(`id="pc-${hi.id}"`), "cards are below all messages, not between them");
  assert.match(page, />Approved /, "the approval message shows as a short line");
  // Once the order is paid, /agent adds one "Payment received" line (written by the app, not the model).
  await pool.query("UPDATE orders SET status='COMPLETED' WHERE id=$1", [hd.order_id]);
  const paidPage = await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.match(paidPage, new RegExp(`Payment received: ${C.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is now in your library`));
  await fetch(`http://127.0.0.1:${web.address().port}/agent`, { headers: { Cookie: cookie } });
  assert.equal((await assistant.listMessages(uh.id)).filter((r) => r.message.note === `paid:${hi.id}`).length, 1, "added once");
  assert.equal((await post("/assistant/clear", {})).status, 303);
  assert.equal((await assistant.listMessages(uh.id)).length, 0);
  assert.ok((await logOf(uh.id)).length >= 2, "Clear chat does not erase the admin log");
  console.log("[ok] HTTP: /agent shows all messages first and the cards (buttons) below them, no tool lines; one 'Payment received' line once paid; clear works");

  // ------------------------------------------------------------ admin page: admin only
  {
    const admin = await newUser("admin");
    const prevAdmin = process.env.ADMIN_EMAIL;
    process.env.ADMIN_EMAIL = admin.email;
    const aapp = express();
    aapp.use(cookieParser());
    aapp.use(attachUser);
    aapp.use(require("../src/routes/admin"));
    const aweb = aapp.listen(0);
    servers.push(aweb);
    await new Promise((r) => aweb.once("listening", r));
    const get = (path, ck) => fetch(`http://127.0.0.1:${aweb.address().port}${path}`, { headers: ck ? { Cookie: ck } : {}, redirect: "manual" });
    const adminCookie = `token=${jwt.sign({ sub: admin.id, email: admin.email }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
    for (const path of ["/admin/assistant", `/admin/assistant/rows?user=${uh.id}`]) {
      assert.equal((await get(path)).status, 302, `${path}: signed out -> redirect`);
      const asUser = await get(path, cookie);
      assert.equal(asUser.status, 302, `${path}: an ordinary user is redirected`);
      assert.ok(!/assistant/.test(asUser.headers.get("location") || ""), "not to the log");
    }
    const pg = await get(`/admin/assistant?user=${uh.id}`, adminCookie);
    assert.equal(pg.status, 200);
    const html = await pg.text();
    assert.match(html, /Assistant Log/);
    assert.ok(html.includes(uh.email), "rows of that user");
    assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;") && !html.includes("<script>x</script>"), "messages are escaped");
    const errs = await (await get(`/admin/assistant/rows?status=errors&user=${uf.id}`, adminCookie)).text();
    assert.match(errs, /MODEL_BUSY/);
    const found = await (await get(`/admin/assistant/rows?q=${encodeURIComponent("what did I ask")}`, adminCookie)).text();
    assert.ok(found.includes(uf.email), "search by message text");
    assert.ok(!found.includes(uq.email), "and only matches");
    if (prevAdmin === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = prevAdmin;
    console.log("[ok] HTTP: /admin/assistant shows the log (search, errors filter, per user, escaped) to the admin only");
  }

  assert.equal((await ledger.getAll()).length, ledgerBefore, "nothing written to the ledger directly");
  console.log("\nASSISTANT CHECKS PASSED");
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error("cleanup:", e.message)); await pool.end(); });

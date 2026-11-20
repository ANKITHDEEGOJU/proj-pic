'use strict';
// M7: agent identities (table agent_keys).
//
// Every purchase request records which agent made it (purchase_intents.agent_key_id), and the
// approval token is bound to that agent: only the agent that proposed a request can collect its
// approval (agentPurchase.pickupToken) and complete it (WRONG_AGENT otherwise).
// LEARNX Assistant gets one such identity per user ("learnx-assistant", created on first use).
// A random key is generated and only its SHA-256 hash is stored; nothing logs in with it, since
// the assistant runs inside the server. There is deliberately no "approve" scope: approving
// needs the user's browser session (and a password step-up above AGENT_STEPUP_ABOVE_CENTS).

const crypto = require('node:crypto');
const pool = require('../db');

const PREFIX = 'lx_agent_';
const SCOPES = ['propose', 'read', 'execute'];
const hash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

async function createKey({ userId, name, scopes = SCOPES }) {
  const clean = String(name || '').trim().slice(0, 60) || 'my-agent';
  const bad = scopes.filter((s) => !SCOPES.includes(s));
  if (bad.length || !scopes.length) throw new Error(`Unknown scope(s): ${bad.join(', ') || '(none)'}`);
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO agent_keys (user_id, name, key_prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, user_id, name, key_prefix, scopes, created_at`,
    [userId, clean, key.slice(0, PREFIX.length + 6), hash(key), scopes]
  );
  return { key, row: rows[0] };
}

module.exports = { createKey, SCOPES, PREFIX };

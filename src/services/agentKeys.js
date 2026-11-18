'use strict';
// M7: agent keys - an agent's own credential, separate from the user's login.
//
// The user creates a key in the browser (/agent) and gives it to their agent. The agent sends
// it as "Authorization: Bearer lx_agent_..." to /agent/api/* only. The key is shown once;
// only its SHA-256 hash is stored (the key is 32 random bytes, so a plain hash is enough).
// Scopes: propose, read, execute. There is deliberately no "approve" scope: approving needs
// the user's browser session (and a password step-up above AGENT_STEPUP_ABOVE_CENTS).

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

async function listKeys(userId) {
  return (await pool.query(
    `SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
       FROM agent_keys WHERE user_id=$1 ORDER BY created_at DESC`,
    [userId]
  )).rows;
}

async function revokeKey({ id, userId }) {
  const { rowCount } = await pool.query(
    'UPDATE agent_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
    [id, userId]
  );
  return rowCount === 1;
}

// Returns the active key row for a raw key, or null.
async function authenticate(rawKey) {
  if (!String(rawKey || '').startsWith(PREFIX)) return null;
  const { rows } = await pool.query(
    `UPDATE agent_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL
     RETURNING id, user_id, name, scopes`,
    [hash(rawKey)]
  );
  return rows[0] || null;
}

module.exports = { createKey, listKeys, revokeKey, authenticate, SCOPES, PREFIX };

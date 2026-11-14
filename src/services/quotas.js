'use strict';
// M5 usage quotas.
//
// A premium feature spends "units" from a daily quota (UTC day). Which quota applies is
// decided from the caller's access to the product:
//   - access through an organization seat  -> pooled quota of the org (org:<id>),
//     limit = active seats across the org's packs * QUOTA_<FEATURE>_PER_SEAT
//   - access through the All-Access pass    -> personal quota, QUOTA_<FEATURE>_SUBSCRIBER
//   - any other access (purchase, grant)    -> personal quota, QUOTA_<FEATURE>_USER
// No access means no quota at all (403 at the route).
//
// consume() is safe under concurrency: the counter only moves through
//   INSERT ... ON CONFLICT DO UPDATE SET used = used + n WHERE used + n <= limit
// which Postgres evaluates under the row lock, so N parallel requests against a limit of L
// accept exactly min(N, L - used). Each accepted request is logged in usage_events with its
// request key; a retry with the same key is answered from that row and not counted twice.
// If the feature's work then fails, release() gives the units back.

const pool = require('../db');

class QuotaError extends Error {
  constructor(code, message, info = {}) { super(message); this.code = code; Object.assign(this, info); }
}

const FEATURES = {
  AI_SUMMARY: { label: 'AI course summary', defaults: { USER: 5, SUBSCRIBER: 20, PER_SEAT: 10 } },
};

function limitFor(feature, kind) {
  const f = FEATURES[feature];
  if (!f) throw new QuotaError('UNKNOWN_FEATURE', `Unknown feature ${feature}`);
  const env = Number(process.env[`QUOTA_${feature}_${kind}`]);
  return Number.isInteger(env) && env >= 0 ? env : f.defaults[kind];
}

// Start of the current UTC day, and seconds until the next one (for Retry-After).
function currentPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const resetsAt = new Date(start.getTime() + 86_400_000);
  return { start, resetsAt, retryAfterSec: Math.max(1, Math.ceil((resetsAt - now) / 1000)) };
}

// The org whose seat gave this access, from the SEAT_ASSIGNED ledger event.
async function orgForSeatEvent(eventId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.org_id FROM commerce_ledger l
       JOIN org_seat_pools p ON p.id::text = l.payment_info->>'poolId'
      WHERE l.event_id = $1 AND l.event_type = 'SEAT_ASSIGNED'`,
    [eventId]
  );
  return rows[0]?.org_id || null;
}

async function orgSeatCount(orgId, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(seats), 0)::int AS seats FROM org_seat_pools WHERE org_id=$1 AND status='ACTIVE'`,
    [orgId]
  );
  return rows[0].seats;
}

// Decides which quota a request draws from. `decision` is the entitlement decision for the
// product the feature is used on (decisions.evaluateAccess).
async function resolveQuota({ userId, feature, decision }) {
  if (!decision?.allowed) throw new QuotaError('NO_ACCESS', 'You need access to this course first.');
  if (decision.grantedVia === 'SEAT_ASSIGNED') {
    const orgId = await orgForSeatEvent(decision.sourceEventIds[0]);
    if (orgId) {
      const seats = await orgSeatCount(orgId);
      return { scopeKey: `org:${orgId}`, kind: 'ORG_POOL', orgId, limit: seats * limitFor(feature, 'PER_SEAT') };
    }
  }
  if (decision.reason === 'ACTIVE_SUBSCRIPTION_PASS')
    return { scopeKey: `user:${userId}`, kind: 'SUBSCRIBER', limit: limitFor(feature, 'SUBSCRIBER') };
  return { scopeKey: `user:${userId}`, kind: 'USER', limit: limitFor(feature, 'USER') };
}

async function usage(scopeKey, feature, now = new Date(), db = pool) {
  const { start } = currentPeriod(now);
  const { rows } = await db.query(
    'SELECT used FROM usage_counters WHERE scope_key=$1 AND feature=$2 AND period_start=$3',
    [scopeKey, feature, start]
  );
  return rows[0]?.used ?? 0;
}

// Takes `units` from the quota. Returns { ok, duplicate, used, limit, remaining, resetsAt,
// retryAfterSec }. ok=false means the quota is exhausted (nothing was taken).
async function consume({ requestKey, quota, feature, userId, productId = null, units = 1, now = new Date() }) {
  if (!requestKey) throw new QuotaError('NO_REQUEST_KEY', 'requestKey is required');
  if (!Number.isInteger(units) || units < 1) throw new QuotaError('BAD_UNITS', 'units must be a positive integer');
  const { start, resetsAt, retryAfterSec } = currentPeriod(now);
  const base = { limit: quota.limit, resetsAt, retryAfterSec };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Claim the request key first. A concurrent request with the same key waits here on the
    // unique index until this transaction ends, then sees the row as a duplicate.
    const claim = await client.query(
      `INSERT INTO usage_events (request_key, scope_key, feature, period_start, user_id, product_id, units, limit_value, used_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)
       ON CONFLICT (request_key) DO NOTHING RETURNING id`,
      [requestKey, quota.scopeKey, feature, start, userId, productId, units, quota.limit]
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      // Use this client, not the pool: under a burst every pooled connection may be held here.
      const prev = (await client.query('SELECT * FROM usage_events WHERE request_key=$1', [requestKey])).rows[0];
      if (prev.user_id !== userId) throw new QuotaError('KEY_CONFLICT', 'Request key belongs to another user');
      return { ...base, ok: prev.status === 'CONSUMED', duplicate: true, status: prev.status,
               used: prev.used_after, limit: prev.limit_value, remaining: Math.max(0, prev.limit_value - prev.used_after) };
    }

    const take = units <= quota.limit
      ? await client.query(
          `INSERT INTO usage_counters (scope_key, feature, period_start, used) VALUES ($1,$2,$3,$4)
           ON CONFLICT (scope_key, feature, period_start)
           DO UPDATE SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
                   WHERE usage_counters.used + EXCLUDED.used <= $5
           RETURNING used`,
          [quota.scopeKey, feature, start, units, quota.limit]
        )
      : { rowCount: 0 };

    if (!take.rowCount) {
      await client.query('ROLLBACK'); // also drops the claimed key, so a later retry may succeed
      const used = await usage(quota.scopeKey, feature, now, client);
      return { ...base, ok: false, duplicate: false, used, remaining: Math.max(0, quota.limit - used) };
    }
    const used = take.rows[0].used;
    await client.query('UPDATE usage_events SET used_after=$2 WHERE id=$1', [claim.rows[0].id, used]);
    await client.query('COMMIT');
    return { ...base, ok: true, duplicate: false, used, remaining: quota.limit - used };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Gives a consumed request's units back (its work failed). Idempotent: only the first call
// for a key changes the counter.
async function release(requestKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ev = await client.query(
      `UPDATE usage_events SET status='RELEASED', released_at=now()
        WHERE request_key=$1 AND status='CONSUMED'
        RETURNING scope_key, feature, period_start, units`,
      [requestKey]
    );
    if (ev.rowCount) {
      const { scope_key, feature, period_start, units } = ev.rows[0];
      await client.query(
        `UPDATE usage_counters SET used = GREATEST(used - $4, 0), updated_at = now()
          WHERE scope_key=$1 AND feature=$2 AND period_start=$3`,
        [scope_key, feature, period_start, units]
      );
    }
    await client.query('COMMIT');
    return ev.rowCount > 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { FEATURES, QuotaError, limitFor, currentPeriod, resolveQuota, usage, consume, release };

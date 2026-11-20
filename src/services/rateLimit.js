'use strict';
// Small in-memory rate limiter (fixed windows) for password guessing:
//   - login:    LOGIN_MAX_FAILS attempts per email from one IP, LOGIN_MAX_PER_EMAIL attempts per email
//               from anywhere, LOGIN_MAX_PER_IP attempts per IP, per window (counted BEFORE the password
//               check, so parallel requests can't slip past; a successful login clears its counts)
//   - register: REGISTER_MAX_PER_IP sign-ups per IP per hour
//   - step-up:  STEPUP_MAX_FAILS wrong approval passwords per user per window
// Counters live in this process (like the entitlement projection: one app instance, see README).
// A blocked request is refused before the password is checked, so it costs no bcrypt work.
const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const LIMITS = {
  loginFail: () => ({ max: num('LOGIN_MAX_FAILS', 5), windowMs: num('LOGIN_WINDOW_MINUTES', 15) * 60e3 }),
  loginEmail: () => ({ max: num('LOGIN_MAX_PER_EMAIL', 50), windowMs: num('LOGIN_WINDOW_MINUTES', 15) * 60e3 }),
  loginIp: () => ({ max: num('LOGIN_MAX_PER_IP', 30), windowMs: num('LOGIN_WINDOW_MINUTES', 15) * 60e3 }),
  registerIp: () => ({ max: num('REGISTER_MAX_PER_IP', 10), windowMs: 60 * 60e3 }),
  stepUpFail: () => ({ max: num('STEPUP_MAX_FAILS', 5), windowMs: num('LOGIN_WINDOW_MINUTES', 15) * 60e3 }),
};

const buckets = new Map(); // `${kind}:${key}` -> { count, resetAt }

function bucket(kind, key) {
  const k = `${kind}:${String(key).toLowerCase()}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + LIMITS[kind]().windowMs };
    buckets.set(k, b);
  }
  return b;
}
const retryAfter = (b) => Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));

// Is this key blocked right now? { blocked, retryAfterSec }
function check(kind, key) {
  const b = bucket(kind, key);
  return b.count >= LIMITS[kind]().max ? { blocked: true, retryAfterSec: retryAfter(b) } : { blocked: false, retryAfterSec: 0 };
}
// Count one attempt (or one failure). blocked: this attempt went over the limit (the first
// `max` attempts in a window are allowed; check() before an attempt blocks once `max` is reached).
function hit(kind, key) {
  const b = bucket(kind, key);
  b.count += 1;
  return b.count > LIMITS[kind]().max ? { blocked: true, retryAfterSec: retryAfter(b) } : { blocked: false, retryAfterSec: 0 };
}
function reset(kind, key) { buckets.delete(`${kind}:${String(key).toLowerCase()}`); }
const waitText = (sec) => (sec >= 90 ? `${Math.ceil(sec / 60)} minutes` : `${sec} seconds`);

// Drop expired windows now and then.
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k); }, 60e3).unref();

module.exports = { check, hit, reset, waitText, _buckets: buckets };

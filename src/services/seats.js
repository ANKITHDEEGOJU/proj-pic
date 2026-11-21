'use strict';
// M4 enterprise seats.
//
// An organization (created by a platform admin, run by its managers) buys seat packs: N seats of one course, paid through the
// normal provider checkout. The pack is recorded in the ledger as SEAT_POOL_PURCHASED (money,
// refundable, no access for the buyer). Each person a manager assigns gets a SEAT_ASSIGNED
// event (source ORG_SEAT, payment_info.poolId); SEAT_UNASSIGNED takes it back.
//
// Seat usage is never stored as a counter: it is counted from the ledger (assignments of the
// pool that have not been reversed). Assign / unassign / reassign of one pool are serialized
// with a Postgres advisory lock, so two concurrent assignments cannot overfill a pack.

const { randomUUID } = require('node:crypto');
const pool = require('../db');
const { createOrder } = require('./orders');

class SeatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MAX_SEATS_PER_PACK = 500;

// ---- organizations & managers ------------------------------------------------------------
// A learner requests an organization; the platform admin approves it (the organization is
// created with the requester as its manager) or rejects it (ADR-023). After that the manager runs
// it: buys seat packs and assigns seats. A seat holder only sees which organization gives them
// which course. A manager is matched to an account by email (case-insensitive).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new SeatError('NO_EMAIL', 'Enter an email address.');
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new SeatError('BAD_EMAIL', `${e} is not a valid email address.`);
  return e;
}

// "a@x.com, b@y.com" or an array -> unique, cleaned emails.
function parseEmails(list) {
  const parts = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  return [...new Set(parts.filter((x) => String(x).trim()).map(cleanEmail))];
}

// The platform admin manages the platform, not an organization: never a manager (ADR-022).
function refuseAdmin(email) {
  const admin = String(process.env.ADMIN_EMAIL || 'admin@learnx.com').trim().toLowerCase();
  if (String(email).toLowerCase() === admin) throw new SeatError('ADMIN_EMAIL', 'The platform admin cannot be an organization manager.');
}

function cleanOrgName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new SeatError('BAD_ORG', 'Give the organization a name.');
  if (clean.length > 120) throw new SeatError('BAD_ORG', 'The name can be at most 120 characters.');
  return clean;
}

// Creates an organization with its managers inside the caller's transaction. Names are unique
// (case-insensitive); creations are serialized so two approvals can't make the same name twice.
async function insertOrg(client, { name, managerEmails, actor }) {
  const clean = cleanOrgName(name);
  const emails = parseEmails(managerEmails);
  if (!emails.length) throw new SeatError('NO_MANAGER', 'An organization needs a manager.');
  emails.forEach(refuseAdmin);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('org:create'))");
  const dup = await client.query('SELECT 1 FROM organizations WHERE lower(name)=lower($1)', [clean]);
  if (dup.rows[0]) throw new SeatError('ORG_EXISTS', `An organization named "${clean}" already exists.`);
  const org = (await client.query('INSERT INTO organizations (name, created_by) VALUES ($1,$2) RETURNING *', [clean, actor])).rows[0];
  for (const e of emails) {
    await client.query('INSERT INTO org_managers (org_id, email, added_by) VALUES ($1,$2,$3)', [org.id, e, actor]);
  }
  return org;
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Used by the approval below, and by the test scripts to set up an organization directly.
async function createOrg({ name, managerEmails, actor }) {
  return inTransaction((client) => insertOrg(client, { name, managerEmails, actor }));
}

// ---- organization requests --------------------------------------------------------------

// A learner asks for an organization. One open request per learner; the name must be free.
async function requestOrg({ user, name }) {
  refuseAdmin(user.email);
  const clean = cleanOrgName(name);
  const taken = await pool.query(
    `SELECT 1 FROM organizations WHERE lower(name)=lower($1)
     UNION ALL SELECT 1 FROM org_requests WHERE status='PENDING' AND lower(org_name)=lower($1)`,
    [clean]
  );
  if (taken.rows[0]) throw new SeatError('ORG_EXISTS', `The name "${clean}" is already taken or requested. Choose another name.`);
  const { rows } = await pool.query(
    `INSERT INTO org_requests (user_id, org_name) VALUES ($1,$2)
     ON CONFLICT (user_id) WHERE status='PENDING' DO NOTHING RETURNING *`,
    [user.id, clean]
  );
  if (!rows[0]) throw new SeatError('REQUEST_OPEN', 'You already have a request waiting for approval.');
  return rows[0];
}

// The admin approves: the organization is created with the requester as manager, in one step.
async function approveRequest({ requestId, actor }) {
  return inTransaction(async (client) => {
    const req = (await client.query(
      `SELECT r.*, u.email FROM org_requests r JOIN users u ON u.id = r.user_id WHERE r.id=$1 FOR UPDATE OF r`,
      [requestId]
    )).rows[0];
    if (!req) throw new SeatError('NOT_FOUND', 'Request not found.');
    if (req.status !== 'PENDING') throw new SeatError('DECIDED', `This request was already ${req.status.toLowerCase()}.`);
    const org = await insertOrg(client, { name: req.org_name, managerEmails: [req.email], actor });
    await client.query(
      "UPDATE org_requests SET status='APPROVED', decided_at=now(), decided_by=$2, org_id=$3 WHERE id=$1",
      [requestId, actor, org.id]
    );
    return { org, managerEmail: req.email };
  });
}

async function rejectRequest({ requestId, actor, reason }) {
  const { rows } = await pool.query(
    `UPDATE org_requests SET status='REJECTED', decided_at=now(), decided_by=$2, reason=$3
      WHERE id=$1 AND status='PENDING' RETURNING *`,
    [requestId, actor, String(reason || '').trim().slice(0, 300) || null]
  );
  if (!rows[0]) throw new SeatError('DECIDED', 'This request was already decided.');
  return rows[0];
}

// Admin view: open requests first, then the most recent decisions.
async function listRequests({ decidedLimit = 10 } = {}) {
  const { rows } = await pool.query(
    `(SELECT r.*, u.email FROM org_requests r JOIN users u ON u.id=r.user_id WHERE r.status='PENDING' ORDER BY r.created_at)
     UNION ALL
     (SELECT r.*, u.email FROM org_requests r JOIN users u ON u.id=r.user_id WHERE r.status<>'PENDING' ORDER BY r.decided_at DESC LIMIT $1)`,
    [decidedLimit]
  );
  return { pending: rows.filter((r) => r.status === 'PENDING'), decided: rows.filter((r) => r.status !== 'PENDING') };
}

// A learner's own requests, newest first.
async function requestsOf(userId) {
  const { rows } = await pool.query('SELECT * FROM org_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [userId]);
  return rows;
}

async function listManagers(orgId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.email, m.added_by, m.added_at, (u.id IS NOT NULL) AS registered
       FROM org_managers m LEFT JOIN users u ON lower(u.email) = m.email
      WHERE m.org_id=$1 AND m.removed_at IS NULL ORDER BY m.added_at, m.email`,
    [orgId]
  );
  return rows;
}

async function isManager(orgId, user, db = pool) {
  if (!user?.email) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM org_managers WHERE org_id=$1 AND email=lower($2) AND removed_at IS NULL',
    [orgId, user.email]
  );
  return Boolean(rows[0]);
}

// Organizations this user manages (by the email of their account).
async function orgsManagedBy(user) {
  if (!user?.email) return [];
  const { rows } = await pool.query(
    `SELECT o.* FROM organizations o JOIN org_managers m ON m.org_id = o.id
      WHERE m.email = lower($1) AND m.removed_at IS NULL ORDER BY o.name`,
    [user.email]
  );
  return rows;
}

// The seats this user holds, from the ledger (assignments not reversed): organization and course.
async function seatsHeldBy(userId) {
  const { rows } = await pool.query(
    `SELECT a.event_id, a.occurred_at, p.course_id, o.id AS org_id, o.name AS org_name
       FROM commerce_ledger a
       JOIN org_seat_pools p ON p.id::text = a.payment_info->>'poolId'
       JOIN organizations o ON o.id = p.org_id
      WHERE a.event_type='SEAT_ASSIGNED' AND a.user_id=$1
        AND NOT EXISTS (SELECT 1 FROM commerce_ledger r WHERE r.reference_event_id = a.event_id)
      ORDER BY o.name, a.ledger_sequence_id`,
    [userId]
  );
  return rows;
}

async function getOrg(orgId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(orgId))) return null;
  const { rows } = await pool.query('SELECT * FROM organizations WHERE id=$1', [orgId]);
  return rows[0] || null;
}

async function listOrgs() {
  const { rows } = await pool.query(
    `SELECT o.*,
            (SELECT string_agg(m.email, ', ' ORDER BY m.email) FROM org_managers m
              WHERE m.org_id=o.id AND m.removed_at IS NULL) AS managers,
            (SELECT count(*)::int FROM org_seat_pools p WHERE p.org_id=o.id AND p.status <> 'PENDING_PAYMENT') AS packs
       FROM organizations o ORDER BY o.created_at DESC`
  );
  return rows;
}

// Seats in use for a pool, from the ledger: assignments not reversed by SEAT_UNASSIGNED.
const ACTIVE_SEATS_SQL = `
  SELECT a.event_id, a.user_id, u.email, a.occurred_at
    FROM commerce_ledger a JOIN users u ON u.id = a.user_id
   WHERE a.event_type='SEAT_ASSIGNED' AND a.payment_info->>'poolId' = $1
     AND NOT EXISTS (SELECT 1 FROM commerce_ledger r WHERE r.reference_event_id = a.event_id)
   ORDER BY a.ledger_sequence_id`;

async function activeSeats(poolId, db = pool) {
  return (await db.query(ACTIVE_SEATS_SQL, [String(poolId)])).rows;
}

async function listPools(orgId) {
  const { rows } = await pool.query(
    `SELECT p.*, o.status AS order_status, o.provider, o.final_payable_cents, o.updated_at AS order_updated_at
       FROM org_seat_pools p JOIN orders o ON o.id = p.order_id
      WHERE p.org_id=$1 ORDER BY p.created_at`,
    [orgId]
  );
  for (const p of rows) p.assigned = await activeSeats(p.id);
  return rows;
}

async function getPool(poolId) {
  const { rows } = await pool.query(
    `SELECT p.*, o.name AS org_name FROM org_seat_pools p
       JOIN organizations o ON o.id=p.org_id WHERE p.id=$1`,
    [poolId]
  );
  return rows[0] || null;
}

// Creates an order with one SEAT_PACK line and a PENDING_PAYMENT pool for an organization the
// buyer manages, in one transaction. The caller then starts the provider payment.
async function createSeatPackOrder({ userId, orgId, course, seats, provider, checkoutKey = null }) {
  seats = Number(seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS_PER_PACK)
    throw new SeatError('BAD_SEATS', `Choose between 1 and ${MAX_SEATS_PER_PACK} seats.`);
  if (!course || (course.type || 'COURSE') !== 'COURSE')
    throw new SeatError('BAD_COURSE', 'Seat packs are sold for individual courses only.');

  const unitCents = Math.round(Number(course.price) * 100);
  const totalCents = unitCents * seats;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One order per checkout click: the same form submitted twice returns the first order.
    const sameClick = await require('./checkoutOnce').claim(client, userId, checkoutKey);
    if (sameClick) {
      await client.query('ROLLBACK');
      return { repeated: sameClick };
    }
    // Only a current manager of the organization may buy seats for it.
    const org = /^[0-9a-f-]{36}$/i.test(String(orgId || '')) && (await client.query(
      `SELECT o.* FROM organizations o
         JOIN org_managers m ON m.org_id = o.id AND m.removed_at IS NULL
         JOIN users u ON lower(u.email) = m.email
        WHERE o.id=$1 AND u.id=$2`,
      [orgId, userId]
    )).rows[0];
    if (!org) throw new SeatError('NOT_MANAGER', 'Only a manager of this organization can buy seats for it.');
    // Coupons never apply to seat packs (see README "Commercial rules").
    const orderId = await createOrder(client, {
      userId, provider, subtotalCents: totalCents, finalCents: totalCents, checkoutKey,
      lines: [{ itemType: 'SEAT_PACK', itemId: course.id, unitPriceCents: unitCents, quantity: seats, paidCents: totalCents }],
    });
    const poolRow = (
      await client.query(
        `INSERT INTO org_seat_pools (org_id, course_id, seats, order_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [org.id, course.id, seats, orderId]
      )
    ).rows[0];
    await client.query('COMMIT');
    return { org, pool: poolRow, orderId, amount: totalCents / 100, currency: course.currency || 'USD' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Called by the webhook processor once the pack's payment is recorded.
async function activatePool(orderId, courseId, purchaseEventId) {
  await pool.query(
    `UPDATE org_seat_pools SET status='ACTIVE', purchase_event_id=$3, updated_at=now()
      WHERE order_id=$1 AND course_id=$2 AND status='PENDING_PAYMENT'`,
    [orderId, courseId, purchaseEventId]
  );
}

async function poolIdForOrder(orderId, courseId) {
  const { rows } = await pool.query('SELECT id FROM org_seat_pools WHERE order_id=$1 AND course_id=$2', [orderId, courseId]);
  return rows[0]?.id || null;
}

// ---- seat assignment --------------------------------------------------------------------

async function withPoolLock(poolId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`seatpool:${poolId}`]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function findUserByEmail(db, email) {
  const clean = String(email || '').trim();
  if (!clean) throw new SeatError('NO_EMAIL', 'Enter the member\'s email address.');
  const { rows } = await db.query('SELECT id, email FROM users WHERE lower(email)=lower($1)', [clean]);
  if (!rows[0]) throw new SeatError('NO_USER', `No LearnX account uses ${clean}. Ask them to sign up first.`);
  return rows[0];
}

// Must run inside withPoolLock.
async function assignLocked(client, { ledger, poolRow, email, actor }) {
  if (poolRow.status !== 'ACTIVE')
    throw new SeatError('POOL_NOT_ACTIVE', poolRow.status === 'PENDING_PAYMENT'
      ? 'This seat pack has not been paid for yet.'
      : 'This seat pack was refunded; its seats can no longer be used.');
  const member = await findUserByEmail(client, email);
  const seats = await activeSeats(poolRow.id, client);
  if (seats.some((s) => s.user_id === member.id))
    throw new SeatError('ALREADY_ASSIGNED', `${member.email} already has a seat in this pack.`);
  if (seats.length >= poolRow.seats)
    throw new SeatError('POOL_FULL', `All ${poolRow.seats} seats are in use. Unassign someone or buy more seats.`);

  const course = ledger.catalog?.get(poolRow.course_id);
  const out = await ledger.appendEvent(
    {
      eventId: `seat_${randomUUID()}`,
      eventType: 'SEAT_ASSIGNED',
      userId: member.id,
      productId: poolRow.course_id,
      quantity: 1,
      amount: 0,
      currency: course?.currency || 'USD',
      occurredAt: new Date().toISOString(),
      referenceeventId: null,
      source: 'ORG_SEAT',
      actor,
      reason: `Seat from ${poolRow.org_name}`,
      entitlement: { kind: 'COURSE' },
    },
    { method: 'ORG_SEAT', orgId: poolRow.org_id, poolId: String(poolRow.id) }
  );
  return { member, eventId: out.record?.event?.eventId };
}

async function unassignLocked({ ledger, assignment, actor, reason }) {
  const { rows } = await pool.query('SELECT * FROM commerce_ledger WHERE event_id=$1', [assignment.event_id]);
  const a = rows[0];
  // Deterministic id: a double click (or a retried refund) records the unassignment once.
  return ledger.appendEvent(
    {
      eventId: `unseat_${a.event_id}`,
      eventType: 'SEAT_UNASSIGNED',
      userId: a.user_id,
      productId: a.product_id,
      quantity: 1,
      amount: 0,
      currency: a.currency,
      occurredAt: new Date().toISOString(),
      referenceeventId: a.event_id,
      source: 'ORG_SEAT',
      actor,
      reason,
    },
    { method: 'ORG_SEAT', orgId: a.payment_info?.orgId, poolId: a.payment_info?.poolId }
  );
}

async function assignSeat({ ledger, poolId, email, actor }) {
  return withPoolLock(poolId, async (client) => {
    const poolRow = await getPool(poolId);
    if (!poolRow) throw new SeatError('NOT_FOUND', 'Seat pack not found.');
    return assignLocked(client, { ledger, poolRow, email, actor });
  });
}

async function seatOf(poolId, assignmentEventId, db = pool) {
  const seat = (await activeSeats(poolId, db)).find((s) => s.event_id === assignmentEventId);
  if (!seat) throw new SeatError('NO_SEAT', 'That seat is no longer assigned.');
  return seat;
}

async function unassignSeat({ ledger, poolId, assignmentEventId, actor }) {
  return withPoolLock(poolId, async (client) => {
    const seat = await seatOf(poolId, assignmentEventId, client);
    await unassignLocked({ ledger, assignment: seat, actor, reason: 'Seat unassigned by organization' });
    return seat;
  });
}

// Moves a seat to another member in one locked step (the seat count never goes over).
async function reassignSeat({ ledger, poolId, assignmentEventId, email, actor }) {
  return withPoolLock(poolId, async (client) => {
    const poolRow = await getPool(poolId);
    if (!poolRow) throw new SeatError('NOT_FOUND', 'Seat pack not found.');
    const seat = await seatOf(poolId, assignmentEventId, client);
    const target = await findUserByEmail(client, email);
    if (target.id === seat.user_id) throw new SeatError('SAME_MEMBER', `${target.email} already holds this seat.`);
    // Check the new member before taking the seat away from the old one.
    const seats = await activeSeats(poolId, client);
    if (seats.some((s) => s.user_id === target.id))
      throw new SeatError('ALREADY_ASSIGNED', `${target.email} already has a seat in this pack.`);
    await unassignLocked({ ledger, assignment: seat, actor, reason: `Seat reassigned to ${target.email}` });
    return assignLocked(client, { ledger, poolRow, email: target.email, actor });
  });
}

// A seat pack was refunded or charged back: every seat goes, and the pack is closed.
async function revokePoolsForOrder({ ledger, orderId, reason }) {
  const { rows: pools } = await pool.query(
    "SELECT id FROM org_seat_pools WHERE order_id=$1 AND status <> 'REVOKED'",
    [orderId]
  );
  for (const p of pools) {
    await withPoolLock(p.id, async (client) => {
      for (const seat of await activeSeats(p.id, client)) {
        await unassignLocked({ ledger, assignment: seat, actor: 'system:seat-pack-reversed', reason });
      }
      await client.query("UPDATE org_seat_pools SET status='REVOKED', updated_at=now() WHERE id=$1", [p.id]);
    });
  }
  return pools.length;
}

module.exports = {
  SeatError, MAX_SEATS_PER_PACK,
  getOrg, listOrgs, listPools, getPool, activeSeats,
  createOrg, requestOrg, approveRequest, rejectRequest, listRequests, requestsOf,
  listManagers, isManager, orgsManagedBy, seatsHeldBy, parseEmails,
  createSeatPackOrder, activatePool, poolIdForOrder,
  assignSeat, unassignSeat, reassignSeat, revokePoolsForOrder,
};

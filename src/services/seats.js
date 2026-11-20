'use strict';
// M4 enterprise seats.
//
// An organization (one per owner) buys seat packs: N seats of one course, paid through the
// normal provider checkout. The pack is recorded in the ledger as SEAT_POOL_PURCHASED (money,
// refundable, no access for the buyer). Each person the owner assigns gets a SEAT_ASSIGNED
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

// ---- organizations & packs --------------------------------------------------------------

async function getOrgByOwner(userId) {
  const { rows } = await pool.query('SELECT * FROM organizations WHERE owner_user_id=$1', [userId]);
  return rows[0] || null;
}

async function getOrg(orgId) {
  const { rows } = await pool.query('SELECT * FROM organizations WHERE id=$1', [orgId]);
  return rows[0] || null;
}

async function listOrgs() {
  const { rows } = await pool.query(
    `SELECT o.*, u.email AS owner_email,
            (SELECT count(*)::int FROM org_seat_pools p WHERE p.org_id=o.id) AS packs
       FROM organizations o JOIN users u ON u.id=o.owner_user_id ORDER BY o.created_at DESC`
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
    `SELECT p.*, o.name AS org_name, o.owner_user_id FROM org_seat_pools p
       JOIN organizations o ON o.id=p.org_id WHERE p.id=$1`,
    [poolId]
  );
  return rows[0] || null;
}

// Creates the org (if the buyer has none yet), an order with one SEAT_PACK line and a
// PENDING_PAYMENT pool, all in one transaction. The caller then starts the provider payment.
async function createSeatPackOrder({ userId, orgName, course, seats, provider, checkoutKey = null }) {
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
    let org = (await client.query('SELECT * FROM organizations WHERE owner_user_id=$1', [userId])).rows[0];
    if (!org) {
      const name = String(orgName || '').trim();
      if (!name) throw new SeatError('BAD_ORG', 'Give your organization a name.');
      org = (
        await client.query('INSERT INTO organizations (name, owner_user_id) VALUES ($1,$2) RETURNING *', [name, userId])
      ).rows[0];
    }
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
  getOrgByOwner, getOrg, listOrgs, listPools, getPool, activeSeats,
  createSeatPackOrder, activatePool, poolIdForOrder,
  assignSeat, unassignSeat, reassignSeat, revokePoolsForOrder,
};

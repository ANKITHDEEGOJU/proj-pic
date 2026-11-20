# Event Sourcing 101: Course Guide

This guide is the companion document for **Event Sourcing 101**. It covers the three building blocks of an event-sourced system: the **ledger** of events, the **projections** built from it, and **replay**, which lets you rebuild any view at any time. The running example is a small learning platform that sells courses, much like this one.

## 1. State versus history

A traditional application stores the current state and overwrites it:

```text
users_courses: user=alice  course=sql  status=owned
```

When Alice gets a refund, the row is updated or deleted, and the fact that she ever bought the course is gone. Event sourcing stores what **happened** instead:

```text
1. PURCHASE_SUCCEEDED  alice  sql   20.00 USD
2. REFUND              alice  sql   refers to event 1
```

The current state ("Alice does not own SQL") is derived from that history. The history itself is never changed.

## 2. The ledger

The ledger is an append-only list of events. Three rules keep it trustworthy:

1. **Append only.** Events are never updated or deleted. A mistake is fixed by appending a correcting event, such as a refund or a revoke.
2. **Each event has a unique id.** Writing the same event twice is detected and ignored, which makes retries safe.
3. **Each event is self-describing.** It records what happened, to whom, when, the amount, and why (source, actor, reason).

```json
{
  "eventId": "pay_8f2c:intro-to-sql",
  "eventType": "PURCHASE_SUCCEEDED",
  "userId": "alice",
  "productId": "intro-to-sql",
  "amount": 20.00,
  "currency": "USD",
  "occurredAt": "2026-11-20T10:02:11Z",
  "source": "PAYMENT"
}
```

A database can enforce rule 1 directly, for example with a trigger that rejects `UPDATE` and `DELETE` on the ledger table.

### Reversals point at what they undo

A refund, chargeback or revoke always names the event it reverses. That makes it impossible to refund something that was never bought, and easy to enforce **at most one reversal per event**.

## 3. Projections

A projection reads events in order and keeps a view that is cheap to query. For access control the view is "who can open what, until when":

```text
apply(PURCHASE_SUCCEEDED) -> grant course access
apply(SUBSCRIPTION_STARTED) -> add a pass period
apply(REFUND)             -> remove the access that event granted
```

Key properties:

- **Deterministic.** The same events in the same order always produce the same view.
- **Disposable.** If a projection has a bug, fix the code and rebuild it. The ledger is the source of truth; the projection is only a cache.
- **Many views, one history.** Access, revenue reports and audit screens can all be separate projections of the same ledger.

### Time-based rules belong in the decision

Expiry is not an event that someone has to remember to write. A pass period records when it ends; the access decision compares that end time with the clock at the moment of the request. Access ends exactly on time, even if no process runs at that moment.

## 4. Replay

Replay means rebuilding a projection by reading the ledger from the first event. You replay:

- when the application starts, to rebuild in-memory views;
- after fixing a projection bug;
- to answer "what did access look like on 1 November?" by replaying only events up to that date.

Because replay is routine, it must be safe: applying events must never call payment providers or send emails. Side effects happen once, when an event is first recorded, never during replay.

## 5. Events from unreliable sources

Payment providers deliver webhooks late, twice, or out of order. An event-sourced system handles this with a few habits:

- **Idempotency:** derive the event id from the provider's payment or refund id, so a duplicate webhook becomes the same event and is ignored.
- **An inbox:** store each incoming webhook first, then process it; failed ones are retried with backoff.
- **Ordering checks:** a refund that arrives before its purchase is retried later, once the purchase exists.
- **Reconciliation:** periodically compare the provider's records with the ledger and append whatever events are missing.

## 6. Practice

1. Write the event sequence for: buy a course, receive a chargeback, then an admin grants the course for free.
2. Explain why deleting the purchase row on refund would break a monthly revenue report.
3. A projection shows a user with access after a refund. List the three things you would check, in order.

With these ideas you can read the ledger, projection and reconciliation code of a real system and follow every change of access back to the event that caused it.

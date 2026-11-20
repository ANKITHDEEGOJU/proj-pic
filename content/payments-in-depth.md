# Payments in Depth: Course Guide

This guide is the companion document for **Payments in Depth**. It explains how online payments really reach an application: through **webhooks** that can be late or repeated, handled with **idempotency** so nothing happens twice, and checked by **reconciliation** so nothing is silently lost. Everything here applies to card gateways, bank transfers and wallets alike.

## 1. The payment lifecycle

A checkout is a conversation between three parties: your application, the payment provider, and the customer's bank.

1. Your application creates an **order** with a fixed amount and currency.
2. The customer pays on the provider's checkout page.
3. The provider tells your application the result, usually by **webhook**.
4. Your application records the payment and grants what was bought.

The browser redirect after payment is only a convenience for the customer. Never grant access because the browser came back to a "success" page: it can be faked, closed early, or never happen at all. The provider's signed message is what counts.

## 2. Webhooks

A webhook is an HTTP request the provider sends to your server when something happens: payment captured, payment failed, refund processed, chargeback opened.

### Verify before you trust

Each webhook carries a signature, an HMAC of the raw request body made with a secret only you and the provider know. Compute it yourself over the **raw bytes** before parsing JSON, compare it in constant time, and reject anything that does not match.

### Expect every kind of delivery problem

- **Duplicates:** the provider retries until you answer 2xx, so you will see the same event more than once.
- **Delays:** a webhook can arrive minutes or hours after the payment.
- **Reordering:** a refund webhook can arrive before the payment webhook it refers to.
- **Loss:** after enough failed retries, the provider gives up.

A sound pattern is an **inbox**: store the raw webhook immediately, answer 200, then process it in the background with retries and exponential backoff. If an event cannot be applied yet (a refund for an unknown payment), leave it in the inbox to retry later instead of dropping it.

## 3. Idempotency

An operation is idempotent when doing it twice has the same effect as doing it once. In payments it is the difference between charging a customer once and charging them twice.

Ways to get it:

- **Natural keys:** record a payment under the provider's payment id, with a unique constraint. The second insert of the same payment does nothing.
- **Idempotency keys:** when your app calls the provider (create order, refund), send a key that is stable for that one intention, so a retried request is recognised.
- **State machines with guarded transitions:** move an order from `PENDING` to `PAID` only if it is still `PENDING`, in a single conditional update:

```sql
UPDATE orders SET status = 'REFUND_PENDING'
WHERE id = $1 AND status = 'COMPLETED'
RETURNING id;
```

If no row comes back, someone else already made the change: stop.

- **One key per click:** a form carries a one-time key, so a double-clicked "Pay" button returns the same checkout instead of creating a second order.

## 4. Refunds and chargebacks

A **refund** is initiated by you; a **chargeback** is forced by the customer's bank. Both reverse a payment, and both should:

- reference the original payment;
- happen at most once per payment;
- remove exactly the access that payment granted, and nothing else.

Treat the provider's confirmation as the moment a refund is done. Until then the order is "refund pending", and access stays, because the refund may still fail.

## 5. Reconciliation

Even with webhooks, inboxes and retries, your records and the provider's can drift. Reconciliation is a scheduled job that compares them and acts on every difference:

- **Missing purchase:** the provider has a captured payment you never recorded. Replay it.
- **Missing refund:** the provider refunded, but you still grant access. Record the refund.
- **Amount mismatch:** the amounts differ. Escalate to a person; never guess.
- **Unknown payment:** money arrived with no matching order. Escalate.

Good reconciliation is itself idempotent: running it twice fixes nothing new and creates no duplicate issues. Issues that disappear on their own (for example, a late webhook arrived) should be resolved automatically.

## 6. Practice

1. Draw the timeline for a payment whose webhook is dropped, and show where reconciliation repairs it.
2. A customer double-clicks "Refund". List every safeguard that stops a double refund.
3. Write the conditional update that marks an order as paid only once, and explain what your code does when it updates zero rows.

After this course you should be able to read any provider's webhook documentation and know exactly which failure cases your integration must handle.

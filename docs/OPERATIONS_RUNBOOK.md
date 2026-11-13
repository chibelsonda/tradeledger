# TradeLedger Operations Runbook

This runbook covers Edge Function failures, Stripe webhook recovery, and payment
reconciliation. It is intentionally safe for production use: never paste API
keys, authorization headers, webhook signatures, full request bodies, or
customer data into tickets or chat.

## Incident priorities

| Priority | Examples | Initial response |
| --- | --- | --- |
| P1 | Incorrect ledger balance, cross-tenant exposure, duplicate charge or refund | Stop the affected workflow, preserve evidence, notify the incident owner immediately |
| P2 | Repeated webhook or checkout `5xx`, payments settled in Stripe but pending in TradeLedger | Acknowledge within 30 minutes and begin reconciliation |
| P3 | One rejected request, expected validation failure, isolated document or notification failure | Record and investigate during business hours |

Do not delete payment, refund, webhook-failure, notification-delivery, or audit
rows during an incident. They are recovery and audit evidence.

## Standard Edge Function evidence

Every Edge Function response includes an `x-request-id` header. JSON failures
also use this stable shape:

```json
{
  "error": "A safe message for the operator or user.",
  "code": "UPSTREAM_ERROR",
  "requestId": "6711bbdd-ea20-4615-af1e-a12aa62f86f7"
}
```

Each invocation writes one JSON completion event with the same request ID,
function name, status, path, and duration. Query strings, credentials, request
bodies, and provider payloads are deliberately excluded.

When investigating:

1. Capture the UTC time, function name, HTTP status, error `code`, and
   `requestId`. Do not capture secrets or the full request body.
2. In Supabase Dashboard, open **Edge Functions**, select the function, and
   review **Invocations** for status and duration.
3. Open **Logs** and find the JSON event whose `requestId` matches the response.
4. Determine whether it was rejected (`4xx`), failed internally (`5xx`), or
   failed before the function ran. A Supabase gateway failure can also expose an
   `sb-error-code` response header.
5. Correlate only with durable identifiers already visible to the operator:
   payment request ID, payment reference, Stripe Checkout Session ID, Payment
   Intent ID, or Stripe event ID.
6. Record the diagnosis, recovery action, and verification evidence in the
   incident timeline.

### Status interpretation

| Result | Meaning | First check |
| --- | --- | --- |
| `401` / `403` | Missing session or role/tenant authorization denied | User session, organization membership, expected role |
| `409` | Lifecycle conflict or an operation is already in progress | Current payment/refund state; do not force a backward transition |
| `422` | Request shape or identifier failed validation | Client payload and current UI version |
| `500` | Database or function invariant failed | Request-correlated Supabase log and relevant audit/failure record |
| `502` / `503` | Stripe, Storage, or another upstream dependency failed | Provider status, provider object state, then retry safety |

## Stripe webhook failure

Use this procedure when Stripe shows failed deliveries, TradeLedger reports an
unresolved webhook failure, or a paid Checkout Session remains pending.

1. In Stripe Workbench, open the production webhook destination and the failed
   event delivery. Record the event ID, event type, UTC time, response status,
   and response `requestId` when present.
2. Confirm the destination URL and mode (test or live) are correct. A signature
   failure normally means the endpoint secret does not match this destination;
   rotate or replace it through Supabase secrets, never through source control.
3. Use the request ID to inspect the `stripe-webhook` invocation and log event in
   Supabase. Review the matching unresolved webhook-failure entry in the
   Operations dashboard.
4. Fix the underlying configuration, deployment, or database failure before
   redelivery. Repeated delivery is safe because Stripe event IDs are processed
   idempotently.
5. Redeliver the event from Stripe after the fix. Do not fabricate a webhook
   body or disable signature verification.
6. Verify all four outcomes:
   - Stripe reports a successful delivery.
   - The payment and payment-request lifecycle states agree with Stripe.
   - The webhook failure is resolved or its retry count has stopped increasing.
   - A duplicate delivery returns success without duplicating payment, refund,
     audit, waiver, or notification records.

Stripe automatically retries failed deliveries with backoff, so an unresolved
endpoint can generate repeated calls. The Stripe Dashboard delivery record is
the source of truth for the provider-side response history.

## Payment reconciliation

Use reconciliation when Stripe and TradeLedger disagree, or when webhook
delivery was delayed beyond the normal recovery window.

1. Find the payment request in the tenant-scoped Operations dashboard.
2. Compare currency and integer minor-unit amount with the Stripe Checkout
   Session and Payment Intent. A mismatch is P1: stop and escalate; do not edit
   the ledger manually.
3. Confirm the Stripe Session belongs to the expected payment reference and
   organization metadata.
4. Run **Reconcile** once from TradeLedger. The server retrieves current Stripe
   state and applies database-controlled, idempotent transitions and refunds.
5. Refresh and verify payment status, request status, refund totals, webhook
   failure state, and audit history.
6. If reconciliation fails, capture its request ID and follow the Edge Function
   evidence procedure. Retrying is safe after the underlying failure is fixed.

Never mark a payment paid, insert a refund, or change financial amounts directly
in PostgreSQL as an incident shortcut.

## Checkout or refund upstream failure

1. Capture the request ID from the failed response and locate the matching
   `create-checkout` or `create-refund` log.
2. Check Stripe service health and find the operation using the durable payment
   or refund reference—not customer data.
3. For checkout, retry through the application. The existing open Checkout
   Session is resumed and session creation uses an idempotency key.
4. For refund, inspect Stripe before retrying. TradeLedger reuses the durable
   refund reference so a retry cannot intentionally create a second refund.
5. Reconcile and verify the ledger after Stripe confirms the final state.

## Recovery completion

An incident is complete only when:

- Provider state, payment ledger, and payment-request state agree.
- No unresolved webhook failure remains for the affected event.
- Duplicate delivery or operator retry does not create duplicate side effects.
- The incident record contains UTC timestamps, safe identifiers, request IDs,
  root cause, recovery action, and verification evidence.
- Any durable fix has an automated regression test.

## Provider references

- [Supabase Edge Function logging](https://supabase.com/docs/guides/functions/logging)
- [Supabase Edge Function error handling](https://supabase.com/docs/guides/functions/error-handling)
- [Supabase Edge Function error codes](https://supabase.com/docs/guides/functions/error-codes)
- [Stripe webhook delivery troubleshooting](https://support.stripe.com/questions/troubleshooting-webhook-delivery-issues)
- [Stripe event retrieval](https://docs.stripe.com/api/events/retrieve)

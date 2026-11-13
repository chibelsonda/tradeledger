# TradeLedger

[![CI](https://github.com/chibelsonda/tradeledger/actions/workflows/ci.yml/badge.svg)](https://github.com/chibelsonda/tradeledger/actions/workflows/ci.yml)

TradeLedger is a multi-tenant subcontractor payment workflow built to
demonstrate production-minded SaaS engineering. It combines tenant-safe project
operations, approval controls, database-owned financial calculations, Stripe
Checkout, refunds, reconciliation, signed webhooks, and an immutable audit
trail. Paid requests can also produce a private, auditable PDF waiver record,
while approval and payment emails use a tenant-visible transactional outbox.

The application is intentionally focused on a credible vertical slice rather
than broad feature count: create an organization, manage projects and
subcontractors, request and approve payment, launch a server-priced checkout,
reconcile the result from an idempotent Stripe webhook, and issue an authorized
full refund without trusting browser-supplied financial data.

## Why this project stands out

- **Tenant isolation at the data boundary.** PostgreSQL Row-Level Security
  prevents one organization from discovering or mutating another tenant's
  records.
- **Server-owned money.** Gross amount, retainage, and net payable use integer
  minor units. Checkout receives only a payment-request ID; PostgreSQL selects
  the approved amount and currency.
- **Explicit payment lifecycle.** Controlled transitions cover draft,
  submission, approval, checkout, processing, payment, and failure states.
- **Reliable Stripe integration.** Checkout sessions are idempotent, webhook
  signatures are verified, duplicate Stripe events are processed once, and
  operators can reconcile missed or delayed outcomes directly with Stripe.
- **Controlled refund operations.** Owner/accountant authorization, durable
  refund records, idempotency keys, terminal-state protection, and Stripe
  refund events keep the ledger consistent.
- **Actionable failure visibility.** Failed webhook processing is persisted
  outside the failed transaction with retry counts and tenant-scoped operator
  visibility.
- **Retry-safe transactional email.** Approval and payment transitions enqueue
  one database-owned delivery. Atomic claims, bounded backoff, Resend
  idempotency keys, escaped templates, and an operator retry log prevent silent
  or duplicate notifications.
- **Private payment documents.** Paid, non-refunded requests can generate a
  server-rendered PDF in a private Supabase Storage bucket. Downloads use
  short-lived signed URLs, and later refunds automatically void the record.
- **Auditable operations.** Sensitive workflow changes append immutable tenant
  audit events.
- **Production-oriented UX.** Every authenticated state includes deliberate
  loading, error, empty, authorization, and financial-status feedback.

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React 19, strict TypeScript, Tailwind CSS v4, Vite |
| Backend | Supabase Edge Functions and PostgREST |
| Database | PostgreSQL, Row-Level Security, constraints, generated columns, RPCs |
| Authentication | Supabase Auth |
| Payments | Stripe Checkout and signed webhooks |
| Transactional email | Resend Email API with deterministic idempotency keys |
| Verification | Vitest, ESLint, TypeScript, executable PostgreSQL security scenarios |

## Architecture

```text
React + TypeScript
        |
        | publishable key + authenticated user JWT
        v
Supabase Auth / PostgREST / PostgreSQL RLS
        |
        | approved payment-request ID only
        v
create-checkout / create-refund ----> Stripe Checkout + Refunds
        ^                                  |
        |                                  | signed events
        +------ stripe-webhook <-----------+
                    |
                    v
     Payment ledger + failure inbox + audit events
                    |
                    +----> Private waiver PDFs
                    |
                    +----> Email outbox ----> Resend
```

Secrets stay in Supabase Edge Function configuration. The browser receives only
the Supabase project URL and publishable key.

## Demonstrated workflow

1. An authenticated user creates an organization and becomes its owner.
2. An owner or admin creates projects and subcontractors.
3. A financial role creates a payment request with exact retainage.
4. An owner or accountant approves it.
5. An authorized role starts Stripe Checkout from the database-owned net amount.
6. A signed, idempotent webhook advances the ledger and request state.
7. An owner or accountant can refund the remaining settled amount.
8. Operators can reconcile Stripe state and inspect unresolved webhook failures.
9. Tenant-scoped audit events provide operational evidence.
10. A financial approver generates and downloads a private payment waiver PDF.
11. Operators inspect approval/payment email delivery and safely retry failures.

## Security and correctness evidence

The executable PostgreSQL scenario in
[`supabase/tests/multi_tenant_foundation.sql`](supabase/tests/multi_tenant_foundation.sql)
verifies:

- Tenant B receives zero Tenant A organization, project, subcontractor,
  payment-request, audit, and payment rows.
- Cross-tenant project and payment-request creation is denied.
- Retainage and net payable are calculated exactly by PostgreSQL.
- Checkout uses the persisted approved net amount.
- Invalid backward payment transitions fail.
- Replayed Stripe event IDs do not process twice.
- Refund preparation enforces role authorization and database-owned amounts.
- Repeated refund application and reconciliation do not duplicate ledger rows.
- Webhook failures persist retry counts and resolve explicitly.
- Refund and failure records remain invisible across tenant boundaries.
- Waiver reservation is role-protected and idempotent.
- Refunding a payment automatically voids its active waiver.
- Waiver metadata remains invisible across tenant boundaries.
- Approval and payment transitions enqueue exactly one delivery each.
- Notification claims reject outsiders, retry with bounded delay, and remain
  invisible across tenant boundaries.
- User-controlled email template content is HTML-escaped.
- Browser roles cannot alter immutable audit events.

## Local development

Requirements: Node.js 22+, a Supabase project, the Supabase CLI, and a Stripe
test-mode account.

```bash
npm install
cp .env.example .env
npm run dev
```

Add the Supabase URL and publishable key to `.env`, then link and migrate the
database:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Configure server-only secrets and deploy the Edge Functions:

```bash
npx supabase secrets set \
  STRIPE_SECRET=sk_test_replace_me \
  STRIPE_WEBHOOK_SECRET=whsec_replace_me \
  RESEND_API_KEY=re_replace_me \
  RESEND_FROM_EMAIL='TradeLedger <payments@your-verified-domain.example>' \
  SITE_URL=http://localhost:5173

npx supabase functions deploy create-checkout
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy create-refund
npx supabase functions deploy reconcile-payment
npx supabase functions deploy generate-waiver
npx supabase functions deploy download-waiver
npx supabase functions deploy dispatch-notification
```

Register this Stripe test webhook URL:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook
```

Subscribe it to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`refund.created`, `refund.updated`, and `refund.failed`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The current suite includes frontend utility and email-template security coverage
plus an isolated PostgreSQL 17 tenant/payment/refund/document/notification
scenario that rolls back after every run.

The database suite requires a fresh PostgreSQL database whose name ends in
`_test`. The guard prevents accidental execution against a development or
production database:

```bash
createdb tradeledger_test
DATABASE_URL=postgresql://localhost/tradeledger_test npm run test:database
```

GitHub Actions runs the same frontend checks and database scenario on every
pull request and every push to `main`, using an ephemeral PostgreSQL 17 service
without application secrets.

## Current roadmap

- Provider delivery/bounce webhooks and automated scheduled outbox draining.
- Browser coverage, operational runbooks, and a safe hosted demo.

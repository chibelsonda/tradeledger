# TradeLedger

TradeLedger is a multi-tenant subcontractor payment workflow built to
demonstrate production-minded SaaS engineering. It combines tenant-safe project
operations, approval controls, database-owned financial calculations, Stripe
Checkout, signed webhooks, and an immutable audit trail.

The application is intentionally focused on a credible vertical slice rather
than broad feature count: create an organization, manage projects and
subcontractors, request and approve payment, launch a server-priced checkout,
and reconcile the result from an idempotent Stripe webhook.

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
  signatures are verified, and duplicate Stripe events are processed once.
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
create-checkout Edge Function -----> Stripe Checkout
        ^                                  |
        |                                  | signed events
        +------ stripe-webhook <-----------+
                    |
                    v
       Payment ledger + audit events
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
7. Tenant-scoped audit events provide operational evidence.

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
  SITE_URL=http://localhost:5173

npx supabase functions deploy create-checkout
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

Register this Stripe test webhook URL:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook
```

Subscribe it to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, and `checkout.session.expired`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The current suite includes frontend utility coverage and an isolated PostgreSQL
17 tenant/payment scenario.

## Current roadmap

- Refund and reconciliation workflows.
- Operator-visible webhook failure handling.
- Private waiver documents for settled requests.
- Delivery logs and retry-safe notifications.
- CI, browser coverage, operational runbooks, and a safe hosted demo.

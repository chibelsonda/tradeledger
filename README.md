# TradeLedger

[![CI](https://github.com/chibelsonda/tradeledger/actions/workflows/ci.yml/badge.svg)](https://github.com/chibelsonda/tradeledger/actions/workflows/ci.yml)

TradeLedger is a production-deployed reference implementation of a secure,
multi-tenant subcontractor payment operations platform. It coordinates project
directories, retainage-aware payment requests, role-based approvals, Stripe
Checkout, webhook reconciliation, refunds, private waiver documents, and an
immutable operational audit trail.

The project demonstrates an end-to-end SaaS architecture in which authorization
and financial correctness are enforced below the presentation layer. PostgreSQL
owns tenant boundaries, role checks, state transitions, and monetary
calculations; Supabase Edge Functions protect provider credentials and external
integrations; and the React application delivers a responsive operational
workspace without treating browser-supplied data as authoritative.

**Live demo:** [tradeledger-sepia.vercel.app](https://tradeledger-sepia.vercel.app)

## Product capabilities

| Area | Implemented capabilities |
| --- | --- |
| Identity and tenancy | Supabase Auth with email verification, organization onboarding, isolated workspaces, role-aware membership, account suspension and restoration |
| Operations directory | Project and subcontractor records, organization switching, opt-in demonstration data and guarded owner-controlled cleanup |
| Payment requests | Draft, submission, approval, retainage calculation, net-payable preview, controlled lifecycle transitions |
| Stripe payments | Server-priced Checkout Sessions, success and cancellation handling, signed webhooks, reconciliation and retry-safe processing |
| Refunds | Authorized full-remaining refunds, durable refund records, idempotency protection and terminal-state enforcement |
| Documents | Server-generated PDF payment waivers, private Supabase Storage, short-lived signed downloads and automatic refund voiding |
| Operational controls | Webhook failure queue, request correlation, structured errors, audit events and payment-state recovery |
| Dashboard experience | Financial summaries, workflow charts, role-aware navigation, responsive tables, loading, empty and failure states |
| Quality assurance | Unit tests, browser workflows, executable PostgreSQL security scenarios, static analysis and continuous integration |

## Production engineering highlights

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
- **Correlated production diagnostics.** Every Edge Function response carries a
  request ID, failures use a stable error envelope, and redaction-safe JSON logs
  connect user-visible errors to Supabase invocations without recording secrets.
- **Governed tenant access.** Owners and admins manage registered users through
  role-aware RPCs. Owner access is protected, privileged roles require an owner,
  and suspension takes effect at the RLS boundary.
- **Traceable demonstration data.** Sample records are opt-in, registered by
  immutable identifiers, and removable only by the organization owner. Cleanup
  is blocked after checkout or when real records depend on the sample dataset.
- **Private payment documents.** Paid, non-refunded requests can generate a
  server-rendered PDF in a private Supabase Storage bucket. Downloads use
  short-lived signed URLs, and later refunds automatically void the record.
- **Auditable operations.** Sensitive workflow changes append immutable tenant
  audit events.
- **Production-oriented UX.** Every authenticated state includes deliberate
  loading, error, empty, authorization, and financial-status feedback.
- **Concurrency and abuse controls.** Advisory locking, durable operation
  records, bounded retries, idempotency keys, and database-backed rate limits
  protect payment and document workflows from duplicate execution.
- **Deployment hardening.** The Vercel deployment includes SPA routing,
  restrictive security headers, same-origin font assets, and production smoke
  checks for the frontend and webhook boundary.

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React 19, strict TypeScript, Tailwind CSS v4, Headless UI, Recharts, Zod, Vite |
| Backend | Supabase Edge Functions and PostgREST |
| Database | PostgreSQL, Row-Level Security, constraints, generated columns, transactional RPCs |
| Authentication | Supabase Auth with email verification and password recovery |
| Payments | Stripe Checkout and signed webhooks |
| Documents | Server-rendered PDF waivers and private Supabase Storage |
| Hosting | Vercel frontend and Supabase managed services |
| Transactional notifications | Tenant-safe outbox and delivery tracking; external email delivery intentionally deferred |
| Verification | Vitest, Playwright, ESLint, TypeScript, Deno checks, executable PostgreSQL security scenarios |

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
```

Secrets stay in Supabase Edge Function configuration. The browser receives only
the Supabase project URL and publishable key.

## End-to-end workflow

1. A user authenticates with Supabase and creates an isolated organization.
2. The owner can explicitly opt in to a demonstration workspace containing
   projects, subcontractors, and payment requests in several lifecycle states.
   Before external side effects begin, the owner can remove only those
   registered sample records while preserving the workspace and audit trail.
3. An owner or admin manages the project and subcontractor directory.
4. A financial role creates a payment request with a gross amount and retainage.
5. PostgreSQL calculates the retainage and persisted net payable in integer
   minor units.
6. The request moves through draft, submitted, and approved states using
   authorized transactional RPCs.
7. An authorized user launches Stripe Checkout using only the approved request
   identifier; the browser cannot override the trusted price or currency.
8. A signed, idempotent webhook records the payment and advances the ledger.
9. Operators can reconcile delayed Stripe state and inspect unresolved webhook
   failures without manufacturing payment outcomes in the browser.
10. A paid request can generate a private PDF waiver with a short-lived signed
    download URL.
11. An owner or accountant can refund the remaining settled amount, which
    updates the ledger and voids the active waiver where applicable.
12. Immutable audit events preserve evidence of sensitive tenant, payment,
    document, and membership operations.

## Authorization model

- **Owner:** organization governance, directory management, financial
  approvals, refunds, documents, and team access.
- **Admin:** directory and membership administration plus operational payment
  management, without owner-only governance privileges.
- **Accountant:** payment-request operations, approvals, reconciliation,
  refunds, and financial documents.
- **Member and subcontractor:** tenant-scoped access constrained by PostgreSQL
  policies and the permissions assigned to their role.

The interface hides unavailable actions for clarity, but PostgreSQL RLS and
role-aware RPCs remain the authoritative enforcement boundary.

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
- Membership management protects the owner, restricts privileged role changes,
  and rejects unregistered users.
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
npx supabase functions deploy create-refund
npx supabase functions deploy reconcile-payment
npx supabase functions deploy generate-waiver
npx supabase functions deploy download-waiver
npx supabase functions deploy dispatch-notification
```

Resend is intentionally deferred. The isolated outbox and dispatch function are
kept as future-facing infrastructure, but active payment workflows do not call
the provider.

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
npm run check:edge
npm run test:e2e
```

The current suite includes frontend utility and email-template security coverage
plus an isolated PostgreSQL 17 tenant/payment/refund/document/membership
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

Playwright also exercises authentication, seeded tenant onboarding, membership
governance, payment approval, the Stripe handoff, and checkout result screens in
Chromium. Exact Supabase and Stripe HTTP contracts are intercepted in the
browser suite, so tests cannot create production users, records, emails, or
charges. The same scenarios can run against an optimized production preview to
catch bundling failures that do not appear during development.

The deployed frontend and public webhook boundary can be checked without
creating data or payments:

```bash
APP_URL=https://tradeledger-sepia.vercel.app npm run test:production
```

## Operations

[`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md) defines incident
priorities, request-ID diagnosis, Stripe webhook recovery, payment
reconciliation, and safe completion evidence. Production errors should be
investigated with durable IDs and correlated logs; never paste secrets, provider
payloads, or customer data into incident records.

## Current scope

- The public deployment uses Stripe test mode and is intended for portfolio,
  evaluation, and engineering demonstration purposes.
- Supabase Auth verification emails are operational through Supabase's built-in
  provider. A custom SMTP sender is still required for commercial delivery
  control, branding, and service-level ownership.
- Application-generated payment notification delivery remains deliberately
  disabled until a verified sender domain is available. The isolated outbox,
  claim, retry, and delivery-tracking foundation remains implemented and tested.
- Production activation would require live Stripe credentials, a production
  webhook endpoint, verified email delivery, operational ownership, and the
  final business-specific compliance review.

import type Stripe from 'stripe'

interface RpcError {
  code?: string
  message?: string
}

interface RpcResult {
  data: unknown
  error: RpcError | null
}

interface RpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<RpcResult>
}

interface CreateRecipientAccountInput {
  companyName: string
  contactEmail: string | null
  idempotencyKey: string
  organizationId: string
  subcontractorId: string
}

interface StripeApiErrorPayload {
  error?: {
    code?: string
    message?: string
  }
}

export class StripeConnectApiError extends Error {
  readonly code: string | null
  readonly status: number

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'StripeConnectApiError'
    this.status = status
    this.code = code
  }
}

export function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export async function createStripeRecipientAccount(
  input: CreateRecipientAccountInput,
): Promise<string> {
  const country = (Deno.env.get('STRIPE_CONNECT_COUNTRY') ?? 'US').toUpperCase()
  const currency = (Deno.env.get('STRIPE_CONNECT_CURRENCY') ?? 'usd').toLowerCase()
  const locale = Deno.env.get('STRIPE_CONNECT_LOCALE') ?? 'en-US'
  const apiVersion = Deno.env.get('STRIPE_API_VERSION') ?? '2026-10-28.endive'
  const response = await fetch('https://api.stripe.com/v2/core/accounts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnvironment('STRIPE_SECRET')}`,
      'content-type': 'application/json',
      'idempotency-key': input.idempotencyKey,
      'stripe-version': apiVersion,
    },
    body: JSON.stringify({
      contact_email: input.contactEmail ?? undefined,
      display_name: input.companyName,
      dashboard: 'full',
      identity: {
        country,
        entity_type: 'company',
        business_details: {
          registered_name: input.companyName,
        },
      },
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: {
                requested: true,
              },
            },
          },
        },
      },
      defaults: {
        currency,
        locales: [locale],
      },
      metadata: {
        organization_id: input.organizationId,
        subcontractor_id: input.subcontractorId,
      },
      include: ['configuration.recipient', 'defaults', 'requirements'],
    }),
  })

  const payload = (await response.json().catch(() => null)) as
    | ({ id?: unknown } & StripeApiErrorPayload)
    | null

  if (!response.ok) {
    throw new StripeConnectApiError(
      payload?.error?.message ?? 'Stripe could not create the connected account.',
      response.status,
      payload?.error?.code ?? null,
    )
  }

  if (
    typeof payload?.id !== 'string' ||
    !/^acct_[A-Za-z0-9]{8,200}$/.test(payload.id)
  ) {
    throw new StripeConnectApiError(
      'Stripe returned an invalid connected account.',
      502,
    )
  }

  return payload.id
}

export function stripeAccountReadiness(account: Stripe.Account) {
  return {
    p_stripe_account_id: account.id,
    p_livemode: requiredEnvironment('STRIPE_SECRET').startsWith('sk_live_'),
    p_details_submitted: account.details_submitted,
    p_charges_enabled: account.charges_enabled,
    p_payouts_enabled: account.payouts_enabled,
    p_requirements_currently_due: account.requirements?.currently_due ?? [],
    p_requirements_eventually_due: account.requirements?.eventually_due ?? [],
    p_requirements_past_due: account.requirements?.past_due ?? [],
    p_disabled_reason: account.requirements?.disabled_reason ?? null,
  }
}

export async function syncStripeAccountReadiness(
  client: unknown,
  account: Stripe.Account,
  event?: { id: string; type: string },
): Promise<RpcResult> {
  return await (client as RpcClient).rpc('sync_subcontractor_stripe_account', {
    ...stripeAccountReadiness(account),
    p_event_id: event?.id ?? null,
    p_event_type: event?.type ?? 'account.refresh',
  })
}

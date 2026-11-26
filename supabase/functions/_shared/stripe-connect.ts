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

export async function credentialScopedIdempotencyKey(
  namespace: string,
  credential: string,
  resourceId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(credential),
  )
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${namespace}-${fingerprint}-${resourceId}`
}

export function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export async function createStripeRecipientAccount(
  stripe: Stripe,
  input: CreateRecipientAccountInput,
): Promise<string> {
  const country = (Deno.env.get('STRIPE_CONNECT_COUNTRY') ?? 'US')
    .trim()
    .toLowerCase()
  const currency = (Deno.env.get('STRIPE_CONNECT_CURRENCY') ?? 'usd')
    .trim()
    .toLowerCase()

  if (!/^[a-z]{2}$/.test(country)) {
    throw new Error('STRIPE_CONNECT_COUNTRY must be a two-letter country code.')
  }

  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error('STRIPE_CONNECT_CURRENCY must be a three-letter currency code.')
  }

  const account = await stripe.v2.core.accounts.create(
    {
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: { requested: true },
            },
          },
        },
      },
      contact_email: input.contactEmail ?? undefined,
      dashboard: 'express',
      defaults: {
        currency,
        responsibilities: {
          fees_collector: 'application',
          losses_collector: 'application',
        },
      },
      display_name: input.companyName,
      identity: { country },
      include: [
        'configuration.recipient',
        'future_requirements',
        'identity',
        'requirements',
      ],
      metadata: {
        organization_id: input.organizationId,
        subcontractor_id: input.subcontractorId,
      },
    },
    { idempotencyKey: input.idempotencyKey },
  )

  if (
    typeof account.id !== 'string' ||
    !/^acct_[A-Za-z0-9]{8,200}$/.test(account.id)
  ) {
    throw new Error('Stripe returned an invalid connected account.')
  }

  return account.id
}

function stripeV2Requirements(
  account: Stripe.V2.Core.Account,
  status: 'currently_due' | 'eventually_due' | 'past_due',
): string[] {
  const entries = [
    ...(account.requirements?.entries ?? []),
    ...(account.future_requirements?.entries ?? []),
  ]

  return [
    ...new Set(
      entries
        .filter((entry) =>
          entry.awaiting_action_from === 'user' &&
          entry.minimum_deadline.status === status
        )
        .map((entry) =>
          entry.reference?.resource ??
            entry.reference?.inquiry ??
            entry.description
        ),
    ),
  ]
}

export function stripeV2AccountReadiness(account: Stripe.V2.Core.Account) {
  const currentlyDue = stripeV2Requirements(account, 'currently_due')
  const eventuallyDue = stripeV2Requirements(account, 'eventually_due')
  const pastDue = stripeV2Requirements(account, 'past_due')
  const transferStatus = account.configuration?.recipient?.capabilities
    ?.stripe_balance?.stripe_transfers?.status

  return {
    p_stripe_account_id: account.id,
    p_livemode: account.livemode,
    p_details_submitted: currentlyDue.length === 0 && pastDue.length === 0,
    p_charges_enabled: false,
    p_payouts_enabled: transferStatus === 'active',
    p_requirements_currently_due: currentlyDue,
    p_requirements_eventually_due: eventuallyDue,
    p_requirements_past_due: pastDue,
    p_disabled_reason: transferStatus === 'restricted' ||
        transferStatus === 'unsupported'
      ? `recipient.stripe_transfers.${transferStatus}`
      : null,
  }
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

export async function syncStripeV2AccountReadiness(
  client: unknown,
  account: Stripe.V2.Core.Account,
  event?: { id: string; type: string },
): Promise<RpcResult> {
  return await (client as RpcClient).rpc('sync_subcontractor_stripe_account', {
    ...stripeV2AccountReadiness(account),
    p_event_id: event?.id ?? null,
    p_event_type: event?.type ?? 'v2.core.account.refresh',
  })
}

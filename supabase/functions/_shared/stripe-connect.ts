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
  const country = (Deno.env.get('STRIPE_CONNECT_COUNTRY') ?? 'US').toUpperCase()
  const account = await stripe.accounts.create(
    {
      type: 'standard',
      country,
      email: input.contactEmail ?? undefined,
      business_profile: {
        name: input.companyName,
      },
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

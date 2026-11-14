import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

interface CheckoutRequest {
  retainageReleaseId?: unknown
}

interface PreparedRelease {
  retainage_release_id: string
  release_reference: string
  payment_reference: string
  organization_id: string
  payment_request_id: string
  project_name: string
  subcontractor_name: string
  release_reason: string
  amount_total: number
  currency: string
  customer_email: string | null
  stripe_checkout_session_id: string | null
  stripe_destination_account_id: string
  platform_fee_amount: number
  subcontractor_transfer_amount: number
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
}

export default {
  fetch: withObservability(
    'create-retainage-checkout',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: CheckoutRequest
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isUuid(body.retainageReleaseId)) {
        return Response.json(
          { error: 'A valid retainage release ID is required.' },
          { status: 422 },
        )
      }

      const userId = context.userClaims?.id
      const userEmail = typeof context.userClaims?.email === 'string'
        ? context.userClaims.email
        : undefined

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'create-retainage-checkout',
        subject: userId,
        limit: 8,
        windowSeconds: 60,
      })
      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_retainage_release_checkout',
        {
          p_retainage_release_id: body.retainageReleaseId,
          p_user_id: userId,
          p_payment_reference: crypto.randomUUID(),
        },
      )

      if (preparationError) {
        console.error('Unable to prepare retainage checkout:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare the retainage checkout. Please try again.',
        )
      }

      const prepared = (Array.isArray(data) ? data[0] : data) as
        | PreparedRelease
        | undefined
      if (!prepared) {
        return Response.json(
          { error: 'Unable to prepare the retainage checkout. Please try again.' },
          { status: 500 },
        )
      }

      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })

      if (prepared.stripe_checkout_session_id) {
        try {
          const existing = await stripe.checkout.sessions.retrieve(
            prepared.stripe_checkout_session_id,
          )
          if (existing.status === 'open' && existing.url) {
            return Response.json({ url: existing.url, resumed: true })
          }

          await context.supabaseAdmin.rpc('mark_retainage_release_checkout_failed', {
            p_payment_reference: prepared.payment_reference,
            p_reason: 'existing_checkout_session_closed',
          })
          return Response.json(
            { error: 'The previous checkout is no longer active. Please try again.' },
            { status: 409 },
          )
        } catch (error) {
          console.error('Unable to resume retainage Checkout Session:', error)
          return Response.json(
            { error: 'Unable to resume retainage checkout. Please try again.' },
            { status: 502 },
          )
        }
      }

      const siteUrl = requiredEnvironment('SITE_URL').replace(/\/$/, '')

      try {
        const session = await stripe.checkout.sessions.create(
          {
            client_reference_id: prepared.payment_reference,
            customer_email: prepared.customer_email ?? userEmail,
            line_items: [
              {
                price_data: {
                  currency: prepared.currency,
                  product_data: {
                    name: `Retainage release to ${prepared.subcontractor_name}`,
                    description:
                      `${prepared.project_name} · ${prepared.release_reason}`,
                  },
                  unit_amount: prepared.amount_total,
                },
                quantity: 1,
              },
            ],
            metadata: {
              payment_reference: prepared.payment_reference,
              payment_request_id: prepared.payment_request_id,
              retainage_release_id: prepared.retainage_release_id,
              retainage_release_reference: prepared.release_reference,
              organization_id: prepared.organization_id,
            },
            payment_intent_data: {
              application_fee_amount: prepared.platform_fee_amount || undefined,
              transfer_data: {
                destination: prepared.stripe_destination_account_id,
              },
              metadata: {
                payment_reference: prepared.payment_reference,
                payment_request_id: prepared.payment_request_id,
                retainage_release_id: prepared.retainage_release_id,
                retainage_release_reference: prepared.release_reference,
                organization_id: prepared.organization_id,
              },
            },
            mode: 'payment',
            success_url: `${siteUrl}/retainage?retainage=success`,
            cancel_url: `${siteUrl}/retainage?retainage=canceled`,
          },
          { idempotencyKey: prepared.payment_reference },
        )

        const { data: attached, error: attachError } = await context.supabaseAdmin.rpc(
          'attach_retainage_release_checkout_session',
          {
            p_payment_reference: prepared.payment_reference,
            p_session_id: session.id,
          },
        )

        if (attachError || attached !== true || !session.url) {
          console.error('Unable to attach retainage Checkout Session:', attachError)
          return Response.json(
            {
              error:
                'Stripe created the checkout, but confirmation is pending. Retry to resume it safely.',
            },
            { status: 502 },
          )
        }

        return Response.json({
          url: session.url,
          platformFeeAmount: prepared.platform_fee_amount,
          subcontractorTransferAmount: prepared.subcontractor_transfer_amount,
        })
      } catch (error) {
        console.error('Stripe retainage checkout failed:', error)
        return Response.json(
          {
            error:
              'The retainage checkout could not be confirmed. Retrying will not create a duplicate charge.',
          },
          { status: 502 },
        )
      }
    }),
  ),
}

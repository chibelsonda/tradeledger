import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

interface CheckoutRequest {
  paymentRequestId?: unknown
  quantity?: unknown
}

interface PreparedPaymentRequest {
  payment_id: number
  payment_reference: string
  organization_id: string
  payment_request_id: string
  request_description: string
  project_name: string
  subcontractor_name: string
  amount_total: number
  currency: string
  customer_email: string | null
  stripe_checkout_session_id: string | null
  stripe_destination_account_id: string
  destination_charge: boolean
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name) ?? fallback)

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }

  return value
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

export default {
  fetch: withObservability(
    'create-checkout',
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

      const userId = context.userClaims?.id
      const email = typeof context.userClaims?.email === 'string'
        ? context.userClaims.email
        : undefined

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'create-checkout',
        subject: userId,
        limit: 10,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      const siteUrl = requiredEnvironment('SITE_URL').replace(/\/$/, '')
      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })

      if (body.paymentRequestId !== undefined) {
        if (!isUuid(body.paymentRequestId)) {
          return Response.json(
            { error: 'A valid payment request ID is required.' },
            { status: 422 },
          )
        }

        const proposedReference = crypto.randomUUID()
        const { data, error: preparationError } = await context.supabaseAdmin.rpc(
          'prepare_payment_request_checkout',
          {
            p_payment_request_id: body.paymentRequestId,
            p_user_id: userId,
            p_reference: proposedReference,
          },
        )

        if (preparationError) {
          console.error('Unable to prepare payment request checkout:', preparationError)
          return safeDatabaseErrorResponse(
            preparationError,
            'Unable to prepare checkout. Please try again.',
          )
        }

        const prepared = (Array.isArray(data) ? data[0] : data) as
          | PreparedPaymentRequest
          | undefined

        if (!prepared) {
          return Response.json(
            { error: 'Unable to prepare checkout. Please try again.' },
            { status: 500 },
          )
        }

        if (prepared.stripe_checkout_session_id) {
          try {
            const existingSession = await stripe.checkout.sessions.retrieve(
              prepared.stripe_checkout_session_id,
            )

            if (!prepared.destination_charge) {
              if (existingSession.status === 'open') {
                await stripe.checkout.sessions.expire(existingSession.id)
                await context.supabaseAdmin.rpc('mark_payment_checkout_failed', {
                  p_reference: prepared.payment_reference,
                  p_reason: 'legacy_platform_checkout_replaced',
                })

                return Response.json(
                  {
                    error:
                      'The previous checkout was replaced with subcontractor payout routing. Please try again.',
                  },
                  { status: 409 },
                )
              }

              return Response.json(
                {
                  error:
                    'The previous payment is being finalized. Refresh before starting another checkout.',
                },
                { status: 409 },
              )
            }

            if (existingSession.status === 'open' && existingSession.url) {
              return Response.json({ url: existingSession.url, resumed: true })
            }

            await context.supabaseAdmin.rpc('mark_payment_checkout_failed', {
              p_reference: prepared.payment_reference,
              p_reason: 'existing_checkout_session_closed',
            })

            return Response.json(
              { error: 'The previous checkout is no longer active. Please try again.' },
              { status: 409 },
            )
          } catch (error) {
            console.error('Unable to resume Stripe Checkout Session:', error)
            return Response.json(
              { error: 'Unable to resume checkout. Please try again.' },
              { status: 502 },
            )
          }
        }

        try {
          const session = await stripe.checkout.sessions.create(
            {
              client_reference_id: prepared.payment_reference,
              customer_email: prepared.customer_email ?? email,
              line_items: [
                {
                  price_data: {
                    currency: prepared.currency,
                    product_data: {
                      name: `Payment to ${prepared.subcontractor_name}`,
                      description:
                        `${prepared.project_name} · ${prepared.request_description}`,
                    },
                    unit_amount: prepared.amount_total,
                  },
                  quantity: 1,
                },
              ],
              metadata: {
                payment_reference: prepared.payment_reference,
                payment_request_id: prepared.payment_request_id,
                organization_id: prepared.organization_id,
                supabase_user_id: userId,
              },
              mode: 'payment',
              payment_intent_data: {
                metadata: {
                  payment_reference: prepared.payment_reference,
                  payment_request_id: prepared.payment_request_id,
                  organization_id: prepared.organization_id,
                },
                transfer_data: {
                  destination: prepared.stripe_destination_account_id,
                },
              },
              success_url: siteUrl +
                '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
              cancel_url: siteUrl + '/?checkout=canceled',
            },
            { idempotencyKey: prepared.payment_reference },
          )

          if (!session.url) {
            throw new Error('Stripe did not return a Checkout URL.')
          }

          const { data: attached, error: attachError } = await context.supabaseAdmin
            .rpc('attach_payment_checkout_session', {
              p_reference: prepared.payment_reference,
              p_session_id: session.id,
            })

          if (attachError || attached !== true) {
            console.error('Unable to attach Stripe session:', attachError)
            await stripe.checkout.sessions.expire(session.id).catch(() => undefined)
            throw new Error('Unable to save the Checkout Session.')
          }

          return Response.json({ url: session.url })
        } catch (error) {
          console.error('Payment request Checkout Session creation failed:', error)

          await context.supabaseAdmin.rpc('mark_payment_checkout_failed', {
            p_reference: prepared.payment_reference,
            p_reason: 'checkout_session_creation_failed',
          })

          return Response.json(
            { error: 'Checkout is temporarily unavailable. Please try again.' },
            { status: 502 },
          )
        }
      }

      const maximumQuantity = positiveInteger('CHECKOUT_MAX_QUANTITY', 10)
      const quantity = Number(body.quantity)

      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > maximumQuantity
      ) {
        return Response.json(
          { error: `Quantity must be between 1 and ${maximumQuantity}.` },
          { status: 422 },
        )
      }

      const productName = Deno.env.get('CHECKOUT_PRODUCT_NAME') ?? 'Launch Kit'
      const productDescription = Deno.env.get('CHECKOUT_PRODUCT_DESCRIPTION') ??
        'A polished starter pack for turning your next idea into a real launch.'
      const unitAmount = positiveInteger('CHECKOUT_UNIT_AMOUNT', 4900)
      const currency = (Deno.env.get('CHECKOUT_CURRENCY') ?? 'usd').toLowerCase()
      const reference = crypto.randomUUID()

      const { error: insertError } = await context.supabaseAdmin
        .from('payments')
        .insert({
          user_id: userId,
          reference,
          product_name: productName,
          unit_amount: unitAmount,
          quantity,
          amount_total: unitAmount * quantity,
          currency,
          status: 'pending',
          customer_email: email ?? null,
        })

      if (insertError) {
        console.error('Unable to create payment:', insertError)
        return Response.json(
          { error: 'Unable to prepare checkout. Please try again.' },
          { status: 500 },
        )
      }

      try {
        const session = await stripe.checkout.sessions.create(
          {
            client_reference_id: reference,
            customer_email: email,
            line_items: [
              {
                price_data: {
                  currency,
                  product_data: {
                    name: productName,
                    description: productDescription,
                  },
                  unit_amount: unitAmount,
                },
                quantity,
              },
            ],
            metadata: {
              payment_reference: reference,
              supabase_user_id: userId,
            },
            mode: 'payment',
            payment_intent_data: {
              metadata: {
                payment_reference: reference,
                supabase_user_id: userId,
              },
            },
            success_url: siteUrl +
              '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url: siteUrl + '/?checkout=canceled',
          },
          { idempotencyKey: reference },
        )

        if (!session.url) {
          throw new Error('Stripe did not return a Checkout URL.')
        }

        const { error: updateError } = await context.supabaseAdmin
          .from('payments')
          .update({ stripe_checkout_session_id: session.id })
          .eq('reference', reference)

        if (updateError) {
          console.error('Unable to attach Stripe session:', updateError)
          await stripe.checkout.sessions.expire(session.id).catch(() => undefined)
          throw new Error('Unable to save the Checkout Session.')
        }

        return Response.json({ url: session.url })
      } catch (error) {
        console.error('Stripe Checkout Session creation failed:', error)

        await context.supabaseAdmin
          .from('payments')
          .update({ status: 'failed' })
          .eq('reference', reference)

        return Response.json(
          { error: 'Checkout is temporarily unavailable. Please try again.' },
          { status: 502 },
        )
      }
    }),
  ),
}

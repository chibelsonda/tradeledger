import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

interface RefundRequest {
  paymentRequestId?: unknown
}

interface PreparedRefund {
  refund_reference: string
  organization_id: string
  payment_request_id: string
  payment_reference: string
  stripe_payment_intent_id: string
  stripe_refund_id: string | null
  amount: number
  currency: string
  refund_status: string
  destination_charge: boolean
  refund_application_fee: boolean
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
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
    'create-refund',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: RefundRequest

      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isUuid(body.paymentRequestId)) {
        return Response.json(
          { error: 'A valid payment request ID is required.' },
          { status: 422 },
        )
      }

      const userId = context.userClaims?.id

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'create-refund',
        subject: userId,
        limit: 5,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_payment_refund',
        {
          p_payment_request_id: body.paymentRequestId,
          p_user_id: userId,
          p_reference: crypto.randomUUID(),
        },
      )

      if (preparationError) {
        console.error('Unable to prepare refund:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare the refund. Please try again.',
        )
      }

      const prepared = (Array.isArray(data) ? data[0] : data) as
        | PreparedRefund
        | undefined

      if (!prepared) {
        return Response.json(
          { error: 'Unable to prepare the refund. Please try again.' },
          { status: 500 },
        )
      }

      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })

      try {
        const refund = prepared.stripe_refund_id
          ? await stripe.refunds.retrieve(prepared.stripe_refund_id)
          : await stripe.refunds.create(
            {
              payment_intent: prepared.stripe_payment_intent_id,
              amount: prepared.amount,
              reason: 'requested_by_customer',
              reverse_transfer: prepared.destination_charge,
              refund_application_fee: prepared.refund_application_fee,
              metadata: {
                refund_reference: prepared.refund_reference,
                payment_reference: prepared.payment_reference,
                payment_request_id: prepared.payment_request_id,
                organization_id: prepared.organization_id,
                requested_by: userId,
              },
            },
            { idempotencyKey: prepared.refund_reference },
          )

        const refundStatus = refund.status ?? 'pending'
        const { data: applied, error: applyError } = await context.supabaseAdmin.rpc(
          'apply_payment_refund_status',
          {
            p_refund_reference: prepared.refund_reference,
            p_stripe_refund_id: refund.id,
            p_status: refundStatus,
            p_failure_reason: refund.failure_reason ?? null,
            p_actor_user_id: userId,
          },
        )

        if (applyError || applied !== true) {
          console.error('Unable to apply Stripe refund status:', applyError)
          return Response.json(
            {
              error:
                'Stripe accepted the refund, but ledger confirmation is pending webhook reconciliation.',
            },
            { status: 502 },
          )
        }

        return Response.json({
          refundId: refund.id,
          status: refundStatus,
          amount: refund.amount,
          currency: refund.currency,
        })
      } catch (error) {
        console.error('Stripe refund request failed:', error)
        return Response.json(
          {
            error:
              'The refund could not be confirmed. No duplicate request will be created if you retry.',
          },
          { status: 502 },
        )
      }
    }),
  ),
}

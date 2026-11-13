import { withSupabase } from 'npm:@supabase/server@^1'
import Stripe from 'npm:stripe@^22'

import { withObservability } from '../_shared/observability.ts'

interface ReconciliationRequest {
  paymentRequestId?: unknown
}

interface PreparedReconciliation {
  payment_reference: string
  organization_id: string
  payment_request_id: string
  stripe_checkout_session_id: string
  stripe_payment_intent_id: string | null
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

function errorStatus(code?: string): number {
  if (code === '42501' || code === '28000') return 403
  if (code === 'P0002') return 404
  if (code === '55000') return 409
  return 500
}

export default {
  fetch: withObservability(
    'reconcile-payment',
    withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }

    let body: ReconciliationRequest

    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'A JSON request body is required.' }, { status: 400 })
    }

    if (!isUuid(body.paymentRequestId)) {
      return Response.json(
        { error: 'A valid payment request ID is required.' },
        { status: 422 },
      )
    }

    const userId = context.userClaims?.id

    if (typeof userId !== 'string' || userId.length === 0) {
      return Response.json({ error: 'Authenticated user is missing.' }, { status: 401 })
    }

    const { data, error: preparationError } = await context.supabaseAdmin.rpc(
      'prepare_payment_reconciliation',
      {
        p_payment_request_id: body.paymentRequestId,
        p_user_id: userId,
      },
    )

    if (preparationError) {
      console.error('Unable to prepare reconciliation:', preparationError)
      return Response.json(
        { error: preparationError.message },
        { status: errorStatus(preparationError.code) },
      )
    }

    const prepared = (Array.isArray(data) ? data[0] : data) as
      | PreparedReconciliation
      | undefined

    if (!prepared) {
      return Response.json(
        { error: 'Unable to prepare reconciliation. Please try again.' },
        { status: 500 },
      )
    }

    const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'))

    try {
      const session = await stripe.checkout.sessions.retrieve(
        prepared.stripe_checkout_session_id,
      )
      const sessionPaymentIntent = session.payment_intent
      const paymentIntentId =
        typeof sessionPaymentIntent === 'string'
          ? sessionPaymentIntent
          : sessionPaymentIntent?.id ?? prepared.stripe_payment_intent_id
      const refundList = paymentIntentId
        ? await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })
        : null
      const refunds =
        refundList?.data.map((refund) => ({
          id: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status ?? 'pending',
          reason: refund.reason ?? 'external_stripe_refund',
          failure_reason: refund.failure_reason ?? null,
        })) ?? []

      const { data: status, error: reconciliationError } =
        await context.supabaseAdmin.rpc('reconcile_stripe_payment', {
          p_payment_request_id: prepared.payment_request_id,
          p_user_id: userId,
          p_session_status: session.status,
          p_payment_status: session.payment_status,
          p_payment_intent_id: paymentIntentId,
          p_refunds: refunds,
        })

      if (reconciliationError) {
        console.error('Unable to apply reconciliation:', reconciliationError)
        return Response.json(
          { error: 'Stripe was reached, but the ledger could not be reconciled.' },
          { status: 500 },
        )
      }

      return Response.json({
        status,
        sessionStatus: session.status,
        paymentStatus: session.payment_status,
        refundCount: refunds.length,
      })
    } catch (error) {
      console.error('Stripe reconciliation failed:', error)
      return Response.json(
        { error: 'Stripe reconciliation is temporarily unavailable.' },
        { status: 502 },
      )
    }
    }),
  ),
}

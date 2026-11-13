import { withSupabase } from 'npm:@supabase/server@^1'
import Stripe from 'npm:stripe@^22'

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function uuidOrNull(value: string | undefined): string | null {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null
}

const cryptoProvider = Stripe.createSubtleCryptoProvider()

export default {
  fetch: withSupabase({ auth: 'none' }, async (request, context) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }

    const signature = request.headers.get('stripe-signature') ?? ''
    const payload = await request.text()
    const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'))

    let event: Stripe.Event

    try {
      event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        requiredEnvironment('STRIPE_WEBHOOK_SECRET'),
        undefined,
        cryptoProvider,
      )
    } catch (error) {
      console.error('Stripe signature verification failed:', error)
      return Response.json({ error: 'Invalid webhook signature.' }, { status: 400 })
    }

    const checkoutSession = event.type.startsWith('checkout.session.')
      ? (event.data.object as Stripe.Checkout.Session)
      : null
    const refund = event.type.startsWith('refund.')
      ? (event.data.object as Stripe.Refund)
      : null
    const checkoutPaymentIntent = checkoutSession?.payment_intent
    const checkoutPaymentIntentId =
      typeof checkoutPaymentIntent === 'string'
        ? checkoutPaymentIntent
        : checkoutPaymentIntent?.id ?? null
    const refundPaymentIntent = refund?.payment_intent
    const refundPaymentIntentId =
      typeof refundPaymentIntent === 'string'
        ? refundPaymentIntent
        : refundPaymentIntent?.id ?? null
    const objectId = checkoutSession?.id ?? refund?.id ?? null

    const result = refund
      ? await context.supabaseAdmin.rpc('process_stripe_refund_webhook', {
          p_event_id: event.id,
          p_event_type: event.type,
          p_stripe_refund_id: refund.id,
          p_refund_reference: uuidOrNull(refund.metadata?.refund_reference),
          p_payment_intent_id: refundPaymentIntentId,
          p_amount: refund.amount,
          p_currency: refund.currency,
          p_status: refund.status ?? 'pending',
          p_failure_reason: refund.failure_reason ?? null,
        })
      : await context.supabaseAdmin.rpc('process_stripe_webhook', {
          p_event_id: event.id,
          p_event_type: event.type,
          p_session_id: checkoutSession?.id ?? null,
          p_payment_status: checkoutSession?.payment_status ?? null,
          p_payment_intent_id: checkoutPaymentIntentId,
          p_customer_email: checkoutSession?.customer_details?.email ?? null,
        })

    if (result.error) {
      console.error('Stripe webhook processing failed:', result.error)

      const { error: failureError } = await context.supabaseAdmin.rpc(
        'record_stripe_webhook_failure',
        {
          p_event_id: event.id,
          p_event_type: event.type,
          p_object_id: objectId,
          p_error_code: result.error.code ?? null,
          p_error_message: result.error.message,
        },
      )

      if (failureError) {
        console.error('Unable to record Stripe webhook failure:', failureError)
      }

      return Response.json({ error: 'Webhook processing failed.' }, { status: 500 })
    }

    return Response.json({
      received: true,
      duplicate: result.data === false,
    })
  }),
}

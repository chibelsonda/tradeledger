import { withSupabase } from 'npm:@supabase/server@^1'
import Stripe from 'npm:stripe@^22'

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
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
    const paymentIntent = checkoutSession?.payment_intent
    const paymentIntentId =
      typeof paymentIntent === 'string'
        ? paymentIntent
        : paymentIntent?.id ?? null

    const { data: processed, error: processingError } =
      await context.supabaseAdmin.rpc('process_stripe_webhook', {
        p_event_id: event.id,
        p_event_type: event.type,
        p_session_id: checkoutSession?.id ?? null,
        p_payment_status: checkoutSession?.payment_status ?? null,
        p_payment_intent_id: paymentIntentId,
        p_customer_email: checkoutSession?.customer_details?.email ?? null,
      })

    if (processingError) {
      console.error('Stripe webhook processing failed:', processingError)
      return Response.json({ error: 'Webhook processing failed.' }, { status: 500 })
    }

    return Response.json({
      received: true,
      duplicate: processed === false,
    })
  }),
}

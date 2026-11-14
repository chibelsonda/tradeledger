import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { syncStripeAccountReadiness } from '../_shared/stripe-connect.ts'

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

interface AdminClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { code?: string; message?: string } | null
  }>
}

function stripeReference(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === 'string' ? value : value?.id ?? null
}

function stripeTimestamp(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null
}

function transferStatus(transfer: Stripe.Transfer): string {
  if (transfer.reversed || transfer.amount_reversed >= transfer.amount) {
    return 'reversed'
  }

  return transfer.amount_reversed > 0 ? 'partially_reversed' : 'succeeded'
}

async function sourceChargeForTransfer(
  stripe: Stripe,
  transfer: Stripe.Transfer,
): Promise<Stripe.Charge | null> {
  if (typeof transfer.source_transaction === 'object') {
    return transfer.source_transaction
  }

  if (typeof transfer.source_transaction === 'string') {
    return await stripe.charges.retrieve(transfer.source_transaction)
  }

  return null
}

async function applyTransferEvent(
  stripe: Stripe,
  supabaseAdmin: AdminClient,
  event: Stripe.Event,
  transfer: Stripe.Transfer,
  knownCharge: Stripe.Charge | null = null,
) {
  const charge = knownCharge ?? await sourceChargeForTransfer(stripe, transfer)
  const paymentIntentId = stripeReference(charge?.payment_intent)
  const destinationAccountId = stripeReference(transfer.destination)

  if (!paymentIntentId || !destinationAccountId) {
    throw new Error('Transfer ownership references are unavailable.')
  }

  return await supabaseAdmin.rpc('apply_stripe_transfer_ledger_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_stripe_transfer_id: transfer.id,
    p_stripe_account_id: destinationAccountId,
    p_payment_intent_id: paymentIntentId,
    p_amount: transfer.amount,
    p_currency: transfer.currency,
    p_status: transferStatus(transfer),
    p_reversed_amount: transfer.amount_reversed,
    p_source_transaction_id: stripeReference(transfer.source_transaction),
    p_stripe_charge_id: charge?.id ?? null,
    p_stripe_created_at: stripeTimestamp(transfer.created),
    p_actor_user_id: null,
  })
}

async function applyPayoutEvent(
  supabaseAdmin: AdminClient,
  event: Stripe.Event,
  payout: Stripe.Payout,
) {
  if (!event.account) {
    throw new Error('Connected payout event is missing its account context.')
  }

  return await supabaseAdmin.rpc('apply_stripe_payout_ledger_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_stripe_account_id: event.account,
    p_stripe_payout_id: payout.id,
    p_amount: payout.amount,
    p_currency: payout.currency,
    p_status: payout.status,
    p_expected_arrival_at: stripeTimestamp(payout.arrival_date),
    p_failure_code: payout.failure_code ?? null,
    p_failure_message: payout.failure_message ?? null,
    p_stripe_created_at: stripeTimestamp(payout.created),
    p_actor_user_id: null,
  })
}

async function applyDisputeEvent(
  stripe: Stripe,
  supabaseAdmin: AdminClient,
  event: Stripe.Event,
  dispute: Stripe.Dispute,
) {
  const charge = typeof dispute.charge === 'string'
    ? await stripe.charges.retrieve(dispute.charge)
    : dispute.charge
  const paymentIntentId = stripeReference(dispute.payment_intent) ??
    stripeReference(charge.payment_intent)

  if (!paymentIntentId) {
    throw new Error('The dispute payment reference is unavailable.')
  }

  return await supabaseAdmin.rpc('apply_stripe_dispute_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_stripe_dispute_id: dispute.id,
    p_stripe_charge_id: charge.id,
    p_stripe_payment_intent_id: paymentIntentId,
    p_amount: dispute.amount,
    p_currency: dispute.currency,
    p_reason: dispute.reason,
    p_status: dispute.status,
    p_livemode: dispute.livemode,
    p_evidence_due_at: stripeTimestamp(dispute.evidence_details?.due_by),
    p_has_evidence: dispute.evidence_details?.has_evidence ?? false,
    p_evidence_past_due: dispute.evidence_details?.past_due ?? false,
    p_evidence_submission_count: dispute.evidence_details?.submission_count ?? 0,
    p_actor_user_id: null,
  })
}

async function constructVerifiedEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
): Promise<{ event: Stripe.Event; source: 'platform' | 'connect' }> {
  const webhookSecrets = [
    {
      source: 'platform' as const,
      secret: requiredEnvironment('STRIPE_WEBHOOK_SECRET'),
    },
    {
      source: 'connect' as const,
      secret: Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET'),
    },
  ].filter(
    (item): item is { source: 'platform' | 'connect'; secret: string } =>
      Boolean(item.secret),
  )

  let verificationError: unknown

  for (const { source, secret } of webhookSecrets) {
    try {
      return {
        event: await stripe.webhooks.constructEventAsync(
          payload,
          signature,
          secret,
          undefined,
          cryptoProvider,
        ),
        source,
      }
    } catch (error) {
      verificationError = error
    }
  }

  throw verificationError ?? new Error('No Stripe webhook secret is configured.')
}

export default {
  fetch: withObservability(
    'stripe-webhook',
    withSupabase({ auth: 'none' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      const signature = request.headers.get('stripe-signature') ?? ''
      const payload = await request.text()
      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'))

      let event: Stripe.Event
      let webhookSource: 'platform' | 'connect'

      try {
        const verified = await constructVerifiedEvent(stripe, payload, signature)
        event = verified.event
        webhookSource = verified.source
      } catch (error) {
        console.error('Stripe signature verification failed:', error)
        return Response.json({ error: 'Invalid webhook signature.' }, { status: 400 })
      }

      const requiresConnectSecret = event.type === 'account.updated' ||
        event.type.startsWith('payout.')

      if (
        (requiresConnectSecret && webhookSource !== 'connect') ||
        (!requiresConnectSecret && webhookSource !== 'platform')
      ) {
        return Response.json({ received: true, ignored: true })
      }

      if (event.type === 'account.updated') {
        const account = event.data.object as Stripe.Account
        const result = await syncStripeAccountReadiness(
          context.supabaseAdmin,
          account,
          { id: event.id, type: event.type },
        )

        if (result.error) {
          if (result.error.code === 'P0002') {
            return Response.json({ received: true, ignored: true })
          }

          console.error('Stripe connected account webhook failed:', result.error)
          return Response.json({ error: 'Webhook processing failed.' }, {
            status: 500,
          })
        }

        return Response.json({
          received: true,
          duplicate: result.data === false,
        })
      }

      if (
        event.type === 'charge.dispute.created' ||
        event.type === 'charge.dispute.updated' ||
        event.type === 'charge.dispute.closed' ||
        event.type === 'charge.dispute.funds_withdrawn' ||
        event.type === 'charge.dispute.funds_reinstated'
      ) {
        const dispute = event.data.object as Stripe.Dispute

        try {
          const result = await applyDisputeEvent(
            stripe,
            context.supabaseAdmin,
            event,
            dispute,
          )

          if (result.error?.code === 'P0002') {
            return Response.json({ received: true, ignored: true })
          }
          if (result.error) throw result.error

          return Response.json({
            received: true,
            duplicate: result.data === false,
          })
        } catch (error) {
          console.error('Stripe dispute webhook failed:', error)
          await context.supabaseAdmin.rpc('record_stripe_webhook_failure', {
            p_event_id: event.id,
            p_event_type: event.type,
            p_object_id: dispute.id,
            p_error_code: 'dispute_ledger_failed',
            p_error_message: 'Dispute ledger processing failed.',
          })

          return Response.json({ error: 'Webhook processing failed.' }, {
            status: 500,
          })
        }
      }

      if (
        event.type === 'transfer.created' ||
        event.type === 'transfer.updated' ||
        event.type === 'transfer.reversed'
      ) {
        const transfer = event.data.object as Stripe.Transfer

        try {
          const result = await applyTransferEvent(
            stripe,
            context.supabaseAdmin,
            event,
            transfer,
          )

          if (result.error?.code === 'P0002') {
            return Response.json({ received: true, ignored: true })
          }

          if (result.error) throw result.error

          return Response.json({
            received: true,
            duplicate: result.data === false,
          })
        } catch (error) {
          console.error('Stripe transfer webhook failed:', error)
          await context.supabaseAdmin.rpc('record_stripe_webhook_failure', {
            p_event_id: event.id,
            p_event_type: event.type,
            p_object_id: transfer.id,
            p_error_code: 'transfer_ledger_failed',
            p_error_message: 'Transfer ledger processing failed.',
          })

          return Response.json({ error: 'Webhook processing failed.' }, {
            status: 500,
          })
        }
      }

      if (event.type === 'charge.succeeded') {
        const charge = event.data.object as Stripe.Charge
        const transferId = stripeReference(charge.transfer)

        if (!transferId) {
          return Response.json({ received: true, ignored: true })
        }

        try {
          const transfer = await stripe.transfers.retrieve(transferId)
          const result = await applyTransferEvent(
            stripe,
            context.supabaseAdmin,
            event,
            transfer,
            charge,
          )

          if (result.error?.code === 'P0002') {
            return Response.json({ received: true, ignored: true })
          }

          if (result.error) throw result.error

          return Response.json({
            received: true,
            duplicate: result.data === false,
          })
        } catch (error) {
          console.error('Stripe destination transfer discovery failed:', error)
          await context.supabaseAdmin.rpc('record_stripe_webhook_failure', {
            p_event_id: event.id,
            p_event_type: event.type,
            p_object_id: transferId,
            p_error_code: 'transfer_discovery_failed',
            p_error_message: 'Destination transfer discovery failed.',
          })

          return Response.json({ error: 'Webhook processing failed.' }, {
            status: 500,
          })
        }
      }

      if (
        event.type === 'payout.created' ||
        event.type === 'payout.updated' ||
        event.type === 'payout.paid' ||
        event.type === 'payout.failed' ||
        event.type === 'payout.canceled'
      ) {
        const payout = event.data.object as Stripe.Payout

        try {
          const result = await applyPayoutEvent(
            context.supabaseAdmin,
            event,
            payout,
          )

          if (result.error?.code === 'P0002') {
            return Response.json({ received: true, ignored: true })
          }

          if (result.error) throw result.error

          return Response.json({
            received: true,
            duplicate: result.data === false,
          })
        } catch (error) {
          console.error('Stripe connected payout webhook failed:', error)
          await context.supabaseAdmin.rpc('record_stripe_webhook_failure', {
            p_event_id: event.id,
            p_event_type: event.type,
            p_object_id: payout.id,
            p_error_code: 'payout_ledger_failed',
            p_error_message: 'Connected payout ledger processing failed.',
          })

          return Response.json({ error: 'Webhook processing failed.' }, {
            status: 500,
          })
        }
      }

      const checkoutSession = event.type.startsWith('checkout.session.')
        ? (event.data.object as Stripe.Checkout.Session)
        : null
      const refund = event.type.startsWith('refund.')
        ? (event.data.object as Stripe.Refund)
        : null

      if (!checkoutSession && !refund) {
        return Response.json({ received: true, ignored: true })
      }

      const retainageReleaseReference = checkoutSession
        ? uuidOrNull(checkoutSession.metadata?.retainage_release_reference)
        : null
      const retainageRefundReference = refund
        ? uuidOrNull(refund.metadata?.refund_reference)
        : null
      const retainageReleaseId = refund
        ? uuidOrNull(refund.metadata?.retainage_release_id)
        : null
      const checkoutPaymentIntent = checkoutSession?.payment_intent
      const checkoutPaymentIntentId = typeof checkoutPaymentIntent === 'string'
        ? checkoutPaymentIntent
        : checkoutPaymentIntent?.id ?? null
      const refundPaymentIntent = refund?.payment_intent
      const refundPaymentIntentId = typeof refundPaymentIntent === 'string'
        ? refundPaymentIntent
        : refundPaymentIntent?.id ?? null
      const objectId = checkoutSession?.id ?? refund?.id ?? null

      const result = checkoutSession && retainageReleaseReference
        ? await context.supabaseAdmin.rpc(
          'process_retainage_release_checkout_webhook',
          {
            p_event_id: event.id,
            p_event_type: event.type,
            p_session_id: checkoutSession.id,
            p_payment_status: checkoutSession.payment_status ?? null,
            p_payment_intent_id: checkoutPaymentIntentId,
            p_release_reference: retainageReleaseReference,
          },
        )
        : refund && retainageRefundReference && retainageReleaseId
        ? await context.supabaseAdmin.rpc(
          'process_retainage_release_refund_webhook',
          {
            p_event_id: event.id,
            p_event_type: event.type,
            p_stripe_refund_id: refund.id,
            p_refund_reference: retainageRefundReference,
            p_payment_intent_id: refundPaymentIntentId,
            p_amount: refund.amount,
            p_currency: refund.currency,
            p_status: refund.status ?? 'pending',
            p_failure_reason: refund.failure_reason ?? null,
          },
        )
        : refund
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
  ),
}

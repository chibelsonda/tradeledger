import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

type DisputeAction =
  | 'sync'
  | 'save_evidence'
  | 'submit_evidence'
  | 'accept'
  | 'recover'

interface ManageDisputeRequest {
  disputeId?: unknown
  action?: unknown
  confirm?: unknown
  evidence?: {
    productDescription?: unknown
    serviceDate?: unknown
    customerEmail?: unknown
    uncategorizedText?: unknown
  }
}

interface PreparedDisputeAction {
  dispute_id: string
  organization_id: string
  stripe_dispute_id: string
  stripe_transfer_id: string | null
  dispute_amount: number
  recoverable_amount: number
  currency: string
  current_status: string
}

interface RpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { code?: string; message?: string } | null
  }>
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

function isAction(value: unknown): value is DisputeAction {
  return typeof value === 'string' &&
    ['sync', 'save_evidence', 'submit_evidence', 'accept', 'recover'].includes(
      value,
    )
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null
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

async function applyDispute(
  stripe: Stripe,
  client: RpcClient,
  dispute: Stripe.Dispute,
  actorUserId: string,
) {
  const charge = typeof dispute.charge === 'string'
    ? await stripe.charges.retrieve(dispute.charge)
    : dispute.charge
  const paymentIntentId = stripeReference(dispute.payment_intent) ??
    stripeReference(charge.payment_intent)

  if (!paymentIntentId) {
    throw new Error('The dispute payment reference is unavailable.')
  }

  const { data, error } = await client.rpc('apply_stripe_dispute_event', {
    p_event_id: null,
    p_event_type: 'dispute.manual_sync',
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
    p_actor_user_id: actorUserId,
  })

  if (error || data !== true) throw error ?? new Error('Dispute sync failed.')
}

export default {
  fetch: withObservability(
    'manage-dispute',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: ManageDisputeRequest
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isUuid(body.disputeId) || !isAction(body.action)) {
        return Response.json(
          { error: 'A valid dispute ID and action are required.' },
          { status: 422 },
        )
      }

      const userId = context.userClaims?.id
      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      if (
        ['submit_evidence', 'accept', 'recover'].includes(body.action) &&
        body.confirm !== true
      ) {
        return Response.json(
          { error: 'Explicit confirmation is required for this action.' },
          { status: 422 },
        )
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: `manage-dispute:${body.action}`,
        subject: userId,
        limit: body.action === 'sync' ? 20 : 8,
        windowSeconds: 60,
      })
      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_dispute_action',
        {
          p_dispute_id: body.disputeId,
          p_user_id: userId,
          p_action: body.action,
        },
      )

      if (preparationError) {
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare the dispute action. Please try again.',
        )
      }

      const prepared = (Array.isArray(data) ? data[0] : data) as
        | PreparedDisputeAction
        | undefined
      if (!prepared) {
        return Response.json({ error: 'The dispute action could not be prepared.' }, {
          status: 500,
        })
      }

      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })
      const evidence = {
        product_description: optionalString(
          body.evidence?.productDescription,
          20_000,
        ) ?? undefined,
        service_date: optionalString(body.evidence?.serviceDate, 10) ?? undefined,
        customer_email_address: optionalString(
          body.evidence?.customerEmail,
          320,
        ) ?? undefined,
        uncategorized_text: optionalString(
          body.evidence?.uncategorizedText,
          20_000,
        ) ?? undefined,
      }

      try {
        if (body.action === 'recover') {
          if (!prepared.stripe_transfer_id || prepared.recoverable_amount <= 0) {
            return Response.json(
              { error: 'No connected transfer funds are available to recover.' },
              { status: 409 },
            )
          }

          const reversal = await stripe.transfers.createReversal(
            prepared.stripe_transfer_id,
            {
              amount: prepared.recoverable_amount,
              metadata: {
                dispute_id: prepared.dispute_id,
                organization_id: prepared.organization_id,
                recovered_by: userId,
              },
            },
            { idempotencyKey: `dispute-recovery:${prepared.dispute_id}` },
          )

          const { error: recordError } = await context.supabaseAdmin.rpc(
            'record_dispute_action_result',
            {
              p_dispute_id: prepared.dispute_id,
              p_user_id: userId,
              p_action: body.action,
              p_recovery_amount: reversal.amount,
              p_transfer_reversal_id: reversal.id,
            },
          )
          if (recordError) throw recordError

          return Response.json({
            status: 'reversed',
            amount: reversal.amount,
            currency: prepared.currency,
          })
        }

        const dispute = body.action === 'sync'
          ? await stripe.disputes.retrieve(prepared.stripe_dispute_id)
          : body.action === 'accept'
          ? await stripe.disputes.close(prepared.stripe_dispute_id)
          : await stripe.disputes.update(prepared.stripe_dispute_id, {
            evidence,
            submit: body.action === 'submit_evidence',
          })

        if (body.action !== 'sync') {
          const { error: recordError } = await context.supabaseAdmin.rpc(
            'record_dispute_action_result',
            {
              p_dispute_id: prepared.dispute_id,
              p_user_id: userId,
              p_action: body.action,
              p_product_description: evidence.product_description ?? null,
              p_service_date: evidence.service_date ?? null,
              p_customer_email: evidence.customer_email_address ?? null,
              p_uncategorized_text: evidence.uncategorized_text ?? null,
            },
          )
          if (recordError) throw recordError
        }

        await applyDispute(stripe, context.supabaseAdmin, dispute, userId)
        return Response.json({ status: dispute.status })
      } catch (error) {
        console.error('Stripe dispute action failed:', error)
        return Response.json(
          {
            error:
              'The Stripe dispute action could not be confirmed. Refresh the dispute before retrying.',
          },
          { status: 502 },
        )
      }
    }),
  ),
}

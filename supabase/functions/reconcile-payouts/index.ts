import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

type ReconciliationTarget = 'organization' | 'subcontractor' | 'payment' | 'payout'

interface ReconciliationRequest {
  organizationId?: unknown
  targetType?: unknown
  targetId?: unknown
}

interface PreparedAccount {
  payout_account_id: string
  subcontractor_id: string
  stripe_account_id: string
  stripe_payout_id: string | null
}

interface PreparedReconciliation {
  organization_id: string
  target_type: ReconciliationTarget
  target_id: string
  accounts: PreparedAccount[]
  payment_intent_ids: string[]
  transfer_ids: string[]
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) throw new Error(`Missing required environment variable: ${name}`)

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

function isTarget(value: unknown): value is ReconciliationTarget {
  return (
    value === 'organization' ||
    value === 'subcontractor' ||
    value === 'payment' ||
    value === 'payout'
  )
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

export default {
  fetch: withObservability(
    'reconcile-payouts',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: ReconciliationRequest

      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      const targetType = body.targetType ?? 'organization'
      const targetId = body.targetId ?? body.organizationId

      if (
        !isUuid(body.organizationId) ||
        !isTarget(targetType) ||
        !isUuid(targetId)
      ) {
        return Response.json(
          { error: 'A valid organization and reconciliation target are required.' },
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
        bucket: 'reconcile-payouts',
        subject: `${userId}:${body.organizationId}`,
        limit: 6,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_payout_reconciliation',
        {
          p_organization_id: body.organizationId,
          p_user_id: userId,
          p_target_type: targetType,
          p_target_id: targetId,
        },
      )

      if (preparationError) {
        console.error('Unable to prepare payout reconciliation:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare payout reconciliation. Please try again.',
        )
      }

      const prepared = data as PreparedReconciliation | null

      if (!prepared) {
        return Response.json(
          { error: 'Unable to prepare payout reconciliation. Please try again.' },
          { status: 500 },
        )
      }

      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 15_000,
      })
      const processedTransfers = new Set<string>()
      let payoutCount = 0

      const applyTransfer = async (
        transfer: Stripe.Transfer,
        charge: Stripe.Charge | null = null,
      ) => {
        if (processedTransfers.has(transfer.id)) return

        const sourceCharge = charge ?? (
          typeof transfer.source_transaction === 'object'
            ? transfer.source_transaction
            : typeof transfer.source_transaction === 'string'
            ? await stripe.charges.retrieve(transfer.source_transaction)
            : null
        )
        const paymentIntentId = stripeReference(sourceCharge?.payment_intent)
        const stripeAccountId = stripeReference(transfer.destination)

        if (!paymentIntentId || !stripeAccountId) {
          throw new Error('TRANSFER_RELATIONSHIP_UNAVAILABLE')
        }

        const balanceTransactionId = stripeReference(transfer.balance_transaction)

        if (balanceTransactionId) {
          await stripe.balanceTransactions.retrieve(balanceTransactionId)
        }

        const { error } = await context.supabaseAdmin.rpc(
          'apply_stripe_transfer_ledger_event',
          {
            p_event_id: null,
            p_event_type: 'manual.reconciliation',
            p_stripe_transfer_id: transfer.id,
            p_stripe_account_id: stripeAccountId,
            p_payment_intent_id: paymentIntentId,
            p_amount: transfer.amount,
            p_currency: transfer.currency,
            p_status: transferStatus(transfer),
            p_reversed_amount: transfer.amount_reversed,
            p_source_transaction_id: stripeReference(transfer.source_transaction),
            p_stripe_charge_id: sourceCharge?.id ?? null,
            p_stripe_created_at: stripeTimestamp(transfer.created),
            p_actor_user_id: userId,
          },
        )

        if (error) throw error
        processedTransfers.add(transfer.id)
      }

      try {
        for (const paymentIntentId of prepared.payment_intent_ids.slice(0, 100)) {
          const paymentIntent = await stripe.paymentIntents.retrieve(
            paymentIntentId,
            { expand: ['latest_charge'] },
          )
          const latestCharge = typeof paymentIntent.latest_charge === 'object'
            ? paymentIntent.latest_charge
            : paymentIntent.latest_charge
            ? await stripe.charges.retrieve(paymentIntent.latest_charge)
            : null
          const transferId = stripeReference(latestCharge?.transfer)

          if (latestCharge?.balance_transaction) {
            const balanceTransactionId = stripeReference(
              latestCharge.balance_transaction,
            )
            if (balanceTransactionId) {
              await stripe.balanceTransactions.retrieve(balanceTransactionId)
            }
          }

          if (transferId) {
            const transfer = await stripe.transfers.retrieve(transferId)
            await applyTransfer(transfer, latestCharge)
          }
        }

        for (const transferId of prepared.transfer_ids.slice(0, 100)) {
          if (!processedTransfers.has(transferId)) {
            await applyTransfer(await stripe.transfers.retrieve(transferId))
          }
        }

        for (const account of prepared.accounts.slice(0, 100)) {
          const payouts = account.stripe_payout_id
            ? [
              await stripe.payouts.retrieve(account.stripe_payout_id, {}, {
                stripeAccount: account.stripe_account_id,
              }),
            ]
            : (await stripe.payouts.list(
              { limit: 100 },
              { stripeAccount: account.stripe_account_id },
            )).data

          for (const payout of payouts) {
            const balanceTransactionId = stripeReference(payout.balance_transaction)

            if (balanceTransactionId) {
              await stripe.balanceTransactions.retrieve(
                balanceTransactionId,
                {},
                { stripeAccount: account.stripe_account_id },
              )
            }

            const { error } = await context.supabaseAdmin.rpc(
              'apply_stripe_payout_ledger_event',
              {
                p_event_id: null,
                p_event_type: 'manual.reconciliation',
                p_stripe_account_id: account.stripe_account_id,
                p_stripe_payout_id: payout.id,
                p_amount: payout.amount,
                p_currency: payout.currency,
                p_status: payout.status,
                p_expected_arrival_at: stripeTimestamp(payout.arrival_date),
                p_failure_code: payout.failure_code ?? null,
                p_failure_message: payout.failure_message ?? null,
                p_stripe_created_at: stripeTimestamp(payout.created),
                p_actor_user_id: userId,
              },
            )

            if (error) throw error
            payoutCount += 1
          }
        }

        await context.supabaseAdmin.rpc('record_payout_reconciliation_result', {
          p_organization_id: prepared.organization_id,
          p_user_id: userId,
          p_target_type: prepared.target_type,
          p_target_id: prepared.target_id,
          p_succeeded: true,
          p_transfer_count: processedTransfers.size,
          p_payout_count: payoutCount,
          p_failure_code: null,
        })

        return Response.json({
          status: 'reconciled',
          transferCount: processedTransfers.size,
          payoutCount,
        })
      } catch (error) {
        console.error('Stripe payout reconciliation failed:', error)
        await context.supabaseAdmin.rpc('record_payout_reconciliation_result', {
          p_organization_id: prepared.organization_id,
          p_user_id: userId,
          p_target_type: prepared.target_type,
          p_target_id: prepared.target_id,
          p_succeeded: false,
          p_transfer_count: processedTransfers.size,
          p_payout_count: payoutCount,
          p_failure_code: 'stripe_reconciliation_failed',
        })

        return Response.json(
          { error: 'Stripe payout reconciliation is temporarily unavailable.' },
          { status: 502 },
        )
      }
    }),
  ),
}

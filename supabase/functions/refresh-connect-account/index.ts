import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'
import {
  requiredEnvironment,
  stripeAccountReadiness,
  syncStripeAccountReadiness,
} from '../_shared/stripe-connect.ts'

interface RefreshRequest {
  subcontractorId?: unknown
}

interface PreparedPayoutAccount {
  stripe_account_id: string | null
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
    'refresh-connect-account',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: RefreshRequest

      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isUuid(body.subcontractorId)) {
        return Response.json({ error: 'A valid subcontractor ID is required.' }, {
          status: 422,
        })
      }

      const userId = context.userClaims?.id

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'refresh-connect-account',
        subject: userId,
        limit: 12,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_subcontractor_payout_onboarding',
        {
          p_subcontractor_id: body.subcontractorId,
          p_user_id: userId,
        },
      )

      if (preparationError) {
        console.error('Unable to authorize Stripe account refresh:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to refresh payout readiness. Please try again.',
        )
      }

      const prepared = (Array.isArray(data) ? data[0] : data) as
        | PreparedPayoutAccount
        | undefined

      if (!prepared?.stripe_account_id) {
        return Response.json(
          { error: 'Payout onboarding has not been started for this subcontractor.' },
          { status: 409 },
        )
      }

      try {
        const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
          maxNetworkRetries: 2,
          timeout: 10_000,
        })
        const account = await stripe.accounts.retrieve(prepared.stripe_account_id)
        const syncResult = await syncStripeAccountReadiness(
          context.supabaseAdmin,
          account,
        )

        if (syncResult.error) {
          console.error(
            'Unable to synchronize Stripe account readiness:',
            syncResult.error,
          )
          return safeDatabaseErrorResponse(
            syncResult.error,
            'Unable to refresh payout readiness. Please try again.',
          )
        }

        const readiness = stripeAccountReadiness(account)

        return Response.json({
          detailsSubmitted: readiness.p_details_submitted,
          payoutsEnabled: readiness.p_payouts_enabled,
          requirementsCurrentlyDue: readiness.p_requirements_currently_due.length,
          requirementsPastDue: readiness.p_requirements_past_due.length,
        })
      } catch (error) {
        console.error('Stripe account refresh failed:', error)
        return Response.json(
          { error: 'Payout readiness is temporarily unavailable. Please try again.' },
          { status: 502 },
        )
      }
    }),
  ),
}

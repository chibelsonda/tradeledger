import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'
import {
  createStripeRecipientAccount,
  requiredEnvironment,
  StripeConnectApiError,
  syncStripeAccountReadiness,
} from '../_shared/stripe-connect.ts'

interface OnboardingRequest {
  subcontractorId?: unknown
}

interface PreparedPayoutAccount {
  payout_account_id: string
  organization_id: string
  subcontractor_id: string
  company_name: string
  contact_email: string | null
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

function applicationUrl(subcontractorId: string, state: 'refresh' | 'return'): string {
  const siteUrl = new URL(requiredEnvironment('SITE_URL'))
  const url = new URL('/directory', siteUrl)
  url.searchParams.set('connect', state)
  url.searchParams.set('subcontractor_id', subcontractorId)
  return url.toString()
}

export default {
  fetch: withObservability(
    'create-connect-onboarding-link',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: OnboardingRequest

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
        bucket: 'create-connect-onboarding-link',
        subject: userId,
        limit: 6,
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
        console.error('Unable to prepare Stripe Connect onboarding:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare payout onboarding. Please try again.',
        )
      }

      const prepared = (Array.isArray(data) ? data[0] : data) as
        | PreparedPayoutAccount
        | undefined

      if (!prepared) {
        return Response.json(
          { error: 'Unable to prepare payout onboarding. Please try again.' },
          { status: 500 },
        )
      }

      const stripe = new Stripe(requiredEnvironment('STRIPE_SECRET'), {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })
      let stripeAccountId = prepared.stripe_account_id

      try {
        if (!stripeAccountId) {
          stripeAccountId = await createStripeRecipientAccount({
            companyName: prepared.company_name,
            contactEmail: prepared.contact_email,
            idempotencyKey: `payout-account-${prepared.payout_account_id}`,
            organizationId: prepared.organization_id,
            subcontractorId: prepared.subcontractor_id,
          })

          const { data: attached, error: attachError } = await context.supabaseAdmin
            .rpc('attach_subcontractor_stripe_account', {
              p_payout_account_id: prepared.payout_account_id,
              p_user_id: userId,
              p_stripe_account_id: stripeAccountId,
              p_dashboard_type: 'full',
            })

          if (attachError || attached !== true) {
            console.error('Unable to attach Stripe connected account:', attachError)
            return Response.json(
              { error: 'Unable to save the connected account. Please try again.' },
              { status: 500 },
            )
          }
        }

        const account = await stripe.accounts.retrieve(stripeAccountId)
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
            'Unable to synchronize payout readiness. Please try again.',
          )
        }

        const accountLink = await stripe.accountLinks.create({
          account: stripeAccountId,
          refresh_url: applicationUrl(prepared.subcontractor_id, 'refresh'),
          return_url: applicationUrl(prepared.subcontractor_id, 'return'),
          type: 'account_onboarding',
          collection_options: {
            fields: 'eventually_due',
          },
        })

        return Response.json({ url: accountLink.url })
      } catch (error) {
        if (error instanceof StripeConnectApiError) {
          console.error('Stripe Accounts v2 request failed:', {
            code: error.code,
            status: error.status,
          })
        } else {
          console.error('Stripe Connect onboarding failed:', error)
        }

        return Response.json(
          { error: 'Payout onboarding is temporarily unavailable. Please try again.' },
          { status: 502 },
        )
      }
    }),
  ),
}

import { withSupabase } from '@supabase/server'
import Stripe from 'stripe'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'
import {
  createStripeRecipientAccount,
  credentialScopedIdempotencyKey,
  requiredEnvironment,
  syncStripeV2AccountReadiness,
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

type StripeOnboardingStage =
  | 'account_create'
  | 'account_attach'
  | 'account_retrieve'
  | 'readiness_sync'
  | 'account_link'

function errorProperty(error: unknown, property: string): unknown {
  return typeof error === 'object' && error !== null && property in error
    ? error[property as keyof typeof error]
    : null
}

function sanitizedStripeErrorMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : null

  if (!message) return null

  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b/g, '[secret]')
    .replace(/\bacct_[A-Za-z0-9]+\b/g, '[account]')
    .slice(0, 500)
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

      const stripeSecret = requiredEnvironment('STRIPE_SECRET')
      const stripe = new Stripe(stripeSecret, {
        maxNetworkRetries: 2,
        timeout: 10_000,
      })
      let stripeAccountId = prepared.stripe_account_id
      let stage: StripeOnboardingStage = stripeAccountId
        ? 'account_retrieve'
        : 'account_create'

      try {
        if (!stripeAccountId) {
          const idempotencyKey = await credentialScopedIdempotencyKey(
            'payout-account-v3-accounts-v2',
            stripeSecret,
            prepared.payout_account_id,
          )

          stripeAccountId = await createStripeRecipientAccount(
            stripe,
            {
              companyName: prepared.company_name,
              contactEmail: prepared.contact_email,
              idempotencyKey,
              organizationId: prepared.organization_id,
              subcontractorId: prepared.subcontractor_id,
            },
          )

          stage = 'account_attach'
          const { data: attached, error: attachError } = await context.supabaseAdmin
            .rpc('attach_subcontractor_stripe_account', {
              p_payout_account_id: prepared.payout_account_id,
              p_user_id: userId,
              p_stripe_account_id: stripeAccountId,
              p_dashboard_type: 'express',
            })

          if (attachError || attached !== true) {
            console.error('Unable to attach Stripe connected account:', attachError)
            return Response.json(
              { error: 'Unable to save the connected account. Please try again.' },
              { status: 500 },
            )
          }
        }

        stage = 'account_retrieve'
        const account = await stripe.v2.core.accounts.retrieve(stripeAccountId, {
          include: [
            'configuration.recipient',
            'future_requirements',
            'requirements',
          ],
        })
        stage = 'readiness_sync'
        const syncResult = await syncStripeV2AccountReadiness(
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

        stage = 'account_link'
        const accountLink = await stripe.v2.core.accountLinks.create({
          account: stripeAccountId,
          use_case: {
            type: 'account_onboarding',
            account_onboarding: {
              collection_options: {
                fields: 'eventually_due',
                future_requirements: 'include',
              },
              configurations: ['recipient'],
              refresh_url: applicationUrl(prepared.subcontractor_id, 'refresh'),
              return_url: applicationUrl(prepared.subcontractor_id, 'return'),
            },
          },
        })

        return Response.json({ url: accountLink.url })
      } catch (error) {
        console.error('Stripe Connect onboarding failed:', {
          code: errorProperty(error, 'code'),
          message: sanitizedStripeErrorMessage(error),
          param: errorProperty(error, 'param'),
          stage,
          status: errorProperty(error, 'statusCode') ?? errorProperty(error, 'status'),
          type: errorProperty(error, 'type') ??
            (error instanceof Error ? error.name : 'UnknownError'),
        })

        return Response.json(
          { error: 'Payout onboarding is temporarily unavailable. Please try again.' },
          { status: 502 },
        )
      }
    }),
  ),
}

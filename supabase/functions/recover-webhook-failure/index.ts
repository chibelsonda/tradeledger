import { withSupabase } from '@supabase/server'

import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'

interface RecoveryRequest {
  failureId?: unknown
}

type RecoveryKind =
  | 'connected_account'
  | 'dispute'
  | 'payment'
  | 'payment_payouts'
  | 'payout'
  | 'subcontractor_payouts'

interface PreparedRecovery {
  failure_id: number
  organization_id: string
  recovery_kind: RecoveryKind
  target_id: string
}

interface RecoveryRoute {
  functionName: string
  body: Record<string, unknown>
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)

  if (!value) throw new Error(`Missing required environment variable: ${name}`)

  return value
}

function isFailureId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function recoveryRoute(prepared: PreparedRecovery): RecoveryRoute {
  switch (prepared.recovery_kind) {
    case 'connected_account':
      return {
        functionName: 'refresh-connect-account',
        body: { subcontractorId: prepared.target_id },
      }
    case 'dispute':
      return {
        functionName: 'manage-dispute',
        body: { disputeId: prepared.target_id, action: 'sync' },
      }
    case 'payment':
      return {
        functionName: 'reconcile-payment',
        body: { paymentRequestId: prepared.target_id },
      }
    case 'payment_payouts':
      return {
        functionName: 'reconcile-payouts',
        body: {
          organizationId: prepared.organization_id,
          targetType: 'payment',
          targetId: prepared.target_id,
        },
      }
    case 'payout':
      return {
        functionName: 'reconcile-payouts',
        body: {
          organizationId: prepared.organization_id,
          targetType: 'payout',
          targetId: prepared.target_id,
        },
      }
    case 'subcontractor_payouts':
      return {
        functionName: 'reconcile-payouts',
        body: {
          organizationId: prepared.organization_id,
          targetType: 'subcontractor',
          targetId: prepared.target_id,
        },
      }
  }
}

export default {
  fetch: withObservability(
    'recover-webhook-failure',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: RecoveryRequest

      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isFailureId(body.failureId)) {
        return Response.json({ error: 'A valid webhook failure ID is required.' }, {
          status: 422,
        })
      }

      const userId = context.userClaims?.id
      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const authorization = request.headers.get('authorization')
      if (!authorization) {
        return Response.json({ error: 'Authentication is required.' }, { status: 401 })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'recover-webhook-failure',
        subject: `${userId}:${body.failureId}`,
        limit: 6,
        windowSeconds: 60,
      })
      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_webhook_failure_recovery',
        { p_failure_id: body.failureId, p_user_id: userId },
      )

      if (preparationError) {
        console.error('Unable to prepare webhook recovery:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'Unable to prepare webhook recovery. Please try again.',
        )
      }

      const prepared = data as PreparedRecovery | null
      if (!prepared) {
        return Response.json(
          { error: 'Unable to prepare webhook recovery. Please try again.' },
          { status: 500 },
        )
      }

      const route = recoveryRoute(prepared)
      let downstreamSucceeded = false
      let downstreamStatus = 502

      try {
        const response = await fetch(
          `${requiredEnvironment('SUPABASE_URL')}/functions/v1/${route.functionName}`,
          {
            method: 'POST',
            headers: {
              authorization,
              apikey: requiredEnvironment('SUPABASE_ANON_KEY'),
              'content-type': 'application/json',
            },
            body: JSON.stringify(route.body),
            signal: AbortSignal.timeout(25_000),
          },
        )

        downstreamSucceeded = response.ok
        downstreamStatus = response.status
      } catch (error) {
        console.error('Webhook recovery coordinator failed:', error)
      }

      const { error: completionError } = await context.supabaseAdmin.rpc(
        'complete_webhook_failure_recovery',
        {
          p_failure_id: prepared.failure_id,
          p_user_id: userId,
          p_succeeded: downstreamSucceeded,
          p_failure_code: downstreamSucceeded
            ? null
            : `${route.functionName}:${downstreamStatus}`,
        },
      )

      if (completionError) {
        console.error('Unable to complete webhook recovery:', completionError)
        return Response.json(
          { error: 'The recovery ran, but its result could not be recorded.' },
          { status: 500 },
        )
      }

      if (!downstreamSucceeded) {
        return Response.json(
          { error: 'The recovery service could not reconcile this event.' },
          { status: 502 },
        )
      }

      return Response.json({ status: 'resolved' })
    }),
  ),
}

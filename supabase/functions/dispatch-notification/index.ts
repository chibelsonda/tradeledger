import { withSupabase } from 'npm:@supabase/server@^1'

import { dispatchPaymentNotification } from '../_shared/notification-delivery.ts'

interface DispatchRequest {
  paymentRequestId?: unknown
  retryDeliveryId?: unknown
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
  fetch: withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }

    let body: DispatchRequest

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

    if (body.retryDeliveryId !== undefined && !isUuid(body.retryDeliveryId)) {
      return Response.json(
        { error: 'A valid notification delivery ID is required.' },
        { status: 422 },
      )
    }

    const userId = context.userClaims?.id

    if (typeof userId !== 'string' || userId.length === 0) {
      return Response.json({ error: 'Authenticated user is missing.' }, { status: 401 })
    }

    try {
      const result = await dispatchPaymentNotification(context.supabaseAdmin, {
        paymentRequestId: body.paymentRequestId,
        retryDeliveryId: body.retryDeliveryId,
        userId,
      })

      return Response.json(result)
    } catch (error) {
      const candidate = error as { code?: string; message?: string }
      console.error('Notification dispatch failed:', error)

      return Response.json(
        { error: candidate.message ?? 'The notification could not be dispatched.' },
        { status: errorStatus(candidate.code) },
      )
    }
  }),
}

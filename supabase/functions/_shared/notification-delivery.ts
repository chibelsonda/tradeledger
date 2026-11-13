import type { SupabaseClient } from '@supabase/supabase-js'

import { buildNotificationEmail } from './notification-email.ts'

interface NotificationClaim {
  delivery_id: string
  worker_token: string
  notification_type: 'payment_request_approved' | 'payment_succeeded'
  recipient_email: string
  recipient_name: string
  subject: string
  template_data: Record<string, unknown>
  idempotency_key: string
  attempt_count: number
  max_attempts: number
}

interface ResendResponsePayload {
  id?: unknown
  name?: unknown
  message?: unknown
}

export interface NotificationDispatchResult {
  status: 'idle' | 'sent' | 'retry_scheduled' | 'failed'
  deliveryId?: string
  providerMessageId?: string
  message?: string
}

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim()

  if (!value) {
    throw new DeliveryError(
      `${name} is not configured for transactional email delivery.`,
      'configuration_missing',
      false,
    )
  }

  return value
}

function retryableStatus(status: number, errorName: string): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    errorName === 'concurrent_idempotent_requests'
  )
}

async function sendWithResend(claim: NotificationClaim): Promise<string> {
  const apiKey = requiredEnvironment('RESEND_API_KEY')
  const from = requiredEnvironment('RESEND_FROM_EMAIL')
  const content = buildNotificationEmail(claim)
  let response: Response

  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': claim.idempotency_key,
      },
      body: JSON.stringify({
        from,
        to: [claim.recipient_email],
        subject: claim.subject,
        html: content.html,
        text: content.text,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new DeliveryError(
      'The email provider could not be reached.',
      'provider_unreachable',
      true,
    )
  }

  const payload = (await response.json().catch(() => ({}))) as ResendResponsePayload

  if (!response.ok) {
    const errorName = typeof payload.name === 'string' ? payload.name : 'provider_error'
    const message = typeof payload.message === 'string'
      ? payload.message
      : `Email provider returned HTTP ${response.status}.`

    throw new DeliveryError(
      message,
      errorName,
      retryableStatus(response.status, errorName),
    )
  }

  if (typeof payload.id !== 'string') {
    throw new DeliveryError(
      'The email provider returned an invalid success response.',
      'invalid_provider_response',
      true,
    )
  }

  return payload.id
}

function firstRow<T>(data: T | T[] | null): T | undefined {
  return Array.isArray(data) ? data[0] : data ?? undefined
}

export async function dispatchPaymentNotification(
  supabaseAdmin: SupabaseClient,
  options: {
    paymentRequestId: string
    userId?: string | null
    retryDeliveryId?: string
  },
): Promise<NotificationDispatchResult> {
  let paymentRequestId = options.paymentRequestId

  if (options.retryDeliveryId) {
    if (!options.userId) {
      throw new Error('An authenticated user is required to retry a notification.')
    }

    const { data, error } = await supabaseAdmin.rpc('retry_notification_delivery', {
      p_delivery_id: options.retryDeliveryId,
      p_user_id: options.userId,
    })

    if (error) throw error
    if (typeof data !== 'string') {
      throw new Error('The notification retry did not return a payment request.')
    }

    paymentRequestId = data
  }

  const { data, error: claimError } = await supabaseAdmin.rpc(
    'claim_notification_delivery',
    {
      p_payment_request_id: paymentRequestId,
      p_user_id: options.userId ?? null,
    },
  )

  if (claimError) throw claimError

  const claim = firstRow(data as NotificationClaim[] | null)

  if (!claim) return { status: 'idle' }

  try {
    const providerMessageId = await sendWithResend(claim)
    const { data: completed, error: completionError } = await supabaseAdmin.rpc(
      'complete_notification_delivery',
      {
        p_delivery_id: claim.delivery_id,
        p_worker_token: claim.worker_token,
        p_provider_message_id: providerMessageId,
      },
    )

    if (completionError || completed !== true) {
      throw completionError ?? new Error('The sent notification was not finalized.')
    }

    return {
      status: 'sent',
      deliveryId: claim.delivery_id,
      providerMessageId,
    }
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error

    const { data: status, error: failureError } = await supabaseAdmin.rpc(
      'fail_notification_delivery',
      {
        p_delivery_id: claim.delivery_id,
        p_worker_token: claim.worker_token,
        p_error_code: error.code,
        p_error_message: error.message,
        p_retryable: error.retryable,
      },
    )

    if (failureError) throw failureError

    return {
      status: status === 'retry_scheduled' ? 'retry_scheduled' : 'failed',
      deliveryId: claim.delivery_id,
      message: error.message,
    }
  }
}

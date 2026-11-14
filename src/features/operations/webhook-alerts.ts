import type { StripeWebhookFailure } from '@/lib/database.types'

export type WebhookAlertSeverity = 'critical' | 'warning' | 'notice'
export type WebhookAlertTab = 'open' | 'resolved'

export interface WebhookAlertFilters {
  tab: WebhookAlertTab
  severity: '' | WebhookAlertSeverity
  search: string
}

const recoverableEvent = /^(account\.updated|charge\.dispute\.|charge\.succeeded|checkout\.session\.|payout\.|refund\.|transfer\.)/

export function webhookAlertSeverity(
  failure: StripeWebhookFailure,
  now = Date.now(),
): WebhookAlertSeverity {
  const ageMs = Math.max(0, now - new Date(failure.last_failed_at).getTime())

  if (
    failure.recovery_status === 'failed' ||
    failure.attempts >= 5 ||
    ageMs >= 24 * 60 * 60 * 1000
  ) {
    return 'critical'
  }

  if (failure.attempts >= 2 || ageMs >= 60 * 60 * 1000) return 'warning'

  return 'notice'
}

export function canRecoverWebhookFailure(failure: StripeWebhookFailure): boolean {
  return (
    failure.organization_id !== null &&
    failure.object_id !== null &&
    failure.resolved_at === null &&
    recoverableEvent.test(failure.event_type)
  )
}

export function webhookRecoveryGuidance(eventType: string): string {
  if (eventType === 'account.updated') {
    return 'Refresh the connected account and re-evaluate payout readiness.'
  }
  if (eventType.startsWith('charge.dispute.')) {
    return 'Synchronize the dispute state and its financial impact from Stripe.'
  }
  if (
    eventType.startsWith('payout.') ||
    eventType.startsWith('transfer.') ||
    eventType === 'charge.succeeded'
  ) {
    return 'Reconcile transfer and payout evidence from Stripe into the ledger.'
  }
  if (eventType.startsWith('refund.')) {
    return 'Reconcile the payment and its refund history from Stripe.'
  }
  if (eventType.startsWith('checkout.session.')) {
    return 'Reconcile the Checkout Session and payment state from Stripe.'
  }

  return 'Review this event in Stripe before retrying it outside TradeLedger.'
}

export function filterWebhookAlerts(
  failures: readonly StripeWebhookFailure[],
  filters: WebhookAlertFilters,
  now = Date.now(),
): StripeWebhookFailure[] {
  const query = filters.search.trim().toLowerCase()

  return failures.filter((failure) => {
    const isResolved = failure.resolved_at !== null
    if (filters.tab === 'open' ? isResolved : !isResolved) return false
    if (
      filters.severity &&
      webhookAlertSeverity(failure, now) !== filters.severity
    ) return false

    return !query || [failure.event_type, failure.event_id, failure.error_code]
      .some((value) => value?.toLowerCase().includes(query))
  })
}

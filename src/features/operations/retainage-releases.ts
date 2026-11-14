import type {
  PaymentRequest,
  RetainageRelease,
  RetainageReleaseStatus,
} from '@/lib/database.types'

const committedStatuses = new Set<RetainageReleaseStatus>([
  'requested',
  'approved',
  'checkout_created',
  'processing',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
])

export function retainageReleaseStatusLabel(
  status: RetainageReleaseStatus,
): string {
  const labels: Record<RetainageReleaseStatus, string> = {
    requested: 'Approval requested',
    approved: 'Approved',
    checkout_created: 'Checkout ready',
    processing: 'Processing',
    paid: 'Paid',
    failed: 'Checkout failed',
    canceled: 'Canceled',
    partially_refunded: 'Partially refunded',
    refunded: 'Refunded',
  }

  return labels[status]
}

export function committedRetainageAmount(
  releases: readonly RetainageRelease[],
  paymentRequestId: string,
): number {
  return releases
    .filter(
      (release) =>
        release.payment_request_id === paymentRequestId &&
        committedStatuses.has(release.status),
    )
    .reduce(
      (total, release) => total + release.amount - release.amount_refunded,
      0,
    )
}

export function remainingRetainageAmount(
  request: Pick<PaymentRequest, 'id' | 'retainage_amount'>,
  releases: readonly RetainageRelease[],
): number {
  return Math.max(
    0,
    request.retainage_amount - committedRetainageAmount(releases, request.id),
  )
}

export function parseCurrencyInputToMinorUnits(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null

  const [whole, fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

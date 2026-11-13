import type {
  PaymentRequest,
  PaymentRequestStatus,
} from '@/lib/database.types'

export type ChartPaymentRequest = Pick<
  PaymentRequest,
  'created_at' | 'gross_amount' | 'net_amount' | 'status'
>

export interface MonthlyFinancialPoint {
  key: string
  month: string
  fullMonth: string
  gross: number
  net: number
}

export interface PaymentStatusPoint {
  key: string
  label: string
  count: number
  color: string
}

const paymentStatusGroups: Array<{
  key: string
  label: string
  color: string
  statuses: PaymentRequestStatus[]
}> = [
  {
    key: 'draft',
    label: 'Draft',
    color: '#8a9892',
    statuses: ['draft'],
  },
  {
    key: 'review',
    label: 'In review',
    color: '#d3a43b',
    statuses: ['submitted'],
  },
  {
    key: 'approved',
    label: 'Approved',
    color: '#5f8d7f',
    statuses: ['approved'],
  },
  {
    key: 'checkout',
    label: 'In checkout',
    color: '#3f7165',
    statuses: ['checkout_created', 'processing'],
  },
  {
    key: 'paid',
    label: 'Paid',
    color: '#153f34',
    statuses: ['paid'],
  },
  {
    key: 'refunded',
    label: 'Refunded',
    color: '#87a84e',
    statuses: ['partially_refunded', 'refunded'],
  },
  {
    key: 'exception',
    label: 'Needs attention',
    color: '#b65c4f',
    statuses: ['failed', 'canceled'],
  },
]

function monthKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`
}

export function buildMonthlyFinancialData(
  requests: readonly ChartPaymentRequest[],
  currentDate = new Date(),
  monthCount = 6,
): MonthlyFinancialPoint[] {
  const normalizedMonthCount = Math.max(1, Math.floor(monthCount))
  const anchor = new Date(
    Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), 1),
  )
  const points = Array.from({ length: normalizedMonthCount }, (_, index) => {
    const monthOffset = index - (normalizedMonthCount - 1)
    const date = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + monthOffset, 1),
    )

    return {
      key: monthKey(date),
      month: new Intl.DateTimeFormat(undefined, {
        month: 'short',
        timeZone: 'UTC',
      }).format(date),
      fullMonth: new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date),
      gross: 0,
      net: 0,
    }
  })
  const pointsByMonth = new Map(points.map((point) => [point.key, point]))

  for (const request of requests) {
    const createdAt = new Date(request.created_at)

    if (Number.isNaN(createdAt.getTime())) continue

    const point = pointsByMonth.get(monthKey(createdAt))

    if (!point) continue

    point.gross += request.gross_amount
    point.net += request.net_amount
  }

  return points
}

export function buildPaymentStatusData(
  requests: readonly ChartPaymentRequest[],
): PaymentStatusPoint[] {
  return paymentStatusGroups
    .map((group) => ({
      key: group.key,
      label: group.label,
      color: group.color,
      count: requests.filter((request) =>
        group.statuses.includes(request.status),
      ).length,
    }))
    .filter((group) => group.count > 0)
}

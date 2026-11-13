import { Button } from '@headlessui/react'

import type {
  NotificationDelivery,
  PaymentRequest,
} from '../lib/database.types'
import { formatStatus } from '../lib/format'

interface NotificationDeliveryPanelProps {
  deliveries: NotificationDelivery[]
  paymentRequests: PaymentRequest[]
  busyDeliveryId: string | null
  onRetry: (delivery: NotificationDelivery) => void
}

function shortDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function statusClassName(status: NotificationDelivery['status']): string {
  switch (status) {
    case 'sent':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800'
    case 'pending':
    case 'processing':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    case 'retry_scheduled':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-800'
  }
}

export function NotificationDeliveryPanel({
  deliveries,
  paymentRequests,
  busyDeliveryId,
  onRetry,
}: NotificationDeliveryPanelProps) {
  const attentionCount = deliveries.filter((delivery) =>
    ['failed', 'retry_scheduled'].includes(delivery.status),
  ).length
  const requestDescriptions = new Map(
    paymentRequests.map((request) => [request.id, request.description]),
  )

  return (
    <section className="border border-ink/10 bg-white p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)]">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
            Transactional messaging
          </p>
          <h2 className="mt-1 text-lg font-black text-ink">Email delivery log</h2>
        </div>
        <span
          className={
            'border px-3 py-1.5 text-xs font-black ' +
            (attentionCount > 0
              ? 'border-amber-300 bg-amber-50 text-amber-900'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800')
          }
        >
          {attentionCount > 0 ? `${attentionCount} need attention` : 'No failures'}
        </span>
      </div>

      {deliveries.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-ink/55">
          Approval and payment emails will appear here with their delivery status.
        </p>
      ) : (
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {deliveries.map((delivery) => {
            const canRetry = ['failed', 'retry_scheduled'].includes(delivery.status)
            const isBusy = busyDeliveryId === delivery.id

            return (
              <article key={delivery.id} className="border border-ink/10 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">
                      {formatStatus(delivery.notification_type)}
                    </p>
                    <p className="mt-1 truncate text-xs text-ink/45">
                      {requestDescriptions.get(delivery.payment_request_id) ??
                        'Payment request'}
                    </p>
                  </div>
                  <span
                    className={
                      'shrink-0 border px-2 py-1 text-[10px] font-bold ' +
                      statusClassName(delivery.status)
                    }
                  >
                    {formatStatus(delivery.status)}
                  </span>
                </div>

                <dl className="mt-4 grid gap-2 text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink/40">Recipient</dt>
                    <dd className="truncate font-semibold text-ink">
                      {delivery.recipient_email ?? 'Email missing'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink/40">Attempts</dt>
                    <dd className="font-semibold text-ink">
                      {delivery.attempt_count} / {delivery.max_attempts}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink/40">Updated</dt>
                    <dd className="font-semibold text-ink">
                      {shortDateTime(delivery.updated_at)}
                    </dd>
                  </div>
                </dl>

                {delivery.error_message && (
                  <p className="mt-3 border-l-2 border-red-300 pl-3 text-xs leading-5 text-red-800">
                    {delivery.error_message}
                  </p>
                )}

                {canRetry && (
                  <Button
                    type="button"
                    disabled={busyDeliveryId !== null}
                    aria-busy={isBusy}
                    onClick={() => onRetry(delivery)}
                    className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 border border-ink/15 px-3 text-xs font-bold text-ink transition hover:border-forest hover:bg-cream disabled:cursor-wait disabled:opacity-50"
                  >
                    {isBusy && (
                      <span className="size-3 animate-spin rounded-full border-2 border-forest/25 border-t-forest" />
                    )}
                    {isBusy ? 'Retrying…' : 'Retry delivery now'}
                  </Button>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

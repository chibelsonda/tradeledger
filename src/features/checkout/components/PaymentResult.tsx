import { useCallback, useEffect, useState } from 'react'

import type { Payment } from '../../../lib/database.types'
import { formatCurrency, formatStatus } from '../../../lib/format'
import { supabase } from '../../../lib/supabase'

interface PaymentResultProps {
  sessionId: string
}

const finalStatuses = new Set([
  'paid',
  'failed',
  'expired',
  'partially_refunded',
  'refunded',
])

export function PaymentResult({ sessionId }: PaymentResultProps) {
  const [payment, setPayment] = useState<Payment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadPayment = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from('payments')
      .select('*')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle()

    if (queryError) {
      setError('We could not load this payment. Please refresh and try again.')
      setIsLoading(false)
      return null
    }

    const currentPayment = data as Payment | null

    if (!currentPayment) {
      setError('This payment was not found for the signed-in account.')
      setIsLoading(false)
      return null
    }

    setPayment(currentPayment)
    setError(null)
    setIsLoading(false)

    return currentPayment
  }, [sessionId])

  useEffect(() => {
    let isActive = true
    let timer: number | undefined
    let attempts = 0

    async function poll() {
      const result = await loadPayment()
      attempts += 1

      if (
        isActive &&
        result &&
        !finalStatuses.has(result.status) &&
        attempts < 8
      ) {
        timer = window.setTimeout(() => void poll(), 2000)
      }
    }

    void poll()

    return () => {
      isActive = false
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [loadPayment])

  if (isLoading) {
    return (
      <ResultShell>
        <div className="flex flex-col items-center gap-5 text-center">
          <span className="grid size-20 place-items-center rounded-full bg-forest/5 text-forest">
            <svg viewBox="0 0 24 24" className="size-10 animate-spin" aria-hidden="true">
              <path
                d="M12 3a9 9 0 1 0 9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-forest">
            Loading payment
          </p>
        </div>
      </ResultShell>
    )
  }

  if (error || !payment) {
    return (
      <ResultShell>
        <ResultIcon tone="warning" />
        <ResultContent
          eyebrow="Payment unavailable"
          title="We could not show this order."
          description={error ?? 'Please return to checkout and try again.'}
        />
      </ResultShell>
    )
  }

  const isPaid = payment.status === 'paid'
  const isRefunded = payment.status === 'refunded'
  const isPartiallyRefunded = payment.status === 'partially_refunded'
  const isProcessing =
    payment.status === 'pending' || payment.status === 'processing'
  const isConfirmed = isPaid || isRefunded || isPartiallyRefunded

  return (
    <section className="mx-auto flex min-h-[68vh] w-full max-w-4xl items-center justify-center px-6 py-12 lg:px-8">
      <div className="w-full overflow-hidden border border-ink/10 bg-white shadow-[0_24px_64px_rgba(19,37,31,0.12)]">
        <div className="grid lg:grid-cols-[0.8fr_1.2fr]">
          <div className="relative grid min-h-72 place-items-center overflow-hidden bg-forest p-10 text-white">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,_rgba(217,249,157,0.18),_transparent_42%)]" />
            <div className="relative flex flex-col items-center gap-5 text-center">
              <ResultIcon
                tone={isConfirmed ? 'success' : isProcessing ? 'loading' : 'warning'}
              />
              <p
                className={
                  'text-sm font-bold uppercase tracking-[0.2em] ' +
                  (isConfirmed || isProcessing ? 'text-mint' : 'text-amber-200')
                }
              >
                {isRefunded
                  ? 'Payment refunded'
                  : isPartiallyRefunded
                    ? 'Partial refund issued'
                    : isPaid
                  ? 'Payment confirmed'
                  : isProcessing
                    ? 'Confirmation pending'
                    : 'Payment incomplete'}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-8 p-8 sm:p-12">
            <ResultContent
              eyebrow={'Order ' + payment.reference.slice(0, 8).toUpperCase()}
              title={
                isRefunded
                  ? 'Your refund is complete.'
                  : isPartiallyRefunded
                    ? 'Your payment was partially refunded.'
                    : isPaid
                  ? "You're all set."
                  : isProcessing
                    ? "We're confirming your payment."
                    : "This payment wasn't completed."
              }
              description={
                isRefunded
                  ? 'The refund is complete and the payment ledger has been updated.'
                  : isPartiallyRefunded
                    ? 'Part of this payment was returned. The refunded amount is shown below.'
                    : isPaid
                  ? 'Thanks for your purchase. Your payment was confirmed and your order is ready.'
                  : isProcessing
                    ? 'The payment is being finalized. This page refreshes the status recorded by the signed payment event.'
                    : 'No successful charge was recorded. You can safely return and try checkout again.'
              }
            />

            <dl className="divide-y divide-ink/10 border border-ink/10 bg-cream/50 px-5">
              <div className="flex items-center justify-between gap-4 py-4 text-sm">
                <dt className="text-ink/80">Item</dt>
                <dd className="font-bold text-ink">
                  {payment.product_name} × {payment.quantity}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-4 text-sm">
                <dt className="text-ink/80">Status</dt>
                <dd
                  className={
                    'px-2.5 py-1 text-xs font-bold ' +
                    (isConfirmed
                      ? 'bg-lime-100 text-lime-800'
                      : isProcessing
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-red-100 text-red-800')
                  }
                >
                  {formatStatus(payment.status)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-4 text-sm">
                <dt className="text-ink/80">Total</dt>
                <dd className="text-lg font-extrabold text-ink">
                  {formatCurrency(payment.amount_total, payment.currency)}
                </dd>
              </div>
              {payment.amount_refunded > 0 && (
                <div className="flex items-center justify-between gap-4 py-4 text-sm">
                  <dt className="text-ink/80">Refunded</dt>
                  <dd className="text-lg font-extrabold text-blue-700">
                    {formatCurrency(payment.amount_refunded, payment.currency)}
                  </dd>
                </div>
              )}
            </dl>

            <a
              href="/"
              className="inline-flex h-10 items-center justify-center bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
            >
              Back to home
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

function ResultShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto flex min-h-[68vh] w-full max-w-2xl items-center justify-center px-6 py-12 lg:px-8">
      <div className="flex w-full flex-col items-center gap-7 border border-ink/10 bg-white p-8 text-center text-ink shadow-[0_24px_64px_rgba(19,37,31,0.12)] sm:p-12">
        {children}
        <a
          href="/"
          className="inline-flex h-10 items-center justify-center bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest"
        >
          Return home
        </a>
      </div>
    </section>
  )
}

function ResultIcon({
  tone,
}: {
  tone: 'success' | 'loading' | 'warning'
}) {
  const sharedClass =
    'grid size-24 place-items-center rounded-full border shadow-[0_0_0_12px_rgba(19,63,52,0.035)]'

  if (tone === 'success') {
    return (
      <span className={sharedClass + ' border-mint/30 bg-mint/10 text-mint'}>
        <svg viewBox="0 0 24 24" className="size-12" fill="none" aria-hidden="true">
          <path
            d="m5 12.5 4.25 4.25L19.5 6.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }

  if (tone === 'loading') {
    return (
      <span className={sharedClass + ' border-mint/30 bg-mint/10 text-mint'}>
        <svg viewBox="0 0 24 24" className="size-11 animate-spin" fill="none" aria-hidden="true">
          <path
            d="M12 3a9 9 0 1 0 9 9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }

  return (
    <span className={sharedClass + ' border-amber-200 bg-amber-50 text-amber-700'}>
      <svg viewBox="0 0 24 24" className="size-11" fill="none" aria-hidden="true">
        <path
          d="M12 8v5m0 3.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

function ResultContent({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-forest/80">
        {eyebrow}
      </p>
      <h1 className="text-3xl font-extrabold tracking-[-0.035em] text-ink sm:text-4xl">
        {title}
      </h1>
      <p className="mx-auto max-w-lg text-sm leading-6 font-medium text-ink/85">
        {description}
      </p>
    </div>
  )
}

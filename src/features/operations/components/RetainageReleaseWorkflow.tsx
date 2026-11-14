import { Button, Field, Input, Label, Textarea } from '@headlessui/react'
import { useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import {
  parseCurrencyInputToMinorUnits,
  remainingRetainageAmount,
  retainageReleaseStatusLabel,
} from '@/features/operations/retainage-releases'
import type {
  OrganizationRole,
  PaymentRequest,
  Project,
  RetainageRelease,
  Subcontractor,
} from '@/lib/database.types'
import { formatCurrency } from '@/lib/format'
import { trustedStripeCheckoutUrl } from '@/lib/navigation-security'
import { supabase } from '@/lib/supabase'

interface RetainageReleaseWorkflowProps {
  role: OrganizationRole
  releases: RetainageRelease[]
  paymentRequests: PaymentRequest[]
  projects: Project[]
  subcontractors: Subcontractor[]
  isLoading: boolean
  onRefresh: () => Promise<void>
}

const inputClassName =
  'h-10 w-full border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/55 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:border-red-600'

function statusClassName(status: RetainageRelease['status']): string {
  if (status === 'paid') return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  if (status === 'approved' || status === 'checkout_created') {
    return 'border-blue-200 bg-blue-50 text-blue-800'
  }
  if (status === 'requested' || status === 'processing') {
    return 'border-amber-200 bg-amber-50 text-amber-800'
  }
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-800'
  return 'border-slate-300 bg-slate-100 text-slate-700'
}

function displayDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  )
}

async function edgeErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  const candidate = error as { context?: unknown } | null
  if (candidate?.context instanceof Response) {
    const payload = (await candidate.context.json().catch(() => null)) as
      | { error?: unknown }
      | null
    if (typeof payload?.error === 'string') return payload.error
  }
  return fallback
}

export function RetainageReleaseWorkflow({
  role,
  releases,
  paymentRequests,
  projects,
  subcontractors,
  isLoading,
  onRefresh,
}: RetainageReleaseWorkflowProps) {
  const [paymentRequestId, setPaymentRequestId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [refundConfirmationId, setRefundConfirmationId] = useState<string | null>(
    null,
  )
  const [notice, setNotice] = useState<string | null>(() => {
    const state = new URLSearchParams(window.location.search).get('retainage')
    if (state === 'success') return 'Retainage checkout completed. Stripe confirmation is synchronizing.'
    if (state === 'canceled') return 'Retainage checkout was canceled. No charge was made.'
    return null
  })
  const [error, setError] = useState<string | null>(null)

  const canApprove = role === 'owner' || role === 'accountant'
  const canRefund = canApprove
  const eligibleRequests = useMemo(
    () =>
      paymentRequests.filter(
        (request) =>
          request.status === 'paid' &&
          request.retainage_amount > 0 &&
          remainingRetainageAmount(request, releases) > 0,
      ),
    [paymentRequests, releases],
  )
  const requestById = useMemo(
    () => new Map(paymentRequests.map((request) => [request.id, request])),
    [paymentRequests],
  )
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  )
  const subcontractorById = useMemo(
    () => new Map(subcontractors.map((item) => [item.id, item])),
    [subcontractors],
  )
  const selectedRequest = requestById.get(paymentRequestId)
  const selectedRemaining = selectedRequest
    ? remainingRetainageAmount(selectedRequest, releases)
    : 0
  const totalHeld = paymentRequests.reduce(
    (total, request) => total + request.retainage_amount,
    0,
  )
  const totalReleased = releases
    .filter((release) => ['paid', 'partially_refunded'].includes(release.status))
    .reduce((total, release) => total + release.amount - release.amount_refunded, 0)
  const totalPending = releases
    .filter((release) =>
      ['requested', 'approved', 'checkout_created', 'processing', 'failed'].includes(
        release.status,
      ),
    )
    .reduce((total, release) => total + release.amount, 0)
  const totalRemaining = Math.max(0, totalHeld - totalReleased - totalPending)

  const clearMessages = () => {
    setNotice(null)
    setError(null)
  }

  const createRelease = async () => {
    clearMessages()
    const minorAmount = parseCurrencyInputToMinorUnits(amount)
    if (!paymentRequestId || !minorAmount) {
      setError('Choose a settled request and enter a valid release amount.')
      return
    }
    if (minorAmount > selectedRemaining) {
      setError('Release amount exceeds the remaining retainage balance.')
      return
    }
    if (reason.trim().length < 3) {
      setError('Enter a release reason of at least 3 characters.')
      return
    }

    setIsCreating(true)
    const { error: createError } = await supabase.rpc('create_retainage_release', {
      p_payment_request_id: paymentRequestId,
      p_amount: minorAmount,
      p_reason: reason.trim(),
    })
    setIsCreating(false)

    if (createError) {
      setError('The retainage release could not be requested. Refresh and try again.')
      return
    }

    setAmount('')
    setReason('')
    setNotice('Retainage release submitted for approval.')
    await onRefresh()
  }

  const runRpcAction = async (
    releaseId: string,
    action: 'approve_retainage_release' | 'cancel_retainage_release',
  ) => {
    clearMessages()
    setBusyId(releaseId)
    const { data, error: actionError } = await supabase.rpc(action, {
      p_retainage_release_id: releaseId,
    })
    setBusyId(null)

    if (actionError || data !== true) {
      setError('The retainage release could not be updated. Refresh and try again.')
      return
    }

    setNotice(
      action === 'approve_retainage_release'
        ? 'Retainage release approved and ready for secure checkout.'
        : 'Retainage release canceled and its balance restored.',
    )
    await onRefresh()
  }

  const startCheckout = async (releaseId: string) => {
    clearMessages()
    setBusyId(releaseId)
    const { data, error: checkoutError } = await supabase.functions.invoke(
      'create-retainage-checkout',
      { body: { retainageReleaseId: releaseId } },
    )

    if (checkoutError) {
      setError(
        await edgeErrorMessage(
          checkoutError,
          'Unable to start retainage checkout. Please try again.',
        ),
      )
      setBusyId(null)
      return
    }

    const checkoutUrl = trustedStripeCheckoutUrl(data?.url)
    if (!checkoutUrl) {
      setError('Stripe did not return a valid checkout URL.')
      setBusyId(null)
      return
    }

    window.location.assign(checkoutUrl)
  }

  const refundRelease = async (releaseId: string) => {
    clearMessages()
    setBusyId(releaseId)
    const { error: refundError } = await supabase.functions.invoke(
      'create-retainage-refund',
      { body: { retainageReleaseId: releaseId } },
    )
    setBusyId(null)
    setRefundConfirmationId(null)

    if (refundError) {
      setError(
        await edgeErrorMessage(
          refundError,
          'Unable to refund the retainage release. Please try again.',
        ),
      )
      return
    }

    setNotice('Retainage refund submitted. Transfer reversal is synchronizing.')
    await onRefresh()
  }

  return (
    <div className="flex flex-col gap-6">
      {notice && <NotificationBanner tone="success">{notice}</NotificationBanner>}
      {error && <NotificationBanner tone="error">{error}</NotificationBanner>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Retainage summary">
        {[
          ['Original retainage', totalHeld, 'Across loaded payment requests'],
          ['Awaiting settlement', totalPending, 'Requested through processing'],
          ['Released', totalReleased, 'Paid less successful refunds'],
          ['Available', totalRemaining, 'Uncommitted retainage balance'],
        ].map(([label, value, detail]) => (
          <article key={String(label)} className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">{label}</p>
            <p className="mt-3 text-lg font-extrabold tracking-[-0.025em] text-ink">
              {formatCurrency(Number(value), 'usd')}
            </p>
            <p className="mt-2 text-[11px] font-medium text-ink/65">{detail}</p>
          </article>
        ))}
      </section>

      <section className="border border-ink/10 bg-white p-5 shadow-[0_18px_42px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-forest">Controlled release</p>
          <h2 className="text-lg font-extrabold tracking-[-0.025em] text-ink">Request retained funds</h2>
          <p className="text-sm font-medium text-ink/65">Only settled requests with an available retained balance can be selected.</p>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1.3fr_0.7fr_1.5fr_auto] lg:items-end">
          <Field className="flex flex-col gap-2">
            <Label className="text-xs font-bold text-ink">Payment request</Label>
            <SelectControl
              ariaLabel="Payment request"
              className={inputClassName}
              value={paymentRequestId}
              onChange={setPaymentRequestId}
              options={[
                { value: '', label: 'Select a settled request' },
                ...eligibleRequests.map((request) => ({
                  value: request.id,
                  label: `${request.description} · ${formatCurrency(
                    remainingRetainageAmount(request, releases),
                    request.currency,
                  )} available`,
                })),
              ]}
            />
          </Field>

          <Field className="flex flex-col gap-2">
            <Label className="text-xs font-bold text-ink">Release amount</Label>
            <Input
              className={inputClassName}
              aria-label="Release amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>

          <Field className="flex flex-col gap-2">
            <Label className="text-xs font-bold text-ink">Release reason</Label>
            <Textarea
              className={`${inputClassName} min-h-10 resize-y py-2`}
              aria-label="Release reason"
              placeholder="Completed scope and acceptance evidence"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <Button
            type="button"
            disabled={isCreating || eligibleRequests.length === 0}
            onClick={() => void createRelease()}
            className="inline-flex h-10 items-center justify-center gap-2 bg-forest px-4 text-sm font-bold text-white transition hover:bg-forest/90 focus:outline-none focus:ring-2 focus:ring-forest/30 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {isCreating && <ButtonSpinner />}
            Request release
          </Button>
        </div>
      </section>

      <section className="overflow-hidden border border-ink/10 bg-white shadow-[0_18px_42px_rgba(19,37,31,0.055)]">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="text-lg font-extrabold tracking-[-0.025em] text-ink">Release ledger</h2>
          <p className="mt-1 text-sm font-medium text-ink/65">Approval, Checkout, fee, payment, and refund state remain independently auditable.</p>
        </div>

        {isLoading ? (
          <div className="p-8 text-sm font-semibold text-ink/65">Loading retainage releases…</div>
        ) : releases.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-bold text-ink">No retainage releases yet</p>
            <p className="mt-1 text-sm font-medium text-ink/60">Request a release after its source payment has settled.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink/10 text-left text-sm">
              <thead className="bg-cream/70 text-[10px] font-bold uppercase tracking-[0.13em] text-ink/65">
                <tr>
                  <th className="px-5 py-3">Request</th>
                  <th className="px-5 py-3">Subcontractor</th>
                  <th className="px-5 py-3">Amount</th>
                  <th className="px-5 py-3">Fee</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Requested</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/8">
                {releases.map((release) => {
                  const request = requestById.get(release.payment_request_id)
                  const project = projectById.get(release.project_id)
                  const subcontractor = subcontractorById.get(release.subcontractor_id)
                  const isBusy = busyId === release.id
                  const isConfirmingRefund = refundConfirmationId === release.id

                  return (
                    <tr key={release.id} className="align-top">
                      <td className="px-5 py-4">
                        <p className="font-bold text-ink">{request?.description ?? 'Payment request'}</p>
                        <p className="mt-1 text-xs font-medium text-ink/60">{project?.name ?? 'Unknown project'} · {release.reason}</p>
                      </td>
                      <td className="px-5 py-4 font-semibold text-ink">{subcontractor?.company_name ?? 'Unknown subcontractor'}</td>
                      <td className="px-5 py-4">
                        <p className="font-bold text-ink">{formatCurrency(release.amount, release.currency)}</p>
                        {release.amount_refunded > 0 && <p className="mt-1 text-xs font-semibold text-red-700">{formatCurrency(release.amount_refunded, release.currency)} refunded</p>}
                      </td>
                      <td className="px-5 py-4 font-semibold text-ink">{formatCurrency(release.platform_fee_amount, release.currency)}</td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${statusClassName(release.status)}`}>
                          {retainageReleaseStatusLabel(release.status)}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-xs font-semibold text-ink/65">{displayDate(release.requested_at)}</td>
                      <td className="px-5 py-4">
                        <div className="flex min-w-44 flex-wrap justify-end gap-2">
                          {release.status === 'requested' && canApprove && (
                            <Button type="button" disabled={isBusy} onClick={() => void runRpcAction(release.id, 'approve_retainage_release')} className="border border-forest bg-white px-3 py-2 text-xs font-bold text-forest hover:bg-lime/20 disabled:opacity-50">Approve</Button>
                          )}
                          {['approved', 'failed', 'checkout_created'].includes(release.status) && (
                            <Button type="button" disabled={isBusy} onClick={() => void startCheckout(release.id)} className="bg-forest px-3 py-2 text-xs font-bold text-white hover:bg-forest/90 disabled:opacity-50">
                              {isBusy ? 'Opening…' : release.status === 'checkout_created' ? 'Resume checkout' : 'Pay securely'}
                            </Button>
                          )}
                          {['requested', 'approved', 'failed'].includes(release.status) && (
                            <Button type="button" disabled={isBusy} onClick={() => void runRpcAction(release.id, 'cancel_retainage_release')} className="border border-ink/20 bg-white px-3 py-2 text-xs font-bold text-ink hover:bg-cream disabled:opacity-50">Cancel</Button>
                          )}
                          {['paid', 'partially_refunded'].includes(release.status) && canRefund && !isConfirmingRefund && (
                            <Button type="button" disabled={isBusy} onClick={() => setRefundConfirmationId(release.id)} className="border border-red-300 bg-white px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50">Refund release</Button>
                          )}
                          {isConfirmingRefund && (
                            <>
                              <Button type="button" disabled={isBusy} onClick={() => void refundRelease(release.id)} className="bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800 disabled:opacity-50">Confirm refund</Button>
                              <Button type="button" disabled={isBusy} onClick={() => setRefundConfirmationId(null)} className="border border-ink/20 bg-white px-3 py-2 text-xs font-bold text-ink">Keep release</Button>
                            </>
                          )}
                          {isBusy && <span className="inline-flex items-center"><ButtonSpinner /></span>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

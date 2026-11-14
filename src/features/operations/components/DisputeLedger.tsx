import { Button, Field, Input, Label, Textarea } from '@headlessui/react'
import { useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import { SidePanel, SidePanelCloseButton } from '@/components/ui/SidePanel'
import {
  disputeDeadlineState,
  disputeIsLost,
  disputeNeedsResponse,
  disputeStatusLabel,
  disputeStatusLabels,
  filterDisputes,
} from '@/features/operations/dispute-ledger'
import type {
  OrganizationRole,
  PaymentDispute,
  PaymentRequest,
  Project,
  Subcontractor,
} from '@/lib/database.types'
import { formatCurrency, formatStatus } from '@/lib/format'
import { supabase } from '@/lib/supabase'

interface DisputeLedgerProps {
  role: OrganizationRole
  disputes: PaymentDispute[]
  paymentRequests: PaymentRequest[]
  projects: Project[]
  subcontractors: Subcontractor[]
  isLoading: boolean
  onRefresh: () => Promise<void>
}

type SensitiveAction = 'submit_evidence' | 'accept' | 'recover'

interface DisputeView extends PaymentDispute {
  projectName: string
  subcontractorName: string
  requestDescription: string
  searchText: string
}

const fieldClassName =
  'w-full border border-ink/15 bg-white px-3 text-sm font-medium text-ink outline-none transition placeholder:text-ink/50 focus:border-forest focus:ring-2 focus:ring-forest/10 disabled:bg-cream disabled:text-ink/55'

function displayDate(value: string | null): string {
  if (!value) return 'Not available'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusClassName(status: string): string {
  if (['won', 'appeal_won', 'prevented'].includes(status)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  if (disputeNeedsResponse(status)) {
    return 'border-red-200 bg-red-50 text-red-800'
  }
  if (['lost', 'appeal_lost'].includes(status)) {
    return 'border-slate-300 bg-slate-100 text-slate-800'
  }
  return 'border-amber-200 bg-amber-50 text-amber-800'
}

function CurrencyTotals({
  records,
}: {
  records: readonly { amount: number; currency: string }[]
}) {
  const totals = new Map<string, number>()
  for (const record of records) {
    totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.amount)
  }
  if (totals.size === 0) return <>{formatCurrency(0, 'usd')}</>
  return (
    <>
      {[...totals.entries()].map(([currency, amount]) => (
        <span key={currency} className="block">
          {formatCurrency(amount, currency)}
        </span>
      ))}
    </>
  )
}

async function edgeErrorMessage(error: unknown): Promise<string> {
  const candidate = error as { context?: unknown } | null
  if (candidate?.context instanceof Response) {
    const payload = (await candidate.context.json().catch(() => null)) as
      | { error?: unknown }
      | null
    if (typeof payload?.error === 'string') return payload.error
  }
  return 'The dispute action could not be confirmed. Refresh and try again.'
}

export function DisputeLedger({
  role,
  disputes,
  paymentRequests,
  projects,
  subcontractors,
  isLoading,
  onRefresh,
}: DisputeLedgerProps) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<SensitiveAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [productDescription, setProductDescription] = useState('')
  const [serviceDate, setServiceDate] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [uncategorizedText, setUncategorizedText] = useState('')

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
  const disputeViews = useMemo<DisputeView[]>(
    () =>
      disputes.map((dispute) => {
        const request = requestById.get(dispute.payment_request_id)
        const project = request ? projectById.get(request.project_id) : undefined
        const subcontractor = request
          ? subcontractorById.get(request.subcontractor_id)
          : undefined
        const projectName = project?.name ?? 'Unknown project'
        const subcontractorName =
          subcontractor?.company_name ?? 'Unknown subcontractor'
        const requestDescription = request?.description ?? 'Payment request'
        return {
          ...dispute,
          projectName,
          subcontractorName,
          requestDescription,
          searchText: [
            projectName,
            project?.code,
            subcontractorName,
            requestDescription,
            dispute.reason,
          ]
            .filter(Boolean)
            .join(' '),
        }
      }),
    [disputes, projectById, requestById, subcontractorById],
  )
  const filtered = useMemo(
    () => filterDisputes(disputeViews, search, status),
    [disputeViews, search, status],
  )
  const selected = disputeViews.find((dispute) => dispute.id === selectedId) ?? null
  const openDisputes = disputeViews.filter(
    (dispute) => !['won', 'lost', 'prevented', 'warning_closed', 'appeal_won', 'appeal_lost'].includes(dispute.status),
  )
  const responseRequired = disputeViews.filter((dispute) =>
    disputeNeedsResponse(dispute.status),
  )
  const lostDisputes = disputeViews.filter((dispute) =>
    disputeIsLost(dispute.status),
  )
  const recovered = disputeViews
    .filter((dispute) => dispute.recovery_status === 'reversed')
    .map((dispute) => ({ amount: dispute.recovery_amount, currency: dispute.currency }))
  const canManage = ['owner', 'admin', 'accountant'].includes(role)

  function selectDispute(dispute: DisputeView) {
    setSelectedId(dispute.id)
    setProductDescription(dispute.evidence_product_description ?? '')
    setServiceDate(dispute.evidence_service_date ?? '')
    setCustomerEmail(dispute.evidence_customer_email ?? '')
    setUncategorizedText(dispute.evidence_uncategorized_text ?? '')
    setConfirmAction(null)
  }

  async function runAction(
    action: 'sync' | 'save_evidence' | SensitiveAction,
    confirmed = false,
  ) {
    if (!selected) return
    setBusyAction(action)
    setError(null)
    setNotice(null)

    const { error: actionError } = await supabase.functions.invoke(
      'manage-dispute',
      {
        body: {
          disputeId: selected.id,
          action,
          confirm: confirmed,
          evidence: {
            productDescription,
            serviceDate,
            customerEmail,
            uncategorizedText,
          },
        },
      },
    )

    if (actionError) {
      setError(await edgeErrorMessage(actionError))
      setBusyAction(null)
      return
    }

    setConfirmAction(null)
    setNotice(
      action === 'sync'
        ? 'Dispute refreshed from Stripe.'
        : action === 'save_evidence'
        ? 'Evidence draft saved to Stripe.'
        : action === 'submit_evidence'
        ? 'Evidence submitted to Stripe.'
        : action === 'accept'
        ? 'Dispute accepted. Stripe will close it as lost.'
        : 'Connected transfer funds recovered.',
    )
    await onRefresh()
    setBusyAction(null)
  }

  if (!canManage) return null

  return (
    <section className="space-y-5" aria-labelledby="disputes-title">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Open exposure', records: openDisputes, detail: `${openDisputes.length} active cases` },
          { label: 'Response required', records: responseRequired, detail: `${responseRequired.length} awaiting evidence` },
          { label: 'Lost exposure', records: lostDisputes, detail: `${lostDisputes.length} closed against you` },
          { label: 'Transfer recovery', records: recovered, detail: `${recovered.length} completed reversals` },
        ].map((metric) => (
          <article key={metric.label} className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">{metric.label}</p>
            <div className="mt-3 text-lg font-extrabold tracking-[-0.025em] text-ink">
              <CurrencyTotals records={metric.records} />
            </div>
            <p className="mt-2 text-[11px] font-medium text-ink/65">{metric.detail}</p>
          </article>
        ))}
      </div>

      {notice && <NotificationBanner tone="success">{notice}</NotificationBanner>}
      {error && <NotificationBanner tone="error">{error}</NotificationBanner>}

      <div className="border border-ink/10 bg-white shadow-[0_18px_44px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col gap-4 border-b border-ink/10 p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-terracotta">Chargeback control</p>
            <h2 id="disputes-title" className="mt-2 text-xl font-extrabold tracking-[-0.03em] text-ink">Dispute ledger</h2>
            <p className="mt-1 text-sm font-medium text-ink/65">Evidence deadlines, outcomes, and connected-transfer recovery.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <Label className="sr-only">Search disputes</Label>
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search project or subcontractor" className={`${fieldClassName} h-10 min-w-64`} />
            </Field>
            <Field>
              <Label className="sr-only">Filter dispute status</Label>
              <SelectControl
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All statuses' },
                  ...Object.entries(disputeStatusLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
                ariaLabel="Filter dispute status"
                className="h-10 min-w-48 border border-ink/15 bg-white px-3 text-sm font-semibold text-ink outline-none focus:border-forest"
              />
            </Field>
          </div>
        </div>

        {isLoading ? (
          <div className="p-10 text-center text-sm font-semibold text-ink/60">Loading disputes…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-bold text-ink">No disputes found</p>
            <p className="mt-1 text-xs font-medium text-ink/60">New Stripe disputes will appear here automatically.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.13em] text-ink/60">
                <tr><th className="px-5 py-3">Project / subcontractor</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Evidence due</th><th className="px-5 py-3 text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-ink/8">
                {filtered.map((dispute) => {
                  const deadline = disputeDeadlineState(dispute.evidence_due_at)
                  return (
                    <tr key={dispute.id} className="hover:bg-cream/55">
                      <td className="px-5 py-4"><p className="font-bold text-ink">{dispute.projectName}</p><p className="mt-0.5 text-xs font-medium text-ink/60">{dispute.subcontractorName} · {dispute.requestDescription}</p></td>
                      <td className="px-5 py-4 font-bold text-ink">{formatCurrency(dispute.amount, dispute.currency)}</td>
                      <td className="px-5 py-4"><span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${statusClassName(dispute.status)}`}>{disputeStatusLabel(dispute.status)}</span></td>
                      <td className={`px-5 py-4 text-xs font-semibold ${deadline === 'overdue' || deadline === 'urgent' ? 'text-red-700' : 'text-ink/65'}`}>{displayDate(dispute.evidence_due_at)}</td>
                      <td className="px-5 py-4 text-right"><Button type="button" onClick={() => selectDispute(dispute)} className="border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:border-forest hover:text-forest">Review</Button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SidePanel open={selected !== null} busy={busyAction !== null} onClose={() => setSelectedId(null)}>
        {selected && (
          <div className="p-6 sm:p-8">
            <SidePanelCloseButton disabled={busyAction !== null} onClick={() => setSelectedId(null)} />
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-terracotta">Dispute review</p>
            <h3 className="mt-2 pr-12 text-2xl font-extrabold tracking-[-0.035em] text-ink">{selected.projectName}</h3>
            <p className="mt-2 text-sm font-medium text-ink/65">{selected.subcontractorName} · {formatCurrency(selected.amount, selected.currency)}</p>

            {notice && <NotificationBanner tone="success" className="mt-5">{notice}</NotificationBanner>}
            {error && <NotificationBanner tone="error" className="mt-5">{error}</NotificationBanner>}

            <dl className="mt-6 grid grid-cols-2 gap-px border border-ink/10 bg-ink/10">
              {[
                ['Status', disputeStatusLabel(selected.status)],
                ['Reason', formatStatus(selected.reason)],
                ['Evidence due', displayDate(selected.evidence_due_at)],
                ['Submissions', String(selected.evidence_submission_count)],
                ['Funds withdrawn', displayDate(selected.funds_withdrawn_at)],
                ['Recovery', formatStatus(selected.recovery_status)],
              ].map(([label, value]) => <div key={label} className="bg-white p-3"><dt className="text-[9px] font-bold uppercase tracking-[0.13em] text-ink/55">{label}</dt><dd className="mt-1 text-xs font-bold text-ink">{value}</dd></div>)}
            </dl>

            {disputeNeedsResponse(selected.status) && (
              <div className="mt-7 space-y-4 border-t border-ink/10 pt-6">
                <div><h4 className="text-sm font-extrabold text-ink">Evidence response</h4><p className="mt-1 text-xs font-medium leading-5 text-ink/60">Save a draft for review or explicitly submit it to Stripe. Submitted evidence cannot be edited unless Stripe permits another submission.</p></div>
                <Field><Label className="text-xs font-bold text-ink">Product or service description</Label><Textarea rows={4} value={productDescription} onChange={(event) => setProductDescription(event.target.value)} className={`${fieldClassName} mt-1.5 py-2.5`} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field><Label className="text-xs font-bold text-ink">Service date</Label><Input type="date" value={serviceDate} onChange={(event) => setServiceDate(event.target.value)} className={`${fieldClassName} mt-1.5 h-10`} /></Field>
                  <Field><Label className="text-xs font-bold text-ink">Customer email</Label><Input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} className={`${fieldClassName} mt-1.5 h-10`} /></Field>
                </div>
                <Field><Label className="text-xs font-bold text-ink">Additional evidence</Label><Textarea rows={5} value={uncategorizedText} onChange={(event) => setUncategorizedText(event.target.value)} className={`${fieldClassName} mt-1.5 py-2.5`} /></Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={busyAction !== null} onClick={() => void runAction('save_evidence')} className="bg-forest px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{busyAction === 'save_evidence' && <ButtonSpinner />} Save draft</Button>
                  <Button type="button" disabled={busyAction !== null} onClick={() => setConfirmAction('submit_evidence')} className="border border-forest px-4 py-2.5 text-xs font-bold text-forest disabled:opacity-50">Submit evidence</Button>
                  <Button type="button" disabled={busyAction !== null} onClick={() => setConfirmAction('accept')} className="border border-red-200 px-4 py-2.5 text-xs font-bold text-red-700 disabled:opacity-50">Accept dispute</Button>
                </div>
              </div>
            )}

            {disputeIsLost(selected.status) && selected.payment_transfer_id && selected.recovery_status !== 'reversed' && (
              <div className="mt-7 border-t border-ink/10 pt-6"><h4 className="text-sm font-extrabold text-ink">Connected-transfer recovery</h4><p className="mt-1 text-xs font-medium leading-5 text-ink/60">Reverse available transferred funds only after confirming the dispute loss. This does not refund the platform fee.</p><Button type="button" disabled={busyAction !== null} onClick={() => setConfirmAction('recover')} className="mt-4 border border-red-200 px-4 py-2.5 text-xs font-bold text-red-700 disabled:opacity-50">Recover transfer funds</Button></div>
            )}

            {confirmAction && (
              <div className="mt-6 border border-red-200 bg-red-50 p-4" role="alert"><p className="text-sm font-extrabold text-red-900">Confirm {confirmAction === 'submit_evidence' ? 'evidence submission' : confirmAction === 'accept' ? 'dispute acceptance' : 'transfer recovery'}</p><p className="mt-1 text-xs font-medium leading-5 text-red-800">{confirmAction === 'accept' ? 'Accepting is irreversible and Stripe will close the dispute as lost.' : confirmAction === 'submit_evidence' ? 'Stripe will receive this evidence as the formal response.' : 'Stripe will reverse the available connected transfer amount.'}</p><div className="mt-3 flex gap-2"><Button type="button" disabled={busyAction !== null} onClick={() => void runAction(confirmAction, true)} className="bg-red-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busyAction === confirmAction && <ButtonSpinner />} Confirm</Button><Button type="button" disabled={busyAction !== null} onClick={() => setConfirmAction(null)} className="border border-red-300 px-3 py-2 text-xs font-bold text-red-800">Cancel</Button></div></div>
            )}

            <Button type="button" disabled={busyAction !== null} onClick={() => void runAction('sync')} className="mt-7 border border-ink/15 px-4 py-2.5 text-xs font-bold text-ink disabled:opacity-50">{busyAction === 'sync' && <ButtonSpinner />} Refresh from Stripe</Button>
          </div>
        )}
      </SidePanel>
    </section>
  )
}

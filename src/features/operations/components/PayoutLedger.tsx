import { Button, Field, Input, Label } from '@headlessui/react'
import { useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import { SidePanel, SidePanelCloseButton } from '@/components/ui/SidePanel'
import {
  createLedgerCsv,
  filterLedgerEntries,
  ledgerStatusLabel,
  payoutFailureRecommendation,
  type LedgerFilters,
  type LedgerKind,
} from '@/features/operations/payout-ledger'
import type {
  AuditEvent,
  ConnectedPayout,
  OrganizationRole,
  PaymentRequest,
  PaymentTransfer,
  Project,
  RetainageRelease,
  Subcontractor,
} from '@/lib/database.types'
import { formatCurrency, formatStatus } from '@/lib/format'
import { supabase } from '@/lib/supabase'

interface PayoutLedgerProps {
  organizationId: string
  role: OrganizationRole
  transfers: PaymentTransfer[]
  payouts: ConnectedPayout[]
  paymentRequests: PaymentRequest[]
  retainageReleases: RetainageRelease[]
  projects: Project[]
  subcontractors: Subcontractor[]
  auditEvents: AuditEvent[]
  isLoading: boolean
  onRefresh: () => Promise<void>
}

interface TransferView extends PaymentTransfer {
  kind: 'transfers'
  subcontractorName: string
  projectName: string
  requestDescription: string
  searchText: string
  createdAt: string
  subcontractorId: string
}

interface PayoutView extends ConnectedPayout {
  kind: 'payouts'
  subcontractorName: string
  searchText: string
  createdAt: string
  subcontractorId: string
}

type SelectedRecord = { kind: LedgerKind; id: string } | null

const initialFilters: LedgerFilters = {
  search: '',
  subcontractorId: '',
  status: '',
  currency: '',
  dateFrom: '',
  dateTo: '',
}

const inputClassName =
  'h-10 w-full border border-ink/15 bg-white px-3 text-sm font-medium text-ink outline-none transition placeholder:text-ink/55 focus:border-forest focus:ring-2 focus:ring-forest/10'

function displayDate(value: string | null): string {
  if (!value) return 'Not available'

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusClassName(status: string): string {
  if (status === 'paid' || status === 'succeeded') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  if (status === 'pending' || status === 'in_transit') {
    return 'border-amber-200 bg-amber-50 text-amber-800'
  }
  if (status === 'partially_reversed') {
    return 'border-blue-200 bg-blue-50 text-blue-800'
  }
  if (status === 'failed') {
    return 'border-red-200 bg-red-50 text-red-800'
  }

  return 'border-slate-300 bg-slate-100 text-slate-700'
}

function CurrencyTotals({
  amounts,
}: {
  amounts: readonly { amount: number; currency: string }[]
}) {
  const totals = new Map<string, number>()

  for (const item of amounts) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amount)
  }

  if (totals.size === 0) return <span>{formatCurrency(0, 'usd')}</span>

  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {[...totals.entries()].map(([currency, amount]) => (
        <span key={currency}>{formatCurrency(amount, currency)}</span>
      ))}
    </span>
  )
}

function MetricCard({
  label,
  amounts,
  detail,
}: {
  label: string
  amounts: readonly { amount: number; currency: string }[]
  detail: string
}) {
  return (
    <article className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">
        {label}
      </p>
      <div className="mt-3 text-lg font-extrabold tracking-[-0.025em] text-ink">
        <CurrencyTotals amounts={amounts} />
      </div>
      <p className="mt-2 text-[11px] font-medium text-ink/65">{detail}</p>
    </article>
  )
}

function downloadCsv(fileName: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

async function edgeErrorMessage(error: unknown): Promise<string> {
  const candidate = error as { message?: unknown; context?: unknown } | null

  if (candidate?.context instanceof Response) {
    const payload = (await candidate.context.json().catch(() => null)) as
      | { error?: unknown }
      | null

    if (typeof payload?.error === 'string') return payload.error
  }

  return 'The payout ledger could not be reconciled. Please try again.'
}

export function PayoutLedger({
  organizationId,
  role,
  transfers,
  payouts,
  paymentRequests,
  retainageReleases,
  projects,
  subcontractors,
  auditEvents,
  isLoading,
  onRefresh,
}: PayoutLedgerProps) {
  const [activeTable, setActiveTable] = useState<LedgerKind>('transfers')
  const [filters, setFilters] = useState<LedgerFilters>(initialFilters)
  const [page, setPage] = useState(1)
  const [selectedRecord, setSelectedRecord] = useState<SelectedRecord>(null)
  const [reconcilingId, setReconcilingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canReadLedger = ['owner', 'admin', 'accountant'].includes(role)
  const pageSize = 20

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  )
  const requestById = useMemo(
    () => new Map(paymentRequests.map((request) => [request.id, request])),
    [paymentRequests],
  )
  const retainageReleaseById = useMemo(
    () => new Map(retainageReleases.map((release) => [release.id, release])),
    [retainageReleases],
  )
  const subcontractorById = useMemo(
    () => new Map(subcontractors.map((item) => [item.id, item])),
    [subcontractors],
  )

  const transferViews = useMemo<TransferView[]>(
    () => transfers.map((transfer) => {
      const request = requestById.get(transfer.payment_request_id)
      const project = request ? projectById.get(request.project_id) : undefined
      const subcontractor = subcontractorById.get(transfer.subcontractor_id)
      const retainageRelease = transfer.retainage_release_id
        ? retainageReleaseById.get(transfer.retainage_release_id)
        : undefined
      const subcontractorName = subcontractor?.company_name ?? 'Unknown subcontractor'
      const projectName = project?.name ?? 'Unknown project'
      const requestDescription = retainageRelease
        ? `Retainage release · ${retainageRelease.reason}`
        : request?.description ?? 'Payment request'

      return {
        ...transfer,
        kind: 'transfers',
        subcontractorName,
        projectName,
        requestDescription,
        subcontractorId: transfer.subcontractor_id,
        createdAt: transfer.stripe_created_at,
        searchText: [
          subcontractorName,
          projectName,
          project?.code,
          requestDescription,
          transfer.stripe_transfer_id,
        ].filter(Boolean).join(' '),
      }
    }),
    [
      projectById,
      requestById,
      retainageReleaseById,
      subcontractorById,
      transfers,
    ],
  )

  const payoutViews = useMemo<PayoutView[]>(
    () => payouts.map((payout) => {
      const subcontractorName =
        subcontractorById.get(payout.subcontractor_id)?.company_name ??
        'Unknown subcontractor'

      return {
        ...payout,
        kind: 'payouts',
        subcontractorName,
        subcontractorId: payout.subcontractor_id,
        createdAt: payout.stripe_created_at,
        searchText: [
          subcontractorName,
          payout.stripe_payout_id,
          payout.failure_code,
        ].filter(Boolean).join(' '),
      }
    }),
    [payouts, subcontractorById],
  )

  const activeEntries = activeTable === 'transfers' ? transferViews : payoutViews
  const filteredTransferViews = useMemo(
    () => filterLedgerEntries(transferViews, filters),
    [filters, transferViews],
  )
  const filteredPayoutViews = useMemo(
    () => filterLedgerEntries(payoutViews, filters),
    [filters, payoutViews],
  )
  const filteredEntries = activeTable === 'transfers'
    ? filteredTransferViews
    : filteredPayoutViews
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pagedTransferViews = filteredTransferViews.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  )
  const pagedPayoutViews = filteredPayoutViews.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  )

  const currencies = [...new Set(activeEntries.map((entry) => entry.currency))]
    .sort()
  const statuses = [...new Set(activeEntries.map((entry) => entry.status))].sort()
  const selectedTransfer = selectedRecord?.kind === 'transfers'
    ? transferViews.find((transfer) => transfer.id === selectedRecord.id) ?? null
    : null
  const selectedPayout = selectedRecord?.kind === 'payouts'
    ? payoutViews.find((payout) => payout.id === selectedRecord.id) ?? null
    : null
  const selected = selectedTransfer ?? selectedPayout
  const selectedAuditEvents = selected
    ? auditEvents.filter((event) => event.entity_id === selected.id)
    : []

  const updateFilter = (key: keyof LedgerFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }

  const reconcile = async (
    targetType: 'organization' | 'payment' | 'payout',
    targetId: string,
  ) => {
    setReconcilingId(targetId)
    setNotice(null)
    setError(null)

    const { data, error: functionError } = await supabase.functions.invoke(
      'reconcile-payouts',
      {
        body: { organizationId, targetType, targetId },
      },
    )

    if (functionError) {
      setError(await edgeErrorMessage(functionError))
      setReconcilingId(null)
      return
    }

    const result = data as { transferCount?: unknown; payoutCount?: unknown }
    setNotice(
      `Reconciliation completed: ${Number(result.transferCount ?? 0)} transfers and ${Number(result.payoutCount ?? 0)} payouts synchronized.`,
    )
    await onRefresh()
    setReconcilingId(null)
  }

  const exportCurrentLedger = () => {
    if (activeTable === 'transfers') {
      downloadCsv(
        `tradeledger-transfers-${new Date().toISOString().slice(0, 10)}.csv`,
        createLedgerCsv(
          [
            'Payment request',
            'Project',
            'Subcontractor',
            'Amount minor units',
            'Currency',
            'Status',
            'Reversed minor units',
            'Stripe transfer reference',
            'Created at',
            'Last synchronized at',
          ],
          filteredTransferViews.map((transfer) => [
            transfer.requestDescription,
            transfer.projectName,
            transfer.subcontractorName,
            transfer.amount,
            transfer.currency,
            transfer.status,
            transfer.reversed_amount,
            transfer.stripe_transfer_id,
            transfer.stripe_created_at,
            transfer.last_synced_at,
          ]),
        ),
      )
      return
    }

    downloadCsv(
      `tradeledger-payouts-${new Date().toISOString().slice(0, 10)}.csv`,
      createLedgerCsv(
        [
          'Payment request',
          'Project',
          'Subcontractor',
          'Amount minor units',
          'Currency',
          'Status',
          'Stripe payout reference',
          'Expected arrival',
          'Created at',
          'Last synchronized at',
        ],
        filteredPayoutViews.map((payout) => [
          '',
          '',
          payout.subcontractorName,
          payout.amount,
          payout.currency,
          payout.status,
          payout.stripe_payout_id,
          payout.expected_arrival_at,
          payout.stripe_created_at,
          payout.last_synced_at,
        ]),
      ),
    )
  }

  if (!canReadLedger) {
    return (
      <NotificationBanner tone="warning">
        Payout ledger access is limited to owners, administrators, and accountants.
      </NotificationBanner>
    )
  }

  const pendingPayouts = payouts.filter((payout) =>
    payout.status === 'pending' || payout.status === 'in_transit'
  )

  return (
    <div className="flex flex-col gap-6">
      {notice && <NotificationBanner tone="success">{notice}</NotificationBanner>}
      {error && <NotificationBanner tone="error">{error}</NotificationBanner>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Routed to subcontractors"
          amounts={transfers.map((item) => ({ amount: item.amount, currency: item.currency }))}
          detail={`${transfers.length} destination transfer${transfers.length === 1 ? '' : 's'}`}
        />
        <MetricCard
          label="Pending / in transit"
          amounts={pendingPayouts.map((item) => ({ amount: item.amount, currency: item.currency }))}
          detail="Connected payouts not yet settled"
        />
        <MetricCard
          label="Paid out"
          amounts={payouts.filter((item) => item.status === 'paid').map((item) => ({ amount: item.amount, currency: item.currency }))}
          detail="Confirmed bank payout state"
        />
        <MetricCard
          label="Failed payouts"
          amounts={payouts.filter((item) => item.status === 'failed').map((item) => ({ amount: item.amount, currency: item.currency }))}
          detail="Operator attention required"
        />
        <MetricCard
          label="Reversed / refunded"
          amounts={transfers.filter((item) => item.reversed_amount > 0).map((item) => ({ amount: item.reversed_amount, currency: item.currency }))}
          detail="Transfer funds returned to platform"
        />
      </div>

      <section className="border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col gap-4 border-b border-ink/10 p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
              Money movement ledger
            </p>
            <h2 className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-ink">
              Transfers and connected payouts
            </h2>
            <p className="mt-1 text-xs font-medium text-ink/65">
              Showing at most 100 synchronized records per ledger.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={exportCurrentLedger}
              disabled={filteredEntries.length === 0}
              className="h-10 border border-ink/15 bg-white px-4 text-xs font-bold text-ink transition hover:border-forest/35 hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-45"
            >
              Export filtered CSV
            </Button>
            <Button
              type="button"
              onClick={() => void reconcile('organization', organizationId)}
              disabled={reconcilingId !== null}
              aria-busy={reconcilingId === organizationId}
              className="inline-flex h-10 items-center gap-2 bg-forest px-4 text-xs font-bold text-white transition hover:bg-forest/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60"
            >
              {reconcilingId === organizationId && <ButtonSpinner tone="light" />}
              Reconcile ledger
            </Button>
          </div>
        </div>

        <div className="border-b border-ink/10 px-4 pt-4 sm:px-5">
          <div role="tablist" aria-label="Payout ledger tables" className="flex gap-6">
            {(['transfers', 'payouts'] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                role="tab"
                aria-selected={activeTable === kind}
                onClick={() => {
                  setActiveTable(kind)
                  setFilters(initialFilters)
                  setPage(1)
                }}
                className={`border-b-2 px-1 pb-3 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${activeTable === kind ? 'border-forest text-forest' : 'border-transparent text-ink/60 hover:text-ink'}`}
              >
                {kind === 'transfers' ? 'Transfers' : 'Payouts'}
                <span className="ml-2 border border-current/15 px-1.5 py-0.5 text-[10px] tabular-nums">
                  {kind === 'transfers' ? transfers.length : payouts.length}
                </span>
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 border-b border-ink/10 bg-cream/45 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-[minmax(14rem,2fr)_repeat(5,minmax(8rem,1fr))]">
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              Search
            </Label>
            <Input
              type="search"
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="Request, project, subcontractor…"
              className={inputClassName}
            />
          </Field>
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              Subcontractor
            </Label>
            <SelectControl
              value={filters.subcontractorId}
              onChange={(value) => updateFilter('subcontractorId', value)}
              ariaLabel="Filter by subcontractor"
              className={inputClassName}
              options={[
                { value: '', label: 'All subcontractors' },
                ...subcontractors.map((item) => ({ value: item.id, label: item.company_name })),
              ]}
            />
          </Field>
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              Status
            </Label>
            <SelectControl
              value={filters.status}
              onChange={(value) => updateFilter('status', value)}
              ariaLabel="Filter by status"
              className={inputClassName}
              options={[
                { value: '', label: 'All statuses' },
                ...statuses.map((status) => ({
                  value: status,
                  label: ledgerStatusLabel(activeTable, status),
                })),
              ]}
            />
          </Field>
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              Currency
            </Label>
            <SelectControl
              value={filters.currency}
              onChange={(value) => updateFilter('currency', value)}
              ariaLabel="Filter by currency"
              className={inputClassName}
              options={[
                { value: '', label: 'All currencies' },
                ...currencies.map((currency) => ({
                  value: currency,
                  label: currency.toUpperCase(),
                })),
              ]}
            />
          </Field>
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              From
            </Label>
            <Input
              type="date"
              value={filters.dateFrom}
              onChange={(event) => updateFilter('dateFrom', event.target.value)}
              className={inputClassName}
            />
          </Field>
          <Field>
            <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
              To
            </Label>
            <Input
              type="date"
              value={filters.dateTo}
              onChange={(event) => updateFilter('dateTo', event.target.value)}
              className={inputClassName}
            />
          </Field>
        </div>

        {isLoading ? (
          <div className="grid min-h-56 place-items-center p-8" role="status">
            <span className="inline-flex items-center gap-3 text-sm font-bold text-ink/70">
              <ButtonSpinner /> Loading payout ledger…
            </span>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="p-5 sm:p-8">
            <div className="border border-dashed border-ink/15 bg-cream/50 p-8 text-center">
              <p className="text-base font-extrabold text-ink">
                {activeEntries.length === 0
                  ? `No ${activeTable} have been synchronized yet.`
                  : 'No ledger records match these filters.'}
              </p>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 font-medium text-ink/65">
                {activeEntries.length === 0
                  ? 'Use reconciliation after a test-mode destination charge or connected payout exists in Stripe.'
                  : 'Clear one or more filters to broaden the results.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {activeTable === 'transfers' ? (
              <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
                <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.13em] text-ink/70">
                  <tr>
                    <th scope="col" className="px-4 py-3">Payment request</th>
                    <th scope="col" className="px-4 py-3">Project</th>
                    <th scope="col" className="px-4 py-3">Subcontractor</th>
                    <th scope="col" className="px-4 py-3 text-right">Transfer</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3 text-right">Reversed</th>
                    <th scope="col" className="px-4 py-3">Created</th>
                    <th scope="col" className="px-4 py-3">Last synchronized</th>
                    <th scope="col" className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/8">
                  {pagedTransferViews.map((transfer) => (
                    <tr key={transfer.id} className="hover:bg-cream/35">
                      <th scope="row" className="max-w-64 px-4 py-4 font-bold text-ink">
                        <span className="line-clamp-2">{transfer.requestDescription}</span>
                      </th>
                      <td className="px-4 py-4 text-ink/75">{transfer.projectName}</td>
                      <td className="px-4 py-4 text-ink/75">{transfer.subcontractorName}</td>
                      <td className="px-4 py-4 text-right font-extrabold tabular-nums text-ink">
                        {formatCurrency(transfer.amount, transfer.currency)}
                        <span className="ml-1 text-[9px] font-bold text-ink/50">{transfer.currency.toUpperCase()}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${statusClassName(transfer.status)}`}>
                          {ledgerStatusLabel('transfers', transfer.status)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right font-semibold tabular-nums text-ink/75">
                        {formatCurrency(transfer.reversed_amount, transfer.currency)}
                      </td>
                      <td className="px-4 py-4 text-xs font-medium text-ink/65">{displayDate(transfer.stripe_created_at)}</td>
                      <td className="px-4 py-4 text-xs font-medium text-ink/65">{displayDate(transfer.last_synced_at)}</td>
                      <td className="px-4 py-4 text-right">
                        <Button
                          type="button"
                          onClick={() => setSelectedRecord({ kind: 'transfers', id: transfer.id })}
                          className="border border-forest/20 px-3 py-2 text-xs font-bold text-forest hover:bg-mint/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                        >
                          Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.13em] text-ink/70">
                  <tr>
                    <th scope="col" className="px-4 py-3">Subcontractor</th>
                    <th scope="col" className="px-4 py-3 text-right">Payout</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3">Expected arrival</th>
                    <th scope="col" className="px-4 py-3">Failure state</th>
                    <th scope="col" className="px-4 py-3">Last synchronized</th>
                    <th scope="col" className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/8">
                  {pagedPayoutViews.map((payout) => (
                    <tr key={payout.id} className="hover:bg-cream/35">
                      <th scope="row" className="px-4 py-4 font-bold text-ink">{payout.subcontractorName}</th>
                      <td className="px-4 py-4 text-right font-extrabold tabular-nums text-ink">
                        {formatCurrency(payout.amount, payout.currency)}
                        <span className="ml-1 text-[9px] font-bold text-ink/50">{payout.currency.toUpperCase()}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${statusClassName(payout.status)}`}>
                          {ledgerStatusLabel('payouts', payout.status)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-xs font-medium text-ink/65">{displayDate(payout.expected_arrival_at)}</td>
                      <td className="max-w-56 px-4 py-4 text-xs font-semibold text-ink/70">
                        {payout.failure_code ? formatStatus(payout.failure_code) : 'None'}
                      </td>
                      <td className="px-4 py-4 text-xs font-medium text-ink/65">{displayDate(payout.last_synced_at)}</td>
                      <td className="px-4 py-4 text-right">
                        <Button
                          type="button"
                          onClick={() => setSelectedRecord({ kind: 'payouts', id: payout.id })}
                          className="border border-forest/20 px-3 py-2 text-xs font-bold text-forest hover:bg-mint/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                        >
                          Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {filteredEntries.length > pageSize && (
          <div className="flex items-center justify-between gap-4 border-t border-ink/10 px-4 py-3 text-xs font-semibold text-ink/65 sm:px-5">
            <span>Page {safePage} of {pageCount}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={safePage === 1}
                className="border border-ink/15 px-3 py-2 font-bold text-ink disabled:opacity-40"
              >
                Previous
              </Button>
              <Button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={safePage === pageCount}
                className="border border-ink/15 px-3 py-2 font-bold text-ink disabled:opacity-40"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </section>

      <SidePanel
        open={selected !== null}
        busy={
          reconcilingId === (
            selectedTransfer?.payment_request_id ?? selectedPayout?.id
          )
        }
        onClose={() => setSelectedRecord(null)}
      >
        {selected && (
          <div className="min-h-full">
            <div className="border-b border-ink/10 bg-cream/60 px-5 py-6 pr-16 sm:px-7 sm:py-8">
              <SidePanelCloseButton
                disabled={
                  reconcilingId === (
                    selectedTransfer?.payment_request_id ?? selectedPayout?.id
                  )
                }
                onClick={() => setSelectedRecord(null)}
              />
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-forest/75">
                {selected.kind === 'transfers' ? 'Transfer details' : 'Payout details'}
              </p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.035em] text-ink">
                {selected.subcontractorName}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${statusClassName(selected.status)}`}>
                  {ledgerStatusLabel(selected.kind, selected.status)}
                </span>
                <span className="text-sm font-extrabold text-ink">
                  {formatCurrency(selected.amount, selected.currency)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-6 p-5 sm:p-7">
              <section>
                <h3 className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink/70">Safe Stripe reference</h3>
                <p className="mt-3 break-all border border-ink/10 bg-cream/55 p-3 font-mono text-xs font-semibold text-ink/75">
                  {selected.kind === 'transfers' ? selected.stripe_transfer_id : selected.stripe_payout_id}
                </p>
              </section>

              {selectedTransfer && (
                <section className="border-t border-ink/10 pt-5">
                  <h3 className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink/70">Related payment</h3>
                  <dl className="mt-3 grid gap-3 text-sm">
                    <div className="flex justify-between gap-4"><dt className="text-ink/60">Request</dt><dd className="text-right font-bold text-ink">{selectedTransfer.requestDescription}</dd></div>
                    <div className="flex justify-between gap-4"><dt className="text-ink/60">Project</dt><dd className="text-right font-bold text-ink">{selectedTransfer.projectName}</dd></div>
                    <div className="flex justify-between gap-4"><dt className="text-ink/60">Reversed</dt><dd className="font-bold text-ink">{formatCurrency(selectedTransfer.reversed_amount, selectedTransfer.currency)}</dd></div>
                  </dl>
                </section>
              )}

              {selectedPayout && payoutFailureRecommendation(selectedPayout.status, selectedPayout.failure_code) && (
                <NotificationBanner tone="warning">
                  <p className="font-bold">{selectedPayout.failure_message ?? 'The payout requires operator attention.'}</p>
                  <p className="mt-1 text-xs">{payoutFailureRecommendation(selectedPayout.status, selectedPayout.failure_code)}</p>
                </NotificationBanner>
              )}

              <section className="border-t border-ink/10 pt-5">
                <h3 className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink/70">Timeline</h3>
                <ol className="mt-4 grid gap-4 border-l border-forest/20 pl-4 text-sm">
                  <li><p className="font-bold text-ink">Created in Stripe</p><time className="text-xs text-ink/60">{displayDate(selected.stripe_created_at)}</time></li>
                  {selectedPayout?.expected_arrival_at && <li><p className="font-bold text-ink">Expected bank arrival</p><time className="text-xs text-ink/60">{displayDate(selectedPayout.expected_arrival_at)}</time></li>}
                  <li><p className="font-bold text-ink">Last synchronized</p><time className="text-xs text-ink/60">{displayDate(selected.last_synced_at)}</time></li>
                </ol>
              </section>

              <section className="border-t border-ink/10 pt-5">
                <h3 className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink/70">Audit events</h3>
                {selectedAuditEvents.length === 0 ? (
                  <p className="mt-3 text-sm font-medium text-ink/60">No matching audit events are in the current bounded result.</p>
                ) : (
                  <ul className="mt-3 grid gap-2">
                    {selectedAuditEvents.map((event) => (
                      <li key={event.id} className="border border-ink/10 p-3 text-xs">
                        <p className="font-bold text-ink">{formatStatus(event.action.replaceAll('.', '_'))}</p>
                        <time className="mt-1 block text-ink/55">{displayDate(event.created_at)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <Button
                type="button"
                onClick={() => void reconcile(
                  selected.kind === 'transfers' ? 'payment' : 'payout',
                  selected.kind === 'transfers' ? selected.payment_request_id : selected.id,
                )}
                disabled={reconcilingId !== null}
                aria-busy={reconcilingId === selected.id}
                className="inline-flex h-11 items-center justify-center gap-2 bg-forest px-4 text-sm font-bold text-white hover:bg-forest/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60"
              >
                {reconcilingId === (selected.kind === 'transfers' ? selected.payment_request_id : selected.id) && <ButtonSpinner tone="light" />}
                Reconcile this {selected.kind === 'transfers' ? 'payment' : 'payout'}
              </Button>
            </div>
          </div>
        )}
      </SidePanel>
    </div>
  )
}

import { Button, Field, Input, Label } from '@headlessui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import {
  createFinancialStatementCsv,
  financialEntryLabel,
  financialMetricAmounts,
  financialStatementFileName,
  netCollectedAmounts,
  reportPeriodError,
} from '@/features/operations/financial-reporting'
import type {
  FinancialReportSummary,
  FinancialStatementRow,
  OrganizationRole,
} from '@/lib/database.types'
import { formatCurrency, formatStatus } from '@/lib/format'
import { safeDatabaseErrorMessage } from '@/lib/public-errors'
import { supabase } from '@/lib/supabase'

interface FinancialReportsProps {
  organizationId: string
  organizationName: string
  role: OrganizationRole
}

interface ReportFilters {
  periodStart: string
  periodEnd: string
  currency: string
}

const inputClassName =
  'h-10 w-full border border-ink/15 bg-white px-3 text-sm font-medium text-ink outline-none transition focus:border-forest focus:ring-2 focus:ring-forest/10'
const pageSize = 25

function localDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function initialReportFilters(): ReportFilters {
  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

  return {
    periodStart: localDateInputValue(monthStart),
    periodEnd: localDateInputValue(today),
    currency: '',
  }
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusClassName(status: string): string {
  if (['paid', 'succeeded', 'won', 'appeal_won'].includes(status)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  if (['pending', 'processing', 'in_transit', 'under_review'].includes(status)) {
    return 'border-amber-200 bg-amber-50 text-amber-800'
  }
  if (['failed', 'lost', 'appeal_lost'].includes(status)) {
    return 'border-red-200 bg-red-50 text-red-800'
  }

  return 'border-slate-300 bg-slate-100 text-slate-700'
}

function CurrencyTotals({
  amounts,
}: {
  amounts: readonly { amount: number; currency: string }[]
}) {
  if (amounts.length === 0) return <span>{formatCurrency(0, 'usd')}</span>

  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {amounts.map(({ amount, currency }) => (
        <span key={currency}>{formatCurrency(amount, currency)}</span>
      ))}
    </span>
  )
}

function ReportMetric({
  label,
  detail,
  amounts,
}: {
  label: string
  detail: string
  amounts: readonly { amount: number; currency: string }[]
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

export function FinancialReports({
  organizationId,
  organizationName,
  role,
}: FinancialReportsProps) {
  const [filters, setFilters] = useState<ReportFilters>(initialReportFilters)
  const [loadedFilters, setLoadedFilters] = useState<ReportFilters>(initialReportFilters)
  const [summaries, setSummaries] = useState<FinancialReportSummary[]>([])
  const [rows, setRows] = useState<FinancialStatementRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const canReadReports = ['owner', 'admin', 'accountant'].includes(role)

  const loadReport = useCallback(
    async (nextFilters: ReportFilters) => {
      const validationError = reportPeriodError(
        nextFilters.periodStart,
        nextFilters.periodEnd,
      )

      if (validationError) {
        setError(validationError)
        return
      }

      setIsLoading(true)
      setError(null)

      const rpcFilters = {
        p_organization_id: organizationId,
        p_period_start: nextFilters.periodStart,
        p_period_end: nextFilters.periodEnd,
        p_currency: nextFilters.currency || null,
      }
      const [summaryResult, statementResult] = await Promise.all([
        supabase.rpc('get_organization_financial_report', rpcFilters),
        supabase.rpc('get_organization_financial_statement', {
          ...rpcFilters,
          p_limit: 500,
        }),
      ])

      const reportError = summaryResult.error ?? statementResult.error
      if (reportError) {
        setError(
          safeDatabaseErrorMessage(
            reportError,
            'The financial report could not be loaded. Please try again.',
          ),
        )
        setIsLoading(false)
        return
      }

      setSummaries(summaryResult.data ?? [])
      setRows(statementResult.data ?? [])
      setLoadedFilters(nextFilters)
      setPage(1)
      setIsLoading(false)
    },
    [organizationId],
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadReport(initialReportFilters())
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadReport])

  const currencyOptions = useMemo(() => {
    const currencies = new Set([
      ...summaries.map((summary) => summary.currency),
      ...rows.map((row) => row.currency),
    ])

    if (filters.currency) currencies.add(filters.currency)

    return [
      { value: '', label: 'All currencies' },
      ...[...currencies]
        .sort()
        .map((currency) => ({ value: currency, label: currency.toUpperCase() })),
    ]
  }, [filters.currency, rows, summaries])

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize)
  function updateFilter<Key extends keyof ReportFilters>(
    key: Key,
    value: ReportFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  function exportStatement() {
    if (rows.length === 0) return

    downloadCsv(
      financialStatementFileName(
        organizationName,
        loadedFilters.periodStart,
        loadedFilters.periodEnd,
        loadedFilters.currency,
      ),
      createFinancialStatementCsv(
        organizationName,
        loadedFilters.periodStart,
        loadedFilters.periodEnd,
        rows,
      ),
    )
  }

  if (!canReadReports) {
    return (
      <NotificationBanner tone="error">
        Financial reports require owner, administrator, or accountant access.
      </NotificationBanner>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="border border-ink/10 bg-white p-5 shadow-[0_14px_36px_rgba(19,37,31,0.05)] sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
              Authoritative ledger reporting
            </p>
            <h2 className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-ink">
              Reporting period
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 font-medium text-ink/65">
              Summaries use all tenant-visible ledger records in the period. Statements are
              bounded to the 500 newest activity rows and exclude Stripe and bank identifiers.
            </p>
          </div>

          <form
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[10rem_10rem_10rem_auto]"
            onSubmit={(event) => {
              event.preventDefault()
              void loadReport(filters)
            }}
          >
            <Field>
              <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
                Start date
              </Label>
              <Input
                type="date"
                value={filters.periodStart}
                onChange={(event) => updateFilter('periodStart', event.target.value)}
                className={inputClassName}
              />
            </Field>
            <Field>
              <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
                End date
              </Label>
              <Input
                type="date"
                value={filters.periodEnd}
                onChange={(event) => updateFilter('periodEnd', event.target.value)}
                className={inputClassName}
              />
            </Field>
            <Field>
              <Label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-ink/65">
                Currency
              </Label>
              <SelectControl
                value={filters.currency}
                onChange={(value) => updateFilter('currency', value)}
                options={currencyOptions}
                ariaLabel="Report currency"
                className={inputClassName}
              />
            </Field>
            <Button
              type="submit"
              disabled={isLoading}
              aria-busy={isLoading}
              className="inline-flex h-10 items-center justify-center gap-2 bg-forest px-4 text-xs font-bold text-white transition hover:bg-forest/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60 xl:self-end"
            >
              {isLoading && <ButtonSpinner tone="light" />}
              Run report
            </Button>
          </form>
        </div>
      </section>

      {error && <NotificationBanner tone="error">{error}</NotificationBanner>}

      <section aria-label="Financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <ReportMetric
          label="Collected"
          amounts={financialMetricAmounts(summaries, 'collected_amount')}
          detail="Successful payment volume"
        />
        <ReportMetric
          label="Net collections"
          amounts={netCollectedAmounts(summaries)}
          detail="Collected less succeeded refunds"
        />
        <ReportMetric
          label="Platform fees"
          amounts={financialMetricAmounts(summaries, 'platform_fee_amount')}
          detail="Fee snapshots on collected payments"
        />
        <ReportMetric
          label="Routed"
          amounts={financialMetricAmounts(summaries, 'routed_amount')}
          detail="Connected transfers created"
        />
        <ReportMetric
          label="Paid out"
          amounts={financialMetricAmounts(summaries, 'paid_out_amount')}
          detail="Confirmed connected bank payouts"
        />
        <ReportMetric
          label="At risk"
          amounts={summaries.map((summary) => ({
            amount: summary.failed_payout_amount + summary.disputed_amount,
            currency: summary.currency,
          }))}
          detail="Failed payouts plus dispute exposure"
        />
      </section>

      <section className="min-w-0 border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col gap-4 border-b border-ink/10 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
              Downloadable statement
            </p>
            <h2 className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-ink">
              Financial activity
            </h2>
            <p className="mt-1 text-xs font-medium text-ink/65">
              {rows.length} displayed rows · summary totals cover the full reporting period
            </p>
          </div>
          <Button
            type="button"
            onClick={exportStatement}
            disabled={rows.length === 0 || isLoading}
            className="h-10 border border-ink/15 bg-white px-4 text-xs font-bold text-ink transition hover:border-forest/35 hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-45"
          >
            Download statement CSV
          </Button>
        </div>

        {isLoading ? (
          <div className="grid min-h-52 place-items-center p-6 text-sm font-semibold text-ink/65" role="status">
            Loading financial report…
          </div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-52 place-items-center p-6 text-center">
            <div>
              <p className="text-sm font-bold text-ink">No financial activity in this period.</p>
              <p className="mt-1 text-xs leading-5 font-medium text-ink/60">
                Adjust the reporting dates or currency and run the report again.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-[1080px] w-full border-collapse text-left">
                <thead className="bg-cream/70 text-[10px] font-bold uppercase tracking-[0.13em] text-ink/70">
                  <tr>
                    <th scope="col" className="px-4 py-3">Date</th>
                    <th scope="col" className="px-4 py-3">Type</th>
                    <th scope="col" className="px-4 py-3">Reference</th>
                    <th scope="col" className="px-4 py-3">Description</th>
                    <th scope="col" className="px-4 py-3">Project / subcontractor</th>
                    <th scope="col" className="px-4 py-3 text-right">Amount</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/8 text-sm">
                  {visibleRows.map((row, index) => (
                    <tr key={`${row.entry_type}-${row.reference}-${row.occurred_at}-${index}`} className="align-top transition-colors hover:bg-cream/40">
                      <td className="whitespace-nowrap px-4 py-4 text-xs font-medium text-ink/70">
                        {displayDate(row.occurred_at)}
                      </td>
                      <td className="px-4 py-4 font-bold text-ink">
                        {financialEntryLabel(row.entry_type)}
                      </td>
                      <td className="max-w-44 truncate px-4 py-4 font-mono text-xs text-ink/70" title={row.reference}>
                        {row.reference}
                      </td>
                      <td className="max-w-64 px-4 py-4 font-medium text-ink/80">
                        {row.description}
                      </td>
                      <td className="px-4 py-4">
                        <span className="block font-bold text-ink">{row.project_name ?? 'Organization ledger'}</span>
                        <span className="mt-1 block text-xs font-medium text-ink/60">{row.subcontractor_name}</span>
                      </td>
                      <td className={`whitespace-nowrap px-4 py-4 text-right font-extrabold tabular-nums ${row.amount < 0 ? 'text-red-700' : 'text-forest'}`}>
                        {formatCurrency(row.amount, row.currency)}
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${statusClassName(row.status)}`}>
                          {formatStatus(row.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 border-t border-ink/10 px-4 py-4 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="font-medium text-ink/65">
                Page {page} of {pageCount}. Activity amounts show movement direction and are not a bank balance.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={page === 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="h-9 border border-ink/15 px-3 font-bold text-ink transition hover:bg-cream disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  disabled={page === pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  className="h-9 border border-ink/15 px-3 font-bold text-ink transition hover:bg-cream disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

import { createLedgerCsv } from '@/features/operations/payout-ledger'
import type {
  FinancialReportSummary,
  FinancialStatementRow,
} from '@/lib/database.types'

export type FinancialMetricKey =
  | 'collected_amount'
  | 'refunded_amount'
  | 'platform_fee_amount'
  | 'routed_amount'
  | 'reversed_amount'
  | 'paid_out_amount'
  | 'failed_payout_amount'
  | 'disputed_amount'

export function reportPeriodError(periodStart: string, periodEnd: string): string | null {
  if (!periodStart || !periodEnd) return 'Choose both a start date and an end date.'

  const start = new Date(`${periodStart}T00:00:00.000Z`)
  const end = new Date(`${periodEnd}T00:00:00.000Z`)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Choose a valid reporting period.'
  }

  if (end < start) return 'The end date must be on or after the start date.'

  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
  if (dayCount > 367) return 'Reporting periods cannot exceed 367 days.'

  return null
}

export function financialMetricAmounts(
  summaries: readonly FinancialReportSummary[],
  key: FinancialMetricKey,
): Array<{ amount: number; currency: string }> {
  return summaries.map((summary) => ({
    amount: summary[key],
    currency: summary.currency,
  }))
}

export function netCollectedAmounts(
  summaries: readonly FinancialReportSummary[],
): Array<{ amount: number; currency: string }> {
  return summaries.map((summary) => ({
    amount: summary.collected_amount - summary.refunded_amount,
    currency: summary.currency,
  }))
}

export function financialEntryLabel(entryType: FinancialStatementRow['entry_type']): string {
  const labels: Record<FinancialStatementRow['entry_type'], string> = {
    payment: 'Payment collected',
    refund: 'Refund',
    transfer: 'Connected transfer',
    transfer_reversal: 'Transfer reversal',
    payout: 'Bank payout',
    dispute: 'Dispute',
  }

  return labels[entryType]
}

export function createFinancialStatementCsv(
  organizationName: string,
  periodStart: string,
  periodEnd: string,
  rows: readonly FinancialStatementRow[],
): string {
  const metadata = createLedgerCsv(
    ['Statement', 'Period start', 'Period end'],
    [[organizationName, periodStart, periodEnd]],
  )
  const activity = createLedgerCsv(
    [
      'Date',
      'Type',
      'Reference',
      'Description',
      'Project',
      'Subcontractor',
      'Amount (minor units)',
      'Currency',
      'Status',
    ],
    rows.map((row) => [
      row.occurred_at,
      financialEntryLabel(row.entry_type),
      row.reference,
      row.description,
      row.project_name,
      row.subcontractor_name,
      row.amount,
      row.currency.toUpperCase(),
      row.status,
    ]),
  )

  return `${metadata}\r\n\r\n${activity}`
}

export function financialStatementFileName(
  organizationName: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
): string {
  const safeOrganization = organizationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'organization'
  const currencySuffix = currency ? `-${currency.toLowerCase()}` : ''

  return `tradeledger-statement-${safeOrganization}-${periodStart}-${periodEnd}${currencySuffix}.csv`
}

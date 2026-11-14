import type {
  ConnectedPayoutStatus,
  TransferStatus,
} from '@/lib/database.types'

export type LedgerKind = 'transfers' | 'payouts'

export interface LedgerFilterableEntry {
  id: string
  kind: LedgerKind
  subcontractorId: string
  status: string
  currency: string
  createdAt: string
  searchText: string
}

export interface LedgerFilters {
  search: string
  subcontractorId: string
  status: string
  currency: string
  dateFrom: string
  dateTo: string
}

const transferLabels: Record<TransferStatus, string> = {
  pending: 'Pending',
  succeeded: 'Routed',
  partially_reversed: 'Partially reversed',
  reversed: 'Reversed',
  failed: 'Failed',
}

const payoutLabels: Record<ConnectedPayoutStatus, string> = {
  pending: 'Pending',
  in_transit: 'In transit',
  paid: 'Paid',
  failed: 'Failed',
  canceled: 'Canceled',
}

export function ledgerStatusLabel(kind: LedgerKind, status: string): string {
  const labels = kind === 'transfers' ? transferLabels : payoutLabels

  return labels[status as keyof typeof labels] ?? 'Unknown'
}

export function filterLedgerEntries<T extends LedgerFilterableEntry>(
  entries: readonly T[],
  filters: LedgerFilters,
): T[] {
  const search = filters.search.trim().toLocaleLowerCase()
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`) : null
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`) : null

  return entries.filter((entry) => {
    const createdAt = new Date(entry.createdAt)

    return (
      (!search || entry.searchText.toLocaleLowerCase().includes(search)) &&
      (!filters.subcontractorId ||
        entry.subcontractorId === filters.subcontractorId) &&
      (!filters.status || entry.status === filters.status) &&
      (!filters.currency || entry.currency === filters.currency) &&
      (!from || createdAt >= from) &&
      (!to || createdAt <= to)
    )
  })
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value == null ? '' : String(value)
  const formulaSafe = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw

  return `"${formulaSafe.replaceAll('"', '""')}"`
}

export function createLedgerCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n')
}

export function payoutFailureRecommendation(
  status: string,
  failureCode: string | null,
): string | null {
  if (status === 'canceled') {
    return 'Confirm the payout schedule and reconcile again before retrying.'
  }

  if (status !== 'failed') return null

  if (failureCode === 'account_closed' || failureCode === 'invalid_account_number') {
    return 'Ask the subcontractor to update their payout account in Stripe.'
  }

  if (failureCode === 'insufficient_funds') {
    return 'Allow the connected balance to recover, then retry from Stripe.'
  }

  return 'Review the connected account in Stripe, resolve the failure, and reconcile again.'
}

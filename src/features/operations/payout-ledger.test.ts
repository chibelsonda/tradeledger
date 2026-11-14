import { describe, expect, it } from 'vitest'

import {
  createLedgerCsv,
  escapeCsvCell,
  filterLedgerEntries,
  ledgerStatusLabel,
  payoutFailureRecommendation,
  type LedgerFilterableEntry,
  type LedgerFilters,
} from './payout-ledger'

const emptyFilters: LedgerFilters = {
  search: '',
  subcontractorId: '',
  status: '',
  currency: '',
  dateFrom: '',
  dateTo: '',
}

const entries: LedgerFilterableEntry[] = [
  {
    id: 'transfer-1',
    kind: 'transfers',
    subcontractorId: 'sub-1',
    status: 'succeeded',
    currency: 'usd',
    createdAt: '2026-11-10T12:00:00.000Z',
    searchText: 'Kitchen trim Fine Finish CEDAR-01',
  },
  {
    id: 'payout-1',
    kind: 'payouts',
    subcontractorId: 'sub-2',
    status: 'failed',
    currency: 'cad',
    createdAt: '2026-11-12T12:00:00.000Z',
    searchText: 'Roofing payout North Star',
  },
]

describe('payout ledger utilities', () => {
  it('maps Stripe states to operator-facing labels', () => {
    expect(ledgerStatusLabel('transfers', 'succeeded')).toBe('Routed')
    expect(ledgerStatusLabel('transfers', 'partially_reversed')).toBe(
      'Partially reversed',
    )
    expect(ledgerStatusLabel('payouts', 'in_transit')).toBe('In transit')
    expect(ledgerStatusLabel('payouts', 'not_a_state')).toBe('Unknown')
  })

  it('filters by search, tenant relationship, status, currency, and date', () => {
    const result = filterLedgerEntries(entries, {
      ...emptyFilters,
      search: 'fine finish',
      subcontractorId: 'sub-1',
      status: 'succeeded',
      currency: 'usd',
      dateFrom: '2026-11-10',
      dateTo: '2026-11-11',
    })

    expect(result.map((entry) => entry.id)).toEqual(['transfer-1'])
  })

  it.each(['=2+3', '+SUM(A1:A2)', '-10+20', '@IMPORT', '  =cmd']) (
    'neutralizes the spreadsheet formula prefix in %s',
    (value) => {
      expect(escapeCsvCell(value)).toBe(`"'${value}"`)
    },
  )

  it('quotes CSV cells and escapes embedded quotes', () => {
    expect(createLedgerCsv(['Name'], [['ACME, "North"']])).toBe(
      '"Name"\r\n"ACME, ""North"""',
    )
  })

  it('returns safe operator guidance without echoing Stripe messages', () => {
    expect(payoutFailureRecommendation('failed', 'account_closed')).toContain(
      'update their payout account',
    )
    expect(payoutFailureRecommendation('paid', null)).toBeNull()
  })
})

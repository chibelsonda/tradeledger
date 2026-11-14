import { describe, expect, it } from 'vitest'

import type {
  FinancialReportSummary,
  FinancialStatementRow,
} from '@/lib/database.types'
import {
  createFinancialStatementCsv,
  financialEntryLabel,
  financialMetricAmounts,
  financialStatementFileName,
  netCollectedAmounts,
  reportPeriodError,
} from './financial-reporting'

const summary: FinancialReportSummary = {
  currency: 'usd',
  collected_amount: 10_000,
  refunded_amount: 1_500,
  platform_fee_amount: 300,
  routed_amount: 9_700,
  reversed_amount: 1_200,
  paid_out_amount: 8_000,
  failed_payout_amount: 400,
  disputed_amount: 500,
  payment_count: 2,
  refund_count: 1,
  transfer_count: 2,
  payout_count: 2,
}

function statementRow(overrides: Partial<FinancialStatementRow> = {}): FinancialStatementRow {
  return {
    occurred_at: '2026-11-14T05:00:00.000Z',
    entry_type: 'payment',
    reference: 'PAY-100',
    description: 'Kitchen trim milestone',
    project_name: 'Cedar Kitchen',
    subcontractor_name: 'Fine Finish Carpentry',
    amount: 10_000,
    currency: 'usd',
    status: 'paid',
    ...overrides,
  }
}

describe('financial reporting utilities', () => {
  it('validates ordered reporting periods with a bounded duration', () => {
    expect(reportPeriodError('', '2026-11-14')).toBe(
      'Choose both a start date and an end date.',
    )
    expect(reportPeriodError('2026-11-15', '2026-11-14')).toBe(
      'The end date must be on or after the start date.',
    )
    expect(reportPeriodError('2025-01-01', '2026-02-01')).toBe(
      'Reporting periods cannot exceed 367 days.',
    )
    expect(reportPeriodError('2026-11-01', '2026-11-14')).toBeNull()
  })

  it('builds currency-aware report metrics without combining currencies', () => {
    expect(financialMetricAmounts([summary], 'routed_amount')).toEqual([
      { amount: 9_700, currency: 'usd' },
    ])
    expect(netCollectedAmounts([summary])).toEqual([
      { amount: 8_500, currency: 'usd' },
    ])
  })

  it('labels statement activity for operators', () => {
    expect(financialEntryLabel('payment')).toBe('Payment collected')
    expect(financialEntryLabel('transfer_reversal')).toBe('Transfer reversal')
    expect(financialEntryLabel('payout')).toBe('Bank payout')
  })

  it('neutralizes formula injection in every user-controlled statement cell', () => {
    const csv = createFinancialStatementCsv(
      '=Unsafe organization',
      '2026-11-01',
      '2026-11-30',
      [
        statementRow({
          reference: '+REFERENCE',
          description: '-cmd',
          project_name: '@PROJECT',
          subcontractor_name: '  =SUBCONTRACTOR',
        }),
      ],
    )

    expect(csv).toContain("\"'=Unsafe organization\"")
    expect(csv).toContain("\"'+REFERENCE\"")
    expect(csv).toContain("\"'-cmd\"")
    expect(csv).toContain("\"'@PROJECT\"")
    expect(csv).toContain("\"'  =SUBCONTRACTOR\"")
  })

  it('creates a bounded filesystem-safe statement filename', () => {
    expect(
      financialStatementFileName(
        'North Ridge / Contracting',
        '2026-11-01',
        '2026-11-30',
        'USD',
      ),
    ).toBe(
      'tradeledger-statement-north-ridge-contracting-2026-11-01-2026-11-30-usd.csv',
    )
  })
})

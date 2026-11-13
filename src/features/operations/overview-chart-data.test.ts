import { describe, expect, it } from 'vitest'

import {
  buildMonthlyFinancialData,
  buildPaymentStatusData,
  type ChartPaymentRequest,
} from './overview-chart-data'

function request(
  overrides: Partial<ChartPaymentRequest>,
): ChartPaymentRequest {
  return {
    created_at: '2026-11-13T04:00:00.000Z',
    gross_amount: 10_000,
    net_amount: 9_000,
    status: 'draft',
    ...overrides,
  }
}

describe('overview chart data', () => {
  it('groups gross and net request value into the latest six months', () => {
    const result = buildMonthlyFinancialData(
      [
        request({ created_at: '2026-10-12T08:00:00.000Z' }),
        request({
          created_at: '2026-10-28T08:00:00.000Z',
          gross_amount: 5_000,
          net_amount: 4_500,
        }),
        request({ created_at: '2026-05-01T00:00:00.000Z' }),
      ],
      new Date('2026-11-13T00:00:00.000Z'),
    )

    expect(result).toHaveLength(6)
    expect(result[0]?.key).toBe('2026-06')
    expect(result.find((point) => point.key === '2026-10')).toMatchObject({
      gross: 15_000,
      net: 13_500,
    })
    expect(result.find((point) => point.key === '2026-11')).toMatchObject({
      gross: 0,
      net: 0,
    })
  })

  it('groups workflow states into operational categories', () => {
    const result = buildPaymentStatusData([
      request({ status: 'draft' }),
      request({ status: 'processing' }),
      request({ status: 'partially_refunded' }),
      request({ status: 'failed' }),
      request({ status: 'failed' }),
    ])

    expect(result.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: 'draft', count: 1 },
      { key: 'checkout', count: 1 },
      { key: 'refunded', count: 1 },
      { key: 'exception', count: 2 },
    ])
  })

  it('returns an empty status series when no requests exist', () => {
    expect(buildPaymentStatusData([])).toEqual([])
  })
})

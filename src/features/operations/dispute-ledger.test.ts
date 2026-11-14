import { describe, expect, it } from 'vitest'

import {
  disputeDeadlineState,
  disputeIsLost,
  disputeNeedsResponse,
  disputeStatusLabel,
  filterDisputes,
} from './dispute-ledger'

describe('dispute ledger utilities', () => {
  it('uses operator-facing status labels', () => {
    expect(disputeStatusLabel('needs_response')).toBe('Response required')
    expect(disputeStatusLabel('appeal_under_review')).toBe('Appeal under review')
    expect(disputeStatusLabel('invented')).toBe('Unknown')
  })

  it('identifies response and recovery states', () => {
    expect(disputeNeedsResponse('warning_needs_response')).toBe(true)
    expect(disputeNeedsResponse('under_review')).toBe(false)
    expect(disputeIsLost('appeal_lost')).toBe(true)
    expect(disputeIsLost('won')).toBe(false)
  })

  it('classifies evidence deadlines without local-time string parsing', () => {
    const now = new Date('2026-11-14T00:00:00.000Z')
    expect(disputeDeadlineState(null, now)).toBe('none')
    expect(disputeDeadlineState('2026-11-13T23:59:59.000Z', now)).toBe('overdue')
    expect(disputeDeadlineState('2026-11-16T00:00:00.000Z', now)).toBe('urgent')
    expect(disputeDeadlineState('2026-11-20T00:00:00.000Z', now)).toBe('upcoming')
  })

  it('filters by normalized search and exact status', () => {
    const disputes = [
      {
        status: 'needs_response' as const,
        searchText: 'Cedar Library Fine Finish',
      },
      { status: 'won' as const, searchText: 'North Star Roofing' },
    ]

    expect(filterDisputes(disputes, ' fine finish ', 'needs_response')).toEqual([
      disputes[0],
    ])
  })
})

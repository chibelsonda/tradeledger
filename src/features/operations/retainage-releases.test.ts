import { describe, expect, it } from 'vitest'

import type { RetainageRelease } from '@/lib/database.types'

import {
  committedRetainageAmount,
  parseCurrencyInputToMinorUnits,
  remainingRetainageAmount,
  retainageReleaseStatusLabel,
} from './retainage-releases'

function release(
  overrides: Partial<RetainageRelease> = {},
): RetainageRelease {
  return {
    id: 'release-1',
    organization_id: 'organization-1',
    payment_request_id: 'request-1',
    project_id: 'project-1',
    subcontractor_id: 'subcontractor-1',
    payout_account_id: null,
    requested_by: 'user-1',
    approved_by: null,
    reference: 'reference-1',
    reason: 'Completed punch-list work',
    amount: 4_000,
    currency: 'usd',
    status: 'paid',
    platform_fee_basis_points: 0,
    platform_fee_fixed_amount: 0,
    platform_fee_amount: 0,
    platform_fee_configured_at: null,
    amount_refunded: 0,
    requested_at: '2026-11-14T00:00:00Z',
    approved_at: null,
    checkout_started_at: null,
    paid_at: null,
    failed_at: null,
    canceled_at: null,
    refunded_at: null,
    created_at: '2026-11-14T00:00:00Z',
    updated_at: '2026-11-14T00:00:00Z',
    ...overrides,
  }
}

describe('retainage release calculations', () => {
  it('subtracts active release balances and restores refunded amounts', () => {
    const releases = [
      release(),
      release({ id: 'release-2', amount: 3_000, amount_refunded: 1_000 }),
      release({ id: 'release-3', amount: 5_000, status: 'canceled' }),
    ]

    expect(committedRetainageAmount(releases, 'request-1')).toBe(6_000)
    expect(
      remainingRetainageAmount(
        { id: 'request-1', retainage_amount: 10_000 },
        releases,
      ),
    ).toBe(4_000)
  })

  it('never exposes a negative remaining balance', () => {
    expect(
      remainingRetainageAmount(
        { id: 'request-1', retainage_amount: 1_000 },
        [release({ amount: 2_000 })],
      ),
    ).toBe(0)
  })

  it('parses currency values without floating-point rounding', () => {
    expect(parseCurrencyInputToMinorUnits('105.09')).toBe(10_509)
    expect(parseCurrencyInputToMinorUnits('8.5')).toBe(850)
    expect(parseCurrencyInputToMinorUnits('0')).toBeNull()
    expect(parseCurrencyInputToMinorUnits('1.999')).toBeNull()
    expect(parseCurrencyInputToMinorUnits('-1')).toBeNull()
  })

  it('uses explicit user-facing lifecycle labels', () => {
    expect(retainageReleaseStatusLabel('requested')).toBe('Approval requested')
    expect(retainageReleaseStatusLabel('partially_refunded')).toBe(
      'Partially refunded',
    )
  })
})

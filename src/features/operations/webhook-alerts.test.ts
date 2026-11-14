import { describe, expect, it } from 'vitest'

import type { StripeWebhookFailure } from '@/lib/database.types'
import {
  canRecoverWebhookFailure,
  filterWebhookAlerts,
  webhookAlertSeverity,
  webhookRecoveryGuidance,
} from './webhook-alerts'

function failure(
  overrides: Partial<StripeWebhookFailure> = {},
): StripeWebhookFailure {
  return {
    id: 1,
    organization_id: '7b85b85d-7526-4bb1-8492-a87c205449d0',
    event_id: 'evt_test_001',
    event_type: 'refund.updated',
    object_id: 're_test_001',
    error_code: 'ledger_failed',
    error_message: 'Internal detail',
    attempts: 1,
    first_failed_at: '2026-11-14T09:30:00.000Z',
    last_failed_at: '2026-11-14T09:30:00.000Z',
    resolved_at: null,
    resolution: null,
    recovery_status: 'pending',
    recovery_attempts: 0,
    last_recovery_requested_at: null,
    last_recovery_requested_by: null,
    ...overrides,
  }
}

const now = new Date('2026-11-14T10:00:00.000Z').getTime()

describe('webhook alert utilities', () => {
  it('escalates repeated, failed, and stale incidents', () => {
    expect(webhookAlertSeverity(failure(), now)).toBe('notice')
    expect(webhookAlertSeverity(failure({ attempts: 2 }), now)).toBe('warning')
    expect(webhookAlertSeverity(failure({ attempts: 5 }), now)).toBe('critical')
    expect(webhookAlertSeverity(failure({ recovery_status: 'failed' }), now))
      .toBe('critical')
  })

  it('only offers automated recovery for supported unresolved tenant events', () => {
    expect(canRecoverWebhookFailure(failure())).toBe(true)
    expect(canRecoverWebhookFailure(failure({ organization_id: null }))).toBe(false)
    expect(canRecoverWebhookFailure(failure({ event_type: 'customer.updated' })))
      .toBe(false)
    expect(canRecoverWebhookFailure(failure({ resolved_at: '2026-11-14T10:00:00Z' })))
      .toBe(false)
  })

  it('filters by lifecycle, severity, and safe identifiers', () => {
    const resolved = failure({
      id: 2,
      event_id: 'evt_resolved',
      resolved_at: '2026-11-14T09:45:00.000Z',
      recovery_status: 'resolved',
    })

    expect(filterWebhookAlerts([failure(), resolved], {
      tab: 'open',
      severity: 'notice',
      search: 'refund',
    }, now).map((item) => item.id)).toEqual([1])
    expect(filterWebhookAlerts([failure(), resolved], {
      tab: 'resolved',
      severity: '',
      search: 'evt_resolved',
    }, now).map((item) => item.id)).toEqual([2])
  })

  it('returns event-specific guidance without exposing stored error messages', () => {
    expect(webhookRecoveryGuidance('account.updated')).toContain('payout readiness')
    expect(webhookRecoveryGuidance('charge.dispute.updated')).toContain('dispute')
    expect(webhookRecoveryGuidance('refund.failed')).toContain('refund history')
  })
})

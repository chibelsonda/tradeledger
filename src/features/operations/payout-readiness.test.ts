import { describe, expect, it } from 'vitest'

import {
  isPayoutActionForPaymentRequest,
  isPayoutReady,
} from './payout-readiness'

describe('payout readiness', () => {
  it('marks only the clicked payment request as opening', () => {
    const target = {
      subcontractorId: 'subcontractor-1',
      paymentRequestId: 'request-1',
    }

    expect(isPayoutActionForPaymentRequest(target, 'request-1')).toBe(true)
    expect(isPayoutActionForPaymentRequest(target, 'request-2')).toBe(false)
  })

  it('requires both a ready status and enabled payouts', () => {
    expect(
      isPayoutReady({
        onboarding_status: 'ready',
        payouts_enabled: true,
      } as Parameters<typeof isPayoutReady>[0]),
    ).toBe(true)
    expect(
      isPayoutReady({
        onboarding_status: 'ready',
        payouts_enabled: false,
      } as Parameters<typeof isPayoutReady>[0]),
    ).toBe(false)
  })
})

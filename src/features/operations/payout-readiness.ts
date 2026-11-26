import type { SubcontractorPayoutAccount } from '@/lib/database.types'

export interface PayoutActionTarget {
  subcontractorId: string
  paymentRequestId: string | null
}

export function isPayoutReady(
  account: SubcontractorPayoutAccount | undefined,
): boolean {
  return account?.onboarding_status === 'ready' && account.payouts_enabled
}

export function isPayoutActionForPaymentRequest(
  target: PayoutActionTarget | null,
  paymentRequestId: string,
): boolean {
  return target?.paymentRequestId === paymentRequestId
}

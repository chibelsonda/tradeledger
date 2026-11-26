import type { SubcontractorPayoutAccount } from '@/lib/database.types'

export function isPayoutReady(
  account: SubcontractorPayoutAccount | undefined,
): boolean {
  return account?.onboarding_status === 'ready' && account.payouts_enabled
}

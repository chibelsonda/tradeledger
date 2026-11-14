import { Button } from '@headlessui/react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import type { SubcontractorPayoutAccount } from '@/lib/database.types'

interface PayoutReadinessControlProps {
  account: SubcontractorPayoutAccount | undefined
  canManage: boolean
  isBusy: boolean
  onRefresh: () => void
  onStartOnboarding: () => void
}

function readinessLabel(account: SubcontractorPayoutAccount | undefined): string {
  if (!account) return 'Not configured'
  if (account.onboarding_status === 'ready') return 'Ready'
  if (account.onboarding_status === 'restricted') return 'Action required'
  return account.details_submitted ? 'Under review' : 'Setup incomplete'
}

function readinessClassName(
  account: SubcontractorPayoutAccount | undefined,
): string {
  if (account?.onboarding_status === 'ready') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }

  if (account?.onboarding_status === 'restricted') {
    return 'border-red-200 bg-red-50 text-red-800'
  }

  if (account) return 'border-amber-200 bg-amber-50 text-amber-800'

  return 'border-ink/10 bg-cream text-ink/75'
}

function actionLabel(account: SubcontractorPayoutAccount | undefined): string {
  if (!account) return 'Set up payouts'
  if (account.onboarding_status === 'ready') return 'Refresh'
  return 'Continue setup'
}

function readinessDetail(
  account: SubcontractorPayoutAccount | undefined,
): string {
  if (!account) return 'Stripe Connect'
  if (account.payouts_enabled) return 'Payouts enabled'

  const pastDue = account.requirements_past_due.length
  if (pastDue > 0) {
    return `${pastDue} past-due requirement${pastDue === 1 ? '' : 's'}`
  }

  const currentlyDue = account.requirements_currently_due.length
  if (currentlyDue > 0) {
    return `${currentlyDue} requirement${currentlyDue === 1 ? '' : 's'} remaining`
  }

  return account.details_submitted ? 'Verification in progress' : 'Onboarding required'
}

export function PayoutReadinessControl({
  account,
  canManage,
  isBusy,
  onRefresh,
  onStartOnboarding,
}: PayoutReadinessControlProps) {
  const isReady = account?.onboarding_status === 'ready'

  return (
    <div className="flex min-w-[150px] flex-col items-start gap-2">
      <span
        className={
          'inline-flex border px-2.5 py-1 text-[11px] font-bold ' +
          readinessClassName(account)
        }
      >
        {readinessLabel(account)}
      </span>
      <span className="text-[10px] font-medium text-ink/60">
        {readinessDetail(account)}
      </span>

      {canManage && (
        <Button
          type="button"
          disabled={isBusy}
          onClick={isReady ? onRefresh : onStartOnboarding}
          className="inline-flex min-h-8 items-center justify-center gap-2 border border-ink/15 bg-white px-3 text-[11px] font-bold text-ink transition hover:border-forest hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy && <ButtonSpinner />}
          {actionLabel(account)}
        </Button>
      )}
    </div>
  )
}

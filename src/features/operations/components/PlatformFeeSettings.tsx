import { Button, Field, Input, Label } from '@headlessui/react'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { FieldError } from '@/components/ui/FieldError'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import type {
  OrganizationPlatformFee,
  OrganizationRole,
} from '@/lib/database.types'
import { formatCurrency } from '@/lib/format'
import { safeDatabaseErrorMessage } from '@/lib/public-errors'
import { supabase } from '@/lib/supabase'
import { platformFeeFormSchema } from '@/features/operations/operations.schemas'
import {
  basisPointsToPercentageInput,
  calculatePlatformFee,
  minorUnitsToDecimalInput,
  nonNegativeDecimalToMinorUnits,
  percentageToBasisPoints,
} from '@/features/operations/platform-fees'

interface PlatformFeeSettingsProps {
  organizationId: string
  role: OrganizationRole
  fees: OrganizationPlatformFee[]
  isLoading: boolean
  onSaved: () => Promise<void>
}

const fieldClassName =
  'h-11 w-full border border-ink/15 bg-white px-3.5 text-sm font-semibold text-ink outline-none transition placeholder:text-ink/55 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20'

function percentageLabel(basisPoints: number): string {
  return `${(basisPoints / 100).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`
}

export function PlatformFeeSettings({
  organizationId,
  role,
  fees,
  isLoading,
  onSaved,
}: PlatformFeeSettingsProps) {
  const configuration = fees.find((fee) => fee.currency === 'usd') ?? null
  const canEdit = role === 'owner' || role === 'admin'
  const [enabled, setEnabled] = useState(false)
  const [percentage, setPercentage] = useState('0')
  const [fixedAmount, setFixedAmount] = useState('0.00')
  const [percentageError, setPercentageError] = useState<string | undefined>()
  const [fixedAmountError, setFixedAmountError] = useState<string | undefined>()
  const [serverError, setServerError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setEnabled(configuration?.enabled ?? false)
      setPercentage(
        basisPointsToPercentageInput(configuration?.percentage_basis_points ?? 0),
      )
      setFixedAmount(minorUnitsToDecimalInput(configuration?.fixed_amount ?? 0))
      setPercentageError(undefined)
      setFixedAmountError(undefined)
      setServerError(null)
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [
    configuration?.enabled,
    configuration?.fixed_amount,
    configuration?.percentage_basis_points,
    organizationId,
  ])

  const preview = useMemo(() => {
    const basisPoints = percentageToBasisPoints(percentage)
    const fixedMinorUnits = nonNegativeDecimalToMinorUnits(fixedAmount)

    if (!enabled || basisPoints === null || fixedMinorUnits === null) return null

    try {
      return calculatePlatformFee(100_000, basisPoints, fixedMinorUnits)
    } catch {
      return null
    }
  }, [enabled, fixedAmount, percentage])

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || isSaving) return

    setPercentageError(undefined)
    setFixedAmountError(undefined)
    setServerError(null)
    setNotice(null)

    const validation = platformFeeFormSchema.safeParse({
      enabled,
      percentage,
      fixedAmount,
    })

    if (!validation.success) {
      for (const issue of validation.error.issues) {
        if (issue.path[0] === 'percentage') setPercentageError(issue.message)
        if (issue.path[0] === 'fixedAmount') setFixedAmountError(issue.message)
      }
      return
    }

    setIsSaving(true)
    const { error } = await supabase.rpc('set_organization_platform_fee', {
      p_organization_id: organizationId,
      p_currency: 'usd',
      p_percentage_basis_points: validation.data.percentage,
      p_fixed_amount: validation.data.fixedAmount,
      p_enabled: validation.data.enabled,
    })

    if (error) {
      setServerError(
        safeDatabaseErrorMessage(
          error,
          'The platform fee policy could not be saved. Please try again.',
        ),
      )
      setIsSaving(false)
      return
    }

    await onSaved()
    setNotice(
      validation.data.enabled
        ? 'Platform fee policy saved. It will apply to newly prepared USD checkouts.'
        : 'Platform fees are disabled for newly prepared USD checkouts.',
    )
    setIsSaving(false)
  }

  if (isLoading) {
    return (
      <section className="grid min-h-72 place-items-center border border-ink/10 bg-white p-8">
        <div className="flex items-center gap-3 text-sm font-semibold text-forest">
          <span className="size-5 animate-spin rounded-full border-2 border-forest/15 border-t-forest" />
          Loading fee policy…
        </div>
      </section>
    )
  }

  const storedBasisPoints = configuration?.percentage_basis_points ?? 0
  const storedFixedAmount = configuration?.fixed_amount ?? 0

  return (
    <section aria-labelledby="platform-fee-settings-heading" className="grid gap-6">
      {serverError && (
        <NotificationBanner tone="error">
          <p className="font-bold">Fee policy could not be saved</p>
          <p className="mt-1 text-sm">{serverError}</p>
        </NotificationBanner>
      )}
      {notice && (
        <NotificationBanner tone="success">
          <p>{notice}</p>
        </NotificationBanner>
      )}

      <div className="grid gap-px border border-ink/10 bg-ink/10 sm:grid-cols-3">
        <article className="bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Collection status
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-[-0.04em] text-ink">
            {configuration?.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/70">USD destination charges</p>
        </article>
        <article className="bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Percentage fee
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-[-0.04em] text-ink">
            {percentageLabel(storedBasisPoints)}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/70">Rounded to the minor unit</p>
        </article>
        <article className="bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Fixed fee
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-[-0.04em] text-ink">
            {formatCurrency(storedFixedAmount, 'usd')}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/70">Added after percentage</p>
        </article>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        <form
          onSubmit={(event) => void saveConfiguration(event)}
          className="border border-ink/10 bg-white p-6 shadow-[0_14px_36px_rgba(19,37,31,0.05)] sm:p-7"
        >
          <div className="flex flex-col gap-4 border-b border-ink/10 pb-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-forest/75">
                Server-owned pricing
              </p>
              <h2
                id="platform-fee-settings-heading"
                className="mt-2 text-xl font-extrabold tracking-[-0.035em] text-ink"
              >
                USD platform fee policy
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
                Stripe deducts this application fee from the destination transfer. The payer’s
                approved amount does not increase.
              </p>
            </div>
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 border border-ink/15 bg-cream px-3.5 py-2 text-sm font-bold text-ink">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={!canEdit || isSaving}
                className="size-4 accent-forest"
              />
              Collect fee
            </label>
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Field>
              <Label className="text-xs font-bold uppercase tracking-[0.12em] text-ink/75">
                Percentage
              </Label>
              <div className="relative mt-2">
                <Input
                  value={percentage}
                  onChange={(event) => {
                    setPercentage(event.target.value)
                    setPercentageError(undefined)
                  }}
                  disabled={!canEdit || isSaving}
                  inputMode="decimal"
                  aria-invalid={Boolean(percentageError) || undefined}
                  aria-describedby={percentageError ? 'platform-fee-percentage-error' : undefined}
                  className={`${fieldClassName} pr-10`}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-bold text-ink/55">
                  %
                </span>
              </div>
              <FieldError id="platform-fee-percentage-error" message={percentageError} />
            </Field>

            <Field>
              <Label className="text-xs font-bold uppercase tracking-[0.12em] text-ink/75">
                Fixed amount
              </Label>
              <div className="relative mt-2">
                <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm font-bold text-ink/55">
                  $
                </span>
                <Input
                  value={fixedAmount}
                  onChange={(event) => {
                    setFixedAmount(event.target.value)
                    setFixedAmountError(undefined)
                  }}
                  disabled={!canEdit || isSaving}
                  inputMode="decimal"
                  aria-invalid={Boolean(fixedAmountError) || undefined}
                  aria-describedby={fixedAmountError ? 'platform-fee-fixed-error' : undefined}
                  className={`${fieldClassName} pl-8`}
                />
              </div>
              <FieldError id="platform-fee-fixed-error" message={fixedAmountError} />
            </Field>
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-ink/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-xs leading-5 text-ink/65">
              Existing payments retain their original fee snapshot. Refunds reverse the transfer
              and return the proportional application fee.
            </p>
            {canEdit ? (
              <Button
                type="submit"
                disabled={isSaving}
                aria-busy={isSaving}
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 bg-forest px-5 text-sm font-bold text-white transition hover:bg-ink disabled:cursor-wait disabled:opacity-60"
              >
                {isSaving && <ButtonSpinner tone="light" />}
                {isSaving ? 'Saving…' : 'Save fee policy'}
              </Button>
            ) : (
              <span className="border border-ink/15 bg-cream px-3 py-2 text-xs font-bold text-ink/70">
                View only
              </span>
            )}
          </div>
        </form>

        <aside className="border border-forest/15 bg-forest p-6 text-white sm:p-7">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-mint/80">
            Checkout example
          </p>
          <h3 className="mt-2 text-lg font-extrabold tracking-[-0.03em]">
            $1,000.00 approved payment
          </h3>
          <dl className="mt-6 grid gap-4 text-sm">
            <div className="flex items-center justify-between gap-4 border-b border-white/15 pb-3">
              <dt className="text-white/70">Platform fee</dt>
              <dd className="font-bold tabular-nums">
                {enabled && preview
                  ? formatCurrency(preview.platformFeeAmount, 'usd')
                  : '$0.00'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-white/15 pb-3">
              <dt className="text-white/70">Subcontractor transfer</dt>
              <dd className="font-bold tabular-nums">
                {enabled && preview
                  ? formatCurrency(preview.subcontractorTransferAmount, 'usd')
                  : '$1,000.00'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-white/70">Payer total</dt>
              <dd className="font-bold tabular-nums">$1,000.00</dd>
            </div>
          </dl>
          {enabled && !preview && (
            <p className="mt-5 border border-amber-200/30 bg-amber-100/10 p-3 text-xs leading-5 text-amber-50">
              Enter a valid fee lower than the example payment to preview the split.
            </p>
          )}
        </aside>
      </div>
    </section>
  )
}

import { Button, Input } from '@headlessui/react'
import { useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import {
  canRecoverWebhookFailure,
  filterWebhookAlerts,
  webhookAlertSeverity,
  webhookRecoveryGuidance,
  type WebhookAlertSeverity,
  type WebhookAlertTab,
} from '@/features/operations/webhook-alerts'
import type { StripeWebhookFailure } from '@/lib/database.types'
import { formatStatus } from '@/lib/format'
import { supabase } from '@/lib/supabase'

interface WebhookOperationsProps {
  failures: StripeWebhookFailure[]
  isLoading: boolean
  onRefresh: () => Promise<void>
}

const controlClassName =
  'h-10 w-full border border-ink/15 bg-white px-3 text-sm font-medium text-ink outline-none transition placeholder:text-ink/55 focus:border-forest focus:ring-2 focus:ring-forest/10'

const severityOptions = [
  { value: '', label: 'All severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'notice', label: 'Notice' },
]

function displayDate(value: string | null): string {
  if (!value) return 'Not available'

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function severityClassName(severity: WebhookAlertSeverity): string {
  if (severity === 'critical') return 'border-red-200 bg-red-50 text-red-800'
  if (severity === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800'
  return 'border-sky-200 bg-sky-50 text-sky-800'
}

async function edgeErrorMessage(error: unknown): Promise<string> {
  const candidate = error as { context?: unknown } | null
  if (candidate?.context instanceof Response) {
    const payload = (await candidate.context.json().catch(() => null)) as
      | { error?: unknown }
      | null
    if (typeof payload?.error === 'string') return payload.error
  }

  return 'The webhook event could not be recovered. Please try again.'
}

export function WebhookOperations({
  failures,
  isLoading,
  onRefresh,
}: WebhookOperationsProps) {
  const [tab, setTab] = useState<WebhookAlertTab>('open')
  const [severity, setSeverity] = useState<'' | WebhookAlertSeverity>('')
  const [search, setSearch] = useState('')
  const [recoveringId, setRecoveringId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const openFailures = failures.filter((failure) => failure.resolved_at === null)
  const resolvedFailures = failures.filter((failure) => failure.resolved_at !== null)
  const criticalCount = openFailures.filter(
    (failure) => webhookAlertSeverity(failure, now) === 'critical',
  ).length
  const filteredFailures = useMemo(
    () => filterWebhookAlerts(failures, { tab, severity, search }, now),
    [failures, now, search, severity, tab],
  )

  const recover = async (failure: StripeWebhookFailure) => {
    setRecoveringId(failure.id)
    setNotice(null)
    setError(null)

    const { error: functionError } = await supabase.functions.invoke(
      'recover-webhook-failure',
      { body: { failureId: failure.id } },
    )

    if (functionError) {
      setError(await edgeErrorMessage(functionError))
      setRecoveringId(null)
      return
    }

    setNotice('Recovery completed and the ledger was reconciled from Stripe.')
    await onRefresh()
    setRecoveringId(null)
  }

  return (
    <section className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <article className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Open incidents
          </p>
          <p className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
            {openFailures.length}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/65">
            Awaiting reconciliation
          </p>
        </article>
        <article className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Critical
          </p>
          <p className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-red-800">
            {criticalCount}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/65">
            Repeated, stale, or failed recovery
          </p>
        </article>
        <article className="border border-ink/10 bg-white p-4 shadow-[0_12px_28px_rgba(19,37,31,0.045)]">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink/65">
            Resolved history
          </p>
          <p className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-forest">
            {resolvedFailures.length}
          </p>
          <p className="mt-1 text-xs font-medium text-ink/65">
            Retained for operator evidence
          </p>
        </article>
      </div>

      {notice && <NotificationBanner tone="success">{notice}</NotificationBanner>}
      {error && <NotificationBanner tone="error">{error}</NotificationBanner>}

      <div className="border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col gap-4 border-b border-ink/10 p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/75">
              Payment operations
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">
              Webhook incident queue
            </h2>
            <p className="mt-1 text-sm leading-6 text-ink/70">
              Recover signed Stripe events through audited, tenant-scoped reconciliation.
            </p>
          </div>
          <Button
            type="button"
            disabled={isLoading}
            onClick={() => void onRefresh()}
            className="h-10 border border-ink/15 bg-white px-4 text-xs font-bold text-ink transition hover:border-forest hover:text-forest disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? 'Refreshing…' : 'Refresh queue'}
          </Button>
        </div>

        <div className="grid gap-3 border-b border-ink/10 bg-cream/40 p-4 md:grid-cols-[auto_1fr_180px]">
          <div className="flex" role="tablist" aria-label="Webhook incident state">
            {(['open', 'resolved'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`h-10 border px-4 text-xs font-bold transition ${
                  tab === value
                    ? 'border-forest bg-forest text-white'
                    : 'border-ink/15 bg-white text-ink hover:border-forest'
                }`}
              >
                {value === 'open' ? `Open (${openFailures.length})` : `Resolved (${resolvedFailures.length})`}
              </Button>
            ))}
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search event type, ID, or code"
            aria-label="Search webhook incidents"
            className={controlClassName}
          />
          <SelectControl
            value={severity}
            options={severityOptions}
            onChange={(value) => setSeverity(value as '' | WebhookAlertSeverity)}
            ariaLabel="Filter webhook incidents by severity"
            className={controlClassName}
          />
        </div>

        {isLoading && failures.length === 0 ? (
          <p className="p-6 text-sm font-medium text-ink/65">Loading webhook incidents…</p>
        ) : filteredFailures.length === 0 ? (
          <div className="p-6">
            <p className="border border-dashed border-forest/20 bg-forest/[0.035] p-5 text-sm font-medium text-ink/75">
              {tab === 'open'
                ? 'No webhook incidents match this view. Signed payment events are healthy.'
                : 'No resolved webhook incidents match this view.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-ink/10">
            {filteredFailures.map((failure) => {
              const alertSeverity = webhookAlertSeverity(failure, now)
              const recoverable = canRecoverWebhookFailure(failure)
              const isRecovering = recoveringId === failure.id

              return (
                <article key={failure.id} className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${severityClassName(alertSeverity)}`}>
                          {alertSeverity}
                        </span>
                        <span className="border border-ink/10 bg-cream px-2 py-1 font-mono text-[10px] font-bold text-ink/75">
                          {failure.event_type}
                        </span>
                        <span className="text-[11px] font-bold text-ink/60">
                          {failure.attempts} delivery {failure.attempts === 1 ? 'attempt' : 'attempts'}
                        </span>
                      </div>
                      <p className="mt-3 text-sm font-semibold leading-6 text-ink">
                        {webhookRecoveryGuidance(failure.event_type)}
                      </p>
                      <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs text-ink/65 sm:grid-cols-2 xl:grid-cols-4">
                        <div>
                          <dt className="font-bold text-ink/45">Event ID</dt>
                          <dd className="mt-1 truncate font-mono">{failure.event_id}</dd>
                        </div>
                        <div>
                          <dt className="font-bold text-ink/45">Failure code</dt>
                          <dd className="mt-1">{failure.error_code ?? 'processing_error'}</dd>
                        </div>
                        <div>
                          <dt className="font-bold text-ink/45">Last failure</dt>
                          <dd className="mt-1">{displayDate(failure.last_failed_at)}</dd>
                        </div>
                        <div>
                          <dt className="font-bold text-ink/45">Recovery</dt>
                          <dd className="mt-1">
                            {formatStatus(
                              failure.resolution ?? failure.recovery_status,
                            )}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    {tab === 'open' && (
                      <div className="shrink-0 lg:w-48">
                        <Button
                          type="button"
                          disabled={!recoverable || recoveringId !== null}
                          onClick={() => void recover(failure)}
                          className="flex h-10 w-full items-center justify-center gap-2 bg-forest px-4 text-xs font-extrabold text-white transition hover:bg-forest/90 disabled:cursor-not-allowed disabled:bg-ink/20"
                        >
                          {isRecovering && <ButtonSpinner />}
                          {isRecovering ? 'Recovering…' : 'Recover from Stripe'}
                        </Button>
                        {!recoverable && (
                          <p className="mt-2 text-[11px] leading-4 text-ink/55">
                            Manual Stripe review is required for this event.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

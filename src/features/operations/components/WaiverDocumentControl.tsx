import { Button } from '@headlessui/react'

import type {
  PaymentRequestStatus,
  WaiverDocument,
} from '../../../lib/database.types'

interface WaiverDocumentControlProps {
  requestStatus: PaymentRequestStatus
  waiver: WaiverDocument | undefined
  canGenerate: boolean
  canDownload: boolean
  isBusy: boolean
  isDisabled: boolean
  onGenerate: () => void
  onDownload: () => void
}

export function WaiverDocumentControl({
  requestStatus,
  waiver,
  canGenerate,
  canDownload,
  isBusy,
  isDisabled,
  onGenerate,
  onDownload,
}: WaiverDocumentControlProps) {
  if (waiver?.status === 'ready' && canDownload) {
    return (
      <Button
        type="button"
        disabled={isDisabled}
        aria-busy={isBusy}
        onClick={onDownload}
        className="inline-flex items-center justify-center gap-2 border border-forest/20 bg-mint/10 px-3 py-2 text-xs font-bold text-forest transition hover:bg-mint/20 disabled:cursor-wait disabled:opacity-50"
      >
        {isBusy ? 'Signing link…' : 'Download PDF'}
      </Button>
    )
  }

  if (waiver?.status === 'generating') {
    return (
      <span className="border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800">
        Preparing
      </span>
    )
  }

  if (waiver?.status === 'voided') {
    return (
      <span
        title={waiver.void_reason ?? undefined}
        className="border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700"
      >
        Waiver voided
      </span>
    )
  }

  if (requestStatus === 'paid' && canGenerate) {
    return (
      <Button
        type="button"
        disabled={isDisabled}
        aria-busy={isBusy}
        onClick={onGenerate}
        className="inline-flex items-center justify-center gap-2 border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:bg-cream disabled:cursor-wait disabled:opacity-50"
      >
        {isBusy
          ? 'Generating…'
          : waiver?.status === 'failed'
            ? 'Retry waiver'
            : 'Generate waiver'}
      </Button>
    )
  }

  return <span className="text-xs text-ink/30">—</span>
}

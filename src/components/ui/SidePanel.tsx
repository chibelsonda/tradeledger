import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogPanel,
} from '@headlessui/react'
import type { ReactNode } from 'react'

interface SidePanelProps {
  open: boolean
  busy?: boolean
  children: ReactNode
  onClose: () => void
  className?: string
}

export function SidePanel({
  open,
  busy = false,
  children,
  onClose,
  className = '',
}: SidePanelProps) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      className="relative z-50"
    >
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-ink/45 transition-opacity duration-150 ease-linear data-closed:opacity-0 motion-reduce:transition-none"
      />
      <div className="fixed inset-0 flex justify-end overflow-hidden">
        <DialogPanel
          transition
          className={`relative h-full w-full max-w-xl transform-gpu overflow-y-auto border-l border-ink/15 bg-white shadow-[-24px_0_64px_rgba(19,37,31,0.2)] transition-transform duration-[240ms] ease-out will-change-transform data-closed:translate-x-full motion-reduce:transition-none ${className}`}
        >
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  )
}

interface SidePanelCloseButtonProps {
  disabled?: boolean
  onClick: () => void
}

export function SidePanelCloseButton({
  disabled = false,
  onClick,
}: SidePanelCloseButtonProps) {
  return (
    <Button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label="Close panel"
      className="absolute top-5 right-5 inline-grid size-9 place-items-center text-ink/60 transition-colors hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:opacity-40 sm:top-7 sm:right-7"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="size-5"
      >
        <path d="m5 5 10 10M15 5 5 15" />
      </svg>
    </Button>
  )
}

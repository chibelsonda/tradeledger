import type { ReactNode } from 'react'

type NotificationTone = 'success' | 'error' | 'warning' | 'info'

interface NotificationBannerProps {
  children: ReactNode
  tone: NotificationTone
  className?: string
}

const toneStyles: Record<
  NotificationTone,
  { container: string; icon: string }
> = {
  success: {
    container: 'border-forest/15 bg-forest/[0.045] text-ink',
    icon: 'text-forest',
  },
  error: {
    container: 'border-red-950/15 bg-red-950/[0.035] text-red-950',
    icon: 'text-red-800',
  },
  warning: {
    container: 'border-amber-950/20 bg-amber-950/[0.04] text-amber-950',
    icon: 'text-amber-800',
  },
  info: {
    container: 'border-sky-950/15 bg-sky-950/[0.035] text-sky-950',
    icon: 'text-sky-800',
  },
}

export function NotificationBanner({
  children,
  tone,
  className = '',
}: NotificationBannerProps) {
  const styles = toneStyles[tone]
  const isUrgent = tone === 'error' || tone === 'warning'

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      className={`flex items-start gap-3 border px-4 py-3 text-sm leading-6 font-medium ${styles.container} ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        className={`mt-0.5 size-4 shrink-0 ${styles.icon}`}
        aria-hidden="true"
      >
        {tone === 'success' && (
          <>
            <circle cx="10" cy="10" r="7.25" />
            <path d="m6.75 10 2.1 2.1 4.4-4.5" />
          </>
        )}
        {tone === 'error' && (
          <>
            <circle cx="10" cy="10" r="7.25" />
            <path d="M10 5.75v5.1M10 13.8v.1" />
          </>
        )}
        {tone === 'warning' && (
          <>
            <path d="M9.98 2.7 17.3 16H2.7L9.98 2.7Z" />
            <path d="M10 7v4.2M10 13.8v.1" />
          </>
        )}
        {tone === 'info' && (
          <>
            <circle cx="10" cy="10" r="7.25" />
            <path d="M10 8.7v5M10 6.1v.1" />
          </>
        )}
      </svg>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

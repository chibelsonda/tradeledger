import { Button } from '@headlessui/react'

export interface DashboardNavigationItem {
  id: string
  href: string
  label: string
  detail: string
  badge?: string
}

interface DashboardSidebarProps {
  email: string | undefined
  items: DashboardNavigationItem[]
  activeItemId: string
  isSigningOut: boolean
  onNavigate: (itemId: string) => void
  onSignOut: () => void
  onClose?: () => void
}

export function DashboardSidebar({
  email,
  items,
  activeItemId,
  isSigningOut,
  onNavigate,
  onSignOut,
  onClose,
}: DashboardSidebarProps) {
  return (
    <div className="flex h-full flex-col bg-white text-ink">
      <div className="flex h-20 items-center justify-between border-b border-white/10 bg-forest px-5 text-white">
        <a
          href="/dashboard"
          onClick={(event) => {
            event.preventDefault()
            onNavigate('overview')
          }}
          className="group inline-flex items-center gap-3"
        >
          <span className="grid size-10 place-items-center bg-mint text-ink transition-transform group-hover:-rotate-3">
            <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
              <path
                d="M5 5.5h14M5 10h14M5 14.5h9M5 19h9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span>
            <span className="block text-base font-black tracking-tight">
              tradeledger
            </span>
            <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">
              Operations admin
            </span>
          </span>
        </a>

        {onClose && (
          <Button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="grid size-10 place-items-center border border-white/10 text-white/65 transition hover:border-white/25 hover:text-white"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
              <path
                d="m5 5 10 10M15 5 5 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </Button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Dashboard">
        <p className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-ink/55">
          Workspace
        </p>
        <div className="mt-3 flex flex-col gap-1">
          {items.map((item) => {
            const isActive = activeItemId === item.id

            return (
              <a
                key={item.id}
                href={item.href}
                onClick={(event) => {
                  event.preventDefault()
                  onNavigate(item.id)
                }}
                aria-current={isActive ? 'page' : undefined}
                className={
                  'group flex items-center justify-between gap-3 border-l-2 px-3 py-3 transition ' +
                  (isActive
                    ? 'border-forest bg-mint/20 text-forest'
                    : 'border-transparent text-ink/85 hover:border-forest/25 hover:bg-cream hover:text-ink')
                }
              >
                <span className="min-w-0">
                  <span className="block text-sm font-bold">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-current opacity-75">
                    {item.detail}
                  </span>
                </span>
                {item.badge && (
                  <span
                    className={
                      'shrink-0 border px-2 py-1 font-mono text-[10px] font-bold ' +
                      (isActive
                        ? 'border-forest/20 bg-white text-forest'
                        : 'border-ink/15 text-ink/60')
                    }
                  >
                    {item.badge}
                  </span>
                )}
              </a>
            )
          })}
        </div>
      </nav>

      <div className="border-t border-ink/10 p-4">
        <div className="min-w-0 px-1">
          <p className="truncate text-xs font-semibold text-ink/70">
            {email ?? 'Authenticated user'}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ink/35">
            Supabase secured
          </p>
        </div>
        <Button
          type="button"
          onClick={onSignOut}
          disabled={isSigningOut}
          className="mt-4 inline-flex h-10 w-full items-center justify-center border border-ink/15 px-4 text-xs font-bold text-ink/70 transition hover:border-forest/30 hover:bg-cream hover:text-forest disabled:cursor-wait disabled:opacity-50"
        >
          {isSigningOut ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </div>
  )
}

import { Button } from '@headlessui/react'

export interface DashboardNavigationItem {
  id: string
  href: string
  label: string
  detail: string
  badge?: string
}

interface DashboardSidebarProps {
  items: DashboardNavigationItem[]
  activeItemId: string
  onNavigate: (itemId: string) => void
  onClose?: () => void
}

function NavigationIcon({ itemId }: { itemId: string }) {
  const paths: Record<string, string> = {
    overview: 'M4 4h5v5H4V4Zm7 0h5v3h-5V4ZM4 11h5v5H4v-5Zm7-2h5v7h-5V9Z',
    directory: 'M3.5 5.25h5l1.5 1.5h6.5v8H3.5v-9.5Z',
    payments: 'M3.5 5.5h13v9h-13v-9Zm0 3h13M6 12h3',
    team: 'M7.25 9a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm5.5-.75a1.75 1.75 0 1 0 0-3.5m-9.5 10.5c.2-2.6 1.54-4 4-4s3.8 1.4 4 4m.75-4c2.53.08 3.77 1.5 3.75 4',
    delivery: 'M3.5 5.25h13v9.5h-13v-9.5Zm.5.5 6 4.75 6-4.75',
    audit: 'M10 2.75 15.5 5v4.25c0 3.64-2.17 6.2-5.5 8-3.33-1.8-5.5-4.36-5.5-8V5L10 2.75Zm-2.25 7L9.3 11.3l3.1-3.1',
  }

  return (
    <svg viewBox="0 0 20 20" className="size-4" fill="none" aria-hidden="true">
      <path
        d={paths[itemId] ?? paths.overview}
        fill={itemId === 'overview' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DashboardSidebar({
  items,
  activeItemId,
  onNavigate,
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
          className="group inline-flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mint/60"
        >
          <span className="grid size-9 place-items-center bg-mint text-ink transition-transform duration-200 group-hover:-rotate-3">
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
            <span className="block text-[15px] font-extrabold tracking-[-0.035em]">
              TradeLedger
            </span>
            <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-[0.18em] text-white/70">
              Operations admin
            </span>
          </span>
        </a>

        {onClose && (
          <Button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="grid size-10 place-items-center border border-white/10 text-white/75 transition hover:border-white/25 hover:text-white"
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

      <nav className="flex-1 overflow-y-auto px-3 py-6" aria-label="Dashboard">
        <p className="px-3 text-[10px] font-bold uppercase tracking-[0.19em] text-ink/75">
          Workspace
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
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
                  'group flex items-center justify-between gap-3 border-l-2 px-3 py-3 transition-colors ' +
                  (isActive
                    ? 'border-forest bg-mint/25 text-forest'
                    : 'border-transparent text-ink/85 hover:border-forest/25 hover:bg-cream hover:text-ink')
                }
              >
                <span className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-current opacity-80">
                    <NavigationIcon itemId={item.id} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold">{item.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] font-medium text-current opacity-85">
                      {item.detail}
                    </span>
                  </span>
                </span>
                {item.badge && (
                  <span
                    className={
                      'inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none font-semibold tabular-nums ' +
                      (isActive
                        ? 'border-forest/20 bg-white text-forest'
                        : 'border-ink/15 text-ink/70')
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

      <div className="border-t border-ink/8 px-6 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/70">
        RLS protected workspace
      </div>
    </div>
  )
}

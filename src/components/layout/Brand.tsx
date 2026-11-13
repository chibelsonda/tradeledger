interface BrandProps {
  compact?: boolean
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <a
      href="/"
      className="group inline-flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
      aria-label="TradeLedger home"
    >
      <span className="grid size-9 place-items-center bg-ink text-mint shadow-[0_8px_20px_rgba(19,37,31,0.16)] transition-transform duration-200 group-hover:-rotate-3">
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
      {!compact && (
        <span className="text-lg font-extrabold tracking-[-0.035em] text-ink">
          TradeLedger
        </span>
      )}
    </a>
  )
}

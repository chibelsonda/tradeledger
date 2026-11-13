import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectControlProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  className?: string
  containerClassName?: string
  disabled?: boolean
  ariaLabel?: string
  ariaDescribedBy?: string
  invalid?: boolean
}

export function SelectControl({
  value,
  options,
  onChange,
  className = '',
  containerClassName = '',
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  invalid = false,
}: SelectControlProps) {
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0]

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className={`relative ${containerClassName}`}>
        <ListboxButton
          type="button"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          className={`${className} relative w-full cursor-default rounded-none pr-10 text-left disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <span className="block truncate">{selectedOption?.label ?? ''}</span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink/80"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none">
              <path
                d="m6 8 4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </ListboxButton>

        <ListboxOptions
          transition
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-none border border-ink/15 bg-white p-1 shadow-[0_16px_36px_rgba(19,37,31,0.14)] transition duration-100 ease-out focus:outline-none data-closed:-translate-y-1 data-closed:opacity-0"
        >
          {options.map((option) => (
            <ListboxOption
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className="group flex cursor-default items-center justify-between gap-3 rounded-none px-3 py-2 text-sm font-semibold text-ink/85 outline-none select-none data-disabled:cursor-not-allowed data-disabled:text-ink/45 data-focus:bg-mint/30 data-selected:bg-cream data-selected:text-forest"
            >
              <span className="truncate">{option.label}</span>
              <svg
                viewBox="0 0 20 20"
                className="size-4 shrink-0 text-forest opacity-0 group-data-selected:opacity-100"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m5.5 10 3 3 6-6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  )
}

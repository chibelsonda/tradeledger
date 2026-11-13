import { Select } from '@headlessui/react'
import type { ComponentPropsWithoutRef } from 'react'

interface SelectControlProps extends ComponentPropsWithoutRef<'select'> {
  containerClassName?: string
}

export function SelectControl({
  children,
  className = '',
  containerClassName = '',
  ...props
}: SelectControlProps) {
  return (
    <div className={`relative ${containerClassName}`}>
      <Select
        {...props}
        className={`${className} w-full appearance-none pr-10`}
      >
        {children}
      </Select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-ink/55"
      >
        <svg viewBox="0 0 20 20" className="size-4" fill="none">
          <path
            d="m6 8 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  )
}

interface ButtonSpinnerProps {
  tone?: 'light' | 'dark'
}

export function ButtonSpinner({ tone = 'dark' }: ButtonSpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={
        'size-3.5 shrink-0 animate-spin rounded-full border-2 motion-reduce:animate-none ' +
        (tone === 'light'
          ? 'border-white/30 border-t-white'
          : 'border-ink/20 border-t-ink')
      }
    />
  )
}

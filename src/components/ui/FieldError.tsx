interface FieldErrorProps {
  id: string
  message?: string
}

export function FieldError({ id, message }: FieldErrorProps) {
  if (!message) return null

  return (
    <p id={id} role="alert" className="text-xs font-semibold text-red-700">
      {message}
    </p>
  )
}

import type { ZodError } from 'zod'

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>

export function fieldErrorsFromZod<Field extends string>(
  error: ZodError,
): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {}

  for (const issue of error.issues) {
    const field = issue.path[0]

    if (typeof field === 'string' && errors[field as Field] === undefined) {
      errors[field as Field] = issue.message
    }
  }

  return errors
}

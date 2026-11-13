interface PublicError {
  code?: string
}

export function safeDatabaseErrorMessage(
  error: PublicError | null | undefined,
  fallback: string,
): string {
  if (error?.code === '42501' || error?.code === '28000') {
    return 'You do not have permission to perform this action.'
  }

  if (error?.code === '23505') {
    return 'A record with those details already exists.'
  }

  if (error?.code === '55000' || error?.code === '23503') {
    return "This action conflicts with the record's current state. Refresh and try again."
  }

  if (error?.code === 'P0002' || error?.code === 'PGRST116') {
    return 'The requested record was not found.'
  }

  return fallback
}

export const WAIVER_BUCKET = 'waiver-documents'
export const WAIVER_URL_TTL_SECONDS = 60

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

export function safeDownloadName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized.endsWith('.pdf')
    ? normalized
    : `${normalized || 'payment-waiver'}.pdf`
}

export const INVOICE_BUCKET = 'invoice-documents'
export const INVOICE_MAX_BYTES = 10 * 1024 * 1024
export const INVOICE_URL_TTL_SECONDS = 60

export const invoiceMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

export function matchesInvoiceSignature(
  bytes: Uint8Array,
  mimeType: string,
): boolean {
  if (mimeType === 'application/pdf') {
    return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  }

  if (mimeType === 'image/jpeg') {
    return startsWith(bytes, [0xff, 0xd8, 0xff])
  }

  if (mimeType === 'image/png') {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }

  if (mimeType === 'image/webp') {
    return (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
  }

  return false
}

export function safeInvoiceDownloadName(value: string): string {
  const lastDot = value.lastIndexOf('.')
  const rawExtension = lastDot > 0 ? value.slice(lastDot).toLowerCase() : ''
  const extension = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(rawExtension)
    ? rawExtension
    : ''
  const base = (lastDot > 0 ? value.slice(0, lastDot) : value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  return `${base || 'invoice'}${extension}`
}

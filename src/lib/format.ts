export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100)
}

export function formatStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function clampQuantity(
  quantity: number,
  minimum = 1,
  maximum = 10,
): number {
  if (!Number.isFinite(quantity)) {
    return minimum
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(quantity)))
}

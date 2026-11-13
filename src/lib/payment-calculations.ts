export interface RetainageBreakdown {
  grossAmount: number
  retainageAmount: number
  netAmount: number
}

export function dollarsToMinorUnits(value: string): number | null {
  const normalized = value.trim()

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const [whole, fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

export function calculateRetainage(
  grossAmount: number,
  retainageBasisPoints: number,
): RetainageBreakdown {
  if (!Number.isSafeInteger(grossAmount) || grossAmount <= 0) {
    throw new RangeError('Gross amount must be a positive integer.')
  }

  if (
    !Number.isSafeInteger(retainageBasisPoints) ||
    retainageBasisPoints < 0 ||
    retainageBasisPoints > 10_000
  ) {
    throw new RangeError('Retainage must be between 0 and 10,000 basis points.')
  }

  const retainageAmount = Math.floor(
    (grossAmount * retainageBasisPoints + 5000) / 10_000,
  )

  return {
    grossAmount,
    retainageAmount,
    netAmount: grossAmount - retainageAmount,
  }
}

export interface PlatformFeeBreakdown {
  paymentAmount: number
  percentageAmount: number
  fixedAmount: number
  platformFeeAmount: number
  subcontractorTransferAmount: number
}

export function percentageToBasisPoints(value: string): number | null {
  const normalized = value.trim()

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null

  const [whole, fraction = ''] = normalized.split('.')
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))

  return Number.isSafeInteger(basisPoints) && basisPoints <= 9900
    ? basisPoints
    : null
}

export function nonNegativeDecimalToMinorUnits(value: string): number | null {
  const normalized = value.trim()

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null

  const [whole, fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))

  return Number.isSafeInteger(amount) && amount <= 99_999_999 ? amount : null
}

export function calculatePlatformFee(
  paymentAmount: number,
  percentageBasisPoints: number,
  fixedAmount: number,
): PlatformFeeBreakdown {
  if (!Number.isSafeInteger(paymentAmount) || paymentAmount <= 0) {
    throw new RangeError('Payment amount must be a positive integer.')
  }

  if (
    !Number.isSafeInteger(percentageBasisPoints) ||
    percentageBasisPoints < 0 ||
    percentageBasisPoints > 9900
  ) {
    throw new RangeError('Platform fee percentage must be between 0 and 9,900 basis points.')
  }

  if (!Number.isSafeInteger(fixedAmount) || fixedAmount < 0) {
    throw new RangeError('Fixed fee must be a non-negative integer.')
  }

  const percentageAmount = Math.floor(
    (paymentAmount * percentageBasisPoints + 5000) / 10_000,
  )
  const platformFeeAmount = percentageAmount + fixedAmount

  if (!Number.isSafeInteger(platformFeeAmount) || platformFeeAmount >= paymentAmount) {
    throw new RangeError('Platform fee must be lower than the payment amount.')
  }

  return {
    paymentAmount,
    percentageAmount,
    fixedAmount,
    platformFeeAmount,
    subcontractorTransferAmount: paymentAmount - platformFeeAmount,
  }
}

export function basisPointsToPercentageInput(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\.00$/, '')
}

export function minorUnitsToDecimalInput(amount: number): string {
  return (amount / 100).toFixed(2)
}

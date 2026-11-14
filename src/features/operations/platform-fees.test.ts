import { describe, expect, it } from 'vitest'

import {
  basisPointsToPercentageInput,
  calculatePlatformFee,
  minorUnitsToDecimalInput,
  nonNegativeDecimalToMinorUnits,
  percentageToBasisPoints,
} from './platform-fees'

describe('platform fee calculations', () => {
  it.each([
    ['0', 0],
    ['2.5', 250],
    ['12.34', 1234],
    ['99', 9900],
  ])('converts %s percent into basis points', (value, expected) => {
    expect(percentageToBasisPoints(value)).toBe(expected)
  })

  it.each(['', '-1', '1.234', '99.01', '100', 'fee']) (
    'rejects invalid percentage %s',
    (value) => {
      expect(percentageToBasisPoints(value)).toBeNull()
    },
  )

  it.each([
    ['0', 0],
    ['1.5', 150],
    ['25.00', 2500],
  ])('converts non-negative decimal amount %s', (value, expected) => {
    expect(nonNegativeDecimalToMinorUnits(value)).toBe(expected)
  })

  it('calculates the rounded percentage, fixed fee, and transfer snapshot', () => {
    expect(calculatePlatformFee(94_500, 275, 30)).toEqual({
      paymentAmount: 94_500,
      percentageAmount: 2599,
      fixedAmount: 30,
      platformFeeAmount: 2629,
      subcontractorTransferAmount: 91_871,
    })
  })

  it('rejects a fee that would consume the complete payment', () => {
    expect(() => calculatePlatformFee(100, 0, 100)).toThrow(RangeError)
  })

  it('formats stored fee values for form controls', () => {
    expect(basisPointsToPercentageInput(275)).toBe('2.75')
    expect(minorUnitsToDecimalInput(30)).toBe('0.30')
  })
})

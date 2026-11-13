import { describe, expect, it } from 'vitest'

import {
  calculateRetainage,
  dollarsToMinorUnits,
} from './payment-calculations'

describe('dollarsToMinorUnits', () => {
  it.each([
    ['105', 10_500],
    ['105.5', 10_550],
    ['105.50', 10_550],
  ])('converts %s dollars into integer cents', (value, expected) => {
    expect(dollarsToMinorUnits(value)).toBe(expected)
  })

  it.each(['', '0', '-10', '10.999', 'ten'])('rejects invalid amount %s', (value) => {
    expect(dollarsToMinorUnits(value)).toBeNull()
  })
})

describe('calculateRetainage', () => {
  it('calculates exact gross, retainage, and net amounts', () => {
    expect(calculateRetainage(10_500, 1000)).toEqual({
      grossAmount: 10_500,
      retainageAmount: 1050,
      netAmount: 9450,
    })
  })

  it('rounds retainage to the nearest minor unit', () => {
    expect(calculateRetainage(10_555, 750).retainageAmount).toBe(792)
  })

  it('rejects an out-of-range retainage percentage', () => {
    expect(() => calculateRetainage(10_000, 10_001)).toThrow(RangeError)
  })
})

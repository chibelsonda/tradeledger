import { describe, expect, it } from 'vitest'

import { clampQuantity, formatStatus } from './format'

describe('clampQuantity', () => {
  it('keeps quantities inside the accepted range', () => {
    expect(clampQuantity(0)).toBe(1)
    expect(clampQuantity(4.8)).toBe(4)
    expect(clampQuantity(20)).toBe(10)
  })
})

describe('formatStatus', () => {
  it('formats database status values for people', () => {
    expect(formatStatus('async_payment_failed')).toBe('Async Payment Failed')
  })
})

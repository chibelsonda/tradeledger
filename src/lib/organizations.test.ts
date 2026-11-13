import { describe, expect, it } from 'vitest'

import { organizationSlug, projectCode } from './organizations'

describe('organizationSlug', () => {
  it('creates a normalized tenant slug from a display name', () => {
    expect(organizationSlug('  Álvarez & Sons Construction  ')).toBe(
      'alvarez-sons-construction',
    )
  })

  it('removes leading and trailing separators', () => {
    expect(organizationSlug('---North Ridge---')).toBe('north-ridge')
  })
})

describe('projectCode', () => {
  it('creates an uppercase project code', () => {
    expect(projectCode(' Cedar kitchen 01 ')).toBe('CEDAR-KITCHEN-01')
  })
})

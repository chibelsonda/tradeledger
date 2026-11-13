import { describe, expect, it } from 'vitest'

import { safeDatabaseErrorMessage } from './public-errors'

describe('safeDatabaseErrorMessage', () => {
  it('maps expected database codes to public messages', () => {
    expect(safeDatabaseErrorMessage({ code: '42501' }, 'fallback')).toContain(
      'permission',
    )
    expect(safeDatabaseErrorMessage({ code: '23505' }, 'fallback')).toContain(
      'already exists',
    )
    expect(safeDatabaseErrorMessage({ code: '55000' }, 'fallback')).toContain(
      'current state',
    )
  })

  it('never forwards an unknown database message', () => {
    const error = {
      code: 'XX000',
      message: 'relation secret_table does not exist',
      details: 'internal schema detail',
    }

    expect(safeDatabaseErrorMessage(error, 'The request failed.')).toBe(
      'The request failed.',
    )
  })
})

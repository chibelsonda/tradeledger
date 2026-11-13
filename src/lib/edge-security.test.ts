import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  enforceUserRateLimit,
  safeDatabaseErrorResponse,
} from '../../supabase/functions/_shared/security'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Edge Function security helpers', () => {
  it('does not expose database error messages to callers', async () => {
    const response = safeDatabaseErrorResponse(
      { code: '42501', message: 'sensitive database policy details' },
      'The request failed.',
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have permission to perform this action.',
    })
  })

  it('allows requests within the database-owned rate limit', async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    }

    await expect(
      enforceUserRateLimit(client, {
        bucket: 'test-operation',
        subject: '00000000-0000-4000-8000-000000000001',
        limit: 5,
        windowSeconds: 60,
      }),
    ).resolves.toBeNull()
  })

  it('returns retry guidance after the rate limit is exhausted', async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
    }
    const response = await enforceUserRateLimit(client, {
      bucket: 'test-operation',
      subject: '00000000-0000-4000-8000-000000000001',
      limit: 5,
      windowSeconds: 60,
    })

    expect(response?.status).toBe(429)
    expect(response?.headers.get('retry-after')).toBe('60')
    await expect(response?.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
    })
  })

  it('fails closed when the rate-limit store is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: '08006', message: 'database connection failed' },
      }),
    }
    const response = await enforceUserRateLimit(client, {
      bucket: 'test-operation',
      subject: '00000000-0000-4000-8000-000000000001',
      limit: 5,
      windowSeconds: 60,
    })

    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toMatchObject({
      code: 'RATE_LIMIT_UNAVAILABLE',
    })
  })
})

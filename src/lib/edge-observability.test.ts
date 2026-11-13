import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  REQUEST_ID_HEADER,
  withObservability,
} from '../../supabase/functions/_shared/observability'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withObservability', () => {
  it('preserves a trusted request ID and returns a stable error envelope', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handler = withObservability('test-function', () =>
      Response.json({ error: 'Invalid input.' }, { status: 422 }),
    )
    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/test-function?secret=hidden', {
        headers: { [REQUEST_ID_HEADER]: 'client-request-123' },
      }),
    )

    expect(response.status).toBe(422)
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('client-request-123')
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid input.',
      code: 'VALIDATION_ERROR',
      requestId: 'client-request-123',
    })

    const log = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(log).toMatchObject({
      event: 'request.rejected',
      function: 'test-function',
      requestId: 'client-request-123',
      path: '/functions/v1/test-function',
      status: 422,
    })
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret=hidden')
  })

  it('replaces an unsafe request ID and adds it to successful responses', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const handler = withObservability('test-function', () => Response.json({ ok: true }))
    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/test-function', {
        headers: { [REQUEST_ID_HEADER]: 'unsafe request id' },
      }),
    )
    const requestId = response.headers.get(REQUEST_ID_HEADER)

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestId).not.toBe('unsafe request id')
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('converts uncaught failures into a non-sensitive response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = withObservability('test-function', () => {
      throw new Error('provider token sk_test_sensitive')
    })
    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/test-function'),
    )
    const payload = await response.json() as Record<string, unknown>

    expect(response.status).toBe(500)
    expect(payload).toMatchObject({
      error: 'The request could not be completed.',
      code: 'INTERNAL_ERROR',
    })
    expect(JSON.stringify(payload)).not.toContain('sk_test_sensitive')
    expect(payload.requestId).toBe(response.headers.get(REQUEST_ID_HEADER))
  })
})

interface RpcError {
  code?: string
  message?: string
}

interface RpcResult {
  data: unknown
  error: RpcError | null
}

interface RpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<RpcResult>
}

interface RateLimitOptions {
  bucket: string
  subject: string
  limit: number
  windowSeconds: number
}

export function databaseErrorStatus(code?: string): number {
  if (code === '42501' || code === '28000') return 403
  if (code === 'P0002') return 404
  if (code === '55000' || code === '23505') return 409
  return 500
}

export function safeDatabaseErrorResponse(
  error: RpcError,
  fallback: string,
): Response {
  const status = databaseErrorStatus(error.code)
  const messages: Record<number, string> = {
    403: 'You do not have permission to perform this action.',
    404: 'The requested record was not found.',
    409: "The request conflicts with the record's current state.",
  }

  return Response.json(
    {
      error: messages[status] ?? fallback,
      code: status === 500 ? 'DATABASE_ERROR' : undefined,
    },
    { status },
  )
}

export async function enforceUserRateLimit(
  client: unknown,
  options: RateLimitOptions,
): Promise<Response | null> {
  const { data, error } = await (client as RpcClient).rpc(
    'consume_edge_rate_limit',
    {
      p_bucket: options.bucket,
      p_subject: options.subject,
      p_limit: options.limit,
      p_window_seconds: options.windowSeconds,
    },
  )

  if (error) {
    console.error('Rate-limit check failed:', {
      bucket: options.bucket,
      code: error.code,
    })

    return Response.json(
      {
        error: 'The service is temporarily unable to validate this request.',
        code: 'RATE_LIMIT_UNAVAILABLE',
      },
      { status: 503, headers: { 'retry-after': '5' } },
    )
  }

  if (data !== true) {
    return Response.json(
      {
        error: 'Too many requests. Please wait before trying again.',
        code: 'RATE_LIMITED',
      },
      {
        status: 429,
        headers: { 'retry-after': String(options.windowSeconds) },
      },
    )
  }

  return null
}

export const REQUEST_ID_HEADER = 'x-request-id'

type EdgeHandler = (request: Request) => Response | Promise<Response>

interface RequestContext {
  functionName: string
  method: string
  path: string
  requestId: string
  startedAt: number
}

const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,99}$/

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get(REQUEST_ID_HEADER)?.trim()

  return candidate && requestIdPattern.test(candidate) ? candidate : crypto.randomUUID()
}

function errorCodeForStatus(status: number): string {
  const codes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    422: 'VALIDATION_ERROR',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    502: 'UPSTREAM_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  }

  return codes[status] ?? 'REQUEST_FAILED'
}

function writeCompletionLog(context: RequestContext, response: Response): void {
  const level = response.status >= 500
    ? 'error'
    : response.status >= 400
    ? 'warn'
    : 'info'
  const event = response.status >= 500
    ? 'request.failed'
    : response.status >= 400
    ? 'request.rejected'
    : 'request.completed'
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    function: context.functionName,
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    status: response.status,
    durationMs: Date.now() - context.startedAt,
  })

  if (level === 'error') {
    console.error(entry)
  } else if (level === 'warn') {
    console.warn(entry)
  } else {
    console.info(entry)
  }
}

function responseHeaders(response?: Response): Headers {
  const headers = new Headers(response?.headers)
  headers.set('cache-control', 'no-store')
  return headers
}

async function observedResponse(
  context: RequestContext,
  response: Response,
): Promise<Response> {
  const headers = responseHeaders(response)
  headers.set(REQUEST_ID_HEADER, context.requestId)

  if (
    response.status >= 400 &&
    response.headers.get('content-type')?.includes('application/json')
  ) {
    let payload: Record<string, unknown> = {}

    try {
      const candidate: unknown = await response.json()
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        payload = candidate as Record<string, unknown>
      }
    } catch {
      payload = {}
    }

    const error = typeof payload.error === 'string'
      ? payload.error
      : 'The request could not be completed.'
    const code = typeof payload.code === 'string'
      ? payload.code
      : errorCodeForStatus(response.status)

    return Response.json(
      { ...payload, error, code, requestId: context.requestId },
      { status: response.status, headers },
    )
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function withObservability(
  functionName: string,
  handler: EdgeHandler,
): EdgeHandler {
  return async (request) => {
    const context: RequestContext = {
      functionName,
      method: request.method,
      path: new URL(request.url).pathname,
      requestId: requestIdFrom(request),
      startedAt: Date.now(),
    }
    let response: Response

    try {
      response = await handler(request)
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'request.crashed',
          function: context.functionName,
          requestId: context.requestId,
          method: context.method,
          path: context.path,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      )

      response = Response.json(
        {
          error: 'The request could not be completed.',
          code: 'INTERNAL_ERROR',
          requestId: context.requestId,
        },
        { status: 500, headers: responseHeaders() },
      )
    }

    const observed = await observedResponse(context, response)
    writeCompletionLog(context, observed)
    return observed
  }
}

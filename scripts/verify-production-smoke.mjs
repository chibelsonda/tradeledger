const appUrl = process.env.APP_URL
const edgeUrl =
  process.env.EDGE_URL ??
  'https://etbihtfpdqueqzjmbncs.supabase.co/functions/v1/stripe-webhook'

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
}

async function verifyApp() {
  if (!appUrl) {
    console.log('Frontend check skipped because APP_URL is not configured.')
    return
  }

  const response = await fetchWithTimeout(appUrl)
  const html = await response.text()

  if (!response.ok || !html.includes('<title>TradeLedger')) {
    throw new Error(
      `Frontend smoke check failed (${response.status}) at ${appUrl}.`,
    )
  }

  const contentSecurityPolicy =
    response.headers.get('content-security-policy') ?? ''
  const expectedHeaders = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-permitted-cross-domain-policies': 'none',
  }

  if (
    !contentSecurityPolicy.includes("object-src 'none'") ||
    !contentSecurityPolicy.includes(
      'https://etbihtfpdqueqzjmbncs.supabase.co',
    ) ||
    contentSecurityPolicy.includes('https://*.supabase.co')
  ) {
    throw new Error('Frontend security policy is missing required restrictions.')
  }

  for (const [name, expectedValue] of Object.entries(expectedHeaders)) {
    if (response.headers.get(name) !== expectedValue) {
      throw new Error(`Frontend security header ${name} is missing or invalid.`)
    }
  }

  console.log(`Frontend healthy: ${response.status} ${appUrl}`)
}

async function verifyWebhookBoundary() {
  const response = await fetchWithTimeout(edgeUrl)
  const payload = await response.json().catch(() => null)
  const requestId = response.headers.get('x-request-id')

  if (
    response.status !== 405 ||
    payload?.error !== 'Method not allowed.' ||
    !requestId
  ) {
    throw new Error(
      `Webhook boundary check failed (${response.status}) at ${edgeUrl}.`,
    )
  }

  console.log(`Webhook boundary healthy: ${response.status}; request ${requestId}`)
}

await Promise.all([verifyApp(), verifyWebhookBoundary()])

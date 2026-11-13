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

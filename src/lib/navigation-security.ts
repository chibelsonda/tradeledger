const stripeCheckoutHosts = new Set(['checkout.stripe.com'])
const stripeCheckoutSessionPattern = /^cs_(?:test|live)_[A-Za-z0-9_]{8,200}$/

function secureUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null

  try {
    const url = new URL(value)

    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) {
      return null
    }

    return url
  } catch {
    return null
  }
}

export function trustedStripeCheckoutUrl(value: unknown): string | null {
  const url = secureUrl(value)

  if (!url || !stripeCheckoutHosts.has(url.hostname)) return null

  return url.toString()
}

export function trustedSupabaseWaiverUrl(
  value: unknown,
  supabaseProjectUrl: string,
): string | null {
  const url = secureUrl(value)
  const projectUrl = secureUrl(supabaseProjectUrl)

  if (
    !url ||
    !projectUrl ||
    url.origin !== projectUrl.origin ||
    !url.pathname.startsWith('/storage/v1/object/sign/waiver-documents/') ||
    !url.searchParams.has('token')
  ) {
    return null
  }

  return url.toString()
}

export function trustedStripeCheckoutSessionId(
  value: string | null,
): string | null {
  return value && stripeCheckoutSessionPattern.test(value) ? value : null
}

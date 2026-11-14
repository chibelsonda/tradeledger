import { describe, expect, it } from 'vitest'

import {
  trustedStripeCheckoutSessionId,
  trustedStripeCheckoutUrl,
  trustedStripeConnectUrl,
  trustedSupabaseWaiverUrl,
} from './navigation-security'

describe('trustedStripeCheckoutUrl', () => {
  it('accepts only the canonical Stripe Checkout host', () => {
    expect(
      trustedStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_123'),
    ).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
    expect(
      trustedStripeCheckoutUrl('https://checkout.stripe.com.evil.test/session'),
    ).toBeNull()
    expect(
      trustedStripeCheckoutUrl('https://evil.test/?next=checkout.stripe.com'),
    ).toBeNull()
    expect(
      trustedStripeCheckoutUrl('https://user@checkout.stripe.com/session'),
    ).toBeNull()
    expect(
      trustedStripeCheckoutUrl('javascript:alert(document.domain)'),
    ).toBeNull()
  })
})

describe('trustedStripeConnectUrl', () => {
  it('accepts only single-use onboarding links on the Stripe Connect host', () => {
    expect(
      trustedStripeConnectUrl(
        'https://connect.stripe.com/setup/c/acct_12345678/onboarding-token',
      ),
    ).toBe(
      'https://connect.stripe.com/setup/c/acct_12345678/onboarding-token',
    )
    expect(
      trustedStripeConnectUrl('https://connect.stripe.com.evil.test/setup'),
    ).toBeNull()
    expect(
      trustedStripeConnectUrl('https://user@connect.stripe.com/setup'),
    ).toBeNull()
    expect(trustedStripeConnectUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('trustedSupabaseWaiverUrl', () => {
  const projectUrl = 'https://project-ref.supabase.co'

  it('accepts a signed waiver URL from the configured Supabase project', () => {
    expect(
      trustedSupabaseWaiverUrl(
        'https://project-ref.supabase.co/storage/v1/object/sign/waiver-documents/tenant/waiver.pdf?token=signed-token',
        projectUrl,
      ),
    ).toContain('/storage/v1/object/sign/waiver-documents/')
  })

  it('rejects foreign projects, wrong buckets, and unsigned URLs', () => {
    expect(
      trustedSupabaseWaiverUrl(
        'https://attacker.supabase.co/storage/v1/object/sign/waiver-documents/file.pdf?token=stolen',
        projectUrl,
      ),
    ).toBeNull()
    expect(
      trustedSupabaseWaiverUrl(
        'https://project-ref.supabase.co/storage/v1/object/sign/another-bucket/file.pdf?token=signed',
        projectUrl,
      ),
    ).toBeNull()
    expect(
      trustedSupabaseWaiverUrl(
        'https://project-ref.supabase.co/storage/v1/object/sign/waiver-documents/file.pdf',
        projectUrl,
      ),
    ).toBeNull()
  })
})

describe('trustedStripeCheckoutSessionId', () => {
  it('allows bounded Stripe session identifiers and rejects query injection', () => {
    expect(trustedStripeCheckoutSessionId('cs_test_browser_001')).toBe(
      'cs_test_browser_001',
    )
    expect(
      trustedStripeCheckoutSessionId('cs_live_A1b2C3d4E5f6'),
    ).toBe('cs_live_A1b2C3d4E5f6')
    expect(
      trustedStripeCheckoutSessionId('cs_test_valid&organization_id=other'),
    ).toBeNull()
    expect(trustedStripeCheckoutSessionId('not-a-session')).toBeNull()
  })
})

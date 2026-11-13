import { describe, expect, it } from 'vitest'

import { buildNotificationEmail } from '../../supabase/functions/_shared/notification-email'

describe('buildNotificationEmail', () => {
  it('renders a paid transaction record with the persisted amount', () => {
    const document = buildNotificationEmail({
      notification_type: 'payment_succeeded',
      recipient_name: 'Hector Ramirez',
      template_data: {
        organizationName: 'Alpha Trades',
        projectName: 'Cedar Kitchen',
        projectCode: 'CEDAR-01',
        description: 'Kitchen trim milestone',
        netAmount: 9450,
        currency: 'usd',
        paidAt: '2026-11-13T04:00:00.000Z',
      },
    })

    expect(document.text).toContain('Payment received')
    expect(document.text).toContain('$94.50')
    expect(document.html).toContain('Cedar Kitchen')
  })

  it('escapes every user-controlled HTML field', () => {
    const dangerous = `<script>alert('xss')</script>`
    const document = buildNotificationEmail({
      notification_type: 'payment_request_approved',
      recipient_name: dangerous,
      template_data: {
        organizationName: dangerous,
        projectName: dangerous,
        projectCode: dangerous,
        description: dangerous,
        netAmount: 100,
        currency: 'usd',
        approvedAt: '2026-11-13T04:00:00.000Z',
      },
    })

    expect(document.html).toContain('&lt;script&gt;')
    expect(document.html).not.toContain(dangerous)
  })
})

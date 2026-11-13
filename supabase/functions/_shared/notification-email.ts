export interface NotificationEmailInput {
  notification_type: 'payment_request_approved' | 'payment_succeeded'
  recipient_name: string
  template_data: Record<string, unknown>
}

export interface NotificationEmailDocument {
  html: string
  text: string
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

function payloadAmount(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount / 100)
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

function formatDate(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return 'Recorded in TradeLedger'

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export function buildNotificationEmail(
  notification: NotificationEmailInput,
): NotificationEmailDocument {
  const payload = notification.template_data
  const organizationName = payloadText(payload, 'organizationName') || 'TradeLedger'
  const projectName = payloadText(payload, 'projectName') || 'your project'
  const projectCode = payloadText(payload, 'projectCode')
  const description = payloadText(payload, 'description')
  const currency = payloadText(payload, 'currency') || 'usd'
  const amount = formatMoney(payloadAmount(payload, 'netAmount'), currency)
  const isPaid = notification.notification_type === 'payment_succeeded'
  const eventDate = formatDate(
    payloadText(payload, isPaid ? 'paidAt' : 'approvedAt'),
  )
  const heading = isPaid ? 'Payment received' : 'Payment request approved'
  const summary = isPaid
    ? `${organizationName} recorded your payment of ${amount}.`
    : `${organizationName} approved a net payment request for ${amount}.`
  const statusLabel = isPaid ? 'Paid' : 'Approved'

  const text = [
    heading,
    '',
    `Hello ${notification.recipient_name},`,
    summary,
    '',
    `Project: ${projectName}${projectCode ? ` (${projectCode})` : ''}`,
    `Work: ${description}`,
    `Net amount: ${amount}`,
    `Status: ${statusLabel}`,
    `Recorded: ${eventDate}`,
    '',
    'This is an automated TradeLedger transaction record.',
  ].join('\n')

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f3ed;color:#10231f;font-family:Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f3ed;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #d9ddd9">
            <tr>
              <td style="background:#0f4538;padding:28px 32px;color:#ffffff">
                <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#c9ef9b">TRADELEDGER</div>
                <h1 style="margin:12px 0 0;font-size:26px;line-height:1.2">${escapeHtml(heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6">Hello ${escapeHtml(notification.recipient_name)},</p>
                <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#42534f">${escapeHtml(summary)}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e2e5e2">
                  <tr><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;color:#6b7774;font-size:12px">Project</td><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;text-align:right;font-weight:700">${escapeHtml(projectName)}${projectCode ? ` (${escapeHtml(projectCode)})` : ''}</td></tr>
                  <tr><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;color:#6b7774;font-size:12px">Work</td><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;text-align:right">${escapeHtml(description)}</td></tr>
                  <tr><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;color:#6b7774;font-size:12px">Net amount</td><td style="padding:12px 16px;border-bottom:1px solid #e2e5e2;text-align:right;font-size:18px;font-weight:800;color:#0f4538">${escapeHtml(amount)}</td></tr>
                  <tr><td style="padding:12px 16px;color:#6b7774;font-size:12px">Status</td><td style="padding:12px 16px;text-align:right;font-weight:700">${escapeHtml(statusLabel)} · ${escapeHtml(eventDate)}</td></tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#7b8582">This automated message is a transaction record from ${escapeHtml(organizationName)} through TradeLedger.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { html, text }
}

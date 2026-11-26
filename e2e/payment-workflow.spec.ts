import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  paidPaymentRecord,
  payoutAccountRecord,
  projectRecord,
  signInAsOwner,
  subcontractorRecord,
  submittedPaymentRequestRecord,
  TEST_PAYMENT_REQUEST_ID,
} from './support/supabase-mock'

test('owner approves a request and starts server-priced Stripe checkout', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    payoutAccounts: [payoutAccountRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
  })
  await installSupabaseMock(page, state)
  await page.route('https://checkout.stripe.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Mock Stripe Checkout</title><h1>Stripe Checkout</h1>',
    })
  })
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payments/ }).click()
  await expect(page.getByText('Kitchen trim milestone')).toBeVisible()

  await page.getByRole('button', { name: 'Approve' }).click()

  await expect(page.getByText('Approved', { exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(
    'ready for secure checkout',
  )
  expect(state.approvedRequestIds).toEqual([TEST_PAYMENT_REQUEST_ID])

  await page.getByRole('button', { name: 'Pay securely' }).click()

  await expect(page).toHaveURL(state.checkoutUrl)
  await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible()
  expect(state.checkoutRequestIds).toEqual([TEST_PAYMENT_REQUEST_ID])
  expect(state.unexpectedRequests).toEqual([])
})

test('owner reviews an extracted invoice before creating a draft request', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payments/ }).click()

  await page.getByRole('button', { name: 'Upload invoice' }).click()
  await page.getByLabel('Invoice file').setInputFiles({
    name: 'invoice-1042.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-browser-test'),
  })
  await page.getByRole('button', { name: 'Upload and extract' }).click()

  await expect(
    page.getByRole('heading', { name: 'Verify invoice details' }),
  ).toBeVisible()
  await expect(page.getByLabel('Invoice number')).toHaveValue('INV-1042')
  await page.getByLabel('Payment description').fill(
    'November framing progress — verified',
  )
  await page.getByRole('button', { name: 'Confirm and create draft' }).click()

  await expect(page.getByText('INV-1042', { exact: true })).toBeVisible()
  await expect(
    page.getByText('November framing progress — verified', { exact: true }),
  ).toBeVisible()
  expect(state.invoiceUploads[0]).toContain('multipart/form-data')
  expect(state.invoiceConfirmations).toHaveLength(1)
  expect(state.invoiceConfirmations[0]).toMatchObject({
    p_invoice_number: 'INV-1042',
    p_gross_amount: 528075,
    p_retainage_basis_points: 1000,
  })
  expect(state.unexpectedRequests).toEqual([])
})

test('checkout refuses a non-Stripe redirect returned by the API', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
    payoutAccounts: [payoutAccountRecord()],
    checkoutUrl: 'https://checkout.stripe.com.attacker.test/phishing',
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payments/ }).click()
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByRole('button', { name: 'Pay securely' }).click()

  await expect(page).toHaveURL(/\/payments$/)
  await expect(page.getByRole('alert')).toContainText(
    'did not return a valid checkout URL',
  )
  expect(state.checkoutRequestIds).toEqual([TEST_PAYMENT_REQUEST_ID])
  expect(state.unexpectedRequests).toEqual([])
})

test('owner is directed to payout setup before checkout is available', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [
      { ...submittedPaymentRequestRecord(), status: 'approved' },
    ],
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payments/ }).click()

  await expect(
    page.getByRole('button', { name: 'Set up payouts' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Pay securely' }),
  ).toHaveCount(0)
  expect(state.unexpectedRequests).toEqual([])
})

test('authenticated payer sees the webhook-confirmed success result', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    paymentResult: paidPaymentRecord(),
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await expect(
    page.getByRole('heading', { name: 'Create your contractor workspace.' }),
  ).toBeVisible()

  await page.goto('/?checkout=success&session_id=cs_test_browser_001')

  await expect(page.getByRole('heading', { name: "You're all set." })).toBeVisible()
  await expect(page.getByText('$94.50')).toBeVisible()
  await expect(page.getByText('Paid', { exact: true })).toBeVisible()
  expect(state.unexpectedRequests).toEqual([])
})

test('authenticated payer sees a no-charge cancellation result', async ({ page }) => {
  const state = createSupabaseMockState()
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await expect(
    page.getByRole('heading', { name: 'Create your contractor workspace.' }),
  ).toBeVisible()

  await page.goto('/?checkout=canceled')

  await expect(
    page.getByRole('heading', { name: 'Checkout canceled' }),
  ).toBeVisible()
  await expect(page.getByText('No charge was made')).toBeVisible()
  expect(state.unexpectedRequests).toEqual([])
})

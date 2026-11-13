import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  paidPaymentRecord,
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
    paymentRequests: [submittedPaymentRequestRecord()],
  })
  await installSupabaseMock(page, state)
  await page.route('https://checkout.stripe.test/**', async (route) => {
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
    'email status is available in the delivery log',
  )
  expect(state.approvedRequestIds).toEqual([TEST_PAYMENT_REQUEST_ID])

  await page.getByRole('button', { name: 'Pay securely' }).click()

  await expect(page).toHaveURL(state.checkoutUrl)
  await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible()
  expect(state.checkoutRequestIds).toEqual([TEST_PAYMENT_REQUEST_ID])
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

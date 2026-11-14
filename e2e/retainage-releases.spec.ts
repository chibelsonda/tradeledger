import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  paidRetainagePaymentRequestRecord,
  projectRecord,
  retainageReleaseRecord,
  signInAsOwner,
  subcontractorRecord,
  TEST_PAYMENT_REQUEST_ID,
  TEST_RETAINAGE_RELEASE_ID,
} from './support/supabase-mock'

test('owner requests, approves, and starts a retainage release checkout', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [paidRetainagePaymentRequestRecord()],
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
  await page.getByRole('link', { name: /Retainage/ }).click()
  await expect(page.getByRole('heading', { name: 'Retainage releases' })).toBeVisible()

  await page.getByLabel('Payment request').click()
  await page.getByRole('option', { name: /Kitchen trim milestone/ }).click()
  await page.getByLabel('Release amount').fill('5.00')
  await page.getByLabel('Release reason').fill('Completed punch-list work')
  await page.getByRole('button', { name: 'Request release' }).click()

  await expect(page.getByRole('status')).toContainText(
    'Retainage release submitted for approval',
  )
  expect(state.retainageReleaseRequests).toEqual([
    {
      p_payment_request_id: TEST_PAYMENT_REQUEST_ID,
      p_amount: 500,
      p_reason: 'Completed punch-list work',
    },
  ])

  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Approved', { exact: true })).toBeVisible()
  expect(state.approvedRetainageReleaseIds).toEqual([
    TEST_RETAINAGE_RELEASE_ID,
  ])

  await page.getByRole('button', { name: 'Pay securely' }).click()
  await expect(page).toHaveURL(state.checkoutUrl)
  expect(state.retainageCheckoutIds).toEqual([TEST_RETAINAGE_RELEASE_ID])
  expect(state.unexpectedRequests).toEqual([])
})

test('financial approver confirms a settled retainage refund', async ({ page }) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [paidRetainagePaymentRequestRecord()],
    retainageReleases: [
      retainageReleaseRecord({
        status: 'paid',
        approved_by: '00000000-0000-4000-8000-000000000001',
        approved_at: '2026-11-13T06:00:00.000Z',
        paid_at: '2026-11-13T06:00:00.000Z',
      }),
    ],
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Retainage/ }).click()

  await page.getByRole('button', { name: 'Refund release' }).click()
  await expect(page.getByRole('button', { name: 'Confirm refund' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm refund' }).click()

  await expect(page.getByRole('status')).toContainText(
    'Retainage refund submitted',
  )
  await expect(page.getByText('Refunded', { exact: true })).toBeVisible()
  expect(state.retainageRefundIds).toEqual([TEST_RETAINAGE_RELEASE_ID])
  expect(state.unexpectedRequests).toEqual([])
})

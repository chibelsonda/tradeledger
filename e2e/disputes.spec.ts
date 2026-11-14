import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  paymentDisputeRecord,
  projectRecord,
  signInAsOwner,
  subcontractorRecord,
  submittedPaymentRequestRecord,
  TEST_DISPUTE_ID,
} from './support/supabase-mock'

test('financial operator reviews and explicitly submits dispute evidence', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
    paymentDisputes: [paymentDisputeRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Disputes/ }).click()

  await expect(page.getByRole('heading', { name: 'Disputes and recovery' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Cedar Kitchen Remodel' })).toBeVisible()
  await page.getByRole('button', { name: 'Review' }).click()

  await page.getByLabel('Product or service description').fill(
    'Completed kitchen trim milestone documented by the project record.',
  )
  await page.getByLabel('Service date').fill('2026-11-12')
  await page.getByLabel('Customer email').fill('owner@example.test')
  await page.getByLabel('Additional evidence').fill(
    'The signed completion record and communication history support fulfillment.',
  )
  await page.getByRole('button', { name: 'Submit evidence' }).click()

  await expect(page.getByText('Confirm evidence submission')).toBeVisible()
  expect(state.disputeActions).toEqual([])
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Evidence submitted to Stripe')

  expect(state.disputeActions).toEqual([
    {
      disputeId: TEST_DISPUTE_ID,
      action: 'submit_evidence',
      confirm: true,
      evidence: {
        productDescription:
          'Completed kitchen trim milestone documented by the project record.',
        serviceDate: '2026-11-12',
        customerEmail: 'owner@example.test',
        uncategorizedText:
          'The signed completion record and communication history support fulfillment.',
      },
    },
  ])
  await expect(page.locator('body')).not.toContainText('dp_browser_test_001')
  await expect(page.locator('body')).not.toContainText('pi_test_browser_001')
  expect(state.unexpectedRequests).toEqual([])
})

test('lost dispute requires confirmation before connected-transfer recovery', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
    paymentDisputes: [paymentDisputeRecord({ status: 'lost' })],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Disputes/ }).click()
  await page.getByRole('button', { name: 'Review' }).click()
  await page.getByRole('button', { name: 'Recover transfer funds' }).click()

  await expect(page.getByText('Confirm transfer recovery')).toBeVisible()
  expect(state.disputeActions).toEqual([])
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(
    'Connected transfer funds recovered',
  )
  expect(state.disputeActions[0]).toMatchObject({
    disputeId: TEST_DISPUTE_ID,
    action: 'recover',
    confirm: true,
  })
  expect(state.unexpectedRequests).toEqual([])
})

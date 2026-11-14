import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  failedConnectedPayoutRecord,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  paymentTransferRecord,
  projectRecord,
  signInAsOwner,
  subcontractorRecord,
  submittedPaymentRequestRecord,
} from './support/supabase-mock'

test('authorized owner filters, switches, and reconciles the payout ledger', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
    paymentTransfers: [paymentTransferRecord()],
    connectedPayouts: [failedConnectedPayoutRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payouts/ }).click()

  await expect(page.getByRole('heading', { name: 'Payout reconciliation' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Cedar Kitchen Remodel' })).toBeVisible()

  await page.getByPlaceholder('Request, project, subcontractor…').fill('no match')
  await expect(page.getByText('No ledger records match these filters.')).toBeVisible()
  await page.getByPlaceholder('Request, project, subcontractor…').fill('Fine Finish')
  await expect(page.getByText('Kitchen trim milestone')).toBeVisible()

  await page.getByRole('tab', { name: /Payouts/ }).click()
  await expect(page.getByText('Account Closed')).toBeVisible()

  await page.getByRole('button', { name: 'Reconcile ledger' }).click()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Reconciliation completed' }),
  ).toContainText('1 transfers and 1 payouts synchronized')
  expect(state.payoutReconciliationRequests).toEqual([
    {
      organizationId: state.organizations[0]?.id,
      targetType: 'organization',
      targetId: state.organizations[0]?.id,
    },
  ])
  expect(state.unexpectedRequests).toEqual([])
})

test('accountant sees an isolated empty payout ledger', async ({ page }) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [{ ...membershipRecord(), role: 'accountant' }],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payouts/ }).click()

  await expect(page.getByText('No transfers have been synchronized yet.')).toBeVisible()
  await page.getByRole('tab', { name: /Payouts/ }).click()
  await expect(page.getByText('No payouts have been synchronized yet.')).toBeVisible()
  expect(state.unexpectedRequests).toEqual([])
})

test('failed payout details render safe guidance without sensitive account data', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    subcontractors: [subcontractorRecord()],
    connectedPayouts: [failedConnectedPayoutRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Payouts/ }).click()
  await page.getByRole('tab', { name: /Payouts/ }).click()
  await page.getByRole('button', { name: 'Details' }).click()

  await expect(page.getByText('The destination account is closed.')).toBeVisible()
  await expect(page.getByText(/update their payout account/)).toBeVisible()
  await expect(page.getByText('po_browser_test_001')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('acct_')
  await expect(page.locator('body')).not.toContainText('bank account number')
  expect(state.unexpectedRequests).toEqual([])
})

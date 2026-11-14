import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  signInAsOwner,
  webhookFailureRecord,
} from './support/supabase-mock'

test('financial operator safely recovers a tenant webhook incident', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    webhookFailures: [webhookFailureRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Webhooks/ }).click()

  await expect(page.getByRole('heading', { name: 'Webhook incident queue' }))
    .toBeVisible()
  await expect(page.getByText('Critical', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Reconcile the payment and its refund history/))
    .toBeVisible()
  await expect(page.locator('body')).not.toContainText('acct_sensitive_001')

  await page.getByRole('button', { name: 'Recover from Stripe' }).click()

  await expect(
    page.getByRole('status').filter({ hasText: 'Recovery completed' }),
  ).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Open (0)' })).toBeVisible()
  await page.getByRole('tab', { name: 'Resolved (1)' }).click()
  await expect(page.getByText('Operator Reconciliation')).toBeVisible()

  expect(state.webhookRecoveryRequests).toEqual([{ failureId: 8001 }])
  expect(state.unexpectedRequests).toEqual([])
})

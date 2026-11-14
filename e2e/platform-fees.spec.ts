import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  platformFeeRecord,
  signInAsOwner,
  TEST_ORGANIZATION_ID,
} from './support/supabase-mock'

test('owner updates the server-owned platform fee and sees the transfer preview', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    platformFees: [platformFeeRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Platform fees/ }).click()

  await expect(page.getByRole('heading', { name: 'Platform fees' })).toBeVisible()
  await expect(page.getByText('$25.30')).toBeVisible()
  await expect(page.getByText('$974.70')).toBeVisible()

  await page.getByLabel('Percentage').fill('3.25')
  await page.getByLabel('Fixed amount').fill('1.00')
  await page.getByRole('button', { name: 'Save fee policy' }).click()

  await expect(page.getByRole('status')).toContainText('Platform fee policy saved')
  expect(state.platformFeeUpdates).toEqual([
    {
      p_organization_id: TEST_ORGANIZATION_ID,
      p_currency: 'usd',
      p_percentage_basis_points: 325,
      p_fixed_amount: 100,
      p_enabled: true,
    },
  ])
  expect(state.unexpectedRequests).toEqual([])
})

test('accountant can inspect platform fees but cannot change them', async ({ page }) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [{ ...membershipRecord(), role: 'accountant' }],
    platformFees: [platformFeeRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Platform fees/ }).click()

  await expect(page.getByText('View only')).toBeVisible()
  await expect(page.getByLabel('Percentage')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save fee policy' })).toHaveCount(0)
  expect(state.platformFeeUpdates).toEqual([])
  expect(state.unexpectedRequests).toEqual([])
})

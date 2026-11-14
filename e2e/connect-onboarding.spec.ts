import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  payoutAccountRecord,
  projectRecord,
  signInAsOwner,
  subcontractorRecord,
} from './support/supabase-mock'

test('owner sees server-synchronized payout readiness in the directory', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    payoutAccounts: [payoutAccountRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Directory/ }).click()
  await page.getByRole('tab', { name: 'Subcontractors' }).click()

  await expect(page.getByText('Fine Finish Carpentry')).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  expect(state.unexpectedRequests).toEqual([])
})

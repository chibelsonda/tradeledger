import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  signInAsOwner,
  TEST_MEMBER_USER_ID,
  TEST_ORGANIZATION_ID,
} from './support/supabase-mock'

test('owner grants and suspends tenant access from the team workspace', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)

  await page.getByRole('link', { name: /Team access/ }).click()
  await expect(page.getByRole('heading', { name: 'Team access' })).toBeVisible()
  await expect(
    page.getByRole('table').getByText('owner@example.test'),
  ).toBeVisible()
  await expect(page.getByText('Protected owner')).toBeVisible()

  await page.getByLabel('Email').fill('accountant@example.test')
  await page.getByLabel('Role').click()
  await page.getByRole('option', { name: 'Accountant' }).click()
  await page.getByRole('button', { name: 'Add or update member' }).click()

  await expect(page.getByText('accountant@example.test')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Team access updated')
  expect(state.memberUpserts).toEqual([
    {
      p_organization_id: TEST_ORGANIZATION_ID,
      p_email: 'accountant@example.test',
      p_role: 'accountant',
    },
  ])

  const memberRow = page.getByRole('row').filter({
    hasText: 'accountant@example.test',
  })
  await memberRow.getByRole('button', { name: 'Suspend' }).click()

  await expect(memberRow.getByText('Suspended', { exact: true })).toBeVisible()
  expect(state.memberStatusChanges).toEqual([
    {
      p_organization_id: TEST_ORGANIZATION_ID,
      p_user_id: TEST_MEMBER_USER_ID,
      p_status: 'suspended',
    },
  ])
  expect(state.unexpectedRequests).toEqual([])
})

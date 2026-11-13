import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  projectRecord,
  signInAsOwner,
  subcontractorRecord,
  submittedPaymentRequestRecord,
  TEST_ORGANIZATION_ID,
} from './support/supabase-mock'

test('workspace owner can remove the registered demonstration dataset', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    projects: [projectRecord()],
    subcontractors: [subcontractorRecord()],
    paymentRequests: [submittedPaymentRequestRecord()],
    demoWorkspaceStatus: {
      status: 'active',
      can_remove: true,
      reason: null,
    },
  })
  await installSupabaseMock(page, state)
  await signInAsOwner(page)

  await expect(
    page.getByRole('heading', { name: 'Sample operational data is active' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Remove demonstration data' })
    .click()

  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: 'Remove demonstration data?' }),
  ).toBeVisible()
  await dialog
    .getByRole('button', { name: 'Remove demonstration data' })
    .click()

  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByText(
      'Demonstration records were removed. Your workspace and independent records were preserved.',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Sample operational data is active' }),
  ).not.toBeVisible()
  expect(state.demoRemovalPayloads).toEqual([
    { p_organization_id: TEST_ORGANIZATION_ID },
  ])
  expect(state.projects).toEqual([])
  expect(state.subcontractors).toEqual([])
  expect(state.paymentRequests).toEqual([])
  expect(state.unexpectedRequests).toEqual([])
})

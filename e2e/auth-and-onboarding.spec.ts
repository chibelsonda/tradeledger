import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  installSupabaseMock,
  signInAsOwner,
  TEST_ORGANIZATION_ID,
} from './support/supabase-mock'

test('rejected credentials show the authentication error', async ({ page }) => {
  const state = createSupabaseMockState({
    authError: 'Invalid login credentials',
  })
  await installSupabaseMock(page, state)

  await signInAsOwner(page)

  await expect(page.getByRole('alert')).toHaveText('Invalid login credentials')
  expect(state.unexpectedRequests).toEqual([])
})

test('authenticated user without a tenant sees organization onboarding', async ({
  page,
}) => {
  const state = createSupabaseMockState()
  await installSupabaseMock(page, state)

  await signInAsOwner(page)

  await expect(
    page.getByRole('heading', { name: 'Create your contractor workspace.' }),
  ).toBeVisible()
  await expect(page.getByText('PostgreSQL Row-Level Security')).toBeVisible()
  expect(state.unexpectedRequests).toEqual([])
})

test('organization onboarding creates the owner workspace and opens its dashboard', async ({
  page,
}) => {
  const state = createSupabaseMockState()
  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await expect(
    page.getByRole('heading', { name: 'Create your contractor workspace.' }),
  ).toBeVisible()

  await page.getByLabel('Organization name').fill('North Ridge Contracting')
  await expect(page.getByLabel('Workspace URL')).toHaveValue(
    'north-ridge-contracting',
  )
  await page.getByRole('button', { name: 'Create organization' }).click()

  await expect(
    page.getByRole('heading', { name: 'Operations overview' }),
  ).toBeVisible()
  expect(state.createdOrganizationPayloads).toEqual([
    {
      p_name: 'North Ridge Contracting',
      p_slug: 'north-ridge-contracting',
    },
  ])
  expect(state.organizations[0]?.id).toBe(TEST_ORGANIZATION_ID)
  expect(state.unexpectedRequests).toEqual([])
})

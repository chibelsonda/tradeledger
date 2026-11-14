import { expect, test } from '@playwright/test'

import {
  createSupabaseMockState,
  financialReportSummaryRecord,
  financialStatementRowRecord,
  installSupabaseMock,
  membershipRecord,
  organizationRecord,
  signInAsOwner,
} from './support/supabase-mock'

test('financial operator runs and downloads a tenant-safe statement', async ({
  page,
}) => {
  const state = createSupabaseMockState({
    organizations: [organizationRecord()],
    memberships: [membershipRecord()],
    financialReportSummaries: [financialReportSummaryRecord()],
    financialStatementRows: [financialStatementRowRecord()],
  })

  await installSupabaseMock(page, state)
  await signInAsOwner(page)
  await page.getByRole('link', { name: /Reports/ }).click()

  await expect(page.getByRole('heading', { name: 'Financial reporting' })).toBeVisible()
  await expect(page.getByText('$94.50', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Payment collected' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('acct_')
  await expect(page.locator('body')).not.toContainText('bank account number')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download statement CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(
    /^tradeledger-statement-north-ridge-contracting-\d{4}-\d{2}-01-\d{4}-\d{2}-\d{2}\.csv$/,
  )

  await page.getByLabel('Start date').fill('2026-11-30')
  await page.getByLabel('End date').fill('2026-11-01')
  await page.getByRole('button', { name: 'Run report' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'The end date must be on or after the start date.',
  )

  expect(state.financialReportRequests).toHaveLength(2)
  expect(state.unexpectedRequests).toEqual([])
})

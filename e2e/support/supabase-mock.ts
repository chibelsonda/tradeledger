import type { Page, Route } from '@playwright/test'

export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001'
export const TEST_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
export const TEST_PROJECT_ID = '20000000-0000-4000-8000-000000000001'
export const TEST_SUBCONTRACTOR_ID = '30000000-0000-4000-8000-000000000001'
export const TEST_PAYOUT_ACCOUNT_ID = '35000000-0000-4000-8000-000000000001'
export const TEST_PAYMENT_REQUEST_ID = '40000000-0000-4000-8000-000000000001'
export const TEST_MEMBER_USER_ID = '00000000-0000-4000-8000-000000000002'

const supabaseOrigin = 'https://test-project.supabase.co'
const now = '2026-11-13T06:00:00.000Z'

type JsonRecord = Record<string, unknown>

export interface SupabaseMockState {
  authError?: string
  organizations: JsonRecord[]
  memberships: JsonRecord[]
  projects: JsonRecord[]
  subcontractors: JsonRecord[]
  payoutAccounts: JsonRecord[]
  paymentRequests: JsonRecord[]
  auditEvents: JsonRecord[]
  webhookFailures: JsonRecord[]
  waiverDocuments: JsonRecord[]
  notificationDeliveries: JsonRecord[]
  organizationMembers: JsonRecord[]
  demoWorkspaceStatus: JsonRecord | null
  paymentResult: JsonRecord | null
  checkoutUrl: string
  createdOrganizationPayloads: JsonRecord[]
  approvedRequestIds: string[]
  checkoutRequestIds: string[]
  memberUpserts: JsonRecord[]
  memberStatusChanges: JsonRecord[]
  demoRemovalPayloads: JsonRecord[]
  unexpectedRequests: string[]
}

export function createSupabaseMockState(
  overrides: Partial<SupabaseMockState> = {},
): SupabaseMockState {
  return {
    organizations: [],
    memberships: [],
    projects: [],
    subcontractors: [],
    payoutAccounts: [],
    paymentRequests: [],
    auditEvents: [],
    webhookFailures: [],
    waiverDocuments: [],
    notificationDeliveries: [],
    organizationMembers: [ownerMemberRecord()],
    demoWorkspaceStatus: null,
    paymentResult: null,
    checkoutUrl: 'https://checkout.stripe.com/c/pay/browser-test',
    createdOrganizationPayloads: [],
    approvedRequestIds: [],
    checkoutRequestIds: [],
    memberUpserts: [],
    memberStatusChanges: [],
    demoRemovalPayloads: [],
    unexpectedRequests: [],
    ...overrides,
  }
}

export async function installSupabaseMock(
  page: Page,
  state: SupabaseMockState,
): Promise<void> {
  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const requestLabel = `${request.method()} ${url.pathname}`

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders })
      return
    }

    if (url.pathname === '/auth/v1/token' && request.method() === 'POST') {
      if (state.authError) {
        await fulfillJson(route, 400, {
          error: 'invalid_grant',
          error_description: state.authError,
        })
        return
      }

      await fulfillJson(route, 200, authenticatedSession())
      return
    }

    if (url.pathname.startsWith('/rest/v1/rpc/') && request.method() === 'POST') {
      const rpcName = url.pathname.slice('/rest/v1/rpc/'.length)
      const body = request.postDataJSON() as JsonRecord

      if (
        rpcName === 'create_organization' ||
        rpcName === 'create_organization_workspace'
      ) {
        state.createdOrganizationPayloads.push(body)
        state.organizations = [organization(body)]
        state.memberships = [membership()]
        await fulfillJson(route, 200, TEST_ORGANIZATION_ID)
        return
      }

      if (rpcName === 'approve_payment_request') {
        const requestId = String(body.p_payment_request_id)
        state.approvedRequestIds.push(requestId)
        state.paymentRequests = state.paymentRequests.map((paymentRequest) =>
          paymentRequest.id === requestId
            ? {
                ...paymentRequest,
                status: 'approved',
                approved_by: TEST_USER_ID,
                approved_at: now,
                updated_at: now,
              }
            : paymentRequest,
        )
        await fulfillJson(route, 200, true)
        return
      }

      if (rpcName === 'list_organization_members') {
        await fulfillJson(route, 200, state.organizationMembers)
        return
      }

      if (rpcName === 'get_demo_workspace_status') {
        await fulfillJson(
          route,
          200,
          state.demoWorkspaceStatus ? [state.demoWorkspaceStatus] : [],
        )
        return
      }

      if (rpcName === 'remove_demo_workspace_data') {
        state.demoRemovalPayloads.push(body)
        state.projects = []
        state.subcontractors = []
        state.payoutAccounts = []
        state.paymentRequests = []
        state.notificationDeliveries = []
        state.demoWorkspaceStatus = null
        await fulfillJson(route, 200, {
          projects: 2,
          subcontractors: 2,
          paymentRequests: 3,
        })
        return
      }

      if (rpcName === 'upsert_organization_member') {
        state.memberUpserts.push(body)
        state.organizationMembers.push({
          user_id: TEST_MEMBER_USER_ID,
          email: body.p_email,
          role: body.p_role,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        await fulfillJson(route, 200, TEST_MEMBER_USER_ID)
        return
      }

      if (rpcName === 'set_organization_member_status') {
        state.memberStatusChanges.push(body)
        state.organizationMembers = state.organizationMembers.map((member) =>
          member.user_id === body.p_user_id
            ? { ...member, status: body.p_status, updated_at: now }
            : member,
        )
        await fulfillJson(route, 200, true)
        return
      }
    }

    if (url.pathname.startsWith('/rest/v1/') && request.method() === 'GET') {
      const table = url.pathname.slice('/rest/v1/'.length)

      if (table === 'payments') {
        await fulfillJson(route, 200, state.paymentResult)
        return
      }

      const tableData: Record<string, JsonRecord[]> = {
        organizations: state.organizations,
        organization_memberships: state.memberships,
        projects: state.projects,
        subcontractors: state.subcontractors,
        subcontractor_payout_accounts: state.payoutAccounts,
        payment_requests: state.paymentRequests,
        audit_events: state.auditEvents,
        stripe_webhook_failures: state.webhookFailures,
        waiver_documents: state.waiverDocuments,
        notification_deliveries: state.notificationDeliveries,
      }

      if (table in tableData) {
        await fulfillJson(route, 200, tableData[table])
        return
      }
    }

    if (
      url.pathname === '/functions/v1/dispatch-notification' &&
      request.method() === 'POST'
    ) {
      await fulfillJson(route, 200, { status: 'deferred' })
      return
    }

    if (
      url.pathname === '/functions/v1/create-checkout' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON() as JsonRecord
      state.checkoutRequestIds.push(String(body.paymentRequestId))
      await fulfillJson(route, 200, { url: state.checkoutUrl })
      return
    }

    state.unexpectedRequests.push(requestLabel)
    await route.abort('failed')
  })
}

export async function signInAsOwner(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill('owner@example.test')
  await page
    .getByLabel('Password', { exact: true })
    .fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: 'Sign in securely' }).click()
}

export function organizationRecord(): JsonRecord {
  return organization({
    p_name: 'North Ridge Contracting',
    p_slug: 'north-ridge-contracting',
  })
}

export function membershipRecord(): JsonRecord {
  return membership()
}

export function projectRecord(): JsonRecord {
  return {
    id: TEST_PROJECT_ID,
    organization_id: TEST_ORGANIZATION_ID,
    name: 'Cedar Kitchen Remodel',
    code: 'CEDAR-01',
    status: 'active',
    created_by: TEST_USER_ID,
    created_at: now,
    updated_at: now,
  }
}

export function subcontractorRecord(): JsonRecord {
  return {
    id: TEST_SUBCONTRACTOR_ID,
    organization_id: TEST_ORGANIZATION_ID,
    user_id: null,
    company_name: 'Fine Finish Carpentry',
    contact_name: 'Hector Ramirez',
    email: 'hector@example.test',
    status: 'active',
    created_by: TEST_USER_ID,
    created_at: now,
    updated_at: now,
  }
}

export function payoutAccountRecord(): JsonRecord {
  return {
    id: TEST_PAYOUT_ACCOUNT_ID,
    organization_id: TEST_ORGANIZATION_ID,
    subcontractor_id: TEST_SUBCONTRACTOR_ID,
    dashboard_type: 'full',
    onboarding_status: 'ready',
    livemode: false,
    details_submitted: true,
    charges_enabled: false,
    payouts_enabled: true,
    requirements_currently_due: [],
    requirements_eventually_due: [],
    requirements_past_due: [],
    disabled_reason: null,
    last_synced_at: now,
    created_at: now,
    updated_at: now,
  }
}

export function submittedPaymentRequestRecord(): JsonRecord {
  return {
    id: TEST_PAYMENT_REQUEST_ID,
    organization_id: TEST_ORGANIZATION_ID,
    project_id: TEST_PROJECT_ID,
    subcontractor_id: TEST_SUBCONTRACTOR_ID,
    created_by: TEST_USER_ID,
    approved_by: null,
    description: 'Kitchen trim milestone',
    gross_amount: 10500,
    retainage_basis_points: 1000,
    retainage_amount: 1050,
    net_amount: 9450,
    currency: 'usd',
    status: 'submitted',
    submitted_at: now,
    approved_at: null,
    checkout_started_at: null,
    paid_at: null,
    failed_at: null,
    refunded_amount: 0,
    refunded_at: null,
    created_at: now,
    updated_at: now,
  }
}

export function paidPaymentRecord(): JsonRecord {
  return {
    id: 1,
    user_id: TEST_USER_ID,
    organization_id: TEST_ORGANIZATION_ID,
    payment_request_id: TEST_PAYMENT_REQUEST_ID,
    reference: '50000000-0000-4000-8000-000000000001',
    product_name: 'Kitchen trim milestone',
    unit_amount: 9450,
    quantity: 1,
    amount_total: 9450,
    currency: 'usd',
    status: 'paid',
    stripe_checkout_session_id: 'cs_test_browser_001',
    stripe_payment_intent_id: 'pi_test_browser_001',
    customer_email: 'owner@example.test',
    paid_at: now,
    amount_refunded: 0,
    refunded_at: null,
    destination_charge: true,
    created_at: now,
    updated_at: now,
  }
}

export function ownerMemberRecord(): JsonRecord {
  return {
    user_id: TEST_USER_ID,
    email: 'owner@example.test',
    role: 'owner',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
}

function organization(payload: JsonRecord): JsonRecord {
  return {
    id: TEST_ORGANIZATION_ID,
    name: String(payload.p_name),
    slug: String(payload.p_slug),
    created_by: TEST_USER_ID,
    created_at: now,
    updated_at: now,
  }
}

function membership(): JsonRecord {
  return {
    organization_id: TEST_ORGANIZATION_ID,
    user_id: TEST_USER_ID,
    role: 'owner',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
}

function authenticatedSession(): JsonRecord {
  const accessToken = createUnsignedJwt({
    sub: TEST_USER_ID,
    role: 'authenticated',
    email: 'owner@example.test',
    exp: 4_102_444_800,
  })

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    refresh_token: 'browser-test-refresh-token',
    user: {
      id: TEST_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'owner@example.test',
      email_confirmed_at: now,
      phone: '',
      confirmed_at: now,
      last_sign_in_at: now,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    },
  }
}

function createUnsignedJwt(payload: JsonRecord): string {
  const encode = (value: JsonRecord) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.browser-test`
}

async function fulfillJson(
  route: Route,
  status: number,
  json: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    json,
    headers: corsHeaders,
  })
}

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-profile',
  'content-profile': 'public',
}

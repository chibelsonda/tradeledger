import {
  Button,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Field,
  Input,
  Label,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from '@headlessui/react'
import type { Session } from '@supabase/supabase-js'
import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AuditEvent,
  ConnectedPayout,
  Organization,
  OrganizationMember,
  OrganizationRole,
  PaymentRequest,
  PaymentTransfer,
  Project,
  StripeWebhookFailure,
  Subcontractor,
  SubcontractorPayoutAccount,
  WaiverDocument,
} from '@/lib/database.types'
import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { FieldError } from '@/components/ui/FieldError'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { formatCurrency, formatStatus } from '@/lib/format'
import {
  trustedStripeCheckoutUrl,
  trustedStripeConnectUrl,
  trustedSupabaseWaiverUrl,
} from '@/lib/navigation-security'
import { safeDatabaseErrorMessage } from '@/lib/public-errors'
import {
  calculateRetainage,
  dollarsToMinorUnits,
} from '@/lib/payment-calculations'
import { supabase, supabaseUrl } from '@/lib/supabase'
import {
  fieldErrorsFromZod,
  type FieldErrors,
} from '@/lib/validation'
import { SelectControl } from '@/components/ui/SelectControl'
import {
  SidePanel,
  SidePanelCloseButton,
} from '@/components/ui/SidePanel'
import {
  organizationMemberFormSchema,
  paymentRequestFormSchema,
  type OrganizationMemberFormValues,
  type PaymentRequestFormValues,
  type ProjectFormValues,
  type SubcontractorFormValues,
} from '@/features/operations/operations.schemas'
import {
  DashboardSidebar,
  type DashboardNavigationItem,
} from './DashboardSidebar'
import {
  DirectoryCreateDrawer,
  type DirectoryCreateTarget,
} from './DirectoryCreateDrawer'
import {
  DirectoryEditDialog,
  type DirectoryEditTarget,
} from './DirectoryEditDialog'
import { OverviewCharts } from './OverviewCharts'
import { PayoutLedger } from './PayoutLedger'
import { PayoutReadinessControl } from './PayoutReadinessControl'
import { TeamManagementPanel } from './TeamManagementPanel'
import { WaiverDocumentControl } from './WaiverDocumentControl'

interface WorkspaceOrganization extends Organization {
  role: OrganizationRole
}

interface OperationsDashboardProps {
  session: Session
  organization: WorkspaceOrganization
  organizations: WorkspaceOrganization[]
  onSelectOrganization: (organizationId: string) => void
}

type PaymentTransition = {
  requestId: string
  action: 'submit' | 'approve'
}
type DemoWorkspaceStatus = {
  status: 'active'
  can_remove: boolean
  reason: string | null
}
type OperationsFormField =
  | keyof ProjectFormValues
  | keyof SubcontractorFormValues
  | keyof PaymentRequestFormValues
  | keyof OrganizationMemberFormValues
type DashboardPage =
  | 'overview'
  | 'directory'
  | 'payments'
  | 'payouts'
  | 'team'
  | 'delivery'
  | 'audit'

const dashboardPathByPage: Record<DashboardPage, string> = {
  overview: '/dashboard',
  directory: '/directory',
  payments: '/payments',
  payouts: '/payouts',
  team: '/team',
  delivery: '/delivery',
  audit: '/audit',
}

const dashboardPageDetails: Record<
  DashboardPage,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: 'Tenant operations workspace',
    title: 'Operations overview',
    description: 'Workspace health and financial totals',
  },
  directory: {
    eyebrow: 'Organization records',
    title: 'Project directory',
    description: 'Projects, subcontractors, and operational contacts',
  },
  payments: {
    eyebrow: 'Financial workflow',
    title: 'Payment operations',
    description: 'Requests, approvals, checkout, waivers, and refunds',
  },
  payouts: {
    eyebrow: 'Connected money movement',
    title: 'Payout reconciliation',
    description: 'Transfers, bank payouts, reversals, and settlement evidence',
  },
  team: {
    eyebrow: 'Access governance',
    title: 'Team access',
    description: 'Active roles and tenant membership',
  },
  delivery: {
    eyebrow: 'Integration health',
    title: 'Webhook operations',
    description: 'Payment event processing and failure recovery',
  },
  audit: {
    eyebrow: 'Security evidence',
    title: 'Audit trail',
    description: 'Immutable organization activity recorded at the data layer',
  },
}

function dashboardPageFromPath(pathname: string): DashboardPage {
  const entry = Object.entries(dashboardPathByPage).find(
    ([, path]) => path === pathname,
  )

  return (entry?.[0] as DashboardPage | undefined) ?? 'overview'
}

const fieldClassName =
  'h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20 aria-invalid:focus:!border-red-700 aria-invalid:focus:!ring-2 aria-invalid:focus:!ring-red-600/20'
const selectFieldClassName =
  'h-10 border border-ink/15 bg-white pl-3.5 text-sm font-medium text-ink outline-none transition focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20 aria-invalid:focus:!border-red-700 aria-invalid:focus:!ring-2 aria-invalid:focus:!ring-red-600/20'

function EditIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
      <path d="m15 5 3 3" />
    </svg>
  )
}

function statusClassName(status: string): string {
  switch (status) {
    case 'approved':
    case 'paid':
    case 'active':
    case 'ready':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800'
    case 'partially_refunded':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    case 'refunded':
      return 'border-slate-300 bg-slate-100 text-slate-700'
    case 'submitted':
    case 'checkout_created':
    case 'processing':
    case 'generating':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    case 'failed':
    case 'blocked':
      return 'border-red-200 bg-red-50 text-red-800'
    case 'voided':
      return 'border-slate-300 bg-slate-100 text-slate-700'
    default:
      return 'border-ink/10 bg-cream text-ink/85'
  }
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

async function edgeFunctionErrorMessage(
  functionError: unknown,
  fallback: string,
): Promise<string> {
  const candidate = functionError as
    | { message?: unknown; context?: unknown }
    | null
    | undefined
  let message = typeof candidate?.message === 'string' ? candidate.message : fallback

  if (candidate?.context instanceof Response) {
    const payload = (await candidate.context.json().catch(() => null)) as
      | { error?: unknown }
      | null

    if (typeof payload?.error === 'string') {
      message = payload.error
    }
  }

  return message
}

export function OperationsDashboard({
  session,
  organization,
  organizations,
  onSelectOrganization,
}: OperationsDashboardProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([])
  const [payoutAccounts, setPayoutAccounts] = useState<
    SubcontractorPayoutAccount[]
  >([])
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([])
  const [paymentTransfers, setPaymentTransfers] = useState<PaymentTransfer[]>([])
  const [connectedPayouts, setConnectedPayouts] = useState<ConnectedPayout[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [webhookFailures, setWebhookFailures] = useState<StripeWebhookFailure[]>([])
  const [waiverDocuments, setWaiverDocuments] = useState<WaiverDocument[]>([])
  const [organizationMembers, setOrganizationMembers] = useState<
    OrganizationMember[]
  >([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [paymentTransition, setPaymentTransition] =
    useState<PaymentTransition | null>(null)
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(null)
  const [reconcilingRequestId, setReconcilingRequestId] = useState<string | null>(
    null,
  )
  const [refundRequestId, setRefundRequestId] = useState<string | null>(null)
  const [waiverRequestId, setWaiverRequestId] = useState<string | null>(null)
  const [memberUserId, setMemberUserId] = useState<string | null>(null)
  const [refundConfirmationId, setRefundConfirmationId] = useState<string | null>(
    null,
  )
  const [isNavigationOpen, setIsNavigationOpen] = useState(false)
  const [activeNavigationId, setActiveNavigationId] = useState<DashboardPage>(
    () => dashboardPageFromPath(window.location.pathname),
  )
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [demoWorkspaceStatus, setDemoWorkspaceStatus] =
    useState<DemoWorkspaceStatus | null>(null)
  const [isDemoRemovalOpen, setIsDemoRemovalOpen] = useState(false)
  const [isRemovingDemoData, setIsRemovingDemoData] = useState(false)
  const [directoryCreateTarget, setDirectoryCreateTarget] =
    useState<DirectoryCreateTarget | null>(null)
  const [directoryCreateError, setDirectoryCreateError] = useState<string | null>(
    null,
  )
  const [isPaymentCreateOpen, setIsPaymentCreateOpen] = useState(false)
  const [paymentCreateError, setPaymentCreateError] = useState<string | null>(
    null,
  )
  const [isTeamAccessOpen, setIsTeamAccessOpen] = useState(false)
  const [teamAccessError, setTeamAccessError] = useState<string | null>(null)
  const [directoryEditTarget, setDirectoryEditTarget] =
    useState<DirectoryEditTarget | null>(null)
  const [directoryEditError, setDirectoryEditError] = useState<string | null>(
    null,
  )
  const [isSavingDirectoryRecord, setIsSavingDirectoryRecord] = useState(false)
  const [payoutActionSubcontractorId, setPayoutActionSubcontractorId] = useState<
    string | null
  >(null)
  const dashboardLoadSequence = useRef(0)
  const connectReturnHandled = useRef(false)

  const [requestProjectId, setRequestProjectId] = useState('')
  const [requestSubcontractorId, setRequestSubcontractorId] = useState('')
  const [requestDescription, setRequestDescription] = useState('')
  const [requestGross, setRequestGross] = useState('')
  const [requestRetainage, setRequestRetainage] = useState('10')
  const [memberEmail, setMemberEmail] = useState('')
  const [memberRole, setMemberRole] = useState<
    Exclude<OrganizationRole, 'owner'>
  >('member')
  const [formErrors, setFormErrors] = useState<
    FieldErrors<OperationsFormField>
  >({})

  const canManageProjects = ['owner', 'admin'].includes(organization.role)
  const canManageTeam = ['owner', 'admin'].includes(organization.role)
  const canManagePayments = ['owner', 'admin', 'accountant'].includes(
    organization.role,
  )
  const canApprovePayments = ['owner', 'accountant'].includes(organization.role)
  const navigationItems = useMemo<DashboardNavigationItem[]>(() => {
    const directoryCount = projects.length + subcontractors.length
    const activeMemberCount = organizationMembers.filter(
      (member) => member.status === 'active',
    ).length

    return [
      {
        id: 'overview',
        href: dashboardPathByPage.overview,
        label: 'Overview',
        detail: 'Workspace health and totals',
      },
      {
        id: 'directory',
        href: dashboardPathByPage.directory,
        label: 'Directory',
        detail: 'Projects and subcontractors',
        badge: directoryCount > 0 ? String(directoryCount) : undefined,
      },
      {
        id: 'payments',
        href: dashboardPathByPage.payments,
        label: 'Payments',
        detail: 'Requests, checkout, and refunds',
        badge:
          paymentRequests.length > 0 ? String(paymentRequests.length) : undefined,
      },
      canManagePayments && {
        id: 'payouts',
        href: dashboardPathByPage.payouts,
        label: 'Payouts',
        detail: 'Transfers and bank settlement',
        badge:
          paymentTransfers.length + connectedPayouts.length > 0
            ? String(paymentTransfers.length + connectedPayouts.length)
            : undefined,
      },
      canManageTeam && {
        id: 'team',
        href: dashboardPathByPage.team,
        label: 'Team access',
        detail: 'Roles and membership',
        badge: activeMemberCount > 0 ? String(activeMemberCount) : undefined,
      },
      canManagePayments && {
        id: 'delivery',
        href: dashboardPathByPage.delivery,
        label: 'Webhooks',
        detail: 'Payment event health',
        badge:
          webhookFailures.length > 0 ? String(webhookFailures.length) : undefined,
      },
      {
        id: 'audit',
        href: dashboardPathByPage.audit,
        label: 'Audit trail',
        detail: 'Immutable activity evidence',
        badge: auditEvents.length > 0 ? String(auditEvents.length) : undefined,
      },
    ].filter(Boolean) as DashboardNavigationItem[]
  }, [
    auditEvents.length,
    canManagePayments,
    canManageTeam,
    connectedPayouts.length,
    organizationMembers,
    paymentRequests.length,
    paymentTransfers.length,
    projects.length,
    subcontractors.length,
    webhookFailures.length,
  ])

  const loadDashboard = useCallback(async () => {
    const loadSequence = ++dashboardLoadSequence.current
    setIsLoading(true)
    setError(null)

    const [
      projectResult,
      subcontractorResult,
      payoutAccountResult,
      requestResult,
      transferResult,
      connectedPayoutResult,
      auditResult,
      failureResult,
      waiverResult,
      memberResult,
      demoStatusResult,
    ] =
      await Promise.all([
        supabase
          .from('projects')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('subcontractors')
          .select('*')
          .eq('organization_id', organization.id)
          .order('company_name'),
        supabase
          .from('subcontractor_payout_accounts')
          .select(
            'id, organization_id, subcontractor_id, dashboard_type, onboarding_status, livemode, details_submitted, charges_enabled, payouts_enabled, requirements_currently_due, requirements_eventually_due, requirements_past_due, disabled_reason, last_synced_at, created_at, updated_at',
          )
          .eq('organization_id', organization.id),
        supabase
          .from('payment_requests')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('payment_transfers')
          .select('*')
          .eq('organization_id', organization.id)
          .order('stripe_created_at', { ascending: false })
          .limit(100),
        supabase
          .from('connected_payouts')
          .select('*')
          .eq('organization_id', organization.id)
          .order('stripe_created_at', { ascending: false })
          .limit(100),
        supabase
          .from('audit_events')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('stripe_webhook_failures')
          .select('*')
          .eq('organization_id', organization.id)
          .is('resolved_at', null)
          .order('last_failed_at', { ascending: false })
          .limit(6),
        supabase
          .from('waiver_documents')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false }),
        canManageTeam
          ? supabase.rpc('list_organization_members', {
              p_organization_id: organization.id,
            })
          : Promise.resolve({ data: [] as OrganizationMember[], error: null }),
        organization.role === 'owner'
          ? supabase
              .rpc('get_demo_workspace_status', {
                p_organization_id: organization.id,
              })
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])

    if (loadSequence !== dashboardLoadSequence.current) return

    const firstError =
      projectResult.error ??
      subcontractorResult.error ??
      payoutAccountResult.error ??
      requestResult.error ??
      transferResult.error ??
      connectedPayoutResult.error ??
      auditResult.error ??
      failureResult.error ??
      waiverResult.error ??
      memberResult.error ??
      demoStatusResult.error

    if (firstError) {
      setError(
        safeDatabaseErrorMessage(
          firstError,
          'The workspace data could not be loaded. Please refresh and try again.',
        ),
      )
      setIsLoading(false)
      return
    }

    const nextProjects = projectResult.data ?? []
    const nextSubcontractors = subcontractorResult.data ?? []

    setProjects(nextProjects)
    setSubcontractors(nextSubcontractors)
    setPayoutAccounts(payoutAccountResult.data ?? [])
    setPaymentRequests(requestResult.data ?? [])
    setPaymentTransfers(transferResult.data ?? [])
    setConnectedPayouts(connectedPayoutResult.data ?? [])
    setAuditEvents(auditResult.data ?? [])
    setWebhookFailures(failureResult.data ?? [])
    setWaiverDocuments(waiverResult.data ?? [])
    setOrganizationMembers(memberResult.data ?? [])
    setDemoWorkspaceStatus(demoStatusResult.data)
    setRequestProjectId((current) =>
      nextProjects.some((project) => project.id === current)
        ? current
        : nextProjects[0]?.id ?? '',
    )
    setRequestSubcontractorId((current) =>
      nextSubcontractors.some(
        (subcontractor) => subcontractor.id === current,
      )
        ? current
        : nextSubcontractors[0]?.id ?? '',
    )
    setIsLoading(false)
  }, [canManageTeam, organization.id, organization.role])

  useEffect(() => {
    if (connectReturnHandled.current || !canManageProjects) return

    const parameters = new URLSearchParams(window.location.search)
    const connectState = parameters.get('connect')
    const subcontractorId = parameters.get('subcontractor_id')

    if (
      !['refresh', 'return'].includes(connectState ?? '') ||
      !subcontractorId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        subcontractorId,
      )
    ) {
      return
    }

    connectReturnHandled.current = true
    window.history.replaceState(null, '', dashboardPathByPage.directory)

    const completeConnectReturn = async () => {
      await Promise.resolve()
      setActiveNavigationId('directory')
      setPayoutActionSubcontractorId(subcontractorId)

      if (connectState === 'refresh') {
        const { data, error: onboardingError } = await supabase.functions.invoke(
          'create-connect-onboarding-link',
          { body: { subcontractorId } },
        )

        if (onboardingError) {
          setError(
            await edgeFunctionErrorMessage(
              onboardingError,
              'Unable to continue payout onboarding. Please try again.',
            ),
          )
          setPayoutActionSubcontractorId(null)
          return
        }

        const onboardingUrl = trustedStripeConnectUrl(data?.url)

        if (!onboardingUrl) {
          setError('Stripe returned an invalid onboarding destination.')
          setPayoutActionSubcontractorId(null)
          return
        }

        window.location.assign(onboardingUrl)
        return
      }

      const { error: refreshError } = await supabase.functions.invoke(
        'refresh-connect-account',
        { body: { subcontractorId } },
      )

      setPayoutActionSubcontractorId(null)

      if (refreshError) {
        setError(
          await edgeFunctionErrorMessage(
            refreshError,
            'Unable to refresh payout readiness. Please try again.',
          ),
        )
        return
      }

      setNotice('Stripe payout readiness synchronized successfully.')
      await loadDashboard()
    }

    void completeConnectReturn()
  }, [canManageProjects, loadDashboard])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setNotice(null)
      void loadDashboard()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
      dashboardLoadSequence.current += 1
    }
  }, [loadDashboard])

  useEffect(() => {
    if (
      !Object.values(dashboardPathByPage).includes(window.location.pathname)
    ) {
      window.history.replaceState(null, '', dashboardPathByPage.overview)
    }

    const handlePopState = () => {
      const nextPage = dashboardPageFromPath(window.location.pathname)
      const isAllowed =
        (!['delivery', 'payouts'].includes(nextPage) || canManagePayments) &&
        (nextPage !== 'team' || canManageTeam)

      if (!isAllowed) {
        window.history.replaceState(null, '', dashboardPathByPage.overview)
      }

      setActiveNavigationId(isAllowed ? nextPage : 'overview')
      setFormErrors({})
      setIsNavigationOpen(false)
      window.scrollTo({ top: 0 })
    }

    window.addEventListener('popstate', handlePopState)
    handlePopState()
    return () => window.removeEventListener('popstate', handlePopState)
  }, [canManagePayments, canManageTeam])

  async function signOut() {
    setIsSigningOut(true)
    await supabase.auth.signOut()
    setIsSigningOut(false)
  }

  async function removeDemoWorkspaceData() {
    setError(null)
    setNotice(null)
    setIsRemovingDemoData(true)

    const { error: removalError } = await supabase.rpc(
      'remove_demo_workspace_data',
      { p_organization_id: organization.id },
    )

    setIsRemovingDemoData(false)

    if (removalError) {
      setError(
        safeDatabaseErrorMessage(
          removalError,
          'Demonstration data could not be removed. Refresh and try again.',
        ),
      )
      return
    }

    setIsDemoRemovalOpen(false)
    setNotice(
      'Demonstration records were removed. Your workspace and independent records were preserved.',
    )
    await loadDashboard()
  }

  const approvedNetAmount = useMemo(
    () =>
      paymentRequests
        .filter((request) => request.status === 'approved')
        .reduce((total, request) => total + request.net_amount, 0),
    [paymentRequests],
  )

  const refundedAmount = useMemo(
    () =>
      paymentRequests.reduce(
        (total, request) => total + request.refunded_amount,
        0,
      ),
    [paymentRequests],
  )

  const waiverByRequestId = useMemo(
    () =>
      new Map(
        waiverDocuments.map((document) => [document.payment_request_id, document]),
      ),
    [waiverDocuments],
  )

  const payoutAccountBySubcontractorId = useMemo(
    () =>
      new Map(
        payoutAccounts.map((account) => [account.subcontractor_id, account]),
      ),
    [payoutAccounts],
  )

  const requestPreview = useMemo(() => {
    const grossAmount = dollarsToMinorUnits(requestGross)
    const percentage = Number(requestRetainage)

    if (
      grossAmount === null ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      return null
    }

    return calculateRetainage(grossAmount, Math.round(percentage * 100))
  }, [requestGross, requestRetainage])

  async function createProject(values: ProjectFormValues) {
    setError(null)
    setNotice(null)
    setDirectoryCreateError(null)
    setIsSubmitting(true)
    const { error: createError } = await supabase.from('projects').insert({
      organization_id: organization.id,
      name: values.name,
      code: values.code,
      status: 'active',
    })
    setIsSubmitting(false)

    if (createError) {
      setDirectoryCreateError(
        safeDatabaseErrorMessage(createError, 'The project could not be created.'),
      )
      return
    }

    setDirectoryCreateTarget(null)
    setNotice('Project created inside the current organization boundary.')
    await loadDashboard()
  }

  async function createSubcontractor(values: SubcontractorFormValues) {
    setError(null)
    setNotice(null)
    setDirectoryCreateError(null)
    setIsSubmitting(true)
    const { error: createError } = await supabase.from('subcontractors').insert({
      organization_id: organization.id,
      company_name: values.companyName,
      contact_name: values.contactName || null,
      email: values.email || null,
      status: 'active',
    })
    setIsSubmitting(false)

    if (createError) {
      setDirectoryCreateError(
        safeDatabaseErrorMessage(
          createError,
          'The subcontractor could not be created.',
        ),
      )
      return
    }

    setDirectoryCreateTarget(null)
    setNotice('Subcontractor added to this organization only.')
    await loadDashboard()
  }

  async function updateProject(
    projectId: string,
    values: ProjectFormValues,
  ) {
    setDirectoryEditError(null)
    setNotice(null)
    setIsSavingDirectoryRecord(true)

    const { data, error: updateError } = await supabase
      .from('projects')
      .update({ name: values.name, code: values.code })
      .eq('id', projectId)
      .eq('organization_id', organization.id)
      .select('id')
      .maybeSingle()

    setIsSavingDirectoryRecord(false)

    if (updateError || !data) {
      setDirectoryEditError(
        updateError
          ? safeDatabaseErrorMessage(
              updateError,
              'The project could not be updated.',
            )
          : 'The project is no longer available in this workspace.',
      )
      return
    }

    setDirectoryEditTarget(null)
    setNotice('Project details updated successfully.')
    await loadDashboard()
  }

  async function updateSubcontractor(
    subcontractorId: string,
    values: SubcontractorFormValues,
  ) {
    setDirectoryEditError(null)
    setNotice(null)
    setIsSavingDirectoryRecord(true)

    const { data, error: updateError } = await supabase
      .from('subcontractors')
      .update({
        company_name: values.companyName,
        contact_name: values.contactName || null,
        email: values.email || null,
      })
      .eq('id', subcontractorId)
      .eq('organization_id', organization.id)
      .select('id')
      .maybeSingle()

    setIsSavingDirectoryRecord(false)

    if (updateError || !data) {
      setDirectoryEditError(
        updateError
          ? safeDatabaseErrorMessage(
              updateError,
              'The subcontractor could not be updated.',
            )
          : 'The subcontractor is no longer available in this workspace.',
      )
      return
    }

    setDirectoryEditTarget(null)
    setNotice('Subcontractor details updated successfully.')
    await loadDashboard()
  }

  async function startPayoutOnboarding(subcontractorId: string) {
    setError(null)
    setNotice(null)
    setPayoutActionSubcontractorId(subcontractorId)

    const { data, error: onboardingError } = await supabase.functions.invoke(
      'create-connect-onboarding-link',
      { body: { subcontractorId } },
    )

    if (onboardingError) {
      setError(
        await edgeFunctionErrorMessage(
          onboardingError,
          'Unable to start payout onboarding. Please try again.',
        ),
      )
      setPayoutActionSubcontractorId(null)
      return
    }

    const onboardingUrl = trustedStripeConnectUrl(data?.url)

    if (!onboardingUrl) {
      setError('Stripe returned an invalid onboarding destination.')
      setPayoutActionSubcontractorId(null)
      return
    }

    window.location.assign(onboardingUrl)
  }

  async function refreshPayoutReadiness(subcontractorId: string) {
    setError(null)
    setNotice(null)
    setPayoutActionSubcontractorId(subcontractorId)

    const { error: refreshError } = await supabase.functions.invoke(
      'refresh-connect-account',
      { body: { subcontractorId } },
    )

    setPayoutActionSubcontractorId(null)

    if (refreshError) {
      setError(
        await edgeFunctionErrorMessage(
          refreshError,
          'Unable to refresh payout readiness. Please try again.',
        ),
      )
      return
    }

    setNotice('Stripe payout readiness synchronized successfully.')
    await loadDashboard()
  }

  async function createPaymentRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setPaymentCreateError(null)

    const validation = paymentRequestFormSchema.safeParse({
      projectId: requestProjectId,
      subcontractorId: requestSubcontractorId,
      description: requestDescription,
      grossAmount: requestGross,
      retainagePercentage: requestRetainage,
    })

    if (!validation.success) {
      setFormErrors(
        fieldErrorsFromZod<OperationsFormField>(validation.error),
      )
      return
    }

    setFormErrors({})
    setIsSubmitting(true)
    const { error: createError } = await supabase.rpc('create_payment_request', {
      p_organization_id: organization.id,
      p_project_id: validation.data.projectId,
      p_subcontractor_id: validation.data.subcontractorId,
      p_description: validation.data.description,
      p_gross_amount: validation.data.grossAmount,
      p_retainage_basis_points: Math.round(
        validation.data.retainagePercentage * 100,
      ),
      p_currency: 'usd',
    })
    setIsSubmitting(false)

    if (createError) {
      setPaymentCreateError(
        safeDatabaseErrorMessage(
          createError,
          'The payment request could not be created.',
        ),
      )
      return
    }

    setIsPaymentCreateOpen(false)
    setRequestDescription('')
    setRequestGross('')
    setNotice('Draft payment request created with database-calculated retainage.')
    await loadDashboard()
  }

  async function transitionPaymentRequest(
    requestId: string,
    action: 'submit' | 'approve',
  ) {
    setError(null)
    setNotice(null)
    setPaymentTransition({ requestId, action })

    const result =
      action === 'submit'
        ? await supabase.rpc('submit_payment_request', {
            p_payment_request_id: requestId,
          })
        : await supabase.rpc('approve_payment_request', {
            p_payment_request_id: requestId,
          })

    setPaymentTransition(null)

    if (result.error || result.data !== true) {
      setError(
        safeDatabaseErrorMessage(
          result.error,
          `The request could not be ${action === 'submit' ? 'submitted' : 'approved'}.`,
        ),
      )
      return
    }

    if (action === 'submit') {
      setNotice('Payment request submitted for approval.')
      await loadDashboard()
      return
    }

    setNotice('Payment request approved and ready for secure checkout.')
    await loadDashboard()
  }

  async function upsertOrganizationMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setTeamAccessError(null)
    const validation = organizationMemberFormSchema.safeParse({
      email: memberEmail,
      role: memberRole,
    })

    if (!validation.success) {
      setFormErrors(
        fieldErrorsFromZod<OperationsFormField>(validation.error),
      )
      return
    }

    setFormErrors({})
    setIsSubmitting(true)

    const { error: memberError } = await supabase.rpc(
      'upsert_organization_member',
      {
        p_organization_id: organization.id,
        p_email: validation.data.email,
        p_role: validation.data.role,
      },
    )

    setIsSubmitting(false)

    if (memberError) {
      setTeamAccessError(
        safeDatabaseErrorMessage(
          memberError,
          'Team access could not be updated.',
        ),
      )
      return
    }

    setMemberEmail('')
    setIsTeamAccessOpen(false)
    setNotice('Team access updated successfully.')
    await loadDashboard()
  }

  async function setOrganizationMemberStatus(
    member: OrganizationMember,
    status: 'active' | 'suspended',
  ) {
    setError(null)
    setNotice(null)
    setMemberUserId(member.user_id)

    const { error: memberError } = await supabase.rpc(
      'set_organization_member_status',
      {
        p_organization_id: organization.id,
        p_user_id: member.user_id,
        p_status: status,
      },
    )

    setMemberUserId(null)

    if (memberError) {
      setError(
        safeDatabaseErrorMessage(
          memberError,
          'The member status could not be updated.',
        ),
      )
      return
    }

    setNotice(
      status === 'active'
        ? `${member.email} can access this workspace again.`
        : `${member.email} has been suspended from this workspace.`,
    )
    await loadDashboard()
  }

  async function startPaymentCheckout(requestId: string) {
    setError(null)
    setNotice(null)
    setCheckoutRequestId(requestId)

    const { data, error: checkoutError } = await supabase.functions.invoke(
      'create-checkout',
      {
        body: { paymentRequestId: requestId },
      },
    )

    if (checkoutError) {
      const message = await edgeFunctionErrorMessage(
        checkoutError,
        'Secure checkout could not be started. Please try again.',
      )

      setCheckoutRequestId(null)
      await loadDashboard()
      setError(message)
      return
    }

    const url = trustedStripeCheckoutUrl(
      (data as { url?: unknown } | null)?.url,
    )

    if (!url) {
      setCheckoutRequestId(null)
      await loadDashboard()
      setError('The payment provider did not return a valid checkout URL.')
      return
    }

    window.location.assign(url)
  }

  async function reconcilePayment(requestId: string) {
    setError(null)
    setNotice(null)
    setReconcilingRequestId(requestId)

    const { data, error: reconciliationError } = await supabase.functions.invoke(
      'reconcile-payment',
      { body: { paymentRequestId: requestId } },
    )

    setReconcilingRequestId(null)

    if (reconciliationError) {
      const message = await edgeFunctionErrorMessage(
        reconciliationError,
        'Payment reconciliation could not be completed.',
      )
      await loadDashboard()
      setError(message)
      return
    }

    const status = (data as { status?: unknown } | null)?.status
    setNotice(
      `Payment reconciliation completed${typeof status === 'string' ? ` with ${formatStatus(status)} status` : ''}.`,
    )
    await loadDashboard()
  }

  async function refundPayment(requestId: string) {
    setError(null)
    setNotice(null)
    setRefundRequestId(requestId)

    const { data, error: refundError } = await supabase.functions.invoke(
      'create-refund',
      { body: { paymentRequestId: requestId } },
    )

    setRefundRequestId(null)
    setRefundConfirmationId(null)

    if (refundError) {
      const message = await edgeFunctionErrorMessage(
        refundError,
        'The refund could not be completed.',
      )
      await loadDashboard()
      setError(message)
      return
    }

    const status = (data as { status?: unknown } | null)?.status
    setNotice(
      typeof status === 'string' && status !== 'succeeded'
        ? `The payment provider accepted the refund with ${formatStatus(status)} status. Reconciliation will keep the ledger current.`
        : 'The refund succeeded and the payment ledger was updated.',
    )
    await loadDashboard()
  }

  async function openWaiverDocument(
    requestId: string,
    mode: 'generate' | 'download',
  ) {
    setError(null)
    setNotice(null)
    setWaiverRequestId(requestId)

    const { data, error: waiverError } = await supabase.functions.invoke(
      mode === 'generate' ? 'generate-waiver' : 'download-waiver',
      { body: { paymentRequestId: requestId } },
    )

    setWaiverRequestId(null)

    if (waiverError) {
      const message = await edgeFunctionErrorMessage(
        waiverError,
        mode === 'generate'
          ? 'The waiver document could not be generated.'
          : 'The waiver download is temporarily unavailable.',
      )
      await loadDashboard()
      setError(message)
      return
    }

    const url = trustedSupabaseWaiverUrl(
      (data as { url?: unknown } | null)?.url,
      supabaseUrl,
    )

    if (!url) {
      await loadDashboard()
      setError('The document service did not return a secure download URL.')
      return
    }

    await loadDashboard()
    window.location.assign(url)
  }

  const selectedProject = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
  const selectedSubcontractor = (subcontractorId: string) =>
    subcontractors.find((item) => item.id === subcontractorId)?.company_name ??
    'Unknown subcontractor'
  const refundConfirmation =
    paymentRequests.find((request) => request.id === refundConfirmationId) ?? null
  const userEmail = session.user.email ?? 'Authenticated user'
  const userInitial = userEmail.charAt(0).toUpperCase()

  function navigateTo(itemId: string) {
    const nextPage = itemId as DashboardPage
    const path = dashboardPathByPage[nextPage]

    if (
      !path ||
      (['delivery', 'payouts'].includes(nextPage) && !canManagePayments) ||
      (nextPage === 'team' && !canManageTeam)
    ) {
      return
    }

    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path)
    }

    setActiveNavigationId(nextPage)
    setFormErrors({})
    setIsNavigationOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const activePageDetails = dashboardPageDetails[activeNavigationId]

  return (
    <div className="min-h-screen bg-cream lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen lg:block">
        <DashboardSidebar
          items={navigationItems}
          activeItemId={activeNavigationId}
          onNavigate={navigateTo}
        />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-20 items-center justify-between gap-4 border-b border-ink/10 bg-white/92 px-4 shadow-[0_1px_0_rgba(19,37,31,0.02)] backdrop-blur-xl sm:px-6 xl:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              onClick={() => setIsNavigationOpen(true)}
              aria-label="Open navigation"
              className="grid size-10 shrink-0 place-items-center border border-ink/15 bg-white text-ink transition hover:bg-cream lg:hidden"
            >
              <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
                <path
                  d="M3 5h14M3 10h14M3 15h14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </Button>
            <div className="min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-forest/80">
                Operations dashboard
              </p>
              <p className="truncate text-sm font-extrabold tracking-[-0.02em] text-ink sm:text-base">
                {organization.name}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {organizations.length > 1 && (
              <Field className="flex items-center gap-3">
                <Label className="sr-only">Workspace</Label>
                <SelectControl
                  value={organization.id}
                  onChange={onSelectOrganization}
                  options={organizations.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                  ariaLabel="Workspace"
                  containerClassName="w-32 sm:w-48 xl:w-56"
                  className="h-9 border border-ink/15 bg-white pl-3 text-sm font-semibold text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/10"
                />
              </Field>
            )}

            <Menu as="div" className="relative">
              <MenuButton className="inline-flex items-center gap-2 py-1 text-left text-ink transition hover:text-forest focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/20">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-forest text-xs font-extrabold text-mint">
                  {userInitial}
                </span>
                <span className="hidden min-w-0 lg:block">
                  <span className="block max-w-40 truncate text-xs font-bold">
                    {userEmail}
                  </span>
                  <span className="mt-0.5 block text-[9px] font-semibold text-ink/75">
                    {formatStatus(organization.role)} access
                  </span>
                </span>
                <svg
                  viewBox="0 0 20 20"
                  className="size-4 shrink-0 text-ink/70"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="m6 8 4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </MenuButton>

              <MenuItems
                transition
                className="absolute right-0 z-50 mt-2 w-72 origin-top-right border border-ink/12 bg-white p-2 shadow-[0_20px_48px_rgba(19,37,31,0.16)] transition duration-100 ease-out focus:outline-none data-closed:scale-95 data-closed:opacity-0"
              >
                <div className="border-b border-ink/8 p-3">
                  <p className="truncate text-sm font-extrabold text-ink">
                    {userEmail}
                  </p>
                  <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.16em] text-ink/70">
                    Verified account
                  </p>
                </div>

                <dl className="grid gap-3 border-b border-ink/8 p-3 text-xs">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-ink/75">Access level</dt>
                    <dd className="border border-forest/15 bg-mint/15 px-2 py-1 font-bold text-forest">
                      {formatStatus(organization.role)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-ink/75">Workspace</dt>
                    <dd className="max-w-40 truncate font-bold text-ink">
                      {organization.name}
                    </dd>
                  </div>
                </dl>

                <MenuItem>
                  <Button
                    type="button"
                    onClick={() => void signOut()}
                    disabled={isSigningOut}
                    aria-busy={isSigningOut}
                    className="mt-1 flex h-10 w-full items-center justify-between px-3 text-sm font-bold text-red-700 transition data-focus:bg-red-50 disabled:cursor-wait disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-2">
                      {isSigningOut && <ButtonSpinner />}
                      {isSigningOut ? 'Signing out…' : 'Sign out'}
                    </span>
                    {!isSigningOut && (
                      <svg
                        viewBox="0 0 20 20"
                        className="size-4"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M8 4H4.75A1.75 1.75 0 0 0 3 5.75v8.5C3 15.22 3.78 16 4.75 16H8m4-3 3-3-3-3m3 3H7"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </Button>
                </MenuItem>
              </MenuItems>
            </Menu>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1480px] flex-col gap-7 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-9">
          <section className="border-b border-ink/10 pb-6">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-forest/80">
              {activePageDetails.eyebrow}
            </p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.04em] text-ink sm:text-[2.25rem]">
              {activePageDetails.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm font-medium text-ink/85">
              <span className="border border-forest/15 bg-white px-2.5 py-1 text-xs font-bold text-forest">
                {formatStatus(organization.role)}
              </span>
              <span>{organization.name}</span>
              <span aria-hidden="true" className="text-ink/20">/</span>
              <span>{activePageDetails.description}</span>
            </div>
          </section>

      {error && (
        <NotificationBanner tone="error">{error}</NotificationBanner>
      )}
      {notice && (
        <NotificationBanner tone="success">{notice}</NotificationBanner>
      )}

      {activeNavigationId === 'overview' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[
              [
                'Active projects',
                projects.filter((project) => project.status === 'active').length,
              ],
              ['Subcontractors', subcontractors.length],
              ['Payment requests', paymentRequests.length],
              ['Approved net', formatCurrency(approvedNetAmount, 'usd')],
              ['Refunded', formatCurrency(refundedAmount, 'usd')],
            ].map(([label, value]) => (
              <div
                key={label}
                className="group relative overflow-hidden border border-ink/10 bg-white p-5 shadow-[0_14px_36px_rgba(19,37,31,0.05)] transition-transform hover:-translate-y-0.5"
              >
                <span className="absolute inset-x-0 top-0 h-0.5 bg-forest/70" />
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink/75">
                  {label}
                </p>
                <p className="mt-3 text-3xl font-extrabold tracking-[-0.04em] text-ink">
                  {value}
                </p>
              </div>
            ))}
          </div>

          <OverviewCharts paymentRequests={paymentRequests} />

          {demoWorkspaceStatus && (
            <section className="grid gap-5 border border-amber-950/15 bg-amber-950/[0.035] p-6 shadow-[0_14px_36px_rgba(19,37,31,0.05)] lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-950/70">
                  Demonstration workspace
                </p>
                <h2 className="mt-2 text-xl font-extrabold tracking-[-0.03em] text-ink">
                  Sample operational data is active
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 font-medium text-ink/80">
                  This workspace contains the optional onboarding dataset. Remove
                  it before entering live records. The immutable audit trail will
                  retain evidence that the sample data was created and removed.
                </p>
                {!demoWorkspaceStatus.can_remove && demoWorkspaceStatus.reason && (
                  <p className="mt-3 border-l-2 border-amber-900/35 pl-3 text-sm font-semibold text-amber-950">
                    {demoWorkspaceStatus.reason}
                  </p>
                )}
              </div>
              <Button
                type="button"
                disabled={!demoWorkspaceStatus.can_remove}
                onClick={() => setIsDemoRemovalOpen(true)}
                className="h-10 border border-red-700 bg-white px-4 text-sm font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-ink/15 disabled:text-ink/45"
              >
                Remove demonstration data
              </Button>
            </section>
          )}
        </>
      )}

      {((activeNavigationId === 'directory' && canManageProjects) ||
        (activeNavigationId === 'payments' && canManagePayments)) && (
        <section
          className="grid items-start gap-6 xl:grid-cols-[1.35fr_0.65fr]"
        >
          <div className="border border-ink/10 bg-white p-6 shadow-[0_16px_40px_rgba(19,37,31,0.06)] sm:p-7">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-forest/80">
                  Controlled write path
                </p>
                <h2 className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-ink">
                  {activeNavigationId === 'payments'
                    ? 'Create payment request'
                    : 'Directory actions'}
                </h2>
              </div>
            </div>

            {activeNavigationId === 'directory' && canManageProjects && (
              <div className="mt-6 flex flex-col gap-4 sm:flex-row">
                <Button
                  type="button"
                  onClick={() => {
                    setDirectoryCreateError(null)
                    setDirectoryCreateTarget('project')
                  }}
                  className="inline-flex h-10 items-center justify-center bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                >
                  Add project
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setDirectoryCreateError(null)
                    setDirectoryCreateTarget('subcontractor')
                  }}
                  className="inline-flex h-10 items-center justify-center border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                >
                  Add subcontractor
                </Button>
              </div>
            )}

            {activeNavigationId === 'payments' && canManagePayments && (
              <>
                <Button
                  type="button"
                  disabled={projects.length === 0 || subcontractors.length === 0}
                  onClick={() => {
                    setPaymentCreateError(null)
                    setFormErrors({})
                    setIsPaymentCreateOpen(true)
                  }}
                  className="mt-6 inline-flex h-10 items-center justify-center bg-ink px-4 text-sm font-bold text-white transition-colors hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Create draft request
                </Button>
                <SidePanel
                  open={isPaymentCreateOpen}
                  busy={isSubmitting}
                  onClose={() => {
                    setIsPaymentCreateOpen(false)
                    setPaymentCreateError(null)
                    setFormErrors({})
                  }}
                >
                  <form
                    noValidate
                    autoComplete="off"
                    onSubmit={(event) => void createPaymentRequest(event)}
                    className="flex min-h-full flex-col"
                  >
                    <SidePanelCloseButton
                      disabled={isSubmitting}
                      onClick={() => {
                        setIsPaymentCreateOpen(false)
                        setPaymentCreateError(null)
                        setFormErrors({})
                      }}
                    />
                    <div className="grid flex-1 content-start gap-x-4 gap-y-5 p-6 pt-16 sm:grid-cols-2 sm:p-8 sm:pt-20">
                    <div className="pr-10 sm:col-span-2">
                      <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
                        Financial workflow
                      </p>
                      <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
                        Create payment request
                      </DialogTitle>
                      <Description className="mt-2 text-sm leading-6 font-medium text-ink/80">
                        Create a draft request with database-calculated retainage.
                      </Description>
                    </div>
                    {paymentCreateError && (
                      <NotificationBanner tone="error" className="sm:col-span-2">
                        {paymentCreateError}
                      </NotificationBanner>
                    )}
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  <Label>Project</Label>
                  <SelectControl
                    value={requestProjectId}
                    onChange={(value) => {
                      setRequestProjectId(value)
                      setFormErrors((current) => ({
                        ...current,
                        projectId: undefined,
                      }))
                    }}
                    options={[
                      { value: '', label: 'Select a project' },
                      ...projects.map((project) => ({
                        value: project.id,
                        label: project.name,
                      })),
                    ]}
                    ariaLabel="Project"
                    ariaDescribedBy={
                      formErrors.projectId ? 'payment-project-error' : undefined
                    }
                    invalid={Boolean(formErrors.projectId)}
                    className={selectFieldClassName}
                  />
                  <FieldError
                    id="payment-project-error"
                    message={formErrors.projectId}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  <Label>Subcontractor</Label>
                  <SelectControl
                    value={requestSubcontractorId}
                    onChange={(value) => {
                      setRequestSubcontractorId(value)
                      setFormErrors((current) => ({
                        ...current,
                        subcontractorId: undefined,
                      }))
                    }}
                    options={[
                      { value: '', label: 'Select a subcontractor' },
                      ...subcontractors.map((subcontractor) => ({
                        value: subcontractor.id,
                        label: subcontractor.company_name,
                      })),
                    ]}
                    ariaLabel="Subcontractor"
                    ariaDescribedBy={
                      formErrors.subcontractorId
                        ? 'payment-subcontractor-error'
                        : undefined
                    }
                    invalid={Boolean(formErrors.subcontractorId)}
                    className={selectFieldClassName}
                  />
                  <FieldError
                    id="payment-subcontractor-error"
                    message={formErrors.subcontractorId}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  <Label>Milestone description</Label>
                  <Input
                    autoComplete="off"
                    required
                    maxLength={500}
                    value={requestDescription}
                    onChange={(event) => {
                      setRequestDescription(event.target.value)
                      setFormErrors((current) => ({
                        ...current,
                        description: undefined,
                      }))
                    }}
                    aria-invalid={Boolean(formErrors.description)}
                    data-validation-error={
                      Boolean(formErrors.description) || undefined
                    }
                    aria-describedby={
                      formErrors.description
                        ? 'payment-description-error'
                        : undefined
                    }
                    placeholder="Kitchen trim milestone"
                    className={fieldClassName}
                  />
                  <FieldError
                    id="payment-description-error"
                    message={formErrors.description}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Gross amount (USD)</Label>
                  <Input
                    autoComplete="off"
                    required
                    inputMode="decimal"
                    value={requestGross}
                    onChange={(event) => {
                      setRequestGross(event.target.value)
                      setFormErrors((current) => ({
                        ...current,
                        grossAmount: undefined,
                      }))
                    }}
                    aria-invalid={Boolean(formErrors.grossAmount)}
                    data-validation-error={
                      Boolean(formErrors.grossAmount) || undefined
                    }
                    aria-describedby={
                      formErrors.grossAmount
                        ? 'payment-gross-error'
                        : undefined
                    }
                    placeholder="2850.00"
                    className={fieldClassName}
                  />
                  <FieldError
                    id="payment-gross-error"
                    message={formErrors.grossAmount}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Retainage percentage</Label>
                  <Input
                    autoComplete="off"
                    required
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={requestRetainage}
                    onChange={(event) => {
                      setRequestRetainage(event.target.value)
                      setFormErrors((current) => ({
                        ...current,
                        retainagePercentage: undefined,
                      }))
                    }}
                    aria-invalid={Boolean(formErrors.retainagePercentage)}
                    data-validation-error={
                      Boolean(formErrors.retainagePercentage) || undefined
                    }
                    aria-describedby={
                      formErrors.retainagePercentage
                        ? 'payment-retainage-error'
                        : undefined
                    }
                    className={fieldClassName}
                  />
                  <FieldError
                    id="payment-retainage-error"
                    message={formErrors.retainagePercentage}
                  />
                </Field>

                <div className="flex flex-col gap-3 border border-ink/10 bg-cream/65 p-4 text-sm sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-bold text-ink">Server-validated preview</p>
                    <p className="mt-1 text-xs text-ink/75">
                      The database recalculates and constrains these values.
                    </p>
                  </div>
                  <div className="flex gap-5 text-right">
                    <div>
                      <p className="text-xs text-ink/75">Retainage</p>
                      <p className="font-bold text-ink">
                        {requestPreview
                          ? formatCurrency(requestPreview.retainageAmount, 'usd')
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-ink/75">Net payable</p>
                      <p className="font-extrabold text-forest">
                        {requestPreview
                          ? formatCurrency(requestPreview.netAmount, 'usd')
                          : '—'}
                      </p>
                    </div>
                  </div>
                </div>
                    </div>

                    <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-3 border-t border-ink/10 bg-white p-4 sm:flex-row sm:justify-end sm:p-6">
                      <Button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => {
                          setIsPaymentCreateOpen(false)
                          setPaymentCreateError(null)
                          setFormErrors({})
                        }}
                        className="h-10 border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          isSubmitting ||
                          projects.length === 0 ||
                          subcontractors.length === 0
                        }
                        aria-busy={isSubmitting}
                        className="inline-flex h-10 items-center justify-center gap-2 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSubmitting && <ButtonSpinner tone="light" />}
                        {isSubmitting
                          ? 'Creating draft…'
                          : 'Create draft request'}
                      </Button>
                    </div>
                  </form>
                </SidePanel>
              </>
            )}
          </div>

          <aside className="flex self-start flex-col gap-4 bg-forest p-6 text-white shadow-[0_16px_40px_rgba(19,37,31,0.12)] sm:p-7">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-mint/75">
                Security evidence
              </p>
              <h2 className="mt-1 text-xl font-extrabold tracking-[-0.035em]">
                The database owns the boundary.
              </h2>
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 pt-4 text-xs font-medium text-white/80">
              {[
                'Tenant-isolated records',
                'Integer-safe money',
                'Database-owned retainage',
                'Audited state changes',
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-mint text-[10px] font-extrabold text-ink">
                    ✓
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </aside>
        </section>
      )}

      {activeNavigationId === 'directory' && (
        <TabGroup
          as="section"
          className="overflow-hidden border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]"
        >
          <div className="border-b border-ink/10 px-6 pt-6 sm:px-7 sm:pt-7">
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-ink/75">
              Organization directory
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">
              Projects and subcontractors
            </h2>
            <TabList className="mt-5 flex gap-6 overflow-x-auto" aria-label="Directory records">
              <Tab className="inline-flex min-w-max border-b-2 border-transparent px-1 pb-3 text-sm font-bold text-ink/65 outline-none transition hover:text-ink focus-visible:ring-2 focus-visible:ring-forest/25 data-selected:border-forest data-selected:text-forest">
                Projects
              </Tab>
              <Tab className="inline-flex min-w-max border-b-2 border-transparent px-1 pb-3 text-sm font-bold text-ink/65 outline-none transition hover:text-ink focus-visible:ring-2 focus-visible:ring-forest/25 data-selected:border-forest data-selected:text-forest">
                Subcontractors
              </Tab>
            </TabList>
          </div>

          <TabPanels>
            <TabPanel className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-forest/25">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left">
                  <thead className="bg-cream/70">
                    <tr className="border-b border-ink/10">
                      <th scope="col" className="w-1/2 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Project
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Code
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Status
                      </th>
                      {canManageProjects && (
                        <th scope="col" className="w-20 px-6 py-3 text-center text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                          Edit
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/8">
                    {projects.length === 0 ? (
                      <tr>
                        <td
                          colSpan={canManageProjects ? 4 : 3}
                          className="px-6 py-8 text-sm font-medium text-ink/75"
                        >
                          No projects yet. Add the first project above.
                        </td>
                      </tr>
                    ) : (
                      projects.map((project) => (
                        <tr key={project.id} className="transition-colors hover:bg-cream/45">
                          <th scope="row" className="px-6 py-4 text-sm font-bold text-ink">
                            {project.name}
                          </th>
                          <td className="px-4 py-4 font-mono text-[11px] font-medium text-ink/75">
                            {project.code}
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={
                                'inline-flex border px-2.5 py-1 text-[11px] font-bold ' +
                                statusClassName(project.status)
                              }
                            >
                              {formatStatus(project.status)}
                            </span>
                          </td>
                          {canManageProjects && (
                            <td className="px-6 py-4 text-center">
                              <Button
                                type="button"
                                onClick={() => {
                                  setDirectoryEditError(null)
                                  setDirectoryEditTarget({
                                    kind: 'project',
                                    record: project,
                                  })
                                }}
                                aria-label={`Edit ${project.name}`}
                                title={`Edit ${project.name}`}
                                className="inline-grid size-8 place-items-center text-ink/65 transition hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                              >
                                <EditIcon />
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </TabPanel>

            <TabPanel className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-forest/25">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left">
                  <thead className="bg-cream/70">
                    <tr className="border-b border-ink/10">
                      <th scope="col" className="w-1/3 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Company
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Contact
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Email
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                        Payout readiness
                      </th>
                      {canManageProjects && (
                        <th scope="col" className="w-20 px-6 py-3 text-center text-[10px] font-bold uppercase tracking-[0.14em] text-ink/70">
                          Edit
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/8">
                    {subcontractors.length === 0 ? (
                      <tr>
                        <td
                          colSpan={canManageProjects ? 6 : 5}
                          className="px-6 py-8 text-sm font-medium text-ink/75"
                        >
                          No subcontractors yet. Add one before creating a payment request.
                        </td>
                      </tr>
                    ) : (
                      subcontractors.map((subcontractor) => (
                        <tr
                          key={subcontractor.id}
                          className="transition-colors hover:bg-cream/45"
                        >
                          <th scope="row" className="px-6 py-4 text-sm font-bold text-ink">
                            {subcontractor.company_name}
                          </th>
                          <td className="px-4 py-4 text-xs font-medium text-ink/75">
                            {subcontractor.contact_name ?? '—'}
                          </td>
                          <td className="px-4 py-4 text-xs font-medium text-ink/75">
                            {subcontractor.email ?? '—'}
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={
                                'inline-flex border px-2.5 py-1 text-[11px] font-bold ' +
                                statusClassName(subcontractor.status)
                              }
                            >
                              {formatStatus(subcontractor.status)}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <PayoutReadinessControl
                              account={payoutAccountBySubcontractorId.get(
                                subcontractor.id,
                              )}
                              canManage={canManageProjects}
                              isBusy={
                                payoutActionSubcontractorId === subcontractor.id
                              }
                              onRefresh={() => {
                                void refreshPayoutReadiness(subcontractor.id)
                              }}
                              onStartOnboarding={() => {
                                void startPayoutOnboarding(subcontractor.id)
                              }}
                            />
                          </td>
                          {canManageProjects && (
                            <td className="px-6 py-4 text-center">
                              <Button
                                type="button"
                                onClick={() => {
                                  setDirectoryEditError(null)
                                  setDirectoryEditTarget({
                                    kind: 'subcontractor',
                                    record: subcontractor,
                                  })
                                }}
                                aria-label={`Edit ${subcontractor.company_name}`}
                                title={`Edit ${subcontractor.company_name}`}
                                className="inline-grid size-8 place-items-center text-ink/65 transition hover:text-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                              >
                                <EditIcon />
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </TabPanel>
          </TabPanels>
        </TabGroup>
      )}

      {activeNavigationId === 'payments' && (
      <section
        className="overflow-hidden border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]"
      >
        <div className="flex flex-col justify-between gap-3 border-b border-ink/10 p-6 sm:flex-row sm:items-center">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-ink/75">
              Financial workflow
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">Payment requests</h2>
          </div>
          <a
            href="/?demo=checkout"
            className="inline-flex h-10 items-center justify-center border border-ink/10 px-4 text-xs font-bold text-ink transition hover:bg-cream"
          >
            Open checkout demo
          </a>
        </div>

        {isLoading ? (
          <p className="p-6 text-sm font-medium text-ink/80">Refreshing payment ledger…</p>
        ) : paymentRequests.length === 0 ? (
          <p className="p-6 text-sm font-medium text-ink/80">
            No payment requests yet. Draft one after adding a project and subcontractor.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.15em] text-ink/80">
                <tr>
                  <th className="px-6 py-3">Request</th>
                  <th className="px-4 py-3">Project / subcontractor</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Retainage</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-6 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/8">
                {paymentRequests.map((request) => {
                  const waiver = waiverByRequestId.get(request.id)

                  return (
                    <tr key={request.id} className="align-middle transition-colors hover:bg-cream/40">
                    <td className="px-6 py-4">
                      <p className="max-w-56 truncate font-bold text-ink">
                        {request.description}
                      </p>
                      <p className="mt-1 text-xs text-ink/70">
                        {shortDate(request.created_at)}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-ink">
                        {selectedProject(request.project_id)}
                      </p>
                      <p className="mt-1 text-xs text-ink/75">
                        {selectedSubcontractor(request.subcontractor_id)}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-right font-semibold text-ink">
                      {formatCurrency(request.gross_amount, request.currency)}
                    </td>
                    <td className="px-4 py-4 text-right text-ink/85">
                      {formatCurrency(request.retainage_amount, request.currency)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <p className="font-extrabold text-forest">
                        {formatCurrency(request.net_amount, request.currency)}
                      </p>
                      {request.refunded_amount > 0 && (
                        <p className="mt-1 text-[11px] font-semibold text-blue-700">
                          {formatCurrency(request.refunded_amount, request.currency)} refunded
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={
                          'border px-2.5 py-1 text-[11px] font-bold ' +
                          statusClassName(request.status)
                        }
                      >
                        {formatStatus(request.status)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <WaiverDocumentControl
                        requestStatus={request.status}
                        waiver={waiver}
                        canGenerate={canApprovePayments}
                        canDownload={canManagePayments}
                        isBusy={waiverRequestId === request.id}
                        isDisabled={waiverRequestId !== null}
                        onGenerate={() =>
                          void openWaiverDocument(request.id, 'generate')
                        }
                        onDownload={() =>
                          void openWaiverDocument(request.id, 'download')
                        }
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                      {request.status === 'draft' && canManagePayments && (
                        <Button
                          type="button"
                          disabled={paymentTransition !== null}
                          aria-busy={
                            paymentTransition?.requestId === request.id &&
                            paymentTransition.action === 'submit'
                          }
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'submit')
                          }
                          className="inline-flex items-center justify-center gap-2 border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:bg-cream disabled:cursor-wait disabled:opacity-50"
                        >
                          {paymentTransition?.requestId === request.id &&
                            paymentTransition.action === 'submit' && (
                              <ButtonSpinner />
                            )}
                          {paymentTransition?.requestId === request.id &&
                          paymentTransition.action === 'submit'
                            ? 'Submitting…'
                            : 'Submit'}
                        </Button>
                      )}
                      {request.status === 'submitted' && canApprovePayments && (
                        <Button
                          type="button"
                          disabled={paymentTransition !== null}
                          aria-busy={
                            paymentTransition?.requestId === request.id &&
                            paymentTransition.action === 'approve'
                          }
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'approve')
                          }
                          className="inline-flex items-center justify-center gap-2 bg-ink px-3 py-2 text-xs font-bold text-white transition hover:bg-forest disabled:cursor-wait disabled:opacity-50"
                        >
                          {paymentTransition?.requestId === request.id &&
                            paymentTransition.action === 'approve' && (
                              <ButtonSpinner tone="light" />
                            )}
                          {paymentTransition?.requestId === request.id &&
                          paymentTransition.action === 'approve'
                            ? 'Approving…'
                            : 'Approve'}
                        </Button>
                      )}
                      {['approved', 'checkout_created', 'failed'].includes(
                        request.status,
                      ) &&
                        canManagePayments && (
                          <Button
                            type="button"
                            disabled={checkoutRequestId !== null}
                            aria-busy={checkoutRequestId === request.id}
                            onClick={() => void startPaymentCheckout(request.id)}
                            className="inline-flex min-w-28 items-center justify-center gap-2 bg-forest px-3 py-2 text-xs font-bold text-white transition hover:bg-ink disabled:cursor-wait disabled:opacity-55"
                          >
                            {checkoutRequestId === request.id && (
                              <ButtonSpinner tone="light" />
                            )}
                            {checkoutRequestId === request.id
                              ? 'Opening…'
                              : request.status === 'failed'
                                ? 'Retry checkout'
                                : request.status === 'checkout_created'
                                  ? 'Resume checkout'
                                  : 'Pay securely'}
                          </Button>
                        )}
                      {request.status === 'processing' && (
                        <span className="text-xs font-semibold text-amber-700">
                          Confirming payment
                        </span>
                      )}
                      {['checkout_created', 'processing', 'failed'].includes(
                        request.status,
                      ) &&
                        canManagePayments && (
                          <Button
                            type="button"
                            disabled={reconcilingRequestId !== null}
                            aria-busy={reconcilingRequestId === request.id}
                            onClick={() => void reconcilePayment(request.id)}
                            className="inline-flex items-center justify-center gap-2 border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:bg-cream disabled:cursor-wait disabled:opacity-50"
                          >
                            {reconcilingRequestId === request.id && (
                              <ButtonSpinner />
                            )}
                            {reconcilingRequestId === request.id
                              ? 'Checking…'
                              : 'Reconcile'}
                          </Button>
                        )}
                      {['paid', 'partially_refunded'].includes(request.status) &&
                        canApprovePayments && (
                          <Button
                            type="button"
                            onClick={() => setRefundConfirmationId(request.id)}
                            className="border border-red-200 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50"
                          >
                            {request.status === 'partially_refunded'
                              ? 'Refund remaining'
                              : 'Refund payment'}
                          </Button>
                        )}
                      {request.status === 'paid' && !canApprovePayments && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                          <span aria-hidden="true">✓</span> Settled
                        </span>
                      )}
                      {request.status === 'refunded' && (
                        <span className="text-xs font-bold text-slate-600">
                          Fully refunded
                        </span>
                      )}
                      </div>
                    </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {activeNavigationId === 'payouts' && (
        <PayoutLedger
          organizationId={organization.id}
          role={organization.role}
          transfers={paymentTransfers}
          payouts={connectedPayouts}
          paymentRequests={paymentRequests}
          projects={projects}
          subcontractors={subcontractors}
          auditEvents={auditEvents}
          isLoading={isLoading}
          onRefresh={loadDashboard}
        />
      )}

      {activeNavigationId === 'team' && canManageTeam && (
        <TeamManagementPanel
          members={organizationMembers}
          currentUserId={session.user.id}
          currentUserRole={organization.role}
          email={memberEmail}
          role={memberRole}
          busyUserId={memberUserId}
          isSubmitting={isSubmitting}
          isFormOpen={isTeamAccessOpen}
          serverError={teamAccessError}
          fieldErrors={{ email: formErrors.email, role: formErrors.role }}
          onOpenForm={() => {
            setTeamAccessError(null)
            setFormErrors({})
            setIsTeamAccessOpen(true)
          }}
          onCloseForm={() => {
            if (!isSubmitting) {
              setIsTeamAccessOpen(false)
              setTeamAccessError(null)
              setFormErrors({})
            }
          }}
          onEmailChange={(value) => {
            setMemberEmail(value)
            setFormErrors((current) => ({ ...current, email: undefined }))
          }}
          onRoleChange={(value) => {
            setMemberRole(value)
            setFormErrors((current) => ({ ...current, role: undefined }))
          }}
          onSubmit={(event) => void upsertOrganizationMember(event)}
          onStatusChange={(member, status) =>
            void setOrganizationMemberStatus(member, status)
          }
        />
      )}

      {activeNavigationId === 'delivery' && canManagePayments && (
        <section
          className={
            'border p-6 shadow-[0_16px_40px_rgba(19,37,31,0.055)] ' +
            (webhookFailures.length > 0
              ? 'border-amber-950/15 bg-amber-950/[0.035]'
              : 'border-forest/15 bg-forest/[0.035]')
          }
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p
                className={
                  'text-[10px] font-bold uppercase tracking-[0.17em] ' +
                  (webhookFailures.length > 0
                    ? 'text-amber-950/65'
                    : 'text-forest/75')
                }
              >
                Payment operations
              </p>
              <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">
                {webhookFailures.length > 0
                  ? 'Webhook attention queue'
                  : 'Webhook delivery healthy'}
              </h2>
            </div>
            <span
              className={
                'border px-3 py-1.5 text-xs font-extrabold ' +
                (webhookFailures.length > 0
                  ? 'border-amber-950/15 bg-white/80 text-amber-950'
                  : 'border-forest/15 bg-white/80 text-forest')
              }
            >
              {webhookFailures.length > 0
                ? `${webhookFailures.length} unresolved`
                : '0 unresolved'}
            </span>
          </div>

          {webhookFailures.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-ink/80">
              Signed payment events are processing without unresolved ledger errors.
            </p>
          ) : (
            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              {webhookFailures.map((failure) => (
                <article key={failure.id} className="border border-amber-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-bold text-amber-900">
                        {failure.event_type}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-ink/70">
                        {failure.event_id}
                      </p>
                    </div>
                    <span className="shrink-0 border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
                      {failure.attempts} {failure.attempts === 1 ? 'attempt' : 'attempts'}
                    </span>
                  </div>
                  <p className="mt-3 break-words text-sm leading-5 text-red-800">
                    {failure.error_message}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink/8 pt-3 text-[11px] text-ink/75">
                    <span>{failure.error_code ?? 'processing_error'}</span>
                    <time>{shortDate(failure.last_failed_at)}</time>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {activeNavigationId === 'audit' && (
        <section
          className="border border-ink/10 bg-white p-6 shadow-[0_16px_40px_rgba(19,37,31,0.055)]"
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-ink/75">
            Immutable audit trail
          </p>
          {auditEvents.length === 0 ? (
            <p className="mt-5 border border-dashed border-ink/12 bg-cream/70 p-5 text-sm font-medium text-ink/80">
              No audit events have been recorded for this workspace yet.
            </p>
          ) : (
            <div className="mt-5 overflow-x-auto border border-ink/10">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.15em] text-ink/80">
                  <tr>
                    <th scope="col" className="px-4 py-3">Event</th>
                    <th scope="col" className="px-4 py-3">Entity</th>
                    <th scope="col" className="px-4 py-3">Record ID</th>
                    <th scope="col" className="px-4 py-3">Actor</th>
                    <th scope="col" className="px-4 py-3 text-right">Recorded</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/8">
                  {auditEvents.map((event) => (
                    <tr
                      key={event.id}
                      className="transition-colors hover:bg-cream/40"
                    >
                      <th scope="row" className="px-4 py-4 font-bold text-ink">
                        {formatStatus(event.action.replaceAll('.', '_'))}
                      </th>
                      <td className="px-4 py-4 text-ink/85">
                        {formatStatus(event.entity_type)}
                      </td>
                      <td className="px-4 py-4 font-mono text-[11px] font-medium text-ink/70">
                        {event.entity_id?.slice(0, 8) ?? 'system'}
                      </td>
                      <td className="px-4 py-4 font-mono text-[11px] font-medium text-ink/70">
                        {event.actor_user_id?.slice(0, 8) ?? 'system'}
                      </td>
                      <td className="px-4 py-4 text-right">
                        <time className="text-[11px] font-semibold text-ink/70">
                          {shortDate(event.created_at)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
        </main>
      </div>

      <Dialog
        open={isNavigationOpen}
        onClose={setIsNavigationOpen}
        className="relative z-50 lg:hidden"
      >
        <DialogBackdrop className="fixed inset-0 bg-ink/60 backdrop-blur-sm" />
        <div className="fixed inset-0 flex">
          <DialogPanel className="h-full w-[min(88vw,18rem)] shadow-[24px_0_64px_rgba(16,35,31,0.28)]">
            <DashboardSidebar
              items={navigationItems}
              activeItemId={activeNavigationId}
              onNavigate={navigateTo}
              onClose={() => setIsNavigationOpen(false)}
            />
          </DialogPanel>
        </div>
      </Dialog>

      <DirectoryCreateDrawer
        target={directoryCreateTarget}
        isSaving={isSubmitting}
        serverError={directoryCreateError}
        onClose={() => {
          if (!isSubmitting) {
            setDirectoryCreateTarget(null)
            setDirectoryCreateError(null)
          }
        }}
        onClearError={() => setDirectoryCreateError(null)}
        onCreateProject={createProject}
        onCreateSubcontractor={createSubcontractor}
      />

      <DirectoryEditDialog
        target={directoryEditTarget}
        isSaving={isSavingDirectoryRecord}
        serverError={directoryEditError}
        onClose={() => {
          if (!isSavingDirectoryRecord) {
            setDirectoryEditTarget(null)
            setDirectoryEditError(null)
          }
        }}
        onClearError={() => setDirectoryEditError(null)}
        onSaveProject={updateProject}
        onSaveSubcontractor={updateSubcontractor}
      />

      <Dialog
        open={isDemoRemovalOpen}
        onClose={() => {
          if (!isRemovingDemoData) {
            setIsDemoRemovalOpen(false)
          }
        }}
        className="relative z-50"
      >
        <DialogBackdrop className="fixed inset-0 bg-ink/55 backdrop-blur-sm" />
        <div className="fixed inset-0 grid place-items-center overflow-y-auto p-6">
          <DialogPanel className="w-full max-w-lg border border-red-200 bg-white p-6 shadow-[0_24px_64px_rgba(19,37,31,0.22)] sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700/70">
              Owner-only workspace action
            </p>
            <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
              Remove demonstration data?
            </DialogTitle>
            <Description className="mt-3 text-sm leading-6 text-ink/85">
              This permanently removes only the registered sample projects,
              subcontractors, payment requests, and pending sample notifications.
              Your organization, members, independent records, and immutable audit
              evidence remain intact.
            </Description>
            <NotificationBanner tone="warning" className="mt-5 font-semibold">
              Cleanup is blocked automatically if a Stripe checkout, payment,
              waiver, delivered notification, or real record depends on the sample
              data.
            </NotificationBanner>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                type="button"
                disabled={isRemovingDemoData}
                onClick={() => setIsDemoRemovalOpen(false)}
                className="h-10 border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={isRemovingDemoData}
                aria-busy={isRemovingDemoData}
                onClick={() => void removeDemoWorkspaceData()}
                className="inline-flex h-10 items-center justify-center gap-2 bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-wait disabled:opacity-55"
              >
                {isRemovingDemoData && <ButtonSpinner tone="light" />}
                {isRemovingDemoData
                  ? 'Removing demonstration data…'
                  : 'Remove demonstration data'}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <Dialog
        open={refundConfirmation !== null}
        onClose={() => {
          if (refundRequestId === null) {
            setRefundConfirmationId(null)
          }
        }}
        className="relative z-50"
      >
        <DialogBackdrop className="fixed inset-0 bg-ink/55 backdrop-blur-sm" />
        <div className="fixed inset-0 grid place-items-center overflow-y-auto p-6">
          <DialogPanel className="w-full max-w-lg border border-red-200 bg-white p-6 shadow-[0_24px_64px_rgba(19,37,31,0.22)] sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700/70">
              Irreversible payment action
            </p>
            <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
              Refund this payment?
            </DialogTitle>
            <Description className="mt-3 text-sm leading-6 text-ink/85">
              This refunds the remaining payment for{' '}
              <span className="font-bold text-ink">
                {refundConfirmation?.description}
              </span>
              . The ledger and audit trail will be updated after the payment
              provider accepts the request.
            </Description>
            {refundConfirmation && (
              <div className="mt-5 border border-ink/10 bg-cream/65 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-ink/70">
                  Remaining refundable amount
                </p>
                <p className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
                  {formatCurrency(
                    refundConfirmation.net_amount -
                      refundConfirmation.refunded_amount,
                    refundConfirmation.currency,
                  )}
                </p>
              </div>
            )}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                type="button"
                disabled={refundRequestId !== null}
                onClick={() => setRefundConfirmationId(null)}
                className="h-10 border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={refundRequestId !== null || refundConfirmation === null}
                aria-busy={refundRequestId !== null}
                onClick={() => {
                  if (refundConfirmation) {
                    void refundPayment(refundConfirmation.id)
                  }
                }}
                className="inline-flex h-10 items-center justify-center gap-2 bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-wait disabled:opacity-55"
              >
                {refundRequestId !== null && <ButtonSpinner tone="light" />}
                {refundRequestId !== null
                  ? 'Refunding payment…'
                  : 'Confirm refund'}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  )
}

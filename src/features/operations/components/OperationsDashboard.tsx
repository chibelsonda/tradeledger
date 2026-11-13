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
  Radio,
  RadioGroup,
} from '@headlessui/react'
import type { Session } from '@supabase/supabase-js'
import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AuditEvent,
  Organization,
  OrganizationMember,
  OrganizationRole,
  PaymentRequest,
  Project,
  StripeWebhookFailure,
  Subcontractor,
  WaiverDocument,
} from '../../../lib/database.types'
import { formatCurrency, formatStatus } from '../../../lib/format'
import { projectCode } from '../../../lib/organizations'
import {
  calculateRetainage,
  dollarsToMinorUnits,
} from '../../../lib/payment-calculations'
import { supabase } from '../../../lib/supabase'
import { SelectControl } from '../../../components/ui/SelectControl'
import {
  DashboardSidebar,
  type DashboardNavigationItem,
} from './DashboardSidebar'
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

type CreatePanel = 'project' | 'subcontractor' | 'payment'
type DashboardPage =
  | 'overview'
  | 'directory'
  | 'payments'
  | 'team'
  | 'delivery'
  | 'audit'

const dashboardPathByPage: Record<DashboardPage, string> = {
  overview: '/dashboard',
  directory: '/directory',
  payments: '/payments',
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
  team: {
    eyebrow: 'Access governance',
    title: 'Team access',
    description: 'Active roles and tenant membership',
  },
  delivery: {
    eyebrow: 'Integration health',
    title: 'Webhook operations',
    description: 'Stripe event processing and failure recovery',
  },
  audit: {
    eyebrow: 'Security evidence',
    title: 'Audit trail',
    description: 'Immutable organization activity recorded by PostgreSQL',
  },
}

function dashboardPageFromPath(pathname: string): DashboardPage {
  const entry = Object.entries(dashboardPathByPage).find(
    ([, path]) => path === pathname,
  )

  return (entry?.[0] as DashboardPage | undefined) ?? 'overview'
}

const fieldClassName =
  'h-10 border border-ink/15 bg-white px-3 text-sm text-ink outline-none transition placeholder:text-ink/30 focus:border-forest focus:ring-2 focus:ring-forest/10'
const selectFieldClassName =
  'h-10 border border-ink/15 bg-white pl-3 text-sm text-ink outline-none transition focus:border-forest focus:ring-2 focus:ring-forest/10'

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
      return 'border-ink/10 bg-cream text-ink/65'
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
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [webhookFailures, setWebhookFailures] = useState<StripeWebhookFailure[]>([])
  const [waiverDocuments, setWaiverDocuments] = useState<WaiverDocument[]>([])
  const [organizationMembers, setOrganizationMembers] = useState<
    OrganizationMember[]
  >([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createPanel, setCreatePanel] = useState<CreatePanel>('project')
  const [isSubmitting, setIsSubmitting] = useState(false)
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

  const [projectName, setProjectName] = useState('')
  const [projectReference, setProjectReference] = useState('')
  const [subcontractorCompany, setSubcontractorCompany] = useState('')
  const [subcontractorContact, setSubcontractorContact] = useState('')
  const [subcontractorEmail, setSubcontractorEmail] = useState('')
  const [requestProjectId, setRequestProjectId] = useState('')
  const [requestSubcontractorId, setRequestSubcontractorId] = useState('')
  const [requestDescription, setRequestDescription] = useState('')
  const [requestGross, setRequestGross] = useState('')
  const [requestRetainage, setRequestRetainage] = useState('10')
  const [memberEmail, setMemberEmail] = useState('')
  const [memberRole, setMemberRole] = useState<
    Exclude<OrganizationRole, 'owner'>
  >('member')

  const canManageProjects = ['owner', 'admin'].includes(organization.role)
  const canManageTeam = ['owner', 'admin'].includes(organization.role)
  const canManagePayments = ['owner', 'admin', 'accountant'].includes(
    organization.role,
  )
  const canApprovePayments = ['owner', 'accountant'].includes(organization.role)
  const activeCreatePanel =
    activeNavigationId === 'payments'
      ? 'payment'
      : !canManageProjects && canManagePayments
        ? 'payment'
        : createPanel === 'payment'
          ? 'project'
          : createPanel
  const createPanelOptions = (
    [
      activeNavigationId === 'directory' &&
        canManageProjects && ['project', 'Project'],
      activeNavigationId === 'directory' &&
        canManageProjects && ['subcontractor', 'Subcontractor'],
      activeNavigationId === 'payments' &&
        canManagePayments && ['payment', 'Payment'],
    ].filter(Boolean) as [CreatePanel, string][]
  )
  const navigationItems = useMemo<DashboardNavigationItem[]>(() => {
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
        badge: String(projects.length + subcontractors.length),
      },
      {
        id: 'payments',
        href: dashboardPathByPage.payments,
        label: 'Payments',
        detail: 'Requests, checkout, and refunds',
        badge: String(paymentRequests.length),
      },
      canManageTeam && {
        id: 'team',
        href: dashboardPathByPage.team,
        label: 'Team access',
        detail: 'Roles and membership',
        badge: String(
          organizationMembers.filter((member) => member.status === 'active').length,
        ),
      },
      canManagePayments && {
        id: 'delivery',
        href: dashboardPathByPage.delivery,
        label: 'Webhooks',
        detail: 'Stripe event health',
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
    organizationMembers,
    paymentRequests.length,
    projects.length,
    subcontractors.length,
    webhookFailures.length,
  ])

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    const [
      projectResult,
      subcontractorResult,
      requestResult,
      auditResult,
      failureResult,
      waiverResult,
      memberResult,
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
          .from('payment_requests')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('audit_events')
          .select('*')
          .eq('organization_id', organization.id)
          .order('created_at', { ascending: false })
          .limit(8),
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
      ])

    const firstError =
      projectResult.error ??
      subcontractorResult.error ??
      requestResult.error ??
      auditResult.error ??
      failureResult.error ??
      waiverResult.error ??
      memberResult.error

    if (firstError) {
      setError(firstError.message)
      setIsLoading(false)
      return
    }

    const nextProjects = projectResult.data ?? []
    const nextSubcontractors = subcontractorResult.data ?? []

    setProjects(nextProjects)
    setSubcontractors(nextSubcontractors)
    setPaymentRequests(requestResult.data ?? [])
    setAuditEvents(auditResult.data ?? [])
    setWebhookFailures(failureResult.data ?? [])
    setWaiverDocuments(waiverResult.data ?? [])
    setOrganizationMembers(memberResult.data ?? [])
    setRequestProjectId((current) => current || nextProjects[0]?.id || '')
    setRequestSubcontractorId(
      (current) => current || nextSubcontractors[0]?.id || '',
    )
    setIsLoading(false)
  }, [canManageTeam, organization.id])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setNotice(null)
      void loadDashboard()
    }, 0)

    return () => window.clearTimeout(timeout)
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
        (nextPage !== 'delivery' || canManagePayments) &&
        (nextPage !== 'team' || canManageTeam)

      if (!isAllowed) {
        window.history.replaceState(null, '', dashboardPathByPage.overview)
      }

      setActiveNavigationId(isAllowed ? nextPage : 'overview')
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

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    const name = projectName.trim()
    const code = projectCode(projectReference || name)

    if (name.length < 2 || code.length < 2) {
      setError('Enter a project name and a valid project code.')
      return
    }

    setIsSubmitting(true)
    const { error: createError } = await supabase.from('projects').insert({
      organization_id: organization.id,
      name,
      code,
      status: 'active',
    })
    setIsSubmitting(false)

    if (createError) {
      setError(createError.message)
      return
    }

    setProjectName('')
    setProjectReference('')
    setNotice('Project created inside the current organization boundary.')
    await loadDashboard()
  }

  async function createSubcontractor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    if (subcontractorCompany.trim().length < 2) {
      setError('Enter a subcontractor company name.')
      return
    }

    setIsSubmitting(true)
    const { error: createError } = await supabase.from('subcontractors').insert({
      organization_id: organization.id,
      company_name: subcontractorCompany.trim(),
      contact_name: subcontractorContact.trim() || null,
      email: subcontractorEmail.trim().toLowerCase() || null,
      status: 'active',
    })
    setIsSubmitting(false)

    if (createError) {
      setError(createError.message)
      return
    }

    setSubcontractorCompany('')
    setSubcontractorContact('')
    setSubcontractorEmail('')
    setNotice('Subcontractor added to this organization only.')
    await loadDashboard()
  }

  async function createPaymentRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    const grossAmount = dollarsToMinorUnits(requestGross)
    const retainagePercentage = Number(requestRetainage)

    if (
      !requestProjectId ||
      !requestSubcontractorId ||
      requestDescription.trim().length < 3 ||
      grossAmount === null ||
      !Number.isFinite(retainagePercentage) ||
      retainagePercentage < 0 ||
      retainagePercentage > 100
    ) {
      setError('Complete every payment request field with valid values.')
      return
    }

    setIsSubmitting(true)
    const { error: createError } = await supabase.rpc('create_payment_request', {
      p_organization_id: organization.id,
      p_project_id: requestProjectId,
      p_subcontractor_id: requestSubcontractorId,
      p_description: requestDescription.trim(),
      p_gross_amount: grossAmount,
      p_retainage_basis_points: Math.round(retainagePercentage * 100),
      p_currency: 'usd',
    })
    setIsSubmitting(false)

    if (createError) {
      setError(createError.message)
      return
    }

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
    setIsSubmitting(true)

    const result =
      action === 'submit'
        ? await supabase.rpc('submit_payment_request', {
            p_payment_request_id: requestId,
          })
        : await supabase.rpc('approve_payment_request', {
            p_payment_request_id: requestId,
          })

    setIsSubmitting(false)

    if (result.error || result.data !== true) {
      setError(
        result.error?.message ??
          `The request could not be ${action === 'submit' ? 'submitted' : 'approved'}.`,
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
    setIsSubmitting(true)

    const { error: memberError } = await supabase.rpc(
      'upsert_organization_member',
      {
        p_organization_id: organization.id,
        p_email: memberEmail.trim(),
        p_role: memberRole,
      },
    )

    setIsSubmitting(false)

    if (memberError) {
      setError(memberError.message)
      return
    }

    setMemberEmail('')
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
      setError(memberError.message)
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
      setError(message)
      await loadDashboard()
      return
    }

    const url = (data as { url?: unknown } | null)?.url

    if (typeof url !== 'string' || !url.startsWith('https://')) {
      setCheckoutRequestId(null)
      setError('Stripe did not return a valid secure checkout URL.')
      await loadDashboard()
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
      setError(
        await edgeFunctionErrorMessage(
          reconciliationError,
          'Stripe reconciliation could not be completed.',
        ),
      )
      await loadDashboard()
      return
    }

    const status = (data as { status?: unknown } | null)?.status
    setNotice(
      `Stripe reconciliation completed${typeof status === 'string' ? ` with ${formatStatus(status)} status` : ''}.`,
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
      setError(
        await edgeFunctionErrorMessage(
          refundError,
          'The refund could not be completed.',
        ),
      )
      await loadDashboard()
      return
    }

    const status = (data as { status?: unknown } | null)?.status
    setNotice(
      typeof status === 'string' && status !== 'succeeded'
        ? `Stripe accepted the refund with ${formatStatus(status)} status. Reconciliation will keep the ledger current.`
        : 'The Stripe refund succeeded and the payment ledger was updated.',
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
      setError(
        await edgeFunctionErrorMessage(
          waiverError,
          mode === 'generate'
            ? 'The waiver document could not be generated.'
            : 'The waiver download is temporarily unavailable.',
        ),
      )
      await loadDashboard()
      return
    }

    const url = (data as { url?: unknown } | null)?.url

    if (typeof url !== 'string' || !url.startsWith('https://')) {
      setError('The document service did not return a secure download URL.')
      await loadDashboard()
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
      (nextPage === 'delivery' && !canManagePayments) ||
      (nextPage === 'team' && !canManageTeam)
    ) {
      return
    }

    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path)
    }

    setActiveNavigationId(nextPage)
    setIsNavigationOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const activePageDetails = dashboardPageDetails[activeNavigationId]

  return (
    <div className="min-h-screen bg-cream lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen lg:block">
        <DashboardSidebar
          email={session.user.email}
          items={navigationItems}
          activeItemId={activeNavigationId}
          isSigningOut={isSigningOut}
          onNavigate={navigateTo}
          onSignOut={() => void signOut()}
        />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-20 items-center justify-between gap-4 border-b border-ink/10 bg-cream/95 px-4 backdrop-blur sm:px-6 xl:px-8">
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
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-forest/50">
                Operations dashboard
              </p>
              <p className="truncate text-sm font-black text-ink sm:text-base">
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
                  onChange={(event) => onSelectOrganization(event.target.value)}
                  containerClassName="w-32 sm:w-48 xl:w-56"
                  className="h-10 border border-ink/15 bg-white pl-3 text-sm font-semibold text-ink outline-none focus:border-forest"
                >
                  {organizations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </SelectControl>
              </Field>
            )}

            <Menu as="div" className="relative">
              <MenuButton className="inline-flex items-center gap-2 py-1 text-left text-ink transition hover:text-forest focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/20">
                <span className="grid size-7 shrink-0 place-items-center bg-forest text-xs font-black text-mint">
                  {userInitial}
                </span>
                <span className="hidden min-w-0 lg:block">
                  <span className="block max-w-36 truncate text-xs font-bold">
                    {userEmail}
                  </span>
                  <span className="block text-[10px] font-semibold text-ink/45">
                    {formatStatus(organization.role)} access
                  </span>
                </span>
                <svg
                  viewBox="0 0 20 20"
                  className="size-4 shrink-0 text-ink/45"
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
                className="absolute right-0 z-50 mt-2 w-72 origin-top-right border border-ink/12 bg-white p-2 shadow-[0_24px_60px_rgba(16,35,31,0.18)] transition duration-100 ease-out focus:outline-none data-closed:scale-95 data-closed:opacity-0"
              >
                <div className="border-b border-ink/8 p-3">
                  <p className="truncate text-sm font-black text-ink">
                    {userEmail}
                  </p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/35">
                    Supabase authenticated
                  </p>
                </div>

                <dl className="grid gap-3 border-b border-ink/8 p-3 text-xs">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-ink/45">Access level</dt>
                    <dd className="border border-forest/15 bg-mint/15 px-2 py-1 font-bold text-forest">
                      {formatStatus(organization.role)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-ink/45">Workspace</dt>
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
                    className="mt-1 flex h-10 w-full items-center justify-between px-3 text-sm font-bold text-red-700 transition data-focus:bg-red-50 disabled:cursor-wait disabled:opacity-50"
                  >
                    <span>{isSigningOut ? 'Signing out…' : 'Sign out'}</span>
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
                  </Button>
                </MenuItem>
              </MenuItems>
            </Menu>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 xl:px-8 xl:py-10">
          <section className="border-b border-ink/10 pb-7">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-forest/60">
              {activePageDetails.eyebrow}
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.035em] text-ink sm:text-4xl">
              {activePageDetails.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink/55">
              <span className="border border-forest/15 bg-white px-2.5 py-1 text-xs font-bold text-forest">
                {formatStatus(organization.role)}
              </span>
              <span>{organization.name}</span>
              <span aria-hidden="true" className="text-ink/20">/</span>
              <span>{activePageDetails.description}</span>
            </div>
          </section>

      {error && (
        <div
          role="alert"
          className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {notice}
        </div>
      )}

      {activeNavigationId === 'overview' && (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Active projects', projects.filter((project) => project.status === 'active').length],
          ['Subcontractors', subcontractors.length],
          ['Payment requests', paymentRequests.length],
          ['Approved net', formatCurrency(approvedNetAmount, 'usd')],
          ['Refunded', formatCurrency(refundedAmount, 'usd')],
        ].map(([label, value]) => (
          <div
            key={label}
            className="border border-ink/10 bg-white p-5 shadow-[0_18px_42px_rgba(16,35,31,0.07)]"
          >
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
              {label}
            </p>
            <p className="mt-3 text-3xl font-black tracking-tight text-ink">
              {value}
            </p>
          </div>
        ))}
      </div>
      )}

      {((activeNavigationId === 'directory' && canManageProjects) ||
        (activeNavigationId === 'payments' && canManagePayments)) && (
        <section
          className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]"
        >
          <div className="border border-ink/10 bg-white p-6 shadow-[0_24px_60px_rgba(16,35,31,0.08)] sm:p-8">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-forest/60">
                  Controlled write path
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-ink">
                  {activeNavigationId === 'payments'
                    ? 'Create payment request'
                    : 'Add directory record'}
                </h2>
              </div>
              {createPanelOptions.length > 1 && (
                <RadioGroup
                  value={activeCreatePanel}
                  onChange={setCreatePanel}
                  aria-label="Data type to create"
                  className="flex bg-cream p-1"
                >
                  {createPanelOptions.map(([panel, label]) => (
                    <Radio
                      key={panel}
                      value={panel}
                      className="cursor-pointer px-3 py-1.5 text-xs font-bold text-ink/45 transition hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/30 data-checked:bg-white data-checked:text-ink data-checked:shadow-sm"
                    >
                      {label}
                    </Radio>
                  ))}
                </RadioGroup>
              )}
            </div>

            {activeCreatePanel === 'project' && canManageProjects && (
              <form
                onSubmit={(event) => void createProject(event)}
                className="mt-6 grid gap-4 sm:grid-cols-[1fr_0.7fr_auto] sm:items-end"
              >
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Project name</Label>
                  <Input
                    required
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="Cedar Kitchen Remodel"
                    className={fieldClassName}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Project code</Label>
                  <Input
                    value={projectReference}
                    onChange={(event) =>
                      setProjectReference(projectCode(event.target.value))
                    }
                    placeholder="CEDAR-01"
                    className={fieldClassName + ' font-mono'}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-10 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:opacity-60"
                >
                  Add project
                </Button>
              </form>
            )}

            {activeCreatePanel === 'subcontractor' && canManageProjects && (
              <form
                onSubmit={(event) => void createSubcontractor(event)}
                className="mt-6 grid gap-4 sm:grid-cols-2"
              >
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Company name</Label>
                  <Input
                    required
                    value={subcontractorCompany}
                    onChange={(event) => setSubcontractorCompany(event.target.value)}
                    placeholder="Fine Finish Carpentry"
                    className={fieldClassName}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Contact name</Label>
                  <Input
                    value={subcontractorContact}
                    onChange={(event) => setSubcontractorContact(event.target.value)}
                    placeholder="Hector Ramirez"
                    className={fieldClassName}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={subcontractorEmail}
                    onChange={(event) => setSubcontractorEmail(event.target.value)}
                    placeholder="hector@example.com"
                    className={fieldClassName}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-10 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:opacity-60 sm:col-span-2 sm:justify-self-end"
                >
                  Add subcontractor
                </Button>
              </form>
            )}

            {activeCreatePanel === 'payment' && canManagePayments && (
              <form
                onSubmit={(event) => void createPaymentRequest(event)}
                className="mt-6 grid gap-4 sm:grid-cols-2"
              >
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Project</Label>
                  <SelectControl
                    required
                    value={requestProjectId}
                    onChange={(event) => setRequestProjectId(event.target.value)}
                    className={selectFieldClassName}
                  >
                    <option value="">Select a project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </SelectControl>
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Subcontractor</Label>
                  <SelectControl
                    required
                    value={requestSubcontractorId}
                    onChange={(event) =>
                      setRequestSubcontractorId(event.target.value)
                    }
                    className={selectFieldClassName}
                  >
                    <option value="">Select a subcontractor</option>
                    {subcontractors.map((subcontractor) => (
                      <option key={subcontractor.id} value={subcontractor.id}>
                        {subcontractor.company_name}
                      </option>
                    ))}
                  </SelectControl>
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  <Label>Milestone description</Label>
                  <Input
                    required
                    value={requestDescription}
                    onChange={(event) => setRequestDescription(event.target.value)}
                    placeholder="Kitchen trim milestone"
                    className={fieldClassName}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Gross amount (USD)</Label>
                  <Input
                    required
                    inputMode="decimal"
                    value={requestGross}
                    onChange={(event) => setRequestGross(event.target.value)}
                    placeholder="2850.00"
                    className={fieldClassName}
                  />
                </Field>
                <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
                  <Label>Retainage percentage</Label>
                  <Input
                    required
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={requestRetainage}
                    onChange={(event) => setRequestRetainage(event.target.value)}
                    className={fieldClassName}
                  />
                </Field>

                <div className="flex flex-col gap-3 border border-ink/10 bg-cream/65 p-4 text-sm sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-bold text-ink">Server-validated preview</p>
                    <p className="mt-1 text-xs text-ink/50">
                      PostgreSQL recalculates and constrains these values.
                    </p>
                  </div>
                  <div className="flex gap-5 text-right">
                    <div>
                      <p className="text-xs text-ink/45">Retainage</p>
                      <p className="font-bold text-ink">
                        {requestPreview
                          ? formatCurrency(requestPreview.retainageAmount, 'usd')
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-ink/45">Net payable</p>
                      <p className="font-black text-forest">
                        {requestPreview
                          ? formatCurrency(requestPreview.netAmount, 'usd')
                          : '—'}
                      </p>
                    </div>
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={
                    isSubmitting || projects.length === 0 || subcontractors.length === 0
                  }
                  className="h-10 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2 sm:justify-self-end"
                >
                  Create draft request
                </Button>
              </form>
            )}
          </div>

          <aside className="flex flex-col gap-8 bg-forest p-6 text-white shadow-[0_24px_60px_rgba(16,35,31,0.16)] sm:p-8">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-mint/70">
                Security evidence
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight">
                The database owns the boundary.
              </h2>
              <p className="mt-3 text-sm leading-6 text-white/65">
                Client controls improve usability. RLS, role checks, constraints,
                and RPCs enforce the actual financial-data rules.
              </p>
            </div>
            <ul className="flex flex-col gap-3 border-t border-white/10 pt-6 text-sm text-white/80">
              {[
                'Tenant A receives zero Tenant B rows',
                'Money is stored in integer minor units',
                'Retainage is generated by PostgreSQL',
                'State changes append audit evidence',
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="mt-1 grid size-4 shrink-0 place-items-center rounded-full bg-mint text-[10px] font-black text-ink">
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
      <section className="grid gap-6 xl:grid-cols-2">
        <div className="border border-ink/10 bg-white p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
                Projects
              </p>
              <h2 className="mt-1 text-lg font-black text-ink">Active job ledger</h2>
            </div>
            <span className="font-mono text-xs font-bold text-forest/50">
              {projects.length.toString().padStart(2, '0')}
            </span>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            {projects.length === 0 ? (
              <p className="bg-cream p-4 text-sm text-ink/50">
                No projects yet. Add the first project above.
              </p>
            ) : (
              projects.slice(0, 5).map((project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between gap-4 border border-ink/8 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">{project.name}</p>
                    <p className="mt-1 font-mono text-[11px] text-ink/40">
                      {project.code}
                    </p>
                  </div>
                  <span
                    className={
                      'border px-2.5 py-1 text-[11px] font-bold ' +
                      statusClassName(project.status)
                    }
                  >
                    {formatStatus(project.status)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="border border-ink/10 bg-white p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
                Subcontractors
              </p>
              <h2 className="mt-1 text-lg font-black text-ink">Organization directory</h2>
            </div>
            <span className="font-mono text-xs font-bold text-forest/50">
              {subcontractors.length.toString().padStart(2, '0')}
            </span>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            {subcontractors.length === 0 ? (
              <p className="bg-cream p-4 text-sm text-ink/50">
                No subcontractors yet. Add one before creating a payment request.
              </p>
            ) : (
              subcontractors.slice(0, 5).map((subcontractor) => (
                <div
                  key={subcontractor.id}
                  className="flex items-center justify-between gap-4 border border-ink/8 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">
                      {subcontractor.company_name}
                    </p>
                    <p className="mt-1 truncate text-xs text-ink/45">
                      {subcontractor.contact_name ?? subcontractor.email ?? 'No contact added'}
                    </p>
                  </div>
                  <span
                    className={
                      'border px-2.5 py-1 text-[11px] font-bold ' +
                      statusClassName(subcontractor.status)
                    }
                  >
                    {formatStatus(subcontractor.status)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
      )}

      {activeNavigationId === 'payments' && (
      <section
        className="overflow-hidden border border-ink/10 bg-white shadow-[0_18px_42px_rgba(16,35,31,0.06)]"
      >
        <div className="flex flex-col justify-between gap-3 border-b border-ink/10 p-6 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
              Financial workflow
            </p>
            <h2 className="mt-1 text-lg font-black text-ink">Payment requests</h2>
          </div>
          <a
            href="/?demo=checkout"
            className="inline-flex h-10 items-center justify-center border border-ink/10 px-4 text-xs font-bold text-ink transition hover:bg-cream"
          >
            Open Stripe checkout demo
          </a>
        </div>

        {isLoading ? (
          <p className="p-6 text-sm text-ink/50">Refreshing payment ledger…</p>
        ) : paymentRequests.length === 0 ? (
          <p className="p-6 text-sm text-ink/50">
            No payment requests yet. Draft one after adding a project and subcontractor.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead className="bg-cream/75 text-[11px] font-bold uppercase tracking-[0.12em] text-ink/45">
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
                    <tr key={request.id} className="align-middle">
                    <td className="px-6 py-4">
                      <p className="max-w-56 truncate font-bold text-ink">
                        {request.description}
                      </p>
                      <p className="mt-1 text-xs text-ink/40">
                        {shortDate(request.created_at)}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-ink">
                        {selectedProject(request.project_id)}
                      </p>
                      <p className="mt-1 text-xs text-ink/45">
                        {selectedSubcontractor(request.subcontractor_id)}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-right font-semibold text-ink">
                      {formatCurrency(request.gross_amount, request.currency)}
                    </td>
                    <td className="px-4 py-4 text-right text-ink/60">
                      {formatCurrency(request.retainage_amount, request.currency)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <p className="font-black text-forest">
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
                          disabled={isSubmitting}
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'submit')
                          }
                          className="border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:bg-cream disabled:opacity-50"
                        >
                          Submit
                        </Button>
                      )}
                      {request.status === 'submitted' && canApprovePayments && (
                        <Button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'approve')
                          }
                          className="bg-ink px-3 py-2 text-xs font-bold text-white transition hover:bg-forest disabled:opacity-50"
                        >
                          Approve
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
                              <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
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
                          Confirming with Stripe
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
                              <span className="size-3 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
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

      {activeNavigationId === 'team' && canManageTeam && (
        <TeamManagementPanel
          members={organizationMembers}
          currentUserId={session.user.id}
          currentUserRole={organization.role}
          email={memberEmail}
          role={memberRole}
          busyUserId={memberUserId}
          isSubmitting={isSubmitting}
          onEmailChange={setMemberEmail}
          onRoleChange={setMemberRole}
          onSubmit={(event) => void upsertOrganizationMember(event)}
          onStatusChange={(member, status) =>
            void setOrganizationMemberStatus(member, status)
          }
        />
      )}

      {activeNavigationId === 'delivery' && canManagePayments && (
        <section
          className={
            'border p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)] ' +
            (webhookFailures.length > 0
              ? 'border-amber-300 bg-amber-50/60'
              : 'border-emerald-200 bg-emerald-50/50')
          }
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p
                className={
                  'text-xs font-bold uppercase tracking-[0.14em] ' +
                  (webhookFailures.length > 0
                    ? 'text-amber-800/70'
                    : 'text-emerald-800/65')
                }
              >
                Payment operations
              </p>
              <h2 className="mt-1 text-lg font-black text-ink">
                {webhookFailures.length > 0
                  ? 'Webhook attention queue'
                  : 'Webhook delivery healthy'}
              </h2>
            </div>
            <span
              className={
                'border px-3 py-1.5 text-xs font-black ' +
                (webhookFailures.length > 0
                  ? 'border-amber-300 bg-white text-amber-900'
                  : 'border-emerald-200 bg-white text-emerald-800')
              }
            >
              {webhookFailures.length > 0
                ? `${webhookFailures.length} unresolved`
                : '0 unresolved'}
            </span>
          </div>

          {webhookFailures.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-emerald-950/65">
              Signed Stripe events are processing without unresolved ledger errors.
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
                      <p className="mt-1 font-mono text-[10px] text-ink/40">
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
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink/8 pt-3 text-[11px] text-ink/45">
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
          className="border border-ink/10 bg-white p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)]"
        >
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
            Immutable audit trail
          </p>
          {auditEvents.length === 0 ? (
            <p className="mt-5 bg-cream p-4 text-sm text-ink/50">
              No audit events have been recorded for this workspace yet.
            </p>
          ) : (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {auditEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-start justify-between gap-4 border border-ink/8 p-4"
              >
                <div>
                  <p className="text-sm font-bold text-ink">
                    {formatStatus(event.action.replaceAll('.', '_'))}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-ink/40">
                    {event.entity_type} · {event.entity_id?.slice(0, 8) ?? 'system'}
                  </p>
                </div>
                <time className="shrink-0 text-[11px] font-semibold text-ink/40">
                  {shortDate(event.created_at)}
                </time>
              </div>
              ))}
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
              email={session.user.email}
              items={navigationItems}
              activeItemId={activeNavigationId}
              isSigningOut={isSigningOut}
              onNavigate={navigateTo}
              onSignOut={() => void signOut()}
              onClose={() => setIsNavigationOpen(false)}
            />
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
          <DialogPanel className="w-full max-w-lg border border-red-200 bg-white p-6 shadow-[0_32px_80px_rgba(16,35,31,0.24)] sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700/70">
              Irreversible Stripe action
            </p>
            <DialogTitle className="mt-2 text-2xl font-black tracking-tight text-ink">
              Refund this payment?
            </DialogTitle>
            <Description className="mt-3 text-sm leading-6 text-ink/60">
              This refunds the remaining Stripe payment for{' '}
              <span className="font-bold text-ink">
                {refundConfirmation?.description}
              </span>
              . The ledger and audit trail will be updated after Stripe accepts
              the request.
            </Description>
            {refundConfirmation && (
              <div className="mt-5 border border-ink/10 bg-cream/65 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-ink/40">
                  Remaining refundable amount
                </p>
                <p className="mt-2 text-2xl font-black text-ink">
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
                className="h-10 bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-wait disabled:opacity-55"
              >
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

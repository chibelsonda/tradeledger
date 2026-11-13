import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AuditEvent,
  Organization,
  OrganizationRole,
  PaymentRequest,
  Project,
  StripeWebhookFailure,
  Subcontractor,
} from '../lib/database.types'
import { formatCurrency, formatStatus } from '../lib/format'
import { projectCode } from '../lib/organizations'
import {
  calculateRetainage,
  dollarsToMinorUnits,
} from '../lib/payment-calculations'
import { supabase } from '../lib/supabase'

interface WorkspaceOrganization extends Organization {
  role: OrganizationRole
}

interface OperationsDashboardProps {
  organization: WorkspaceOrganization
  organizations: WorkspaceOrganization[]
  onSelectOrganization: (organizationId: string) => void
}

type CreatePanel = 'project' | 'subcontractor' | 'payment'

const fieldClassName =
  'h-11 border border-ink/15 bg-cream/60 px-3 text-sm text-ink outline-none transition placeholder:text-ink/30 focus:border-forest focus:ring-2 focus:ring-forest/10'

function statusClassName(status: string): string {
  switch (status) {
    case 'approved':
    case 'paid':
    case 'active':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800'
    case 'partially_refunded':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    case 'refunded':
      return 'border-slate-300 bg-slate-100 text-slate-700'
    case 'submitted':
    case 'checkout_created':
    case 'processing':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    case 'failed':
    case 'blocked':
      return 'border-red-200 bg-red-50 text-red-800'
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
  organization,
  organizations,
  onSelectOrganization,
}: OperationsDashboardProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([])
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [webhookFailures, setWebhookFailures] = useState<StripeWebhookFailure[]>([])
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
  const [refundConfirmationId, setRefundConfirmationId] = useState<string | null>(
    null,
  )

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

  const canManageProjects = ['owner', 'admin'].includes(organization.role)
  const canManagePayments = ['owner', 'admin', 'accountant'].includes(
    organization.role,
  )
  const canApprovePayments = ['owner', 'accountant'].includes(organization.role)
  const activeCreatePanel =
    !canManageProjects && canManagePayments ? 'payment' : createPanel

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    const [
      projectResult,
      subcontractorResult,
      requestResult,
      auditResult,
      failureResult,
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
      ])

    const firstError =
      projectResult.error ??
      subcontractorResult.error ??
      requestResult.error ??
      auditResult.error ??
      failureResult.error

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
    setRequestProjectId((current) => current || nextProjects[0]?.id || '')
    setRequestSubcontractorId(
      (current) => current || nextSubcontractors[0]?.id || '',
    )
    setIsLoading(false)
  }, [organization.id])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setNotice(null)
      void loadDashboard()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadDashboard])

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

    setNotice(
      action === 'submit'
        ? 'Payment request submitted for approval.'
        : 'Payment request approved and recorded in the audit trail.',
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

  const selectedProject = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
  const selectedSubcontractor = (subcontractorId: string) =>
    subcontractors.find((item) => item.id === subcontractorId)?.company_name ??
    'Unknown subcontractor'

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-8 lg:py-12">
      <div className="flex flex-col justify-between gap-5 border-b border-ink/10 pb-7 md:flex-row md:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-forest/60">
            Tenant operations workspace
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.035em] text-ink sm:text-4xl">
            {organization.name}
          </h1>
          <div className="mt-3 flex items-center gap-2 text-sm text-ink/55">
            <span className="border border-forest/15 bg-white px-2.5 py-1 text-xs font-bold text-forest">
              {formatStatus(organization.role)}
            </span>
            <span>Organization-scoped through RLS</span>
          </div>
        </div>

        {organizations.length > 1 && (
          <label className="flex flex-col gap-2 text-xs font-bold uppercase tracking-[0.12em] text-ink/45">
            Workspace
            <select
              value={organization.id}
              onChange={(event) => onSelectOrganization(event.target.value)}
              className="h-11 min-w-56 border border-ink/15 bg-white px-3 text-sm font-semibold tracking-normal text-ink outline-none focus:border-forest"
            >
              {organizations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

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

      {(canManageProjects || canManagePayments) && (
        <div className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="border border-ink/10 bg-white p-6 shadow-[0_24px_60px_rgba(16,35,31,0.08)] sm:p-8">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-forest/60">
                  Controlled write path
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-ink">
                  Add operations data
                </h2>
              </div>
              <div className="flex bg-cream p-1">
                {(
                  [
                    canManageProjects && ['project', 'Project'],
                    canManageProjects && ['subcontractor', 'Subcontractor'],
                    canManagePayments && ['payment', 'Payment'],
                  ].filter(Boolean) as [CreatePanel, string][]
                ).map(([panel, label]) => (
                  <button
                    key={panel}
                    type="button"
                    onClick={() => setCreatePanel(panel)}
                    className={
                      'px-3 py-2 text-xs font-bold transition ' +
                      (activeCreatePanel === panel
                        ? 'bg-white text-ink shadow-sm'
                        : 'text-ink/45 hover:text-ink')
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {activeCreatePanel === 'project' && canManageProjects && (
              <form
                onSubmit={(event) => void createProject(event)}
                className="mt-6 grid gap-4 sm:grid-cols-[1fr_0.7fr_auto] sm:items-end"
              >
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Project name
                  <input
                    required
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="Cedar Kitchen Remodel"
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Project code
                  <input
                    value={projectReference}
                    onChange={(event) =>
                      setProjectReference(projectCode(event.target.value))
                    }
                    placeholder="CEDAR-01"
                    className={fieldClassName + ' font-mono'}
                  />
                </label>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-11 bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest disabled:opacity-60"
                >
                  Add project
                </button>
              </form>
            )}

            {activeCreatePanel === 'subcontractor' && canManageProjects && (
              <form
                onSubmit={(event) => void createSubcontractor(event)}
                className="mt-6 grid gap-4 sm:grid-cols-2"
              >
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Company name
                  <input
                    required
                    value={subcontractorCompany}
                    onChange={(event) => setSubcontractorCompany(event.target.value)}
                    placeholder="Fine Finish Carpentry"
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Contact name
                  <input
                    value={subcontractorContact}
                    onChange={(event) => setSubcontractorContact(event.target.value)}
                    placeholder="Hector Ramirez"
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  Email
                  <input
                    type="email"
                    value={subcontractorEmail}
                    onChange={(event) => setSubcontractorEmail(event.target.value)}
                    placeholder="hector@example.com"
                    className={fieldClassName}
                  />
                </label>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-11 bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest disabled:opacity-60 sm:col-span-2 sm:justify-self-end"
                >
                  Add subcontractor
                </button>
              </form>
            )}

            {activeCreatePanel === 'payment' && canManagePayments && (
              <form
                onSubmit={(event) => void createPaymentRequest(event)}
                className="mt-6 grid gap-4 sm:grid-cols-2"
              >
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Project
                  <select
                    required
                    value={requestProjectId}
                    onChange={(event) => setRequestProjectId(event.target.value)}
                    className={fieldClassName}
                  >
                    <option value="">Select a project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Subcontractor
                  <select
                    required
                    value={requestSubcontractorId}
                    onChange={(event) =>
                      setRequestSubcontractorId(event.target.value)
                    }
                    className={fieldClassName}
                  >
                    <option value="">Select a subcontractor</option>
                    {subcontractors.map((subcontractor) => (
                      <option key={subcontractor.id} value={subcontractor.id}>
                        {subcontractor.company_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
                  Milestone description
                  <input
                    required
                    value={requestDescription}
                    onChange={(event) => setRequestDescription(event.target.value)}
                    placeholder="Kitchen trim milestone"
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Gross amount (USD)
                  <input
                    required
                    inputMode="decimal"
                    value={requestGross}
                    onChange={(event) => setRequestGross(event.target.value)}
                    placeholder="2850.00"
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-bold text-ink">
                  Retainage percentage
                  <input
                    required
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={requestRetainage}
                    onChange={(event) => setRequestRetainage(event.target.value)}
                    className={fieldClassName}
                  />
                </label>

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

                <button
                  type="submit"
                  disabled={
                    isSubmitting || projects.length === 0 || subcontractors.length === 0
                  }
                  className="h-11 bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2 sm:justify-self-end"
                >
                  Create draft request
                </button>
              </form>
            )}
          </div>

          <aside className="flex flex-col justify-between gap-6 bg-forest p-6 text-white shadow-[0_24px_60px_rgba(16,35,31,0.16)] sm:p-8">
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
            <ul className="flex flex-col gap-3 text-sm text-white/80">
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
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
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
      </div>

      <div className="overflow-hidden border border-ink/10 bg-white shadow-[0_18px_42px_rgba(16,35,31,0.06)]">
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
            <table className="w-full min-w-[860px] border-collapse text-left text-sm">
              <thead className="bg-cream/75 text-[11px] font-bold uppercase tracking-[0.12em] text-ink/45">
                <tr>
                  <th className="px-6 py-3">Request</th>
                  <th className="px-4 py-3">Project / subcontractor</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Retainage</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/8">
                {paymentRequests.map((request) => (
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
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                      {request.status === 'draft' && canManagePayments && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'submit')
                          }
                          className="border border-ink/15 px-3 py-2 text-xs font-bold text-ink transition hover:bg-cream disabled:opacity-50"
                        >
                          Submit
                        </button>
                      )}
                      {request.status === 'submitted' && canApprovePayments && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() =>
                            void transitionPaymentRequest(request.id, 'approve')
                          }
                          className="bg-ink px-3 py-2 text-xs font-bold text-white transition hover:bg-forest disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {['approved', 'checkout_created', 'failed'].includes(
                        request.status,
                      ) &&
                        canManagePayments && (
                          <button
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
                          </button>
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
                          <button
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
                          </button>
                        )}
                      {['paid', 'partially_refunded'].includes(request.status) &&
                        canApprovePayments &&
                        (refundConfirmationId === request.id ? (
                          <div className="flex items-center gap-2 border border-red-200 bg-red-50 p-2">
                            <span className="max-w-32 text-left text-[11px] font-semibold leading-4 text-red-800">
                              Refund the remaining Stripe payment?
                            </span>
                            <button
                              type="button"
                              disabled={refundRequestId !== null}
                              aria-busy={refundRequestId === request.id}
                              onClick={() => void refundPayment(request.id)}
                              className="bg-red-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-red-800 disabled:cursor-wait disabled:opacity-55"
                            >
                              {refundRequestId === request.id
                                ? 'Refunding…'
                                : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              disabled={refundRequestId !== null}
                              onClick={() => setRefundConfirmationId(null)}
                              className="border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-800 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setRefundConfirmationId(request.id)}
                            className="border border-red-200 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50"
                          >
                            {request.status === 'partially_refunded'
                              ? 'Refund remaining'
                              : 'Refund payment'}
                          </button>
                        ))}
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManagePayments && (
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

      {auditEvents.length > 0 && (
        <div className="border border-ink/10 bg-white p-6 shadow-[0_18px_42px_rgba(16,35,31,0.06)]">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/40">
            Immutable audit trail
          </p>
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
        </div>
      )}
    </section>
  )
}

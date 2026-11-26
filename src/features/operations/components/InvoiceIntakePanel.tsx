import {
  Button,
  Description,
  DialogTitle,
  Field,
  Input,
  Label,
  Textarea,
} from '@headlessui/react'
import type { ChangeEvent, FormEvent } from 'react'
import { useMemo, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { FieldError } from '@/components/ui/FieldError'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { SelectControl } from '@/components/ui/SelectControl'
import {
  SidePanel,
  SidePanelCloseButton,
} from '@/components/ui/SidePanel'
import {
  invoiceReviewSchema,
  type InvoiceReviewValues,
} from '@/features/operations/operations.schemas'
import type {
  InvoiceDocument,
  InvoiceLineItem,
  Json,
  Project,
  Subcontractor,
} from '@/lib/database.types'
import { formatCurrency, formatStatus } from '@/lib/format'
import { trustedSupabaseInvoiceUrl } from '@/lib/navigation-security'
import { supabase, supabaseUrl } from '@/lib/supabase'
import { fieldErrorsFromZod, type FieldErrors } from '@/lib/validation'

interface InvoiceIntakePanelProps {
  organizationId: string
  projects: Project[]
  subcontractors: Subcontractor[]
  documents: InvoiceDocument[]
  isLoading: boolean
  onDataChanged: () => Promise<void>
}

interface UploadInvoiceResponse {
  documentId: string
  status: 'review_required'
  mode: 'ai' | 'manual'
  extraction: Record<string, unknown>
  confidence: Record<string, number>
  note: string
}

interface EditableLineItem {
  description: string
  quantity: string
  unitAmount: string
  amount: string
}

type ReviewField = keyof InvoiceReviewValues

const inputClassName =
  'h-10 w-full rounded-lg border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/45 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:border-red-600 aria-invalid:ring-1 aria-invalid:ring-red-600/20'
const selectClassName =
  'h-10 border border-ink/15 bg-white pl-3.5 text-sm font-medium text-ink outline-none transition focus:border-forest focus:ring-2 focus:ring-forest/10'

const emptyReview = {
  invoiceNumber: '',
  vendorName: '',
  invoiceDate: '',
  dueDate: '',
  projectReference: '',
  description: '',
  grossAmount: '',
  currency: 'usd',
  retainagePercentage: '0',
  costCode: '',
}

function recordValue(value: Json | Record<string, unknown>): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function numberValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function confidenceValues(value: Json | Record<string, number>): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && entry[1] >= 0 && entry[1] <= 1,
    ),
  )
}

function minorUnitsToInput(value: number | null): string {
  return value === null ? '' : (value / 100).toFixed(2)
}

function optionalMinorUnits(value: string): number | null {
  const normalized = value.trim()
  if (normalized === '') return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN

  const [whole = '0', fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(amount) ? amount : Number.NaN
}

function editableLineItems(record: Record<string, unknown>): EditableLineItem[] {
  const value = record.line_items
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const line = item as Record<string, unknown>
    return [{
      description: stringValue(line, 'description'),
      quantity: numberValue(line, 'quantity')?.toString() ?? '',
      unitAmount: minorUnitsToInput(numberValue(line, 'unit_amount_minor')),
      amount: minorUnitsToInput(numberValue(line, 'amount_minor')),
    }]
  })
}

function reviewValues(record: Record<string, unknown>) {
  const retainage = numberValue(record, 'retainage_basis_points')
  return {
    invoiceNumber: stringValue(record, 'invoice_number'),
    vendorName: stringValue(record, 'vendor_name'),
    invoiceDate: stringValue(record, 'invoice_date'),
    dueDate: stringValue(record, 'due_date'),
    projectReference: stringValue(record, 'project_reference'),
    description: stringValue(record, 'description'),
    grossAmount: minorUnitsToInput(numberValue(record, 'gross_amount_minor')),
    currency: stringValue(record, 'currency') || 'usd',
    retainagePercentage: retainage === null ? '0' : String(retainage / 100),
    costCode: stringValue(record, 'cost_code'),
  }
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const candidate = error as { message?: unknown; context?: unknown } | null
  let message = typeof candidate?.message === 'string' ? candidate.message : fallback

  if (candidate?.context instanceof Response) {
    const body = await candidate.context.json().catch(() => null) as
      | { error?: unknown }
      | null
    if (typeof body?.error === 'string') message = body.error
  }

  return message
}

export function InvoiceIntakePanel({
  organizationId,
  projects,
  subcontractors,
  documents,
  isLoading,
  onDataChanged,
}: InvoiceIntakePanelProps) {
  const availableProjects = useMemo(
    () => projects.filter((project) => project.status !== 'archived'),
    [projects],
  )
  const availableSubcontractors = useMemo(
    () => subcontractors.filter((subcontractor) => subcontractor.status === 'active'),
    [subcontractors],
  )
  const [isOpen, setIsOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [projectId, setProjectId] = useState(availableProjects[0]?.id ?? '')
  const [subcontractorId, setSubcontractorId] = useState(
    availableSubcontractors[0]?.id ?? '',
  )
  const [file, setFile] = useState<File | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [values, setValues] = useState(emptyReview)
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([])
  const [fieldConfidence, setFieldConfidence] = useState<Record<string, number>>({})
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ReviewField>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? 'Unknown project'
  const subcontractorName = (id: string) =>
    subcontractors.find((subcontractor) => subcontractor.id === id)?.company_name ??
    'Unknown subcontractor'

  function closePanel() {
    if (isBusy) return
    setIsOpen(false)
    setActiveDocumentId(null)
    setError(null)
    setNotice(null)
    setFieldErrors({})
    setFile(null)
  }

  function startUpload() {
    setProjectId(availableProjects[0]?.id ?? '')
    setSubcontractorId(availableSubcontractors[0]?.id ?? '')
    setFile(null)
    setActiveDocumentId(null)
    setValues(emptyReview)
    setLineItems([])
    setFieldConfidence({})
    setError(null)
    setNotice(null)
    setFieldErrors({})
    setIsOpen(true)
  }

  function startReview(document: InvoiceDocument) {
    const extracted = recordValue(document.extracted_data)
    setProjectId(document.project_id)
    setSubcontractorId(document.subcontractor_id)
    setActiveDocumentId(document.id)
    setValues(reviewValues(extracted))
    setLineItems(editableLineItems(extracted))
    setFieldConfidence(confidenceValues(document.extraction_confidence))
    setFile(null)
    setError(null)
    setNotice(document.extraction_note)
    setFieldErrors({})
    setIsOpen(true)
  }

  function setReviewValue(field: keyof typeof values, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  async function uploadInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    if (!projectId || !subcontractorId || !file) {
      setError('Select a project, subcontractor, and invoice file.')
      return
    }

    const form = new FormData()
    form.set('organizationId', organizationId)
    form.set('projectId', projectId)
    form.set('subcontractorId', subcontractorId)
    form.set('invoice', file)
    setIsBusy(true)

    const { data, error: invokeError } = await supabase.functions.invoke<UploadInvoiceResponse>(
      'extract-invoice',
      { body: form },
    )

    if (invokeError || !data) {
      setError(
        await functionErrorMessage(
          invokeError,
          'The invoice could not be uploaded. Please try again.',
        ),
      )
      setIsBusy(false)
      return
    }

    const extracted = recordValue(data.extraction)
    setActiveDocumentId(data.documentId)
    setValues(reviewValues(extracted))
    setLineItems(editableLineItems(extracted))
    setFieldConfidence(confidenceValues(data.confidence))
    setNotice(data.note)
    await onDataChanged()
    setIsBusy(false)
  }

  function updateLineItem(index: number, field: keyof EditableLineItem, value: string) {
    setLineItems((current) => current.map((line, lineIndex) =>
      lineIndex === index ? { ...line, [field]: value } : line
    ))
  }

  async function confirmInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeDocumentId) return

    setError(null)
    setNotice(null)
    const parsed = invoiceReviewSchema.safeParse(values)

    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod<ReviewField>(parsed.error))
      return
    }

    const reviewedLineItems: InvoiceLineItem[] = []
    for (const line of lineItems) {
      const quantity = line.quantity.trim() === '' ? null : Number(line.quantity)
      const unitAmount = optionalMinorUnits(line.unitAmount)
      const amount = optionalMinorUnits(line.amount)

      if (
        line.description.trim().length > 500 ||
        (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) ||
        Number.isNaN(unitAmount) ||
        Number.isNaN(amount)
      ) {
        setError('Review the line-item descriptions, quantities, and amounts.')
        return
      }

      reviewedLineItems.push({
        description: line.description.trim(),
        quantity,
        unit_amount_minor: unitAmount,
        amount_minor: amount,
      })
    }

    setIsBusy(true)
    const { error: rpcError } = await supabase.rpc('confirm_invoice_document', {
      p_invoice_document_id: activeDocumentId,
      p_invoice_number: parsed.data.invoiceNumber,
      p_vendor_name: parsed.data.vendorName,
      p_invoice_date: parsed.data.invoiceDate || null,
      p_due_date: parsed.data.dueDate || null,
      p_project_reference: parsed.data.projectReference,
      p_description: parsed.data.description,
      p_gross_amount: parsed.data.grossAmount,
      p_currency: parsed.data.currency,
      p_retainage_basis_points: Math.round(
        parsed.data.retainagePercentage * 100,
      ),
      p_cost_code: parsed.data.costCode,
      p_line_items: reviewedLineItems as unknown as Json,
    })

    if (rpcError) {
      setError(
        rpcError.code === '23505'
          ? 'That invoice number is already recorded for this subcontractor.'
          : 'The reviewed invoice could not be confirmed. Refresh and try again.',
      )
      setIsBusy(false)
      return
    }

    await onDataChanged()
    setIsBusy(false)
    setIsOpen(false)
    setActiveDocumentId(null)
    setFile(null)
    setFieldErrors({})
  }

  async function openOriginal(documentId: string) {
    setError(null)
    const { data, error: invokeError } = await supabase.functions.invoke<{
      url?: unknown
    }>('download-invoice', { body: { invoiceDocumentId: documentId } })

    if (invokeError) {
      setError(
        await functionErrorMessage(
          invokeError,
          'The original invoice is temporarily unavailable.',
        ),
      )
      return
    }

    const url = trustedSupabaseInvoiceUrl(data?.url, supabaseUrl)
    if (!url) {
      setError('The invoice download returned an invalid link.')
      return
    }

    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const reviewFields: Array<{
    key: keyof typeof values
    confidenceKey?: string
    label: string
    type?: string
    placeholder?: string
  }> = [
    { key: 'invoiceNumber', confidenceKey: 'invoice_number', label: 'Invoice number', placeholder: 'INV-1042' },
    { key: 'vendorName', confidenceKey: 'vendor_name', label: 'Vendor', placeholder: 'Vendor name' },
    { key: 'invoiceDate', confidenceKey: 'invoice_date', label: 'Invoice date', type: 'date' },
    { key: 'dueDate', confidenceKey: 'due_date', label: 'Due date', type: 'date' },
    { key: 'projectReference', confidenceKey: 'project_reference', label: 'Project reference', placeholder: 'Project or PO reference' },
    { key: 'costCode', confidenceKey: 'cost_code', label: 'Cost code', placeholder: 'Optional' },
    { key: 'grossAmount', confidenceKey: 'gross_amount_minor', label: 'Gross amount', placeholder: '0.00' },
    { key: 'currency', confidenceKey: 'currency', label: 'Currency', placeholder: 'USD' },
    { key: 'retainagePercentage', confidenceKey: 'retainage_basis_points', label: 'Retainage %', placeholder: '0' },
  ]

  return (
    <section className="overflow-hidden rounded-lg border border-ink/10 bg-white shadow-[0_16px_40px_rgba(19,37,31,0.055)]">
      <div className="flex flex-col justify-between gap-4 border-b border-ink/10 p-6 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
            Document intake
          </p>
          <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">
            Invoice review queue
          </h2>
          <p className="mt-1 max-w-2xl text-sm font-medium text-ink/70">
            Upload an invoice, verify every extracted value, then create a draft payment request.
          </p>
        </div>
        <Button
          type="button"
          onClick={startUpload}
          disabled={availableProjects.length === 0 || availableSubcontractors.length === 0}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-forest px-4 text-sm font-bold text-white transition hover:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-50"
        >
          Upload invoice
        </Button>
      </div>

      {error && <NotificationBanner tone="error" className="m-6">{error}</NotificationBanner>}

      {isLoading ? (
        <p className="p-6 text-sm font-medium text-ink/75">Refreshing invoice queue…</p>
      ) : documents.length === 0 ? (
        <div className="grid justify-items-start gap-2 p-6">
          <p className="font-bold text-ink">No invoices uploaded yet.</p>
          <p className="text-sm font-medium text-ink/70">
            PDF and image invoices stay private and always require human confirmation.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] border-collapse text-left text-sm">
            <thead className="bg-cream text-[10px] font-bold uppercase tracking-[0.15em] text-ink/75">
              <tr>
                <th className="px-6 py-3">Invoice</th>
                <th className="px-4 py-3">Project / subcontractor</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-6 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/8">
              {documents.map((document) => (
                <tr key={document.id} className="transition-colors hover:bg-cream/40">
                  <td className="px-6 py-4">
                    <p className="max-w-64 truncate font-bold text-ink">
                      {document.invoice_number || document.file_name}
                    </p>
                    <p className="mt-1 text-xs text-ink/65">{shortDate(document.created_at)}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-ink">{projectName(document.project_id)}</p>
                    <p className="mt-1 text-xs text-ink/70">
                      {subcontractorName(document.subcontractor_id)}
                    </p>
                  </td>
                  <td className="px-4 py-4 font-semibold text-ink">
                    {document.gross_amount && document.currency
                      ? formatCurrency(document.gross_amount, document.currency)
                      : 'Pending review'}
                  </td>
                  <td className="px-4 py-4">
                    <span className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                      document.status === 'confirmed'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : document.status === 'failed'
                          ? 'border-red-200 bg-red-50 text-red-800'
                          : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}>
                      {formatStatus(document.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex justify-end gap-2">
                      {document.status === 'review_required' && (
                        <Button
                          type="button"
                          onClick={() => startReview(document)}
                          className="inline-flex h-9 items-center rounded-lg bg-ink px-3 text-xs font-bold text-white transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                        >
                          Review
                        </Button>
                      )}
                      {(document.status === 'review_required' ||
                        document.status === 'confirmed') && (
                        <Button
                          type="button"
                          onClick={() => void openOriginal(document.id)}
                          className="inline-flex h-9 items-center rounded-lg border border-ink/15 px-3 text-xs font-bold text-ink transition hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                        >
                          Original
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SidePanel open={isOpen} busy={isBusy} onClose={closePanel} className="max-w-2xl">
        {activeDocumentId ? (
          <form noValidate onSubmit={(event) => void confirmInvoice(event)} className="flex min-h-full flex-col">
            <SidePanelCloseButton disabled={isBusy} onClick={closePanel} />
            <div className="grid flex-1 content-start gap-5 p-6 pt-16 sm:grid-cols-2 sm:p-8 sm:pt-20">
              <div className="pr-10 sm:col-span-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">Human review required</p>
                <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">Verify invoice details</DialogTitle>
                <Description className="mt-2 text-sm leading-6 font-medium text-ink/75">
                  Confirm against the original. AI values are suggestions, not approval.
                </Description>
              </div>
              {notice && <NotificationBanner tone="info" className="sm:col-span-2">{notice}</NotificationBanner>}
              {error && <NotificationBanner tone="error" className="sm:col-span-2">{error}</NotificationBanner>}
              <div className="flex items-center justify-between gap-4 rounded-lg border border-ink/10 bg-cream/60 p-4 sm:col-span-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-ink/60">Applied to</p>
                  <p className="mt-1 font-bold text-ink">{projectName(projectId)}</p>
                  <p className="text-sm font-medium text-ink/70">{subcontractorName(subcontractorId)}</p>
                </div>
                <Button
                  type="button"
                  onClick={() => void openOriginal(activeDocumentId)}
                  className="inline-flex h-9 shrink-0 items-center rounded-lg border border-ink/15 bg-white px-3 text-xs font-bold text-ink transition hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                >
                  Open original
                </Button>
              </div>
              {reviewFields.map((field) => (
                <Field key={field.key} className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-bold text-ink">{field.label}</Label>
                    {field.confidenceKey &&
                      fieldConfidence[field.confidenceKey] !== undefined && (
                        <span
                          className={`text-[10px] font-bold uppercase tracking-[0.08em] ${
                            (fieldConfidence[field.confidenceKey] ?? 0) < 0.75
                              ? 'text-amber-700'
                              : 'text-ink/50'
                          }`}
                        >
                          {Math.round(
                            (fieldConfidence[field.confidenceKey] ?? 0) * 100,
                          )}% confidence
                        </span>
                      )}
                  </div>
                  <Input
                    type={field.type ?? 'text'}
                    value={values[field.key]}
                    placeholder={field.placeholder}
                    onChange={(event) => setReviewValue(field.key, event.target.value)}
                    aria-invalid={Boolean(fieldErrors[field.key]) || undefined}
                    aria-describedby={fieldErrors[field.key] ? `invoice-${field.key}-error` : undefined}
                    className={inputClassName}
                  />
                  <FieldError id={`invoice-${field.key}-error`} message={fieldErrors[field.key]} />
                </Field>
              ))}
              <Field className="grid gap-2 sm:col-span-2">
                <Label className="text-sm font-bold text-ink">Payment description</Label>
                <Textarea
                  rows={3}
                  value={values.description}
                  onChange={(event) => setReviewValue('description', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.description) || undefined}
                  aria-describedby={fieldErrors.description ? 'invoice-description-error' : undefined}
                  className={`${inputClassName} h-auto py-3`}
                />
                <FieldError id="invoice-description-error" message={fieldErrors.description} />
              </Field>
              <div className="grid gap-3 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-extrabold text-ink">Line items</h3>
                  <Button
                    type="button"
                    onClick={() => setLineItems((current) => [...current, { description: '', quantity: '', unitAmount: '', amount: '' }])}
                    className="text-xs font-bold text-forest hover:text-ink"
                  >
                    Add line
                  </Button>
                </div>
                {lineItems.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-ink/15 p-4 text-sm font-medium text-ink/60">No line items were detected.</p>
                ) : lineItems.map((line, index) => (
                  <div key={index} className="grid gap-3 rounded-lg border border-ink/10 p-4 sm:grid-cols-6">
                    <Input aria-label={`Line ${index + 1} description`} value={line.description} onChange={(event) => updateLineItem(index, 'description', event.target.value)} placeholder="Description" className={`${inputClassName} sm:col-span-3`} />
                    <Input aria-label={`Line ${index + 1} quantity`} value={line.quantity} onChange={(event) => updateLineItem(index, 'quantity', event.target.value)} inputMode="decimal" placeholder="Qty" className={inputClassName} />
                    <Input aria-label={`Line ${index + 1} unit amount`} value={line.unitAmount} onChange={(event) => updateLineItem(index, 'unitAmount', event.target.value)} inputMode="decimal" placeholder="Unit" className={inputClassName} />
                    <Input aria-label={`Line ${index + 1} amount`} value={line.amount} onChange={(event) => updateLineItem(index, 'amount', event.target.value)} inputMode="decimal" placeholder="Amount" className={inputClassName} />
                    <Button type="button" onClick={() => setLineItems((current) => current.filter((_, lineIndex) => lineIndex !== index))} className="justify-self-start text-xs font-bold text-red-700 sm:col-span-6">Remove line</Button>
                  </div>
                ))}
              </div>
            </div>
            <div className="sticky bottom-0 flex justify-end gap-3 border-t border-ink/10 bg-white p-6 sm:px-8">
              <Button type="button" disabled={isBusy} onClick={closePanel} className="h-10 rounded-lg border border-ink/15 px-4 text-sm font-bold text-ink hover:bg-cream disabled:opacity-50">Cancel</Button>
              <Button type="submit" disabled={isBusy} className="inline-flex h-10 items-center gap-2 rounded-lg bg-forest px-4 text-sm font-bold text-white hover:bg-ink disabled:cursor-wait disabled:opacity-50">
                {isBusy && <ButtonSpinner />}
                Confirm and create draft
              </Button>
            </div>
          </form>
        ) : (
          <form noValidate onSubmit={(event) => void uploadInvoice(event)} className="flex min-h-full flex-col">
            <SidePanelCloseButton disabled={isBusy} onClick={closePanel} />
            <div className="grid flex-1 content-start gap-5 p-6 pt-16 sm:p-8 sm:pt-20">
              <div className="pr-10">
                <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">Private document intake</p>
                <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">Upload an invoice</DialogTitle>
                <Description className="mt-2 text-sm leading-6 font-medium text-ink/75">PDF, JPG, PNG, or WebP up to 10 MB. Every result stops for human review.</Description>
              </div>
              {error && <NotificationBanner tone="error">{error}</NotificationBanner>}
              <Field className="grid gap-2">
                <Label className="text-sm font-bold text-ink">Project</Label>
                <SelectControl value={projectId} onChange={setProjectId} disabled={isBusy} className={selectClassName} options={availableProjects.map((project) => ({ value: project.id, label: `${project.code} — ${project.name}` }))} />
              </Field>
              <Field className="grid gap-2">
                <Label className="text-sm font-bold text-ink">Subcontractor</Label>
                <SelectControl value={subcontractorId} onChange={setSubcontractorId} disabled={isBusy} className={selectClassName} options={availableSubcontractors.map((subcontractor) => ({ value: subcontractor.id, label: subcontractor.company_name }))} />
              </Field>
              <Field className="grid gap-2">
                <Label className="text-sm font-bold text-ink">Invoice file</Label>
                <Input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  disabled={isBusy}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}
                  className="block w-full rounded-lg border border-dashed border-ink/20 bg-cream/50 p-4 text-sm font-semibold text-ink file:mr-4 file:rounded-lg file:border-0 file:bg-ink file:px-4 file:py-2 file:text-xs file:font-bold file:text-white hover:file:bg-forest"
                />
              </Field>
            </div>
            <div className="sticky bottom-0 flex justify-end gap-3 border-t border-ink/10 bg-white p-6 sm:px-8">
              <Button type="button" disabled={isBusy} onClick={closePanel} className="h-10 rounded-lg border border-ink/15 px-4 text-sm font-bold text-ink hover:bg-cream disabled:opacity-50">Cancel</Button>
              <Button type="submit" disabled={isBusy || !file} className="inline-flex h-10 items-center gap-2 rounded-lg bg-forest px-4 text-sm font-bold text-white hover:bg-ink disabled:cursor-wait disabled:opacity-50">
                {isBusy && <ButtonSpinner />}
                {isBusy ? 'Preparing review…' : 'Upload and extract'}
              </Button>
            </div>
          </form>
        )}
      </SidePanel>
    </section>
  )
}

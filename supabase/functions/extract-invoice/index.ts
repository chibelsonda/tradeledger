import { withSupabase } from '@supabase/server'

import { extractInvoiceWithOpenAi } from '../_shared/invoice-extraction.ts'
import {
  INVOICE_BUCKET,
  INVOICE_MAX_BYTES,
  invoiceMimeTypes,
  matchesInvoiceSignature,
} from '../_shared/invoice.ts'
import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'
import { isUuid } from '../_shared/waiver.ts'

interface ReservedInvoice {
  document_id: string
  storage_path: string
  project_name: string
  project_code: string
  subcontractor_name: string
}

async function sha256(value: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(value.byteLength)
  new Uint8Array(input).set(value)
  const bytes = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function stringFormValue(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' ? value : null
}

export default {
  fetch: withObservability(
    'extract-invoice',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      const contentType = request.headers.get('content-type') ?? ''

      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return Response.json(
          { error: 'A multipart invoice upload is required.' },
          { status: 400 },
        )
      }

      const userId = context.userClaims?.id

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'extract-invoice',
        subject: userId,
        limit: 10,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      let form: FormData

      try {
        form = await request.formData()
      } catch {
        return Response.json({ error: 'The invoice upload could not be read.' }, {
          status: 400,
        })
      }

      const organizationId = stringFormValue(form, 'organizationId')
      const projectId = stringFormValue(form, 'projectId')
      const subcontractorId = stringFormValue(form, 'subcontractorId')
      const invoice = form.get('invoice')

      if (!isUuid(organizationId) || !isUuid(projectId) || !isUuid(subcontractorId)) {
        return Response.json(
          { error: 'Organization, project, and subcontractor are required.' },
          { status: 422 },
        )
      }

      if (!(invoice instanceof File)) {
        return Response.json({ error: 'Select an invoice file.' }, { status: 422 })
      }

      if (
        !invoiceMimeTypes.has(invoice.type) ||
        invoice.size < 1 ||
        invoice.size > INVOICE_MAX_BYTES
      ) {
        return Response.json(
          { error: 'Use a PDF, JPG, PNG, or WebP invoice no larger than 10 MB.' },
          { status: 422 },
        )
      }

      const bytes = new Uint8Array(await invoice.arrayBuffer())

      if (!matchesInvoiceSignature(bytes, invoice.type)) {
        return Response.json(
          { error: 'The file content does not match the selected invoice format.' },
          { status: 422 },
        )
      }

      const digest = await sha256(bytes)
      const { data, error: reservationError } = await context.supabaseAdmin.rpc(
        'reserve_invoice_document',
        {
          p_organization_id: organizationId,
          p_project_id: projectId,
          p_subcontractor_id: subcontractorId,
          p_user_id: userId,
          p_file_name: invoice.name,
          p_mime_type: invoice.type,
          p_file_size: invoice.size,
          p_sha256: digest,
        },
      )

      if (reservationError) {
        console.error('Unable to reserve invoice document:', reservationError)
        return safeDatabaseErrorResponse(
          reservationError,
          'The invoice upload could not be prepared.',
        )
      }

      const reserved = (Array.isArray(data) ? data[0] : data) as
        | ReservedInvoice
        | undefined

      if (!reserved) {
        return Response.json({ error: 'The invoice upload could not be prepared.' }, {
          status: 500,
        })
      }

      const { error: uploadError } = await context.supabaseAdmin.storage
        .from(INVOICE_BUCKET)
        .upload(reserved.storage_path, bytes, {
          contentType: invoice.type,
          upsert: false,
        })

      if (uploadError) {
        console.error('Invoice storage upload failed:', uploadError)
        await context.supabaseAdmin.rpc('fail_invoice_document', {
          p_document_id: reserved.document_id,
          p_failure_reason: 'Private storage upload failed.',
        })
        return Response.json(
          { error: 'The invoice file could not be stored. Please try again.' },
          { status: 502 },
        )
      }

      const apiKey = Deno.env.get('OPENAI_API_KEY')?.trim()
      const model = Deno.env.get('OPENAI_INVOICE_MODEL')?.trim() || 'gpt-4o-mini'
      let provider = 'manual'
      let responseId: string | null = null
      let extractedData: Record<string, unknown> = {}
      let extractionConfidence: Record<string, number> = {}
      let extractionNote =
        'AI extraction is not configured. Review the invoice manually.'

      if (apiKey) {
        try {
          const extraction = await extractInvoiceWithOpenAi({
            apiKey,
            model,
            fileName: invoice.name,
            mimeType: invoice.type,
            bytes,
            projectName: reserved.project_name,
            projectCode: reserved.project_code,
            subcontractorName: reserved.subcontractor_name,
          })
          provider = 'openai'
          responseId = extraction.responseId
          extractedData = extraction.invoice as unknown as Record<string, unknown>
          extractionConfidence = Object.fromEntries(
            extraction.invoice.field_confidence.map((field) => [
              field.field,
              field.confidence,
            ]),
          )
          extractionNote =
            'AI-extracted values require human review before confirmation.'
        } catch (error) {
          console.error('Invoice extraction fell back to manual review:', {
            errorType: error instanceof Error ? error.name : 'UnknownError',
          })
          extractionNote =
            'Automatic extraction was unavailable. Review the invoice manually.'
        }
      }

      const { data: completed, error: completionError } = await context.supabaseAdmin
        .rpc('complete_invoice_extraction', {
          p_document_id: reserved.document_id,
          p_provider: provider,
          p_model: provider === 'openai' ? model : null,
          p_provider_response_id: responseId,
          p_extracted_data: extractedData,
          p_extraction_confidence: extractionConfidence,
          p_extraction_note: extractionNote,
        })

      if (completionError || completed !== true) {
        console.error('Unable to complete invoice extraction:', completionError)
        await context.supabaseAdmin.storage
          .from(INVOICE_BUCKET)
          .remove([reserved.storage_path])
        await context.supabaseAdmin.rpc('fail_invoice_document', {
          p_document_id: reserved.document_id,
          p_failure_reason: 'The extraction record could not be finalized.',
        })
        return Response.json(
          { error: 'The invoice could not be prepared for review.' },
          { status: 500 },
        )
      }

      return Response.json({
        documentId: reserved.document_id,
        status: 'review_required',
        mode: provider === 'openai' ? 'ai' : 'manual',
        extraction: extractedData,
        confidence: extractionConfidence,
        note: extractionNote,
      })
    }),
  ),
}

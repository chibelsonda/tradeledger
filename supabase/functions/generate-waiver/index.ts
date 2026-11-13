import { withSupabase } from 'npm:@supabase/server@^1'

import { buildWaiverPdf } from '../_shared/waiver-pdf.ts'
import {
  databaseErrorStatus,
  isUuid,
  safeDownloadName,
  WAIVER_BUCKET,
  WAIVER_URL_TTL_SECONDS,
} from '../_shared/waiver.ts'

interface WaiverRequest {
  paymentRequestId?: unknown
}
interface ReservedWaiver {
  document_id: string
  document_status: 'generating' | 'ready' | 'failed' | 'voided'
  storage_path: string
  file_name: string
  organization_id: string
  organization_name: string
  payment_request_id: string
  payment_reference: string
  project_name: string
  project_code: string
  subcontractor_name: string
  subcontractor_contact: string | null
  description: string
  gross_amount: number
  retainage_amount: number
  net_amount: number
  currency: string
  paid_at: string
}

async function sha256(value: Uint8Array): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }

    let body: WaiverRequest

    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'A JSON request body is required.' }, { status: 400 })
    }

    if (!isUuid(body.paymentRequestId)) {
      return Response.json(
        { error: 'A valid payment request ID is required.' },
        { status: 422 },
      )
    }

    const userId = context.userClaims?.id

    if (typeof userId !== 'string' || userId.length === 0) {
      return Response.json({ error: 'Authenticated user is missing.' }, { status: 401 })
    }

    const { data, error: reservationError } = await context.supabaseAdmin.rpc(
      'reserve_waiver_document',
      {
        p_payment_request_id: body.paymentRequestId,
        p_user_id: userId,
      },
    )

    if (reservationError) {
      console.error('Unable to reserve waiver document:', reservationError)
      return Response.json(
        { error: reservationError.message },
        { status: databaseErrorStatus(reservationError.code) },
      )
    }

    const waiver = (Array.isArray(data) ? data[0] : data) as
      | ReservedWaiver
      | undefined

    if (!waiver) {
      return Response.json(
        { error: 'The waiver document could not be prepared.' },
        { status: 500 },
      )
    }

    if (waiver.document_status !== 'ready') {
      try {
        const pdf = await buildWaiverPdf({
          organizationName: waiver.organization_name,
          paymentRequestId: waiver.payment_request_id,
          paymentReference: waiver.payment_reference,
          projectName: waiver.project_name,
          projectCode: waiver.project_code,
          subcontractorName: waiver.subcontractor_name,
          subcontractorContact: waiver.subcontractor_contact,
          description: waiver.description,
          grossAmount: waiver.gross_amount,
          retainageAmount: waiver.retainage_amount,
          netAmount: waiver.net_amount,
          currency: waiver.currency,
          paidAt: waiver.paid_at,
        })
        const digest = await sha256(pdf)
        const { error: uploadError } = await context.supabaseAdmin.storage
          .from(WAIVER_BUCKET)
          .upload(waiver.storage_path, pdf, {
            contentType: 'application/pdf',
            upsert: true,
          })

        if (uploadError) {
          throw new Error(`Private storage upload failed: ${uploadError.message}`)
        }

        const { data: finalized, error: finalizeError } =
          await context.supabaseAdmin.rpc('finalize_waiver_document', {
            p_document_id: waiver.document_id,
            p_user_id: userId,
            p_sha256: digest,
            p_file_size: pdf.byteLength,
          })

        if (finalizeError || finalized !== true) {
          await context.supabaseAdmin.storage
            .from(WAIVER_BUCKET)
            .remove([waiver.storage_path])
          throw new Error(
            finalizeError?.message ??
              'The payment changed before the document could be finalized.',
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Document generation failed.'
        console.error('Waiver generation failed:', error)
        await context.supabaseAdmin.rpc('fail_waiver_document', {
          p_document_id: waiver.document_id,
          p_failure_reason: message,
        })

        return Response.json(
          { error: 'The waiver could not be generated. Please try again.' },
          { status: 500 },
        )
      }
    }

    const { data: signed, error: signingError } = await context.supabaseAdmin.storage
      .from(WAIVER_BUCKET)
      .createSignedUrl(waiver.storage_path, WAIVER_URL_TTL_SECONDS, {
        download: safeDownloadName(waiver.file_name),
      })

    if (signingError || !signed?.signedUrl) {
      console.error('Unable to sign waiver download:', signingError)
      return Response.json(
        { error: 'The waiver was generated, but its download link is unavailable.' },
        { status: 502 },
      )
    }

    return Response.json({
      documentId: waiver.document_id,
      status: 'ready',
      url: signed.signedUrl,
      expiresIn: WAIVER_URL_TTL_SECONDS,
    })
  }),
}

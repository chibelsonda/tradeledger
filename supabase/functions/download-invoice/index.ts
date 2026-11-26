import { withSupabase } from '@supabase/server'

import {
  INVOICE_BUCKET,
  INVOICE_URL_TTL_SECONDS,
  safeInvoiceDownloadName,
} from '../_shared/invoice.ts'
import { withObservability } from '../_shared/observability.ts'
import { enforceUserRateLimit, safeDatabaseErrorResponse } from '../_shared/security.ts'
import { isUuid } from '../_shared/waiver.ts'

interface DownloadRequest {
  invoiceDocumentId?: unknown
}
interface DownloadableInvoice {
  document_id: string
  storage_path: string
  file_name: string
}

export default {
  fetch: withObservability(
    'download-invoice',
    withSupabase({ auth: 'user' }, async (request, context) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed.' }, { status: 405 })
      }

      let body: DownloadRequest

      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'A JSON request body is required.' }, {
          status: 400,
        })
      }

      if (!isUuid(body.invoiceDocumentId)) {
        return Response.json(
          { error: 'A valid invoice document ID is required.' },
          { status: 422 },
        )
      }

      const userId = context.userClaims?.id

      if (typeof userId !== 'string' || userId.length === 0) {
        return Response.json({ error: 'Authenticated user is missing.' }, {
          status: 401,
        })
      }

      const rateLimitResponse = await enforceUserRateLimit(context.supabaseAdmin, {
        bucket: 'download-invoice',
        subject: userId,
        limit: 30,
        windowSeconds: 60,
      })

      if (rateLimitResponse) return rateLimitResponse

      const { data, error: preparationError } = await context.supabaseAdmin.rpc(
        'prepare_invoice_download',
        {
          p_invoice_document_id: body.invoiceDocumentId,
          p_user_id: userId,
        },
      )

      if (preparationError) {
        console.error('Unable to prepare invoice download:', preparationError)
        return safeDatabaseErrorResponse(
          preparationError,
          'The invoice download could not be prepared.',
        )
      }

      const invoice = (Array.isArray(data) ? data[0] : data) as
        | DownloadableInvoice
        | undefined

      if (!invoice) {
        return Response.json({ error: 'A downloadable invoice was not found.' }, {
          status: 404,
        })
      }

      const { data: signed, error: signingError } = await context.supabaseAdmin.storage
        .from(INVOICE_BUCKET)
        .createSignedUrl(invoice.storage_path, INVOICE_URL_TTL_SECONDS, {
          download: safeInvoiceDownloadName(invoice.file_name),
        })

      if (signingError || !signed?.signedUrl) {
        console.error('Unable to sign invoice download:', signingError)
        return Response.json(
          { error: 'The invoice download link is temporarily unavailable.' },
          { status: 502 },
        )
      }

      return Response.json({
        documentId: invoice.document_id,
        url: signed.signedUrl,
        expiresIn: INVOICE_URL_TTL_SECONDS,
      })
    }),
  ),
}

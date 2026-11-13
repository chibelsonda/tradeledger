import { withSupabase } from 'npm:@supabase/server@^1'

import {
  databaseErrorStatus,
  isUuid,
  safeDownloadName,
  WAIVER_BUCKET,
  WAIVER_URL_TTL_SECONDS,
} from '../_shared/waiver.ts'

interface DownloadRequest {
  paymentRequestId?: unknown
}
interface DownloadableWaiver {
  document_id: string
  storage_path: string
  file_name: string
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }

    let body: DownloadRequest

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

    const { data, error: preparationError } = await context.supabaseAdmin.rpc(
      'prepare_waiver_download',
      {
        p_payment_request_id: body.paymentRequestId,
        p_user_id: userId,
      },
    )

    if (preparationError) {
      console.error('Unable to prepare waiver download:', preparationError)
      return Response.json(
        { error: preparationError.message },
        { status: databaseErrorStatus(preparationError.code) },
      )
    }

    const waiver = (Array.isArray(data) ? data[0] : data) as
      | DownloadableWaiver
      | undefined

    if (!waiver) {
      return Response.json({ error: 'A downloadable waiver was not found.' }, { status: 404 })
    }

    const { data: signed, error: signingError } = await context.supabaseAdmin.storage
      .from(WAIVER_BUCKET)
      .createSignedUrl(waiver.storage_path, WAIVER_URL_TTL_SECONDS, {
        download: safeDownloadName(waiver.file_name),
      })

    if (signingError || !signed?.signedUrl) {
      console.error('Unable to sign waiver download:', signingError)
      return Response.json(
        { error: 'The waiver download link is temporarily unavailable.' },
        { status: 502 },
      )
    }

    return Response.json({
      documentId: waiver.document_id,
      url: signed.signedUrl,
      expiresIn: WAIVER_URL_TTL_SECONDS,
    })
  }),
}

import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { bulkNotificationAction } from '@/lib/domain/notifications/notification-intelligence-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const body = await parseJsonSafe(request)
    const ids = body.ids || body.notification_ids || []
    const action = body.action || 'mark_read'

    const result = await bulkNotificationAction(ids, action)
    if (!result.ok) {
      const status = result.error === 'ids_required' ? 400 : 500
      return NextResponse.json({ ok: false, error: result.error }, { status, headers: cors })
    }

    return NextResponse.json({
      ok: true,
      action,
      updated_count: result.updated_count,
      ids: result.ids,
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'bulk_action_failed' },
      { status: 500, headers: cors },
    )
  }
}
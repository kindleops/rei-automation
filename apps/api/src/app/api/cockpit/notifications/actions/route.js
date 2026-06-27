import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { executeNotificationAction } from '@/lib/domain/notifications/notification-action-executor.js'

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
    const notificationId = body.notification_id || body.notificationId
    const actionType = body.action_type || body.actionType || body.action
    const operatorId = body.operator_id || body.operatorId || auth.auth?.operator_id || auth.auth?.user_id || 'operator'

    if (!notificationId) {
      return NextResponse.json({ ok: false, error: 'notification_id_required' }, { status: 400, headers: cors })
    }
    if (!actionType) {
      return NextResponse.json({ ok: false, error: 'action_type_required' }, { status: 400, headers: cors })
    }

    const result = await executeNotificationAction(notificationId, actionType, operatorId, body)

    const status = result.ok ? 200 : (result.error === 'notification_not_found' ? 404 : 400)
    return NextResponse.json(result, { status, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'notification_action_failed' },
      { status: 500, headers: cors },
    )
  }
}
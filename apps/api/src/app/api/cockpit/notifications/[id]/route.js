import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import {
  markRead,
  markUnread,
  dismissNotification,
  clearNotification,
  snoozeNotification,
} from '@/lib/domain/notifications/notification-intelligence-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function PATCH(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const notificationId = params?.id
  if (!notificationId) {
    return NextResponse.json({ ok: false, error: 'notification_id_required' }, { status: 400, headers: cors })
  }

  try {
    const body = await parseJsonSafe(request)
    const action = String(body.action ?? '').toLowerCase()

    let result
    switch (action) {
      case 'read':
      case 'mark_read':
        result = await markRead(notificationId)
        break
      case 'unread':
      case 'mark_unread':
        result = await markUnread(notificationId)
        break
      case 'dismiss':
        result = await dismissNotification(notificationId)
        break
      case 'clear':
      case 'resolve':
        result = await clearNotification(notificationId)
        break
      case 'snooze':
        result = await snoozeNotification(notificationId, body.snoozed_until || body.until)
        break
      default:
        return NextResponse.json(
          { ok: false, error: `unknown_action:${action || 'missing'}` },
          { status: 400, headers: cors },
        )
    }

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 404, headers: cors })
    }

    return NextResponse.json({ ok: true, action, notification: result.notification }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'notification_patch_failed' },
      { status: 500, headers: cors },
    )
  }
}
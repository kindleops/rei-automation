import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../_shared.js'
import { listNotificationEvents } from '@/lib/domain/notifications/notification-intelligence-service.js'
import { runNotificationIntelligenceScan } from '@/lib/domain/notifications/notification-scanners.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const result = await listNotificationEvents({
      severity: searchParams.get('severity') ?? undefined,
      domain: searchParams.get('domain') ?? undefined,
      search: searchParams.get('search') ?? undefined,
      unread: searchParams.get('unread') ?? undefined,
      status: searchParams.get('status') ?? 'active',
      campaign_id: searchParams.get('campaign_id') ?? undefined,
      limit: searchParams.get('limit') ?? 100,
      offset: searchParams.get('offset') ?? 0,
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500, headers: cors })
    }

    return NextResponse.json({
      ok: true,
      notifications: result.notifications,
      total: result.total,
      meta: { unread_filter: searchParams.get('unread') === 'true' },
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'notifications_list_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const body = await parseJsonSafe(request)
    const action = String(body.action ?? 'scan').toLowerCase()

    if (action !== 'scan') {
      return NextResponse.json(
        { ok: false, error: `unknown_action:${action}` },
        { status: 400, headers: cors },
      )
    }

    const scan = await runNotificationIntelligenceScan({
      dry_run: body.dry_run === true,
    })

    return NextResponse.json({ ok: true, action: 'scan', ...scan }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'notification_scan_failed' },
      { status: 500, headers: cors },
    )
  }
}
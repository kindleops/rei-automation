import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => ({}))

  return NextResponse.json({
    ok: false,
    action: 'reprocess_paused',
    route: 'cockpit/queue/reprocess-paused',
    error: 'QUEUE_REPROCESS_PAUSED_NOT_WIRED',
    message: 'Paused-row reprocessing is not wired to a launch-safe backend service yet. Use Retry Routing for individual paused rows.',
    requested_ids: Array.isArray(body?.ids) ? body.ids : [],
    summary: {
      resolved: 0,
      still_blocked: 0,
      skipped: 0,
    },
  }, { status: 501 })
}

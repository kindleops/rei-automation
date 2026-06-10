import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  return NextResponse.json({
    ok: false,
    action: 'cancel_stale_followups',
    route: 'cockpit/queue/cancel-stale-followups',
    error: 'CANCEL_STALE_FOLLOWUPS_NOT_WIRED',
    message: 'Cancel stale follow-ups is not wired to a launch-safe backend service yet.',
    cancelled: 0,
  }, { status: 501 })
}

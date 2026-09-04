import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { listScheduledFollowups } from '@/lib/domain/inbox/list-scheduled-followups.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

// Read-only. Lists follow-ups already parked in send_queue; creates nothing and
// sends nothing.
export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const result = await listScheduledFollowups({
      limit: searchParams.get('limit'),
      thread_key: searchParams.get('thread_key'),
    })
    return NextResponse.json(result, { status: result.ok ? 200 : 500, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'scheduled_list_failed', items: [], count: 0 },
      { status: 500, headers: cors },
    )
  }
}

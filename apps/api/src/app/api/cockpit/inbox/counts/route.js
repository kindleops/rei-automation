import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { getDealContextCounts } from '@/lib/domain/deal-context/deal-context-service.js'

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
    const countsResult = await getDealContextCounts(Object.fromEntries(searchParams.entries()))
    const { by_inbox_bucket: b, by_context_type: c, total } = countsResult

    const counts = {
      all: total || 0,
      all_messages: total || 0,
      priority: b.priority || 0,
      new_replies: b.new_replies || 0,
      needs_review: b.needs_review || 0,
      follow_up: b.follow_up || 0,
      cold: b.cold || 0,
      dead: b.dead || 0,
      suppressed: b.suppressed || 0,
      unlinked: c.unlinked_thread || 0
    }
    
    return NextResponse.json({ ok: true, data: { counts } }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}

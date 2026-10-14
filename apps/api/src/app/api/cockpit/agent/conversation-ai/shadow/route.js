// Conversation Engine 2.0 — READ-ONLY operator view of shadow decisions.
// GET /api/cockpit/agent/conversation-ai/shadow?limit=50&outcome=REPLY_CANDIDATE
// Reads public.conversation_ai_shadow_decisions (PROPOSED table) — select only, bounded,
// newest first (created_at index). Masked text only (the table's CHECK). Nothing here
// can send, queue or change anything. While the table is not applied the route answers
// { ok: true, available: false } — it never substitutes fixtures (the dashboard's dev
// fixture lives in the dashboard, behind an explicit dev flag).
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth, handleOptionsResponse } from '../../../_shared.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { listShadowRecords } from '@/lib/domain/conversation-ai/shadow-read.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return handleOptionsResponse(request)
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const url = new URL(request.url)
  const r = await listShadowRecords({ supabase: getDefaultSupabaseClient(), limit: url.searchParams.get('limit'), outcome: url.searchParams.get('outcome') })
  return NextResponse.json(r, { status: 200, headers: cors })
}

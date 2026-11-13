// Conversation Engine — review-panel DRAFT over the canonical runtime (rc-8.5.21).
// POST /api/cockpit/agent/conversation-ai/draft  { inbound_message_id }
// Returns what the canonical runtime (decideAndCompose) would do and say for that inbound: the
// plan, the text, its validation and every version. Never queues, reserves or sends; writes
// nothing. See lib/ai/conversation-ai-draft-service.js for the gates and the spend posture.
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth, handleOptionsResponse } from '../../../_shared.js'
import { draftReplyForInbound } from '@/lib/ai/conversation-ai-draft-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return handleOptionsResponse(request)
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  let body = {}
  try { body = await request.json() } catch { body = {} }
  const r = await draftReplyForInbound({ inboundMessageId: body?.inbound_message_id, caller: 'review_api' })
  return NextResponse.json(r, { status: r.ok ? 200 : r.code === 'INBOUND_ID_INVALID' ? 400 : 200, headers: cors })
}

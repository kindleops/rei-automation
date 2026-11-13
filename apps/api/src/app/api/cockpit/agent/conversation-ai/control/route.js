// Conversation Engine 2.0 — operator control plane for the SHADOW runtime.
// GET  /api/cockpit/agent/conversation-ai/control  read-only state (gates, budget, kind, jobs)
// POST /api/cockpit/agent/conversation-ai/control  { action: 'emergency_stop'|'pause_kind', confirm: true, reason? }
//      named-operator only; writes ONLY via agent.runtime_emergency_stop / agent.runtime_pause_kind.
// See lib/agent/review/conversation-ai-control.js for the auth order and the guarantees.
import { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth, handleOptionsResponse } from '../../../_shared.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { handleConversationAiControlGet, handleConversationAiControlPost } from '@/lib/agent/review/conversation-ai-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return handleOptionsResponse(request)
}

export async function GET(request) {
  return handleConversationAiControlGet(request, { auth: ensureDashboardReadAuth, headers: corsHeaders(request), supabase: getDefaultSupabaseClient() })
}

export async function POST(request) {
  return handleConversationAiControlPost(request, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

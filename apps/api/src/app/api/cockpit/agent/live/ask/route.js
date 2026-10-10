// Read-only research agent (owner GO 10-10). 404 with an empty body unless the live
// route gate, AGENT_ENABLED and AGENT_RESEARCH_ENABLED=1 all hold.
//   GET  → status (resolved models, caps, spend)   POST → { question, context?, wait_ms? } → 202 { run_id }
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { handleResearchStatus, handleResearchAsk } from '@/lib/agent/research/research-routes.js'
import { getResearchAgent } from '@/lib/ai/research-agent.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleResearchStatus(request, { auth: ensureMutationAuth, headers: corsHeaders(request), getResearch: getResearchAgent })
}

export async function POST(request) {
  return handleResearchAsk(request, { auth: ensureMutationAuth, headers: corsHeaders(request), getResearch: getResearchAgent })
}

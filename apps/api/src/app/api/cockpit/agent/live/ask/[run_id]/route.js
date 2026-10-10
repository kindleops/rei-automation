// Read-only research agent: one run (state, answer, latency, cost per call, audit). Owner-scoped (404 otherwise).
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleResearchRun } from '@/lib/agent/research/research-routes.js'
import { getResearchAgent } from '@/lib/ai/research-agent.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, context) {
  return handleResearchRun(request, { params: (await context?.params) || {}, auth: ensureMutationAuth, headers: corsHeaders(request), getResearch: getResearchAgent })
}

// 8.5.20 part C Operations API — Inbound Action Center — states, the active queue, lost conversations.
// 404 with an empty body unless AGENT_ENABLED and AGENT_OPERATIONS_ENABLED. Read only.
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { handleActionCenter } from '@/lib/agent/operations/operations-routes.js'
import { getOperationsRouteServices } from '@/lib/ai/operations-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleActionCenter(request, { auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getOperationsRouteServices })
}

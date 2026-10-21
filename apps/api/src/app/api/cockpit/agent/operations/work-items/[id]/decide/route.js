// 8.5.20 part C Operations API — a named operator acknowledges / resolves / dismisses / reopens a work item.
// 404 with an empty body unless AGENT_ENABLED and AGENT_OPERATIONS_ENABLED. Sends nothing.
import { corsHeaders, ensureMutationAuth } from '../../../../../_shared.js'
import { handleWorkItemDecide } from '@/lib/agent/operations/operations-routes.js'
import { getOperationsRouteServices } from '@/lib/ai/operations-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const { id } = await params
  return handleWorkItemDecide(request, id, { auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getOperationsRouteServices })
}

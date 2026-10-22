// LeadCommand Workforce API (docs/WORKFORCE.md §7) — POST the CEO's decision on an item in the CEO queue
// ({ decision: approve | decline | done, note? }). CEO only. 404 with an empty body unless AGENT_ENABLED and
// WORKFORCE_ENABLED=1. The decision is recorded inside Workforce only: nothing is sent, offered or staged.
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleAssignmentResolve } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const { id } = await params
  return handleAssignmentResolve(request, id, opts(request))
}

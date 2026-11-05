// LeadCommand Workforce API (docs/WORKFORCE.md §7) — POST cancel a mission (requester or owner).
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. Sends nothing.
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleMissionCancel } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const { id } = await params
  return handleMissionCancel(request, id, opts(request))
}

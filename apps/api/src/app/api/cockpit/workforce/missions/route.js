// LeadCommand Workforce API (docs/WORKFORCE.md §7) — GET missions / POST a CEO directive (opens a mission and enqueues workforce.coo_plan).
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. The requester is the session operator, never the body. Sends nothing.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleMissionsList, handleMissionCreate } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleMissionsList(request, opts(request))
}

export async function POST(request) {
  return handleMissionCreate(request, opts(request))
}

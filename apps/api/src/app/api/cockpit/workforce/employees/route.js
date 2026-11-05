// LeadCommand Workforce API (docs/WORKFORCE.md §7) — GET employees / POST create or update an employee (CEO only).
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. The actor is the session operator, never the body.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleEmployeesList, handleEmployeeUpsert } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleEmployeesList(request, opts(request))
}

export async function POST(request) {
  return handleEmployeeUpsert(request, opts(request))
}

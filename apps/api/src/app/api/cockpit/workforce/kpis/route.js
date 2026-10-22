// LeadCommand Workforce API (docs/WORKFORCE.md §7) — GET KPIs (unknown-aware).
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. Read only.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleKpis } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleKpis(request, opts(request))
}

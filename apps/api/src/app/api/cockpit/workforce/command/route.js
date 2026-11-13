// LeadCommand Workforce API (docs/WORKFORCE.md §7) — GET / POST the executive conversation with the COO.
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. A directive opens a mission or is answered from live data; nothing contacts a seller.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleCommandList, handleCommandPost } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleCommandList(request, opts(request))
}

export async function POST(request) {
  return handleCommandPost(request, opts(request))
}

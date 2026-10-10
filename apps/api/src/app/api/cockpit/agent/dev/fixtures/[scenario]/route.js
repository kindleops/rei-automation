// DEV ONLY — 404 in production. One fixture scenario's event log (cursor/SSE).
import { corsHeaders } from '../../../../_shared.js'
import { requireDevRouteAccess } from '@/lib/security/dev-route-guard.js'
import { handleFixtureScenario } from '@/lib/agent/dev/fixture-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, context) {
  return handleFixtureScenario(request, { params: context?.params || {}, guard: requireDevRouteAccess, headers: corsHeaders(request) })
}

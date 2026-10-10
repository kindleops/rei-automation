// DEV ONLY — 404 in production. Fixture event logs for the S2 agent prototype.
import { corsHeaders } from '../../../_shared.js'
import { requireDevRouteAccess } from '@/lib/security/dev-route-guard.js'
import { handleFixtureIndex } from '@/lib/agent/dev/fixture-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleFixtureIndex(request, { guard: requireDevRouteAccess, headers: corsHeaders(request) })
}

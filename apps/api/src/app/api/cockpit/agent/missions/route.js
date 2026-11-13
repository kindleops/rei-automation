// Persistent missions (8.5.18) — list + create. Contract: docs/agent-missions-api.md.
// 404 with an empty body unless AGENT_ENABLED and AGENT_MISSIONS_ENABLED.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleMissionsList, handleMissionCreate } from '@/lib/agent/missions/missions-routes.js'
import { getMissionsService } from '@/lib/ai/mission-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleMissionsList(request, { auth: ensureMutationAuth, headers: corsHeaders(request), getService: getMissionsService })
}

export async function POST(request) {
  return handleMissionCreate(request, { auth: ensureMutationAuth, headers: corsHeaders(request), getService: getMissionsService })
}

// Persistent missions (8.5.18) — one mission: status, progress, events, findings, result, cost.
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { handleMissionGet } from '@/lib/agent/missions/missions-routes.js'
import { getMissionsService } from '@/lib/ai/mission-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const { id } = await params
  return handleMissionGet(request, id, { auth: ensureMutationAuth, headers: corsHeaders(request), getService: getMissionsService })
}

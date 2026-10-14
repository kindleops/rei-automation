// Persistent missions (8.5.18) — cancel (cooperative while running; cascades to a supervisor's children).
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleMissionCancel } from '@/lib/agent/missions/missions-routes.js'
import { getMissionsService } from '@/lib/ai/mission-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const { id } = await params
  return handleMissionCancel(request, id, { auth: ensureMutationAuth, headers: corsHeaders(request), getService: getMissionsService })
}

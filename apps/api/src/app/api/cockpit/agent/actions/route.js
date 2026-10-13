// Intelligence Command 2.0 — capability matrix. 404 unless AGENT_ENABLED + AGENT_CAPABILITIES_ENABLED.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleActionsCatalog } from '@/lib/agent/actions/routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleActionsCatalog(request, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

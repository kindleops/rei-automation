// Intelligence Command 2.0 — operator-initiated capability invocation (same server-side enforcement as the model path).
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { handleActionsInvoke } from '@/lib/agent/actions/routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  return handleActionsInvoke(request, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

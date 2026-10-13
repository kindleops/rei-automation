// Intelligence Command 2.0 — pending / decided capability approvals for the verified operator's org.
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { handleApprovalsList } from '@/lib/agent/actions/routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleApprovalsList(request, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

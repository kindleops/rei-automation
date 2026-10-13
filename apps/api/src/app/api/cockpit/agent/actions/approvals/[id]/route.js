// Intelligence Command 2.0 — one capability approval (+ display-only preview).
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleApprovalGet } from '@/lib/agent/actions/routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const { id } = await params
  return handleApprovalGet(request, id, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

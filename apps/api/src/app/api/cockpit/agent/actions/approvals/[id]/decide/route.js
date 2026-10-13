// Intelligence Command 2.0 — the human decision on a capability approval. Approve re-reads the
// current state (drift refuses), then executes through the existing UI service path.
import { corsHeaders, ensureMutationAuth } from '../../../../../_shared.js'
import { handleApprovalDecide } from '@/lib/agent/actions/routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const { id } = await params
  return handleApprovalDecide(request, id, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

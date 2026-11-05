// LeadCommand Workforce API (docs/WORKFORCE.md §7) — GET policies, settings and proposed grants / POST put or revoke a policy, change settings (CEO only).
// 404 with an empty body unless AGENT_ENABLED and WORKFORCE_ENABLED=1. Proposed grants are display only.
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { handleAuthorityGet, handleAuthorityPost } from '@/lib/workforce/routes.js'
import { getWorkforceRouteServices } from '@/lib/ai/workforce-runtime-wiring.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const opts = (request) => ({ auth: ensureMutationAuth, headers: corsHeaders(request), getServices: getWorkforceRouteServices })

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  return handleAuthorityGet(request, opts(request))
}

export async function POST(request) {
  return handleAuthorityPost(request, opts(request))
}

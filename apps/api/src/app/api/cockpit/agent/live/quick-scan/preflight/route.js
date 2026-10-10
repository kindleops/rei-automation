// LOCAL DEV ONLY (S3) — live Quick Scan. 404 unless AGENT_LIVE_ROUTES=1 and not production.
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { handleQuickScanPreflight } from '@/lib/agent/live/live-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  return handleQuickScanPreflight(request, { auth: ensureMutationAuth, headers: corsHeaders(request) })
}

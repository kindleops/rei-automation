/**
 * BUYER MATCH SALES — current canonical recorded sales (deduped; price > 0 for
 * comps) for one subject scope. Read-only. See buyer-match-sales.js.
 */
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { createBuyerMatchSalesGet } from '@/lib/domain/buyer-match/buyer-match-sales-handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export const GET = createBuyerMatchSalesGet({ auth: ensureDashboardReadAuth, cors: corsHeaders })

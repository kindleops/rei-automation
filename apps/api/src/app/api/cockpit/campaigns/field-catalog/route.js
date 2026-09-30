import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import {
  getCampaignFieldCatalogWithApplicability,
  loadGraphColumnPopulation,
} from '@/lib/domain/campaigns/campaign-graph-filter-plan.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  // Each field says whether it can narrow a campaign, and why not — so the
  // builder disables it instead of accepting a filter Reach and Build ignore.
  // The audience-column probe is cached per process; a failure only means
  // "mapping-only" answers, never a broken catalog.
  const population = await loadGraphColumnPopulation(supabase).catch(() => null)
  return withCors(request, getCampaignFieldCatalogWithApplicability({ population }), 200)
}

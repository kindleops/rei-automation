import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { getCampaignFieldCatalogResponse } from '@/lib/domain/campaigns/campaign-field-catalog.js'

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

  return withCors(request, getCampaignFieldCatalogResponse(), 200)
}

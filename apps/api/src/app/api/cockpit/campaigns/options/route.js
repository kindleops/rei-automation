import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { queryCampaignFieldOptions } from '@/lib/domain/campaigns/campaign-field-catalog.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const field = url.searchParams.get('field') || ''
  const search = url.searchParams.get('search') || ''
  const limit = url.searchParams.get('limit') || 50

  try {
    const result = await queryCampaignFieldOptions({ field_key: field, search, limit })
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200)
  } catch (error) {
    console.error('campaigns.options_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_options_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

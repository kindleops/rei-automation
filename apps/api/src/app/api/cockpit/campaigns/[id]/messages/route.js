import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { fetchCampaignMessages } from '@/lib/domain/campaigns/campaign-messages.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

async function campaignIdFromParams(params) {
  const resolved = await params
  return resolved?.id || resolved?.campaign_id || null
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/** GET ?bucket=upcoming|sending|sent&limit=40 — read-only. */
export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const { searchParams } = new URL(request.url)
    const result = await fetchCampaignMessages(campaignId, {
      bucket: searchParams.get('bucket'),
      limit: searchParams.get('limit'),
    })
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.messages_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_messages_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

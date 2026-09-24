import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { fetchCampaignSendsSince } from '@/lib/domain/campaigns/campaign-sends-since.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/** GET ?since=<ISO> (within the last week) — read-only. */
export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const since = new URL(request.url).searchParams.get('since')
    const result = await fetchCampaignSendsSince(since)
    return withCors(request, result, result.ok ? 200 : 400)
  } catch (error) {
    console.error('campaigns.sends_since_failed', error)
    return withCors(request, { ok: false, error: 'campaign_sends_since_failed', message: error?.message || String(error) }, 500)
  }
}

import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../_shared.js'
import {
  createCampaign,
  listCampaigns,
} from '@/lib/domain/campaigns/campaign-automation-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const result = await listCampaigns()
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.list_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaigns_list_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const payload = await parseJsonSafe(request)
    const result = await createCampaign(payload)
    return withCors(request, result, result.ok === false ? Number(result.status || 423) : 200)
  } catch (error) {
    console.error('campaigns.create_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_create_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

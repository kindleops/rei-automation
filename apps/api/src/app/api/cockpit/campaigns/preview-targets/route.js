import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { previewCampaignTargets } from '@/lib/domain/campaigns/campaign-automation-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const body = await parseJsonSafe(request)
    const result = await previewCampaignTargets({
      ...body,
      dry_run: true,
    })
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.preview_targets_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_preview_targets_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

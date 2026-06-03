import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  const body = await parseJsonSafe(request)
  const result = await createCampaignQueuePlan(campaignId, {
    ...body,
    dry_run: true,
    create_send_queue_rows: false,
    explicit_operator_action: true,
  })

  return withCors(request, {
    ...result,
    success: result.ok !== false,
    queued_count: 0,
    send_queue_rows_created: 0,
    deprecated_route: true,
    message: 'queue-batch is disabled for Phase 1. Use queue-plan dry runs; no send_queue rows were created.',
  }, 200)
}

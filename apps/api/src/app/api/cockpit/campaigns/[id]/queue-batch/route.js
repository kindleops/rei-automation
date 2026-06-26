import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

function sanitizeQueueBatchPayload(result = {}) {
  return {
    ok: result.ok !== false && !(result.blockers || []).length,
    success: result.success !== false && !(result.blockers || []).length,
    campaign_id: result.campaign_id,
    status: result.status,
    blockers: result.blockers || result.exact_blockers || [],
    exact_blockers: result.exact_blockers || result.blockers || [],
    queued_count: result.send_queue_rows_created ?? result.queue_rows_created ?? 0,
    send_queue_rows_created: result.send_queue_rows_created ?? 0,
    skipped_count: result.skipped_count ?? 0,
    proof_hydration: Boolean(result.live_gate?.proof_hydration),
    no_send: Boolean(result.no_send),
    launch_summary: result.launch_summary || null,
    hydration_result: result.hydration_result || null,
    sample_skips: (result.sample_skips || []).slice(0, 10),
  }
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

  try {
    const body = await parseJsonSafe(request)
    const supabase = defaultSupabase
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('id,status,auto_send_enabled,auto_queue_enabled,name,metadata')
      .eq('id', campaignId)
      .maybeSingle()

    if (campaignError) {
      return withCors(request, { ok: false, error: 'campaign_read_failed', message: campaignError.message }, 500)
    }
    if (!campaign) {
      return withCors(request, { ok: false, error: 'campaign_not_found' }, 404)
    }

    const status = normalizeCampaignStatus(campaign.status)
    if (['archived', 'completed', 'failed'].includes(status)) {
      return withCors(request, {
        ok: false,
        error: 'campaign_not_queueable',
        blockers: [`Campaign status "${status}" cannot queue a new batch.`],
        from: status,
      }, 423)
    }

    const metadata = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
    const productionLaunch = Boolean(metadata.production_launch || metadata.converted_to_live_at)
    const explicitLive = body?.confirm_live === true || body?.confirmLive === true
    // Active proof campaigns stay no-send unless production launch conversion already occurred.
    const forceProofBatch = ['active', 'activating', 'paused'].includes(status)
      && !campaign.auto_send_enabled
      && !productionLaunch
    const noSend = (forceProofBatch && !explicitLive) || body?.no_send === true || body?.noSend === true
    const confirmLive = productionLaunch || explicitLive || (!forceProofBatch && body?.confirm_live !== false && body?.confirmLive !== false)

    const result = await createCampaignQueuePlan(campaignId, {
      ...body,
      dry_run: false,
      no_send: noSend,
      hydrate_canonical_queue: noSend,
      confirm_live: confirmLive,
      create_send_queue_rows: true,
      explicit_operator_action: true,
    })

    const payload = sanitizeQueueBatchPayload({ ...result, campaign_id: campaignId })
    const hasBlockers = (payload.blockers || []).length > 0
    return withCors(request, payload, payload.ok && !hasBlockers ? 200 : 423)
  } catch (error) {
    console.error('campaigns.queue_batch_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_queue_batch_failed',
      message: error?.message || String(error),
      blockers: [error?.message || 'campaign_queue_batch_failed'],
    }, 500)
  }
}
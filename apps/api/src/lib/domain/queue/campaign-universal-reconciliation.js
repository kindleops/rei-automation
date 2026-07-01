import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { isCampaignFullyLive, isCampaignLiveInconsistent } from '@/lib/domain/campaigns/campaign-live-execution.js'
import { isProofQueueExecutionRow } from '@/lib/domain/campaigns/campaign-execution-mode.js'
import { recoverUnprocessedDeliveryWebhooks } from '@/lib/domain/delivery/delivery-webhook-recovery.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']

function clean(value) {
  return String(value ?? '').trim()
}

export async function reconcileCampaignExecutionHealth(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const limit = Math.max(Number(options.limit ?? 20), 1)
  const now = options.now || new Date().toISOString()
  const repairs = []
  const warnings = []

  const { data: campaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id,name,status,auto_queue_enabled,auto_send_enabled,auto_reply_mode,metadata,execution_heartbeat_at')
    .in('status', ['active', 'activating', 'scheduled', 'paused'])
    .order('execution_heartbeat_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (campaignError) throw campaignError

  for (const campaign of campaigns || []) {
    if (isCampaignFullyLive(campaign)) continue
    if (isCampaignLiveInconsistent(campaign)) {
      warnings.push({
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        reason: 'live_campaign_inconsistent_flags',
      })
    }
  }

  const { data: activeRows, error: queueError } = await supabase
    .from('send_queue')
    .select('id,campaign_id,queue_status,metadata,scheduled_for,sent_at,provider_message_id,textgrid_message_id,is_locked,locked_at')
    .in('queue_status', ACTIVE_QUEUE_STATUSES)
    .limit(2000)
  if (queueError) throw queueError

  let proofRowsOnLiveCampaigns = 0
  let missingScheduledFor = 0
  let expiredLeases = 0

  for (const row of activeRows || []) {
    if (!row.scheduled_for && ['scheduled', 'queued'].includes(clean(row.queue_status).toLowerCase())) {
      missingScheduledFor += 1
      warnings.push({ queue_row_id: row.id, reason: 'missing_scheduled_for' })
    }

    if (isProofQueueExecutionRow(row)) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('id,metadata,auto_send_enabled')
        .eq('id', row.campaign_id)
        .maybeSingle()
      if (campaign?.metadata?.production_launch === true && campaign.auto_send_enabled === true) {
        proofRowsOnLiveCampaigns += 1
        warnings.push({ queue_row_id: row.id, campaign_id: row.campaign_id, reason: 'proof_row_on_live_campaign' })
      }
    }

    if (clean(row.queue_status).toLowerCase() === 'processing' && row.is_locked) {
      const leaseAt = new Date(row.locked_at || 0).getTime()
      if (Number.isFinite(leaseAt) && Date.now() - leaseAt > 10 * 60 * 1000) {
        expiredLeases += 1
      }
    }
  }

  const deliveryRecovery = await recoverUnprocessedDeliveryWebhooks(
    { limit: Math.min(Number(options.delivery_recovery_limit ?? 50), 100) },
    deps
  )

  const processorHeartbeat = await getSystemValue('queue_processor_heartbeat_at', { supabase })
  const feederHeartbeat = await getSystemValue('campaign_feeder_heartbeat_at', { supabase })
  const reconcileHeartbeat = await getSystemValue('queue_reconcile_heartbeat_at', { supabase })

  await setSystemValues(
    {
      universal_reconcile_last_at: now,
      universal_reconcile_last_delivery_recovered: String(deliveryRecovery.recovered || 0),
    },
    { supabase }
  ).catch(() => {})

  return {
    ok: true,
    scanned_campaigns: (campaigns || []).length,
    scanned_active_queue_rows: (activeRows || []).length,
    proof_rows_on_live_campaigns: proofRowsOnLiveCampaigns,
    missing_scheduled_for: missingScheduledFor,
    expired_processing_leases: expiredLeases,
    delivery_recovery: deliveryRecovery,
    heartbeats: {
      processor: processorHeartbeat || null,
      feeder: feederHeartbeat || null,
      reconcile: reconcileHeartbeat || null,
    },
    repairs,
    warnings,
  }
}
/**
 * Truthful launch readiness — evaluates execution gates before live send.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import { renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import {
  asBoolean,
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from '@/lib/domain/queue/queue-control-safety.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

async function launchCandidateFromTarget(target, campaign) {
  const { launchCandidateFromTarget: resolve } = await import('@/lib/domain/campaigns/campaign-automation-service.js')
  return resolve(target, campaign)
}

function clean(value) {
  return String(value ?? '').trim()
}

function normalizeLanguage(code) {
  const raw = clean(code).toLowerCase()
  if (!raw || raw === 'auto') return 'en'
  if (raw.startsWith('es') || raw === 'spanish') return 'es'
  if (raw.startsWith('ru') || raw === 'russian') return 'ru'
  if (raw.startsWith('en') || raw === 'english') return 'en'
  return raw.slice(0, 5)
}

const BLOCKER_LABELS = {
  emergency_stop: 'Emergency stop is active',
  queue_processor_disabled: 'Global queue processor is disabled',
  global_auto_enqueue_disabled: 'Global campaign enqueue is disabled',
  campaign_auto_queue_disabled: 'Campaign auto-queue is disabled',
  transmission_disabled: 'Campaign transmission is disabled (test mode / auto-send off)',
  missing_daily_cap: 'Daily send cap is missing',
  missing_total_cap: 'Total send cap is missing',
  missing_batch_max: 'Batch maximum is missing',
  missing_market_cap: 'Market cap is missing',
  missing_per_sender_cap: 'Per-sender cap is missing',
  missing_send_window: 'Send window is not configured',
  routing_zero: 'No routable recipients (routing allowed = 0)',
  template_required: 'No approved template resolved for scenario/stage/language',
  language_template_gap: 'Targets missing language template assignment',
  no_ready_recipients: 'No ready recipients in target snapshot',
  missing_canonical_phone: 'Recipient missing canonical phone',
  suppression_blocked: 'Active suppression on ready recipients',
  routing_blocked: 'Sender route unavailable for ready recipients',
  identity_blocked: 'Identity confidence too low for activation',
  duplicate_queue_row: 'Duplicate active queue row exists',
  campaign_not_queueable: 'Campaign lifecycle does not allow activation',
  missing_launch_caps: 'Campaign missing required pacing caps',
  provider_disabled: 'Outbound SMS provider is disabled',
}

export async function evaluateCampaignLaunchReadiness(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const blockers = []
  const blockerCodes = []
  const warnings = []

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const status = normalizeCampaignStatus(campaign.status)

  const [
    emergencyStop,
    processorModeRaw,
    globalAutoEnqueue,
    outboundSms,
    readyCountRes,
    readyTargetsRes,
    languageTargetsRes,
    routableCountRes,
  ] = await Promise.all([
    getSystemValue('queue_emergency_stop_at', { supabase }),
    getSystemValue('queue_processor_mode', { supabase }),
    getSystemValue('queue_auto_enqueue_enabled', { supabase }),
    getSystemValue('outbound_sms_enabled', { supabase }),
    supabase.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('target_status', 'ready'),
    supabase.from('campaign_targets').select('*').eq('campaign_id', campaignId).eq('target_status', 'ready').order('priority_score', { ascending: false, nullsFirst: false }).limit(20),
    supabase.from('campaign_targets').select('language,template_status').eq('campaign_id', campaignId).limit(50000),
    supabase.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('target_status', 'ready').eq('routing_status', 'ready').eq('template_status', 'ready'),
  ])

  if (isEmergencyStopActive(emergencyStop)) {
    blockers.push(BLOCKER_LABELS.emergency_stop)
    blockerCodes.push('emergency_stop')
  }

  const processorMode = normalizeQueueProcessorMode(processorModeRaw, 'off')
  if (processorMode === 'off') {
    blockers.push(BLOCKER_LABELS.queue_processor_disabled)
    blockerCodes.push('queue_processor_disabled')
  }

  if (!asBoolean(globalAutoEnqueue, false)) {
    blockers.push(BLOCKER_LABELS.global_auto_enqueue_disabled)
    blockerCodes.push('global_auto_enqueue_disabled')
  }

  if (!campaign.auto_queue_enabled) {
    blockers.push(BLOCKER_LABELS.campaign_auto_queue_disabled)
    blockerCodes.push('campaign_auto_queue_disabled')
  }

  if (!campaign.auto_send_enabled) {
    blockers.push(BLOCKER_LABELS.transmission_disabled)
    blockerCodes.push('transmission_disabled')
  }

  if (!asBoolean(outboundSms, false)) {
    blockers.push(BLOCKER_LABELS.provider_disabled)
    blockerCodes.push('provider_disabled')
  }

  if (!campaign.daily_cap) {
    blockers.push(BLOCKER_LABELS.missing_daily_cap)
    blockerCodes.push('missing_daily_cap')
  }
  if (!campaign.total_cap) {
    warnings.push('Total send cap is not set')
  }
  if (!campaign.batch_max) {
    blockers.push(BLOCKER_LABELS.missing_batch_max)
    blockerCodes.push('missing_batch_max')
  }
  if (!campaign.market_cap) {
    blockers.push(BLOCKER_LABELS.missing_market_cap)
    blockerCodes.push('missing_market_cap')
  }
  if (!campaign.per_sender_cap) {
    blockers.push(BLOCKER_LABELS.missing_per_sender_cap)
    blockerCodes.push('missing_per_sender_cap')
  }
  if (!campaign.contact_window_start || !campaign.contact_window_end) {
    blockers.push(BLOCKER_LABELS.missing_send_window)
    blockerCodes.push('missing_send_window')
  }

  const ready = readyTargetsRes.data || []
  const readyTotal = Number(readyCountRes.count ?? ready.length)
  const routableTotal = Number(routableCountRes.count ?? 0)

  if (!readyTotal) {
    blockers.push(BLOCKER_LABELS.no_ready_recipients)
    blockerCodes.push('no_ready_recipients')
  }

  if (readyTotal > 0 && routableTotal === 0) {
    blockers.push(BLOCKER_LABELS.routing_zero)
    blockerCodes.push('routing_zero')
  }

  const langBuckets = new Map()
  for (const row of languageTargetsRes.data || []) {
    const lang = normalizeLanguage(row.language)
    if (!langBuckets.has(lang)) langBuckets.set(lang, { total: 0, unassigned: 0 })
    const b = langBuckets.get(lang)
    b.total += 1
    if (clean(row.template_status) !== 'ready') b.unassigned += 1
  }
  for (const [lang, bucket] of langBuckets) {
    if (bucket.unassigned > 0) {
      const label = lang === 'es' ? 'Spanish' : lang === 'ru' ? 'Russian' : lang === 'en' ? 'English' : lang
      blockers.push(`${bucket.unassigned} ${label} targets have no assigned template`)
      blockerCodes.push('language_template_gap')
    }
  }

  let templateResolved = 0
  let templateMissing = 0
  const sampleSize = Math.min(5, ready.length)

  for (let i = 0; i < sampleSize; i += 1) {
    const target = ready[i]
    const candidate = launchCandidateFromTarget(target, campaign)
    candidate.stage_code = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
    const rendered = await renderOutboundTemplate(candidate, {
      template_use_case: campaign.metadata?.template_use_case || campaign.objective || 'ownership_check',
      stage_code: normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1'),
      first_touch: true,
    }, deps)
    if (rendered.ok && (rendered.selected_template_id || rendered.template?.template_id)) {
      templateResolved += 1
    } else {
      templateMissing += 1
    }
  }

  if (readyTotal && templateMissing === sampleSize) {
    blockers.push(BLOCKER_LABELS.template_required)
    blockerCodes.push('template_required')
  } else if (templateMissing > 0) {
    warnings.push(`${templateMissing}/${sampleSize} sampled recipients missing template resolution`)
  }

  if (['archived', 'completed', 'failed'].includes(status)) {
    blockers.push(BLOCKER_LABELS.campaign_not_queueable)
    blockerCodes.push('campaign_not_queueable')
  }

  const uniqueBlockers = [...new Set(blockers)]
  const uniqueCodes = [...new Set(blockerCodes)]
  const level = uniqueBlockers.length ? 'blocked' : warnings.length ? 'warnings' : 'ready'

  return {
    ok: true,
    launch_readiness: level,
    blocker_count: uniqueBlockers.length,
    blocker_codes: uniqueCodes,
    blockers: uniqueBlockers,
    warnings,
    template_readiness: templateMissing === 0 && readyTotal ? 'resolved' : templateMissing === sampleSize ? 'missing' : 'partial',
    template_sample: { resolved: templateResolved, missing: templateMissing, sampled: sampleSize },
    ready_recipient_count: readyTotal,
    routable_recipient_count: routableTotal,
    remediation: uniqueBlockers,
  }
}
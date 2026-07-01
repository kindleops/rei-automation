/**
 * Single source of truth for Campaign Command — selected campaign + current run scope.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import {
  asBoolean,
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from '@/lib/domain/queue/queue-control-safety.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  deriveOperatorState,
  deriveReadinessLabel,
  operatorModeLabel,
  operatorStateLabel,
  primaryCommandForState,
} from '@/lib/domain/campaigns/campaign-operator-state.js'
import { evaluateCampaignLaunchReadiness } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { fetchCampaignTargetStatusCounts } from '@/lib/domain/campaigns/campaign-recipient-metrics.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const TERMINAL_QUEUE_FAILURE = ['failed', 'expired', 'cancelled', 'suppressed', 'blocked']
const SENDING_STATUSES = ['sending', 'processing']

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

function languageLabel(code) {
  const map = { en: 'English', es: 'Spanish', ru: 'Russian' }
  return map[code] || code.toUpperCase()
}

async function loadCurrentRun(supabase, campaignId) {
  const { data } = await supabase
    .from('campaign_runs')
    .select('id,run_type,status,dry_run,started_at,finished_at,metadata')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

async function aggregateQueueExecution(supabase, campaignId, runId = null, campaign = {}) {
  const { data: rows, error } = await supabase
    .from('send_queue')
    .select('id,queue_status,sms_eligible,routing_allowed,scheduled_for,metadata,failed_reason,updated_at,delivered_at,sent_at')
    .eq('campaign_id', campaignId)
    .limit(5000)
  if (error) throw error

  const scoped = (rows || []).filter((row) => {
    if (!runId) return true
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    return !rowRun || rowRun === runId
  })

  const counts = {
    hydrated_queue_rows: 0,
    proof_no_send_rows: 0,
    live_send_rows: 0,
    queued_rows: 0,
    scheduled_queue_rows: 0,
    due_queue_rows: 0,
    claimed_or_sending_rows: 0,
    sent_rows: 0,
    delivered_rows: 0,
    failed_execution_rows: 0,
    blocked_rows: 0,
    sms_eligible: 0,
    routing_allowed: 0,
  }

  const now = Date.now()
  let nextScheduledAt = null

  for (const row of scoped) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const noSend = asBoolean(meta.no_send ?? meta.proof_no_send, false)
    const proofHydration = clean(meta.launch_mode) === 'proof_hydration_no_send' || noSend
    const status = clean(row.queue_status).toLowerCase()
    const isLiveExecutable = !proofHydration && row.sms_eligible && row.routing_allowed

    const isCancelled = status === 'cancelled'
    if ((ACTIVE_QUEUE_STATUSES.includes(status) || TERMINAL_QUEUE_FAILURE.includes(status)) && !isCancelled) {
      counts.hydrated_queue_rows += 1
    }

    if (proofHydration && !isCancelled && ACTIVE_QUEUE_STATUSES.includes(status)) {
      counts.proof_no_send_rows += 1
    } else {
      counts.live_send_rows += 1
      if (row.sms_eligible) counts.sms_eligible += 1
      if (row.routing_allowed) counts.routing_allowed += 1
    }

    if (status === 'queued' && isLiveExecutable) counts.queued_rows += 1

    if (status === 'scheduled' && isLiveExecutable) {
      counts.scheduled_queue_rows += 1
      if (row.scheduled_for) {
        if (!nextScheduledAt || row.scheduled_for < nextScheduledAt) nextScheduledAt = row.scheduled_for
        const dueMs = new Date(row.scheduled_for).getTime()
        if (Number.isFinite(dueMs) && dueMs <= now) counts.due_queue_rows += 1
      }
    }

    if (SENDING_STATUSES.includes(status) && isLiveExecutable) counts.claimed_or_sending_rows += 1
    if (['sent', 'delivered'].includes(status) && !proofHydration) counts.sent_rows += 1
    if (status === 'delivered' && !proofHydration) counts.delivered_rows += 1
    if (status === 'failed' && !proofHydration) counts.failed_execution_rows += 1
    if (status === 'blocked') counts.blocked_rows += 1
  }

  const productionLaunch = asBoolean(campaign.metadata?.production_launch, false)
    || Boolean(clean(campaign.metadata?.converted_to_live_at))
  const transmissionEnabled =
    counts.live_send_rows > 0 &&
    counts.routing_allowed > 0 &&
    (asBoolean(campaign.auto_send_enabled, false) || productionLaunch)

  const proofMode =
    counts.proof_no_send_rows > 0 &&
    counts.live_send_rows === 0 &&
    !transmissionEnabled

  return {
    ...counts,
    transmission_enabled: transmissionEnabled,
    proof_mode: proofMode,
    no_messages_will_transmit: proofMode,
    next_scheduled_at: nextScheduledAt,
    campaign_state: null,
  }
}

async function aggregateTargetFunnel(supabase, campaignId) {
  const countMap = await fetchCampaignTargetStatusCounts([campaignId], { supabase })
  const bucket = countMap.get(campaignId) || { statuses: {}, blocked: {}, total: 0 }
  const s = bucket.statuses || {}

  const total_targets = bucket.total || 0
  const ready_targets = Number(s.ready || 0)
  const planned_targets = Number(s.planned || 0)
  const target_queued = Number(s.queued || 0)
  const target_sending = Number(s.sending || 0)
  const sent_rows = Number(s.sent || 0) + Number(s.delivered || 0)
  const delivered_rows = Number(s.delivered || 0)
  const replied_rows = Number(s.replied || 0) + Number(s.replied_positive || 0) + Number(s.replied_negative || 0)
  const positive = Number(s.replied_positive || 0)
  const negative = Number(s.replied_negative || 0)
  const opted_out_rows = Number(s.opt_out || 0)
  const failed_target_rows = Number(s.failed || 0)
  const blocked_rows = Number(s.blocked || 0)
  const suppressed = Number(s.suppressed || 0)
  const skipped = Number(s.skipped || 0)

  const terminal = sent_rows + failed_target_rows + opted_out_rows + suppressed + skipped
  const remaining = Math.max(0, total_targets - terminal - target_queued - planned_targets - target_sending)

  return {
    total_targets,
    ready_targets,
    planned_targets,
    target_queued,
    target_sending,
    sent_rows,
    delivered_rows,
    replied_rows,
    positive,
    negative,
    opted_out_rows,
    failed_target_rows,
    blocked_rows,
    suppressed,
    skipped,
    remaining,
    blocked_reason_counts: bucket.blocked || {},
    invariant_ok: total_targets >= ready_targets + planned_targets + target_queued + target_sending + terminal,
  }
}

async function aggregateLanguageCoverage(supabase, campaignId) {
  const { data, error } = await supabase
    .from('campaign_targets')
    .select('language,template_status,target_status')
    .eq('campaign_id', campaignId)
    .limit(50000)
  if (error) throw error

  const byLang = new Map()
  for (const row of data || []) {
    const lang = normalizeLanguage(row.language)
    if (!byLang.has(lang)) {
      byLang.set(lang, { language: lang, label: languageLabel(lang), targets: 0, assigned: 0, blocked: 0 })
    }
    const entry = byLang.get(lang)
    entry.targets += 1
    if (clean(row.template_status) === 'ready') entry.assigned += 1
    else if (clean(row.template_status) === 'blocked' || clean(row.template_status) === 'missing') entry.blocked += 1
  }

  return Array.from(byLang.values())
    .map((entry) => ({
      ...entry,
      coverage_pct: entry.targets > 0 ? Math.round((entry.assigned / entry.targets) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.targets - a.targets)
}

async function loadQueueProcessorState(supabase) {
  const keys = [
    'queue_processor_mode',
    'queue_auto_enqueue_enabled',
    'queue_auto_send_enabled',
    'queue_emergency_stop_at',
    'outbound_sms_enabled',
    'queue_processor_heartbeat_at',
    'queue_processor_last_claimed_at',
    'campaign_feeder_heartbeat_at',
    'campaign_feeder_last_batch_at',
    'recovery_worker_heartbeat_at',
    'auto_reply_mode',
  ]
  const settings = {}
  for (const key of keys) {
    settings[key] = await getSystemValue(key, { supabase })
  }
  const processorMode = normalizeQueueProcessorMode(settings.queue_processor_mode, 'off')
  return {
    processor_mode: processorMode,
    processor_enabled: processorMode !== 'off',
    processor_heartbeat_at: settings.queue_processor_heartbeat_at || null,
    processor_last_claimed_at: settings.queue_processor_last_claimed_at || null,
    feeder_heartbeat_at: settings.campaign_feeder_heartbeat_at || null,
    feeder_last_batch_at: settings.campaign_feeder_last_batch_at || null,
    recovery_worker_heartbeat_at: settings.recovery_worker_heartbeat_at || null,
    followup_scheduler_heartbeat_at: settings.recovery_worker_heartbeat_at || settings.queue_processor_heartbeat_at || null,
    auto_enqueue_enabled: asBoolean(settings.queue_auto_enqueue_enabled, false),
    auto_send_enabled: asBoolean(settings.queue_auto_send_enabled, false),
    emergency_stop_active: isEmergencyStopActive(settings.queue_emergency_stop_at),
    outbound_sms_enabled: asBoolean(settings.outbound_sms_enabled, false),
    auto_reply_mode: clean(settings.auto_reply_mode) || 'disabled',
  }
}

/**
 * Build canonical selected-campaign summary for all Campaign Command surfaces.
 */
export async function buildCampaignCommandSummary(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const currentRun = await loadCurrentRun(supabase, campaignId)
  const runId = currentRun?.id || null

  const productionLaunch = Boolean(clean(campaign.metadata?.converted_to_live_at) || campaign.metadata?.production_launch)
  const [targets, queueExec, languageCoverage, readiness, processorState] = await Promise.all([
    aggregateTargetFunnel(supabase, campaignId),
    aggregateQueueExecution(supabase, campaignId, runId, campaign),
    aggregateLanguageCoverage(supabase, campaignId),
    evaluateCampaignLaunchReadiness(campaignId, deps, {
      guarded_live_launch: productionLaunch,
      explicit_operator_action: productionLaunch,
      scheduled_activation: productionLaunch,
    }),
    loadQueueProcessorState(supabase),
  ])

  queueExec.campaign_state = normalizeCampaignStatus(campaign.status)
  queueExec.transmission_enabled =
    asBoolean(campaign.auto_send_enabled, false) &&
    productionLaunch &&
    queueExec.live_send_rows > 0 &&
    queueExec.routing_allowed > 0

  const operatorState = deriveOperatorState(campaign, queueExec, readiness)
  const mode = operatorModeLabel(queueExec)
  const readinessLabel = deriveReadinessLabel(campaign, queueExec, readiness, operatorState)
  const primary = primaryCommandForState(operatorState, { liveReady: readiness.launch_readiness === 'ready' && queueExec.transmission_enabled })

  const counts = {
    total_targets: targets.total_targets,
    ready_targets: targets.ready_targets,
    planned_targets: targets.planned_targets,
    hydrated_queue_rows: queueExec.hydrated_queue_rows,
    proof_no_send_rows: queueExec.proof_no_send_rows,
    live_send_rows: queueExec.live_send_rows,
    queued_rows: queueExec.queued_rows,
    scheduled_queue_rows: queueExec.scheduled_queue_rows,
    due_queue_rows: queueExec.due_queue_rows,
    claimed_or_sending_rows: queueExec.claimed_or_sending_rows,
    sent_rows: Math.max(targets.sent_rows, queueExec.sent_rows),
    delivered_rows: Math.max(targets.delivered_rows, queueExec.delivered_rows),
    replied_rows: targets.replied_rows,
    failed_target_rows: targets.failed_target_rows,
    failed_execution_rows: queueExec.failed_execution_rows,
    blocked_rows: targets.blocked_rows + queueExec.blocked_rows,
    opted_out_rows: targets.opted_out_rows,
    remaining_targets: targets.remaining,
    routable_recipients: queueExec.routing_allowed,
  }

  return {
    ok: true,
    campaign_id: campaignId,
    run_id: runId,
    run: currentRun
      ? {
          id: currentRun.id,
          run_type: currentRun.run_type,
          status: currentRun.status,
          dry_run: currentRun.dry_run,
          started_at: currentRun.started_at,
          label: currentRun.dry_run ? 'Test Run' : 'Current Run',
        }
      : null,
    previous_state: null,
    state: operatorState,
    state_label: operatorStateLabel(operatorState),
    persisted_status: normalizeCampaignStatus(campaign.status),
    mode,
    mode_label: mode === 'live' ? 'Live' : 'Test Mode',
    readiness_label: readinessLabel,
    message: null,
    counts,
    blockers: readiness.blockers || [],
    warnings: readiness.warnings || [],
    readiness: {
      level: readiness.launch_readiness || 'unknown',
      label: readinessLabel,
      blockers: readiness.blockers || [],
      warnings: readiness.warnings || [],
      blocker_codes: readiness.blocker_codes || [],
    },
    execution: {
      ...queueExec,
      transmission_label: queueExec.transmission_enabled ? 'Sending Enabled' : 'Sending Disabled',
    },
    language_coverage: languageCoverage,
    processor: processorState,
    primary_command: primary,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      market: campaign.market,
      objective: campaign.objective,
      stage_code: campaign.metadata?.stage_code || 'S1',
      send_interval_seconds: campaign.send_interval_seconds,
      contact_window_start: campaign.contact_window_start,
      contact_window_end: campaign.contact_window_end,
      auto_queue_enabled: campaign.auto_queue_enabled,
      auto_send_enabled: campaign.auto_send_enabled,
      auto_reply_mode: campaign.auto_reply_mode,
      execution_heartbeat_at: campaign.execution_heartbeat_at || null,
      next_scheduled_at: queueExec.next_scheduled_at || campaign.scheduled_for || null,
    },
    automation: {
      feeder_heartbeat_at: processorState.feeder_heartbeat_at,
      feeder_last_batch_at: processorState.feeder_last_batch_at,
      processor_heartbeat_at: processorState.processor_heartbeat_at,
      processor_last_claimed_at: processorState.processor_last_claimed_at,
      followup_scheduler_heartbeat_at: processorState.followup_scheduler_heartbeat_at,
      recovery_worker_heartbeat_at: processorState.recovery_worker_heartbeat_at,
    },
  }
}
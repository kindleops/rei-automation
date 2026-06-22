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
  operatorModeLabel,
  operatorStateLabel,
  primaryCommandForState,
} from '@/lib/domain/campaigns/campaign-operator-state.js'
import { evaluateCampaignLaunchReadiness } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { fetchCampaignTargetStatusCounts } from '@/lib/domain/campaigns/campaign-recipient-metrics.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const TERMINAL_QUEUE_FAILURE = ['failed', 'expired', 'cancelled', 'suppressed', 'blocked']
const TERMINAL_TARGET = ['sent', 'delivered', 'replied', 'replied_positive', 'replied_negative', 'opt_out', 'failed', 'skipped', 'suppressed']

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

async function aggregateQueueExecution(supabase, campaignId, runId = null) {
  let query = supabase
    .from('send_queue')
    .select('id,queue_status,sms_eligible,routing_allowed,scheduled_for,metadata,failed_reason,failure_category,updated_at')
    .eq('campaign_id', campaignId)

  const { data: rows, error } = await query.limit(5000)
  if (error) throw error

  const scoped = (rows || []).filter((row) => {
    if (!runId) return true
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    return !rowRun || rowRun === runId
  })

  const counts = {
    hydrated_rows: 0,
    live_send_rows: 0,
    test_mode_rows: 0,
    sms_eligible: 0,
    routing_allowed: 0,
    ready: 0,
    scheduled: 0,
    queued: 0,
    sending: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    overdue: 0,
  }

  const now = Date.now()
  let nextScheduledAt = null
  let transmissionEnabled = false

  for (const row of scoped) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const noSend = asBoolean(meta.no_send ?? meta.proof_no_send, false)
    const proofHydration = clean(meta.launch_mode) === 'proof_hydration_no_send' || noSend
    const status = clean(row.queue_status).toLowerCase()

    if (ACTIVE_QUEUE_STATUSES.includes(status) || TERMINAL_QUEUE_FAILURE.includes(status)) {
      counts.hydrated_rows += 1
    }

    if (proofHydration) {
      counts.test_mode_rows += 1
    } else {
      counts.live_send_rows += 1
      if (row.sms_eligible) counts.sms_eligible += 1
      if (row.routing_allowed) counts.routing_allowed += 1
    }

    if (status === 'ready') counts.ready += 1
    if (status === 'scheduled') {
      if (!proofHydration && row.routing_allowed && row.sms_eligible) {
        counts.scheduled += 1
        if (row.scheduled_for) {
          if (!nextScheduledAt || row.scheduled_for < nextScheduledAt) nextScheduledAt = row.scheduled_for
          const dueMs = new Date(row.scheduled_for).getTime()
          if (Number.isFinite(dueMs) && dueMs < now) counts.overdue += 1
        }
      } else if (proofHydration) {
        // test rows never count as live scheduled sends
      }
    }
    if (status === 'queued') counts.queued += 1
    if (status === 'sending' || status === 'processing') counts.sending += 1
    if (['sent', 'delivered'].includes(status)) counts.sent += 1
    if (status === 'delivered') counts.delivered += 1
    if (status === 'failed') counts.failed += 1
    if (status === 'blocked') counts.blocked += 1
  }

  transmissionEnabled = counts.live_send_rows > 0 && counts.routing_allowed > 0

  const proofMode = counts.test_mode_rows > 0 && counts.live_send_rows === 0

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

  const frozen = bucket.total || 0
  const ready = Number(s.ready || 0)
  const scheduled = Number(s.planned || 0)
  const queued = Number(s.queued || 0)
  const sending = Number(s.sending || 0)
  const sent = Number(s.sent || 0) + Number(s.delivered || 0)
  const delivered = Number(s.delivered || 0)
  const replied = Number(s.replied || 0) + Number(s.replied_positive || 0) + Number(s.replied_negative || 0)
  const positive = Number(s.replied_positive || 0)
  const negative = Number(s.replied_negative || 0)
  const optedOut = Number(s.opt_out || 0)
  const failed = Number(s.failed || 0)
  const blocked = Number(s.blocked || 0)
  const suppressed = Number(s.suppressed || 0)
  const skipped = Number(s.skipped || 0)

  const terminal = sent + failed + optedOut + suppressed + skipped
  const remaining = Math.max(0, frozen - terminal - queued - scheduled - sending)

  return {
    frozen_targets: frozen,
    eligible: ready + scheduled + queued,
    ready,
    scheduled,
    queued,
    sending,
    sent,
    delivered,
    replied,
    positive,
    negative,
    opted_out: optedOut,
    blocked,
    suppressed,
    failed,
    skipped,
    remaining,
    blocked_reason_counts: bucket.blocked || {},
    invariant_ok: frozen >= ready + scheduled + queued + sending + terminal,
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
  ]
  const settings = {}
  for (const key of keys) {
    settings[key] = await getSystemValue(key, { supabase })
  }
  const processorMode = normalizeQueueProcessorMode(settings.queue_processor_mode, 'off')
  return {
    processor_mode: processorMode,
    processor_enabled: processorMode !== 'off',
    auto_enqueue_enabled: asBoolean(settings.queue_auto_enqueue_enabled, false),
    auto_send_enabled: asBoolean(settings.queue_auto_send_enabled, false),
    emergency_stop_active: isEmergencyStopActive(settings.queue_emergency_stop_at),
    outbound_sms_enabled: asBoolean(settings.outbound_sms_enabled, false),
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

  const [funnel, queueExec, languageCoverage, readiness, processorState] = await Promise.all([
    aggregateTargetFunnel(supabase, campaignId),
    aggregateQueueExecution(supabase, campaignId, runId),
    aggregateLanguageCoverage(supabase, campaignId),
    evaluateCampaignLaunchReadiness(campaignId, { supabase, ...deps }),
    loadQueueProcessorState(supabase),
  ])

  queueExec.campaign_state = normalizeCampaignStatus(campaign.status)

  const operatorState = deriveOperatorState(campaign, queueExec, readiness)
  const mode = operatorModeLabel(queueExec)
  const primary = primaryCommandForState(operatorState)

  const counts = {
    ...funnel,
    queue_rows_created: queueExec.hydrated_rows,
    live_send_rows: queueExec.live_send_rows,
    test_mode_rows: queueExec.test_mode_rows,
    routable_recipients: queueExec.routing_allowed,
    live_scheduled: queueExec.scheduled,
    live_queued: queueExec.queued,
    live_sending: queueExec.sending,
    queue_failed: queueExec.failed,
    overdue_scheduled: queueExec.overdue,
  }

  // Reconcile failed count: prefer queue failures when sent > 0, else target failures
  const failedCount = queueExec.failed > 0 ? queueExec.failed : funnel.failed

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
    message: null,
    counts: {
      ...counts,
      failed: failedCount,
    },
    blockers: readiness.blockers || [],
    warnings: readiness.warnings || [],
    readiness: {
      level: readiness.launch_readiness || 'unknown',
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
      next_scheduled_at: queueExec.next_scheduled_at || campaign.scheduled_for || null,
    },
  }
}
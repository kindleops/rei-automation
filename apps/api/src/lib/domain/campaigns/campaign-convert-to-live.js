/**
 * Convert a test-mode campaign to a guarded live launch.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { runCanonicalCampaignActivation } from '@/lib/domain/campaigns/campaign-activation-orchestrator.js'
import { transitionCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

import { syncCampaignMetrics, isProofQueueRow } from '@/lib/domain/campaigns/campaign-sync-metrics.js'
import { buildCampaignCommandSummary } from '@/lib/domain/campaigns/campaign-command-summary.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { asBoolean } from '@/lib/domain/queue/queue-control-safety.js'

const PROOF_CANCEL_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const MARKET_TIMEZONES = {
  'miami, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'los angeles, ca': 'America/Los_Angeles',
  'minneapolis, mn': 'America/Chicago',
  'charlotte, nc': 'America/New_York',
  'atlanta, ga': 'America/New_York',
}

function clean(value) {
  return String(value ?? '').trim()
}

function parseTimeMinutes(value, fallback = 8 * 60) {
  const raw = clean(value)
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  return Number(match[1]) * 60 + Number(match[2])
}

function resolveCampaignTimezone(campaign = {}) {
  const market = clean(campaign.market || campaign.metadata?.market).toLowerCase()
  if (MARKET_TIMEZONES[market]) return MARKET_TIMEZONES[market]
  const metaTz = clean(campaign.metadata?.timezone || campaign.metadata?.recipient_timezone)
  if (metaTz) return metaTz
  return 'America/New_York'
}

function getLocalParts(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second || 0),
    }
  } catch {
    return null
  }
}

function timezoneOffsetMs(date, timezone) {
  const parts = getLocalParts(date, timezone)
  if (!parts) return 0
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return localAsUtc - date.getTime()
}

function localPartsToUtc(parts, timezone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  for (let i = 0; i < 3; i += 1) {
    const offset = timezoneOffsetMs(new Date(guess), timezone)
    const next = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0) - offset
    if (Math.abs(next - guess) < 1000) return next
    guess = next
  }
  return guess
}

export function computeNextValidSendInstant(campaign = {}, now = new Date()) {
  const timezone = resolveCampaignTimezone(campaign)
  const startMinutes = parseTimeMinutes(campaign.contact_window_start, 8 * 60)
  const endMinutes = parseTimeMinutes(campaign.contact_window_end, 21 * 60)
  const localNow = getLocalParts(now, timezone) || getLocalParts(now, 'America/New_York')
  const currentMinutes = localNow.hour * 60 + localNow.minute

  let dayOffset = 0
  if (currentMinutes >= endMinutes) dayOffset = 1

  const buildStart = (offset) => localPartsToUtc({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + offset,
    hour: Math.floor(startMinutes / 60),
    minute: startMinutes % 60,
    second: 0,
  }, timezone)

  let startUtc = buildStart(dayOffset)
  const endUtc = localPartsToUtc({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + dayOffset,
    hour: Math.floor(endMinutes / 60),
    minute: endMinutes % 60,
    second: 0,
  }, timezone)

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    startUtc = Math.max(now.getTime() + 5 * 60 * 1000, now.getTime())
  } else if (startUtc < now.getTime()) {
    dayOffset += 1
    startUtc = buildStart(dayOffset)
  }

  if (startUtc >= endUtc) {
    dayOffset += 1
    startUtc = buildStart(dayOffset)
  }

  return {
    scheduled_for: new Date(startUtc).toISOString(),
    timezone,
    window_start: campaign.contact_window_start || '08:00',
    window_end: campaign.contact_window_end || '21:00',
  }
}

async function cancelProofQueueRows(supabase, campaignId) {
  let cancelled = 0
  const filters = [
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>no_send', 'eq', 'true'),
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>proof_no_send', 'eq', 'true'),
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>launch_mode', 'eq', 'proof_hydration_no_send'),
  ]
  for (const run of filters) {
    const { data, error } = await run().select('id')
    if (error) throw error
    cancelled += data?.length || 0
  }
  return { cancelled, proof_rows: cancelled, deleted: 0 }
}

export async function convertTestCampaignToLive(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const beforeSummary = await buildCampaignCommandSummary(campaignId, deps)
  const proofRows = Number(beforeSummary.counts?.proof_no_send_rows || 0)
  const liveRows = Number(beforeSummary.counts?.live_send_rows || 0)
  const inTestMode = beforeSummary.state === 'test_mode' || proofRows > 0 || beforeSummary.mode === 'test'

  if (!inTestMode && liveRows > 0) {
    return { ok: false, error: 'already_live', message: 'Campaign is already on the live send path.' }
  }

  if (!asBoolean(input.confirm_live ?? input.confirmLive, true)) {
    return { ok: false, error: 'confirm_live_required', message: 'Operator must confirm live conversion.' }
  }

  const purged = await cancelProofQueueRows(supabase, campaignId)

  const { data: staleActive, error: staleError } = await supabase
    .from('send_queue')
    .update({
      queue_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('campaign_id', campaignId)
    .in('queue_status', PROOF_CANCEL_STATUSES)
    .select('id')
  if (staleError) throw staleError
  const staleCancelled = staleActive?.length || 0

  await syncCampaignMetrics(campaignId, deps)

  if (asBoolean(input.enable_processor ?? input.enableProcessor, true)) {
    await setSystemValues({
      queue_emergency_stop_at: '',
      queue_processor_mode: 'on',
      queue_auto_enqueue_enabled: 'true',
      outbound_sms_enabled: 'true',
      auto_reply_mode: 'live_limited',
    }, { supabase })
  }

  const schedule = computeNextValidSendInstant(campaign)
  const batchMax = Number(input.batch_max ?? input.limit ?? campaign.daily_cap ?? campaign.batch_max ?? 5)
  const status = normalizeCampaignStatus(campaign.status)

  if (status === 'paused') {
    const resumed = await transitionCampaignStatus(supabase, campaignId, 'active', {
      reason: clean(input.reason) || 'operator:convert_to_live',
    })
    if (!resumed.ok) return { ok: false, error: resumed.error || 'resume_failed', from: status }
  }

  await supabase.from('campaigns').update({
    auto_queue_enabled: true,
    scheduled_for: schedule.scheduled_for,
    metadata: {
      ...(campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}),
      converted_to_live_at: new Date().toISOString(),
      production_launch: true,
      test_mode_cleared: true,
      launch_timezone: schedule.timezone,
      launch_window: { start: schedule.window_start, end: schedule.window_end },
    },
  }).eq('id', campaignId)

  const activation = await runCanonicalCampaignActivation(campaignId, {
    ...input,
    action: 'activate',
    no_send: false,
    confirm_live: true,
    explicit_operator_action: true,
    scheduled_activation: true,
    scheduled_for: schedule.scheduled_for,
    first_scheduled_at: schedule.scheduled_for,
    batch_max: batchMax,
    limit: batchMax,
    activation_idempotency_key: clean(input.activation_idempotency_key) || `convert-live:${Date.now()}`,
    reason: clean(input.reason) || 'operator:convert_to_live',
    lock_owner: 'convert_to_live',
  }, deps)

  if (!activation.ok) {
    return {
      ok: false,
      error: activation.error || 'activation_failed',
      blockers: activation.blockers || [],
      purged: { ...purged, stale_cancelled: staleCancelled },
      schedule,
      from: status,
      to: normalizeCampaignStatus(campaign.status),
    }
  }

  await syncCampaignMetrics(campaignId, deps)
  const afterSummary = await buildCampaignCommandSummary(campaignId, deps)

  const processorMode = await getSystemValue('queue_processor_mode', { supabase })
  await supabase.from('campaign_events').insert({
    campaign_id: campaignId,
    event_type: 'campaign.converted_to_live',
    severity: 'success',
    title: 'Converted to Live Campaign',
    description: `Test rows purged (${purged.cancelled}). Live queue hydrated. Scheduled for ${schedule.scheduled_for}.`,
    metadata: {
      purged_proof_rows: purged.cancelled,
      scheduled_for: schedule.scheduled_for,
      timezone: schedule.timezone,
      inserted: activation.inserted ?? 0,
      processor_mode: processorMode,
      counts: afterSummary.counts,
    },
  })

  const { data: refreshed } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()

  return {
    ok: true,
    campaign_id: campaignId,
    action: 'convert_to_live',
    from: status,
    to: refreshed?.status || 'active',
    state: afterSummary.state,
    state_label: afterSummary.state_label,
    mode: afterSummary.mode,
    purged: { ...purged, stale_cancelled: staleCancelled },
    schedule,
    activation,
    counts: afterSummary.counts,
    blockers: afterSummary.blockers || [],
    warnings: afterSummary.warnings || [],
    campaign: refreshed,
    proof_mode_cleared: afterSummary.execution?.proof_mode !== true,
  }
}
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { runSupabaseCandidateFeeder } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { getSystemValue } from '@/lib/system-control.js'
import { supabase } from '@/lib/supabase/client.js'
import {
  asBoolean,
  blockedSafetyResult,
  clean,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from '@/lib/domain/queue/queue-control-safety.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function asNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function loadSafetySettings(configuredMode) {
  return {
    queue_processor_mode: configuredMode,
    campaign_mode: await getSystemValue('campaign_mode'),
    queue_hard_cap: await getSystemValue('queue_hard_cap'),
    queue_max_batch_size: await getSystemValue('queue_max_batch_size'),
    queue_daily_send_cap: await getSystemValue('queue_daily_send_cap'),
    queue_market_cap: await getSystemValue('queue_market_cap'),
    queue_per_number_cap: await getSystemValue('queue_per_number_cap'),
    queue_market_throttle: await getSystemValue('queue_market_throttle'),
    queue_sender_throttle: await getSystemValue('queue_sender_throttle'),
    queue_scan_limit: await getSystemValue('queue_scan_limit'),
    queue_market_filter: await getSystemValue('queue_market_filter'),
    queue_state_filter: await getSystemValue('queue_state_filter'),
    queue_all_market_ack: await getSystemValue('queue_all_market_ack'),
  }
}

function blockSummary(result = {}) {
  return {
    suppression: Number(result.suppression_block_count || result.suppressed_count || 0),
    routing: Number(result.routing_block_count || result.routing_blocked_count || 0),
    duplicates: Number(result.duplicate_queue_block_count || result.duplicate_blocked_count || 0),
    no_template: Number(result.template_block_count || result.template_blocked_count || 0),
    contact_window: Number(result.contact_window_block_count || 0),
    pending_prior_touch: Number(result.pending_prior_touch_block_count || 0),
    prior_touch_cooldown: Number(result.prior_touch_cooldown_block_count || 0),
    active_queue_row: Number(result.active_queue_block_count || result.active_queue_blocked_count || 0),
    identity_held: Number(result.identity_held_count || result.identity_hold_count || 0),
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => ({}))
  const configuredMode = clean(await getSystemValue('queue_processor_mode') || 'paused').toLowerCase()
  const safetySettings = await loadSafetySettings(configuredMode)
  const safety = normalizeSafetyInput(body, safetySettings)
  const dryRun = asBoolean(body.dry_run, safety.campaign_mode !== 'live_limited')
  const target_count = Math.max(1, Math.min(1000, asNumber(body.target_count, body.limit || 25)))
  const scan_limit = Math.max(25, Math.min(5000, asNumber(body.scan_limit || safety.scan_limit, 1000)))
  const per_pass_limit = Math.max(1, Math.min(250, asNumber(body.limit, Math.min(100, target_count))))
  const respect_contact_window = asBoolean(body.respect_contact_window, true)
  const candidate_source = clean(body.candidate_source || 'v_sms_ready_contacts_expanded')

  if (dryRun) {
    const result = await runSupabaseCandidateFeeder({
      candidate_source,
      limit: Math.min(per_pass_limit, target_count),
      scan_limit,
      candidate_offset: Math.max(0, Number(body.candidate_offset || 0) || 0),
      market: safety.market,
      state: safety.state,
      within_contact_window_now: respect_contact_window,
      routing_safe_only: true,
      dry_run: true,
      campaign_session_id: clean(body.campaign_session_id) || `queue-more-preview-${Date.now()}`,
      debug_templates: body.debug_templates !== false,
      allow_multiple_per_owner: false,
      allow_internal_test_phones: false,
    })
    return NextResponse.json({
      ok: result?.ok !== false,
      action: 'queue-more-preview',
      dry_run: true,
      inserted_count: 0,
      live_rows_inserted: 0,
      candidates_scanned: Number(result?.scanned_count || 0),
      eligible_found: Number(result?.eligible_count || 0),
      rows_created: 0,
      rows_scheduled: 0,
      rows_blocked: Number(result?.skipped_count || 0),
      block_reasons: blockSummary(result),
      preview: result,
    }, { status: result?.ok === false ? Number(result?.status || 500) : 200 })
  }

  const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true })
  if (!validation.ok) {
    return NextResponse.json(blockedSafetyResult(validation, 'queue-more'), { status: validation.status })
  }

  const cappedTarget = Math.min(target_count, validation.effective_limit)
  let offset = 0
  let queued_total = 0
  let scheduled_total = 0
  let scanned_total = 0
  let eligible_total = 0
  let skipped_total = 0
  let suppression_blocks = 0
  let routing_blocks = 0
  let duplicate_blocks = 0
  let no_template_blocks = 0
  let contact_window_blocks = 0
  let pending_prior_touch_blocks = 0
  let prior_touch_cooldown_blocks = 0
  let active_queue_blocks = 0
  let identity_held_blocks = 0
  let passes = 0

  while ((queued_total + scheduled_total) < cappedTarget && passes < 20) {
    passes += 1
    const result = await runSupabaseCandidateFeeder({
      candidate_source,
      limit: Math.min(per_pass_limit, cappedTarget - (queued_total + scheduled_total)),
      scan_limit,
      candidate_offset: offset,
      market: safety.market,
      state: safety.state,
      within_contact_window_now: respect_contact_window,
      routing_safe_only: true,
      dry_run: false,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      campaign_session_id: clean(body.campaign_session_id) || `queue-more-live-limited-${Date.now()}`,
      allow_multiple_per_owner: false,
      allow_internal_test_phones: false,
    })

    queued_total += Number(result?.queued_count || 0)
    scheduled_total += Number(result?.scheduled_count || 0)
    scanned_total += Number(result?.scanned_count || 0)
    eligible_total += Number(result?.eligible_count || 0)
    skipped_total += Number(result?.skipped_count || 0)
    suppression_blocks += Number(result?.suppression_block_count || 0)
    routing_blocks += Number(result?.routing_block_count || 0)
    duplicate_blocks += Number(result?.duplicate_queue_block_count || 0)
    duplicate_blocks += Number(result?.batch_duplicate_block_count || 0)
    no_template_blocks += Number(result?.template_block_count || 0)
    contact_window_blocks += Number(result?.contact_window_block_count || 0)
    pending_prior_touch_blocks += Number(result?.pending_prior_touch_block_count || 0)
    prior_touch_cooldown_blocks += Number(result?.prior_touch_cooldown_block_count || 0)
    active_queue_blocks += Number(result?.active_queue_block_count || 0)
    identity_held_blocks += Number(result?.identity_held_count || result?.identity_hold_count || 0)

    if ((result?.scanned_count || 0) < 1) break
    offset += scan_limit
  }

  const { count: queue_count_after } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .in('queue_status', ['queued', 'scheduled', 'pending', 'ready'])

  return NextResponse.json({
    ok: true,
    action: 'queue-more',
    dry_run: false,
    candidates_scanned: scanned_total,
    eligible_found: eligible_total,
    rows_created: queued_total,
    rows_scheduled: scheduled_total,
    rows_blocked: skipped_total,
    prior_touch_cooldown_blocks,
    active_queue_blocks,
    suppression_blocks,
    duplicate_blocks,
    block_reasons: {
      suppression: suppression_blocks,
      routing: routing_blocks,
      duplicates: duplicate_blocks,
      no_template: no_template_blocks,
      contact_window: contact_window_blocks,
      pending_prior_touch: pending_prior_touch_blocks,
      prior_touch_cooldown: prior_touch_cooldown_blocks,
      active_queue_row: active_queue_blocks,
      identity_held: identity_held_blocks,
    },
    queue_count_after: queue_count_after || 0,
  }, { status: 200 })
}

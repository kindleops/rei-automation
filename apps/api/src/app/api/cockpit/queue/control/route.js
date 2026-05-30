import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { supabase } from '@/lib/supabase/client.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import {
  asBoolean,
  asPositiveInteger,
  blockedSafetyResult,
  clean,
  normalizeCampaignMode,
  normalizeQueueProcessorMode,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from '@/lib/domain/queue/queue-control-safety.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONTROL_KEYS = [
  'queue_processor_mode',
  'auto_reply_mode',
  'campaign_mode',
  'candidate_source',
  'queue_daily_send_cap',
  'queue_hard_cap',
  'queue_max_batch_size',
  'queue_run_limit',
  'queue_scan_limit',
  'queue_spacing_seconds',
  'queue_contact_window_start',
  'queue_contact_window_end',
  'queue_auto_pause_failure_rate',
  'queue_auto_pause_optout_rate',
  'queue_market_throttle',
  'queue_sender_throttle',
  'queue_market_cap',
  'queue_per_number_cap',
  'queue_market_filter',
  'queue_state_filter',
  'queue_all_market_ack',
  'queue_auto_enqueue_enabled',
  'queue_auto_send_enabled',
  'queue_last_run_status',
  'queue_last_run_at',
  'queue_last_run_diagnostics',
  'queue_emergency_stop_at',
]

const DEFAULTS = {
  queue_processor_mode: 'paused',
  auto_reply_mode: 'disabled',
  campaign_mode: 'paused',
  candidate_source: 'v_sms_ready_contacts_expanded',
  queue_daily_send_cap: '500',
  queue_hard_cap: '',
  queue_max_batch_size: '',
  queue_run_limit: '50',
  queue_scan_limit: '1000',
  queue_spacing_seconds: '45',
  queue_contact_window_start: '08:00',
  queue_contact_window_end: '21:00',
  queue_auto_pause_failure_rate: '12',
  queue_auto_pause_optout_rate: '5',
  queue_market_throttle: '250',
  queue_sender_throttle: '150',
  queue_market_cap: '',
  queue_per_number_cap: '',
  queue_market_filter: '',
  queue_state_filter: '',
  queue_all_market_ack: 'false',
  queue_auto_enqueue_enabled: 'true',
  queue_auto_send_enabled: 'false',
  queue_last_run_status: 'idle',
  queue_last_run_at: '',
  queue_last_run_diagnostics: '',
  queue_emergency_stop_at: '',
}

function parseBody(body = {}) {
  const patch = {}
  for (const key of CONTROL_KEYS) {
    if (body[key] === undefined) continue
    patch[key] = clean(body[key])
  }
  if (patch.queue_processor_mode) {
    patch.queue_processor_mode = normalizeQueueProcessorMode(patch.queue_processor_mode)
  }
  if (patch.campaign_mode) {
    const mode = normalizeCampaignMode(patch.campaign_mode)
    patch.campaign_mode = mode === 'live' ? 'live_limited' : mode
  }
  if (patch.auto_reply_mode) {
    patch.auto_reply_mode = clean(patch.auto_reply_mode).toLowerCase()
  }
  return patch
}

async function loadSettings() {
  const values = {}
  for (const key of CONTROL_KEYS) {
    const value = await getSystemValue(key)
    values[key] = value ?? DEFAULTS[key] ?? null
  }
  return values
}

function todayStartIso() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}

async function countRows(label, buildQuery, errors) {
  try {
    const query = buildQuery()
    const { count, error } = await query
    if (error) throw error
    return Number(count || 0)
  } catch (error) {
    errors.push({ label, message: error?.message || String(error) })
    return 0
  }
}

function parseDiagnostics(value) {
  const raw = clean(value)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function loadCampaignDiagnostics(values) {
  const since = todayStartIso()
  const errors = []
  const queueDepth = await countRows('queue_depth', () => supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .in('queue_status', ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing']), errors)
  const queuedToday = await countRows('queued_today', () => supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .in('queue_status', ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing']), errors)
  const sentToday = await countRows('sent_today', () => supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', since), errors)
  const deliveredToday = await countRows('delivered_today', () => supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .gte('delivered_at', since), errors)
  const failedToday = await countRows('failed_today', () => supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .gte('updated_at', since)
    .eq('queue_status', 'failed'), errors)
  const optOutsToday = await countRows('opt_outs_today', () => supabase
    .from('message_events')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('is_opt_out', true), errors)
  const positiveRepliesToday = await countRows('positive_replies_today', () => supabase
    .from('message_events')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('direction', 'inbound')
    .in('detected_intent', ['positive', 'interested', 'seller_positive', 'asks_offer', 'offer_requested', 'appointment_ready']), errors)

  const lastRun = {
    status: clean(values.queue_last_run_status) || 'idle',
    at: clean(values.queue_last_run_at) || null,
    diagnostics: parseDiagnostics(values.queue_last_run_diagnostics),
  }

  return {
    queue_processor_mode: values.queue_processor_mode,
    auto_reply_mode: values.auto_reply_mode,
    campaign_mode: normalizeCampaignMode(values.campaign_mode || values.queue_processor_mode),
    candidate_source: values.candidate_source,
    daily_cap: asPositiveInteger(values.queue_daily_send_cap, null),
    hard_cap: asPositiveInteger(values.queue_hard_cap, null),
    max_batch_size: asPositiveInteger(values.queue_max_batch_size, null),
    market_cap: asPositiveInteger(values.queue_market_cap || values.queue_market_throttle, null),
    per_number_cap: asPositiveInteger(values.queue_per_number_cap || values.queue_sender_throttle, null),
    scan_limit: asPositiveInteger(values.queue_scan_limit, null),
    market: clean(values.queue_market_filter) || null,
    state: clean(values.queue_state_filter) || null,
    all_market_ack: asBoolean(values.queue_all_market_ack, false),
    stats: {
      queue_depth: queueDepth,
      queued_today: queuedToday,
      sent_today: sentToday,
      delivered_today: deliveredToday,
      failed_today: failedToday,
      opt_outs_today: optOutsToday,
      positive_replies_today: positiveRepliesToday,
    },
    last_run: lastRun,
    diagnostics_errors: errors,
  }
}

async function recordLastRun(status, diagnostics = {}) {
  const payload = {
    queue_last_run_status: clean(status) || 'unknown',
    queue_last_run_at: new Date().toISOString(),
    queue_last_run_diagnostics: JSON.stringify(diagnostics).slice(0, 6000),
  }
  await setSystemValues(payload)
}

function responseWithDiagnostics(payload, values, status = 200) {
  return loadCampaignDiagnostics(values).then((campaign) => NextResponse.json({
    ...payload,
    diagnostics: {
      ...values,
      ...campaign,
    },
    control: {
      settings: values,
      campaign,
    },
  }, { status }))
}

function queueRowIsProof(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
  return Boolean(
    metadata.proof === true ||
    metadata.proof_mode ||
    metadata.internal_test_phone === true ||
    metadata.exclude_from_kpis === true
  )
}

async function runDryRunFeeder(body = {}, values = {}) {
  const { runSupabaseCandidateFeeder } = await import('@/lib/domain/outbound/supabase-candidate-feeder.js')
  const limit = Math.max(1, Math.min(50, Number(body.limit) || 10))
  const scan_limit = Math.max(limit, Math.min(5000, Number(body.scan_limit || values.queue_scan_limit) || 250))
  const result = await runSupabaseCandidateFeeder({
    candidate_source: clean(body.candidate_source || values.candidate_source || DEFAULTS.candidate_source),
    limit,
    scan_limit,
    candidate_offset: Math.max(0, Number(body.candidate_offset || 0) || 0),
    market: clean(body.market || values.queue_market_filter) || null,
    state: clean(body.state || values.queue_state_filter) || null,
    dry_run: true,
    within_contact_window_now: asBoolean(body.within_contact_window_now ?? body.respect_contact_window, true),
    routing_safe_only: true,
    debug_templates: body.debug_templates !== false,
    campaign_session_id: clean(body.campaign_session_id) || `cockpit-dry-run-${Date.now()}`,
    allow_internal_test_phones: false,
  })
  await recordLastRun(result?.ok === false ? 'dry_run_failed' : 'dry_run_complete', {
    action: 'run_dry_run_feeder',
    dry_run: true,
    scanned_count: result?.scanned_count || 0,
    eligible_count: result?.eligible_count || 0,
    skipped_count: result?.skipped_count || 0,
    queued_count: 0,
    error: result?.error || null,
  })
  return result
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const values = await loadSettings()
  return responseWithDiagnostics({ ok: true, action: 'queue-control:get' }, values, 200)
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const action = clean(body.action).toLowerCase()
  const values = await loadSettings()

  if (action === 'pause_queue_processor') {
    const result = await setSystemValues({
      queue_processor_mode: 'off',
      campaign_mode: 'paused',
      queue_auto_send_enabled: 'false',
      queue_auto_enqueue_enabled: 'false',
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
    const updated = await loadSettings()
    return responseWithDiagnostics({ ok: true, action }, updated, 200)
  }

  if (action === 'resume_queue_processor') {
    const requestedMode = normalizeCampaignMode(body.campaign_mode || 'dry_run')
    const campaign_mode = requestedMode === 'live' ? 'live_limited' : requestedMode
    const result = await setSystemValues({
      queue_processor_mode: 'safe',
      campaign_mode,
      queue_auto_enqueue_enabled: 'true',
      queue_auto_send_enabled: 'false',
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
    const updated = await loadSettings()
    return responseWithDiagnostics({ ok: true, action, campaign_mode }, updated, 200)
  }

  if (action === 'emergency_stop') {
    const stoppedAt = new Date().toISOString()
    const result = await setSystemValues({
      queue_processor_mode: 'off',
      campaign_mode: 'paused',
      queue_auto_send_enabled: 'false',
      queue_auto_enqueue_enabled: 'false',
      queue_emergency_stop_at: stoppedAt,
      queue_last_run_status: 'emergency_stopped',
      queue_last_run_at: stoppedAt,
      queue_last_run_diagnostics: JSON.stringify({ action, stopped_at: stoppedAt }),
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
    const updated = await loadSettings()
    return responseWithDiagnostics({ ok: true, action, stopped_at: stoppedAt }, updated, 200)
  }

  if (action === 'run_dry_run_feeder') {
    const result = await runDryRunFeeder(body, values)
    const updated = await loadSettings()
    return responseWithDiagnostics({
      ok: result?.ok !== false,
      action,
      dry_run: true,
      inserted_count: 0,
      live_rows_inserted: 0,
      eligible_count: Number(result?.eligible_count || 0),
      skipped_count: Number(result?.skipped_count || 0),
      block_reasons: {
        routing_blocked: Number(result?.routing_blocked_count ?? result?.routing_block_count ?? 0),
        suppressed: Number(result?.suppressed_count ?? result?.suppression_block_count ?? 0),
        identity_held: Number(result?.identity_held_count ?? result?.identity_hold_count ?? 0),
        template_blocked: Number(result?.template_blocked_count ?? result?.template_block_count ?? 0),
        duplicate_blocked: Number(result?.duplicate_blocked_count ?? result?.duplicate_queue_block_count ?? 0),
        active_queue_blocked: Number(result?.active_queue_blocked_count ?? result?.active_queue_block_count ?? 0),
      },
      preview: result,
    }, updated, result?.ok === false ? 500 : 200)
  }

  if (action === 'queue_limited_batch') {
    const safety = normalizeSafetyInput(body, values)
    const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true })
    if (!validation.ok) {
      return NextResponse.json(blockedSafetyResult(validation, action), { status: validation.status })
    }
    const { runSupabaseCandidateFeeder } = await import('@/lib/domain/outbound/supabase-candidate-feeder.js')
    const result = await runSupabaseCandidateFeeder({
      candidate_source: clean(body.candidate_source || values.candidate_source || DEFAULTS.candidate_source),
      limit: validation.effective_limit,
      scan_limit: Math.max(validation.effective_limit, Math.min(5000, Number(body.scan_limit || values.queue_scan_limit) || 1000)),
      market: safety.market,
      state: safety.state,
      dry_run: false,
      within_contact_window_now: asBoolean(body.within_contact_window_now ?? body.respect_contact_window, true),
      routing_safe_only: true,
      campaign_session_id: clean(body.campaign_session_id) || `cockpit-live-limited-${Date.now()}`,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      allow_internal_test_phones: false,
    })
    await recordLastRun(result?.ok === false ? 'queue_limited_failed' : 'queue_limited_complete', {
      action,
      campaign_mode: safety.campaign_mode,
      market: safety.market,
      state: safety.state,
      hard_cap: safety.hard_cap,
      max_batch_size: safety.max_batch_size,
      queued_count: result?.queued_count || 0,
      scheduled_count: result?.scheduled_count || 0,
      scanned_count: result?.scanned_count || 0,
      error: result?.error || null,
    })
    const updated = await loadSettings()
    return responseWithDiagnostics({
      ok: result?.ok !== false,
      action,
      rows_created: Number(result?.queued_count || 0),
      rows_scheduled: Number(result?.scheduled_count || 0),
      diagnostics_result: result,
    }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  if (action === 'safe_batch' || action === 'run_due_queue' || action === 'run_small_queue_batch') {
    const safety = normalizeSafetyInput(body, values)
    const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true })
    if (!validation.ok) {
      return NextResponse.json(blockedSafetyResult(validation, action), { status: validation.status })
    }
    const { runSendQueue } = await import('@/lib/domain/queue/run-send-queue.js')
    const limit = Math.max(1, Math.min(25, validation.effective_limit))
    const result = await runSendQueue({ limit, dry_run: false }, {})
    await recordLastRun(result?.ok === false ? 'queue_run_failed' : 'queue_run_complete', {
      action,
      campaign_mode: safety.campaign_mode,
      limit,
      sent_count: result?.sent_count || 0,
      failed_count: result?.failed_count || 0,
      blocked_count: result?.blocked_count || 0,
    })
    const updated = await loadSettings()
    return responseWithDiagnostics({
      ok: result?.ok !== false,
      action,
      rows_sent: Number(result?.sent_count || 0),
      block_reasons: {
        failed: Number(result?.failed_count || 0),
        blocked: Number(result?.blocked_count || 0),
      },
      result,
    }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  if (action === 'run_targeted_queue_row') {
    const queue_row_id = clean(body.queue_row_id || body.queue_item_id || body.item_id || body.id)
    if (!queue_row_id) {
      return NextResponse.json({ ok: false, action, error: 'queue_row_id_required' }, { status: 400 })
    }
    const { loadQueueRowById, processSendQueue } = await import('@/lib/domain/queue/process-send-queue.js')
    const row = await loadQueueRowById(queue_row_id)
    if (!row) return NextResponse.json({ ok: false, action, error: 'missing_queue_row', queue_row_id }, { status: 404 })

    const proof = queueRowIsProof(row)
    if (isInternalTestPhone(row.to_phone_number) && !proof) {
      return NextResponse.json({ ok: false, action, error: 'internal_test_phone_requires_proof_mode', queue_row_id }, { status: 423 })
    }
    if (!proof) {
      const safety = normalizeSafetyInput(body, values)
      const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true })
      if (!validation.ok) {
        return NextResponse.json(blockedSafetyResult(validation, action), { status: validation.status })
      }
    }
    const result = await processSendQueue({ queue_row_id })
    await recordLastRun(result?.ok === false ? 'targeted_queue_row_failed' : 'targeted_queue_row_complete', {
      action,
      queue_row_id,
      proof,
      sent: Boolean(result?.sent),
      reason: result?.reason || null,
    })
    const updated = await loadSettings()
    return responseWithDiagnostics({ ok: result?.ok !== false, action, queue_row_id, result }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  const patch = parseBody(body)
  const result = await setSystemValues(patch)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
  }
  const updated = await loadSettings()
  return responseWithDiagnostics({ ok: true, action: 'queue-control:set' }, updated, 200)
}

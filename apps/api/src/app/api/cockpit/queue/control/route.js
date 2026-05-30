import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { supabase } from '@/lib/supabase/client.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import {
  asBoolean,
  asPositiveInteger,
  blockedRuntimeBrakeResult,
  blockedSafetyResult,
  clean,
  evaluateQueueCreationRuntimeBrakes,
  evaluateQueueSendRuntimeBrakes,
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
  queue_auto_enqueue_enabled: 'false',
  queue_auto_send_enabled: 'false',
  queue_last_run_status: 'idle',
  queue_last_run_at: '',
  queue_last_run_diagnostics: '',
  queue_emergency_stop_at: '',
}

const QUEUE_LIMITED_ACTIVE_STATUSES = ['queued', 'scheduled']
const DIAGNOSTIC_COUNT_TIMEOUT_MS = 2500

function normalizeComparable(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeState(value) {
  return clean(value).toUpperCase()
}

function metadataObject(row = {}) {
  return row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {}
}

function rowMarketValue(row = {}) {
  const metadata = metadataObject(row)
  return clean(
    row.market ||
    metadata.seller_market ||
    metadata.candidate_snapshot?.seller_market ||
    metadata.market ||
    ''
  )
}

function rowStateValue(row = {}) {
  const metadata = metadataObject(row)
  return normalizeState(
    row.property_address_state ||
    metadata.seller_state ||
    metadata.candidate_snapshot?.seller_state ||
    metadata.state ||
    ''
  )
}

function rowMatchesScope(row = {}, { market = null, state = null } = {}) {
  const targetMarket = normalizeComparable(market)
  const targetState = normalizeState(state)
  const rowMarket = normalizeComparable(rowMarketValue(row))
  const rowState = rowStateValue(row)
  if (targetMarket && rowMarket !== targetMarket) return false
  if (targetState && rowState !== targetState) return false
  return true
}

function totalCreatedCount(result = {}) {
  return Number(result?.queued_count || 0) + Number(result?.scheduled_count || 0)
}

function capBasisEntry(name, cap, used, scope) {
  const numericCap = asPositiveInteger(cap, null)
  if (!numericCap) return null
  const numericUsed = Math.max(0, Number(used || 0))
  return {
    name,
    cap: numericCap,
    used: numericUsed,
    remaining: Math.max(0, numericCap - numericUsed),
    scope,
  }
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
  const values = { ...DEFAULTS }
  try {
    const { data, error } = await supabase
      .from('system_control')
      .select('key,value')
      .in('key', CONTROL_KEYS)
    if (error) throw error
    for (const row of data || []) {
      if (!row?.key) continue
      values[row.key] = row.value ?? DEFAULTS[row.key] ?? null
    }
  } catch {
    for (const key of CONTROL_KEYS) {
      const value = await getSystemValue(key)
      values[key] = value ?? DEFAULTS[key] ?? null
    }
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
    const { count, error } = await Promise.race([
      query,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`diagnostic_count_timeout:${label}`)), DIAGNOSTIC_COUNT_TIMEOUT_MS)
      }),
    ])
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
  const [
    queueDepth,
    queuedToday,
    sentToday,
    deliveredToday,
    failedToday,
    optOutsToday,
    positiveRepliesToday,
  ] = await Promise.all([
    countRows('queue_depth', () => supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .in('queue_status', ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing']), errors),
    countRows('queued_today', () => supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .in('queue_status', ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing']), errors),
    countRows('sent_today', () => supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', since), errors),
    countRows('delivered_today', () => supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .gte('delivered_at', since), errors),
    countRows('failed_today', () => supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .gte('updated_at', since)
      .eq('queue_status', 'failed'), errors),
    countRows('opt_outs_today', () => supabase
      .from('message_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .eq('is_opt_out', true), errors),
    countRows('positive_replies_today', () => supabase
      .from('message_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .eq('direction', 'inbound')
      .in('detected_intent', ['positive', 'interested', 'seller_positive', 'asks_offer', 'offer_requested', 'appointment_ready']), errors),
  ])

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

async function loadQueuedScheduledRowsToday() {
  const { data, error } = await supabase
    .from('send_queue')
    .select('id,from_phone_number,market,property_address_state,metadata')
    .gte('created_at', todayStartIso())
    .in('queue_status', QUEUE_LIMITED_ACTIVE_STATUSES)
    .limit(10000)
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function computeQueueLimitedCap(safety = {}) {
  const rowsToday = await loadQueuedScheduledRowsToday()
  const scopedRows = rowsToday.filter((row) => rowMatchesScope(row, safety))
  const marketRows = safety.market
    ? rowsToday.filter((row) => normalizeComparable(rowMarketValue(row)) === normalizeComparable(safety.market))
    : scopedRows

  const senderCounts = new Map()
  for (const row of scopedRows) {
    const sender = clean(row.from_phone_number) || 'unknown'
    senderCounts.set(sender, Number(senderCounts.get(sender) || 0) + 1)
  }
  const maxSenderQueuedScheduledToday = Math.max(0, ...senderCounts.values())

  const cap_basis = [
    capBasisEntry('limit', safety.limit, 0, 'request'),
    capBasisEntry('hard_cap', safety.hard_cap, scopedRows.length, 'same_day_scope_queued_scheduled'),
    capBasisEntry('max_batch_size', safety.max_batch_size, 0, 'request'),
    capBasisEntry('daily_cap', safety.daily_cap, rowsToday.length, 'same_day_queued_scheduled'),
    capBasisEntry('market_cap', safety.market_cap, marketRows.length, 'same_day_market_queued_scheduled'),
    capBasisEntry('per_number_cap', safety.per_number_cap, maxSenderQueuedScheduledToday, 'same_day_scope_sender_max_queued_scheduled'),
  ].filter(Boolean)

  const remainingValues = cap_basis.map((entry) => entry.remaining)
  const remaining_cap_before_create = remainingValues.length
    ? Math.max(0, Math.min(...remainingValues))
    : 0

  return {
    ok: remaining_cap_before_create > 0,
    cap_basis,
    effective_total_cap: remaining_cap_before_create,
    remaining_cap_before_create,
    existing_queued_scheduled_today: rowsToday.length,
    existing_queued_scheduled_for_scope: scopedRows.length,
    existing_queued_scheduled_for_market: marketRows.length,
    existing_queued_scheduled_sender_max: maxSenderQueuedScheduledToday,
  }
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
    const reason = clean(body.reason) || 'operator_emergency_stop'
    const result = await setSystemValues({
      queue_processor_mode: 'off',
      campaign_mode: 'paused',
      queue_auto_send_enabled: 'false',
      queue_auto_enqueue_enabled: 'false',
      queue_emergency_stop_at: stoppedAt,
      queue_last_run_status: 'emergency_stopped',
      queue_last_run_at: stoppedAt,
      queue_last_run_diagnostics: JSON.stringify({ action, reason, stopped_at: stoppedAt }),
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
    const updated = await loadSettings()
    return responseWithDiagnostics({ ok: true, action, reason, stopped_at: stoppedAt }, updated, 200)
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
    const runtimeBrake = evaluateQueueCreationRuntimeBrakes(values, {
      action,
      requireAutoEnqueue: false,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return NextResponse.json(blockedRuntimeBrakeResult(runtimeBrake, action), { status: runtimeBrake.status })
    }
    const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true })
    if (!validation.ok) {
      return NextResponse.json(blockedSafetyResult(validation, action), { status: validation.status })
    }
    const cap = await computeQueueLimitedCap(safety)
    if (!cap.ok) {
      await recordLastRun('queue_limited_cap_exhausted', {
        action,
        campaign_mode: safety.campaign_mode,
        market: safety.market,
        state: safety.state,
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        total_created_count: 0,
      })
      const updated = await loadSettings()
      return responseWithDiagnostics({
        ok: false,
        action,
        error: 'queue_limited_cap_exhausted',
        reason: 'queue_limited_cap_exhausted',
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        total_created_count: 0,
      }, updated, 423)
    }
    const { runSupabaseCandidateFeeder } = await import('@/lib/domain/outbound/supabase-candidate-feeder.js')
    const result = await runSupabaseCandidateFeeder({
      candidate_source: clean(body.candidate_source || values.candidate_source || DEFAULTS.candidate_source),
      limit: cap.remaining_cap_before_create,
      max_created_count: cap.remaining_cap_before_create,
      scan_limit: Math.max(cap.remaining_cap_before_create, Math.min(5000, Number(body.scan_limit || values.queue_scan_limit) || 1000)),
      market: safety.market,
      state: safety.state,
      dry_run: false,
      within_contact_window_now: asBoolean(body.within_contact_window_now ?? body.respect_contact_window, true),
      routing_safe_only: true,
      campaign_session_id: clean(body.campaign_session_id) || `cockpit-live-limited-${Date.now()}`,
      batch_name: clean(body.batch_name || body.proof_key) || null,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      allow_internal_test_phones: false,
    })
    const createdTotal = totalCreatedCount(result)
    await recordLastRun(result?.ok === false ? 'queue_limited_failed' : 'queue_limited_complete', {
      action,
      campaign_mode: safety.campaign_mode,
      market: safety.market,
      state: safety.state,
      hard_cap: safety.hard_cap,
      max_batch_size: safety.max_batch_size,
      queued_count: result?.queued_count || 0,
      scheduled_count: result?.scheduled_count || 0,
      total_created_count: createdTotal,
      cap_basis: cap.cap_basis,
      effective_total_cap: cap.effective_total_cap,
      remaining_cap_before_create: cap.remaining_cap_before_create,
      scanned_count: result?.scanned_count || 0,
      error: result?.error || null,
    })
    const updated = await loadSettings()
    return responseWithDiagnostics({
      ok: result?.ok !== false,
      action,
      rows_created: Number(result?.queued_count || 0),
      rows_scheduled: Number(result?.scheduled_count || 0),
      total_created_count: createdTotal,
      cap_basis: cap.cap_basis,
      effective_total_cap: cap.effective_total_cap,
      remaining_cap_before_create: cap.remaining_cap_before_create,
      diagnostics_result: result,
    }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  if (action === 'safe_batch' || action === 'run_due_queue' || action === 'run_small_queue_batch') {
    const safety = normalizeSafetyInput(body, values)
    const runtimeBrake = evaluateQueueSendRuntimeBrakes(values, {
      action,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return NextResponse.json(blockedRuntimeBrakeResult(runtimeBrake, action), { status: runtimeBrake.status })
    }
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
    const runtimeBrake = evaluateQueueSendRuntimeBrakes(values, {
      action,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return NextResponse.json(blockedRuntimeBrakeResult(runtimeBrake, action), { status: runtimeBrake.status })
    }
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

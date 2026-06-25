import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, withCors, handleOptionsResponse } from '../../_shared.js'
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
  isEmergencyStopActive,
  normalizeCampaignMode,
  normalizeQueueProcessorMode,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from '@/lib/domain/queue/queue-control-safety.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
import { createRequestTimer } from '@/lib/cockpit/server-timing.js'
import { normalizeQueueExecutionMode } from '@/lib/domain/queue/queue-execution-mode.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function corsJson(request, payload, status = 200) {
  return withCors(request, NextResponse.json(payload, { status }))
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request)
}

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
  'queue_execution_mode',
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
  queue_execution_mode: 'stopped',
}

const QUEUE_LIMITED_ACTIVE_STATUSES = ['queued', 'scheduled']
const DIAGNOSTIC_COUNT_TIMEOUT_MS = 2500
const SEND_ONE_CONFIRM = 'SEND_ONE_REAL_SELLER_SMS'
const ONE_ROW_SENDABLE_STATUSES = new Set(['queued', 'scheduled', 'pending', 'approved', 'ready'])
const ONE_ROW_REJECT_STATUSES = new Set([
  'expired',
  'failed',
  'paused',
  'paused_operator_review',
  'paused_name_missing',
  'paused_invalid_queue_row',
  'sent',
  'delivered',
  'cancelled',
  'duplicate_blocked',
  'sending',
  'processing',
])

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

function hasOwn(value = {}, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function bodyBoolean(body = {}, keys = [], fallback = false) {
  for (const key of keys) {
    if (hasOwn(body, key)) return asBoolean(body[key], fallback)
  }
  return fallback
}

function oneRowQueueSafetyFailure(values = {}) {
  const autoSendEnabled = asBoolean(values.queue_auto_send_enabled, false)
  if (autoSendEnabled) {
    return {
      ok: false,
      status: 423,
      reason: 'queue_auto_send_enabled_must_be_false',
      message: 'queue_one requires queue_auto_send_enabled=false.',
    }
  }

  const autoEnqueueEnabled = asBoolean(values.queue_auto_enqueue_enabled, false)
  if (autoEnqueueEnabled) {
    return {
      ok: false,
      status: 423,
      reason: 'queue_auto_enqueue_enabled_must_be_false',
      message: 'queue_one requires queue_auto_enqueue_enabled=false.',
    }
  }

  const processorMode = normalizeQueueProcessorMode(values.queue_processor_mode)
  if (processorMode !== 'off') {
    return {
      ok: false,
      status: 423,
      reason: 'queue_processor_must_be_off',
      message: 'queue_one requires queue_processor_mode off/paused.',
    }
  }

  const autoReplyMode = clean(values.auto_reply_mode || 'disabled').toLowerCase()
  if (!['disabled', 'dry_run'].includes(autoReplyMode)) {
    return {
      ok: false,
      status: 423,
      reason: 'auto_reply_mode_must_be_disabled_or_dry_run',
      message: 'queue_one requires auto_reply_mode disabled/dry_run.',
    }
  }

  if (!isEmergencyStopActive(values.queue_emergency_stop_at)) {
    return {
      ok: false,
      status: 423,
      reason: 'queue_emergency_stop_required',
      message: 'queue_one requires the emergency stop to stay active while planning/creating one row.',
    }
  }

  return { ok: true, status: 200 }
}

function validateOneRowRails(safety = {}) {
  const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true })
  if (!validation.ok) return validation

  const exactOneFields = [
    ['limit', safety.limit],
    ['hard_cap', safety.hard_cap],
    ['max_batch_size', safety.max_batch_size],
    ['daily_cap', safety.daily_cap],
    ['market_cap', safety.market_cap],
    ['per_number_cap', safety.per_number_cap],
  ]
  const nonOne = exactOneFields
    .filter(([, value]) => asPositiveInteger(value, null) !== 1)
    .map(([field]) => `${field}_must_equal_1`)

  if (nonOne.length > 0) {
    return {
      ok: false,
      status: 423,
      reason: 'one_row_rails_required',
      message: 'queue_one requires limit, hard_cap, max_batch_size, daily_cap, market_cap, and per_number_cap to all equal 1.',
      missing: nonOne,
      safety,
    }
  }

  return {
    ok: true,
    status: 200,
    effective_limit: 1,
    safety,
  }
}

function rowMetadata(row = {}) {
  return row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {}
}

function queueRowIsNoSend(row = {}) {
  const metadata = rowMetadata(row)
  return (
    asBoolean(metadata.no_send, false) ||
    asBoolean(metadata.proof_no_send, false) ||
    clean(metadata.proof_mode).toLowerCase() === 'no_send' ||
    row.sms_eligible === false ||
    row.routing_allowed === false
  )
}

function rejectOneRowStatusReason(row = {}) {
  const status = clean(row.queue_status).toLowerCase()
  if (ONE_ROW_REJECT_STATUSES.has(status) || status.startsWith('paused')) {
    return `queue_row_${status || 'status'}_not_sendable`
  }
  if (!ONE_ROW_SENDABLE_STATUSES.has(status)) {
    return 'queue_row_status_not_sendable'
  }
  return null
}

function rowScheduledInFuture(row = {}) {
  const scheduledAt = clean(row.scheduled_for_utc || row.scheduled_for)
  if (!scheduledAt) return false
  const ts = new Date(scheduledAt).getTime()
  return Number.isFinite(ts) && ts > Date.now()
}

async function rearmEmergencyStopAfterOneSend(action, reason, details = {}) {
  const stoppedAt = new Date().toISOString()
  await setSystemValues({
    queue_processor_mode: 'off',
    campaign_mode: 'paused',
    queue_auto_send_enabled: 'false',
    queue_auto_enqueue_enabled: 'false',
    queue_emergency_stop_at: stoppedAt,
    queue_last_run_status: clean(reason) || 'one_send_window_closed',
    queue_last_run_at: stoppedAt,
    queue_last_run_diagnostics: JSON.stringify({
      action,
      reason,
      stopped_at: stoppedAt,
      ...details,
    }),
  })
  return stoppedAt
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
  if (patch.queue_execution_mode) {
    patch.queue_execution_mode = normalizeQueueExecutionMode(patch.queue_execution_mode)
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

  const campaignAware = {
    active_campaign: null,
    campaign_queue_depth: 0,
    queue_depth_by_campaign: {},
    next_send_window: null,
    blocked_reason_counts: {},
    campaigns: [],
  }

  const exactBlockers = []
  const activeCampaign = campaignAware.active_campaign
  if (!activeCampaign) exactBlockers.push('no_ready_or_live_limited_campaign')
  if (isEmergencyStopActive(values.queue_emergency_stop_at)) exactBlockers.push('global_queue_emergency_stop_active')
  if (asBoolean(values.queue_auto_send_enabled, false)) exactBlockers.push('global_auto_send_must_remain_disabled')
  if (!asBoolean(values.queue_auto_enqueue_enabled, false)) exactBlockers.push('global_auto_enqueue_disabled')
  if (activeCampaign) {
    if (!activeCampaign.auto_queue_enabled) exactBlockers.push('active_campaign_auto_queue_disabled')
    if (activeCampaign.auto_send_enabled) exactBlockers.push('active_campaign_auto_send_must_remain_disabled')
    if (clean(activeCampaign.auto_reply_mode || 'disabled') !== 'disabled') exactBlockers.push('active_campaign_auto_reply_must_remain_disabled')
    if (!asPositiveInteger(activeCampaign.daily_cap, null)) exactBlockers.push('active_campaign_missing_daily_cap')
    if (!asPositiveInteger(activeCampaign.total_cap, null)) exactBlockers.push('active_campaign_missing_total_cap')
    if (!asPositiveInteger(activeCampaign.batch_max, null)) exactBlockers.push('active_campaign_missing_batch_max')
    if (!asPositiveInteger(activeCampaign.market_cap, null)) exactBlockers.push('active_campaign_missing_market_cap')
    if (!asPositiveInteger(activeCampaign.per_sender_cap, null)) exactBlockers.push('active_campaign_missing_per_sender_cap')
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
    ...campaignAware,
    exact_blockers: exactBlockers,
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

function responseWithDiagnostics(request, payload, values, status = 200) {
  const timer = createRequestTimer('queue-control:get')
  return readThroughCache('cockpit:queue-control:diagnostics', 8_000, () => loadCampaignDiagnostics(values))
    .then((campaign) => {
      timer.mark('diagnostics_loaded')
      const timing = timer.summary()
      return corsJson(request, {
        ...payload,
        diagnostics: {
          ...values,
          ...campaign,
        },
        control: {
          settings: values,
          campaign,
        },
        queryMs: timing.totalMs,
        sourceUsed: 'queue-control:cached-diagnostics',
        timing,
      }, status)
    })
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
  return responseWithDiagnostics(request, { ok: true, action: 'queue-control:get' }, values, 200)
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
    if (!result.ok) return corsJson(request,{ ok: false, error: 'queue_control_update_failed' }, 500)
    const updated = await loadSettings()
    return responseWithDiagnostics(request, { ok: true, action }, updated, 200)
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
    if (!result.ok) return corsJson(request,{ ok: false, error: 'queue_control_update_failed' }, 500)
    const updated = await loadSettings()
    return responseWithDiagnostics(request, { ok: true, action, campaign_mode }, updated, 200)
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
    if (!result.ok) return corsJson(request,{ ok: false, error: 'queue_control_update_failed' }, 500)
    const updated = await loadSettings()
    return responseWithDiagnostics(request, { ok: true, action, reason, stopped_at: stoppedAt }, updated, 200)
  }

  if (action === 'run_dry_run_feeder') {
    const result = await runDryRunFeeder(body, values)
    const updated = await loadSettings()
    return responseWithDiagnostics(request, {
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
    const campaignSessionId = clean(body.campaign_session_id || body.campaignSessionId || body.session_id) || `cockpit-live-limited-${Date.now()}`
    const approvalMode = clean(body.approval_mode || body.approvalMode || body.approval) || null
    const noSendProvided =
      hasOwn(body, 'no_send') ||
      hasOwn(body, 'noSend') ||
      hasOwn(body, 'proof_no_send')
    const noSend = bodyBoolean(body, ['no_send', 'noSend', 'proof_no_send'], false)
    const proofMode = bodyBoolean(body, ['proof_mode', 'proofMode', 'proof'], false)
    const excludeFromKpis = bodyBoolean(body, ['exclude_from_kpis', 'excludeFromKpis'], noSend || proofMode)
    const runtimeBrake = evaluateQueueCreationRuntimeBrakes(values, {
      action,
      requireAutoEnqueue: false,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return corsJson(request, blockedRuntimeBrakeResult(runtimeBrake, action), runtimeBrake.status)
    }
    const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true })
    if (!validation.ok) {
      return corsJson(request, blockedSafetyResult(validation, action), validation.status)
    }
    const cap = await computeQueueLimitedCap(safety)
    if (!cap.ok) {
      await recordLastRun('queue_limited_cap_exhausted', {
        action,
        campaign_session_id: campaignSessionId,
        campaign_mode: safety.campaign_mode,
        approval_mode: approvalMode,
        no_send: noSendProvided ? noSend : null,
        market: safety.market,
        state: safety.state,
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        total_created_count: 0,
      })
      const updated = await loadSettings()
      return responseWithDiagnostics(request, {
        ok: false,
        action,
        campaign_session_id: campaignSessionId,
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
      campaign_session_id: campaignSessionId,
      campaign_mode: safety.campaign_mode,
      approval_mode: approvalMode,
      ...(noSendProvided ? { no_send: noSend } : {}),
      proof_mode: proofMode,
      exclude_from_kpis: excludeFromKpis,
      cap_basis: cap.cap_basis,
      cap_basis_snapshot: cap.cap_basis,
      effective_total_cap: cap.effective_total_cap,
      remaining_cap_before_create: cap.remaining_cap_before_create,
      queue_limited_request_context: {
        action,
        campaign_session_id: campaignSessionId,
        campaign_mode: safety.campaign_mode,
        approval_mode: approvalMode,
        no_send: noSendProvided ? noSend : null,
        proof_mode: proofMode,
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        market: safety.market,
        state: safety.state,
        requested_limit: safety.limit,
      },
      batch_name: clean(body.batch_name || body.proof_key) || null,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      allow_internal_test_phones: false,
    })
    const createdTotal = totalCreatedCount(result)
    await recordLastRun(result?.ok === false ? 'queue_limited_failed' : 'queue_limited_complete', {
      action,
      campaign_session_id: campaignSessionId,
      campaign_mode: safety.campaign_mode,
      approval_mode: approvalMode,
      no_send: noSendProvided ? noSend : null,
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
    return responseWithDiagnostics(request, {
      ok: result?.ok !== false,
      action,
      campaign_session_id: campaignSessionId,
      rows_created: Number(result?.queued_count || 0),
      rows_scheduled: Number(result?.scheduled_count || 0),
      total_created_count: createdTotal,
      cap_basis: cap.cap_basis,
      effective_total_cap: cap.effective_total_cap,
      remaining_cap_before_create: cap.remaining_cap_before_create,
      diagnostics_result: result,
    }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  if (action === 'queue_one') {
    const campaignSessionId = clean(body.campaign_session_id || body.campaignSessionId || body.session_id)
    if (!campaignSessionId) {
      return corsJson(request,{ ok: false, action, error: 'campaign_session_id_required', reason: 'campaign_session_id_required' }, 400)
    }

    const globalBrake = oneRowQueueSafetyFailure(values)
    if (!globalBrake.ok) {
      return corsJson(request,{
        ok: false,
        action,
        error: globalBrake.reason,
        reason: globalBrake.reason,
        message: globalBrake.message,
        diagnostics: {
          queue_processor_mode: values.queue_processor_mode,
          auto_reply_mode: values.auto_reply_mode,
          queue_auto_send_enabled: values.queue_auto_send_enabled,
          queue_auto_enqueue_enabled: values.queue_auto_enqueue_enabled,
          queue_emergency_stop_at: values.queue_emergency_stop_at,
        },
      }, globalBrake.status)
    }

    const scheduleFor = clean(body.schedule_for || body.scheduled_for || 'now').toLowerCase()
    if (!['now', 'immediate'].includes(scheduleFor)) {
      return corsJson(request,{
        ok: false,
        action,
        error: 'schedule_for_must_be_now_or_immediate',
        reason: 'schedule_for_must_be_now_or_immediate',
      }, 423)
    }

    const safety = normalizeSafetyInput({
      ...body,
      limit: 1,
      hard_cap: body.hard_cap ?? body.queue_hard_cap,
      max_batch_size: body.max_batch_size ?? body.queue_max_batch_size,
      daily_cap: body.daily_cap ?? body.queue_daily_send_cap,
      market_cap: body.market_cap ?? body.queue_market_cap,
      per_number_cap: body.per_number_cap ?? body.queue_per_number_cap,
    }, values)
    const validation = validateOneRowRails(safety)
    if (!validation.ok) {
      return corsJson(request, blockedSafetyResult(validation, action), validation.status)
    }

    const cap = await computeQueueLimitedCap(safety)
    if (!cap.ok || cap.remaining_cap_before_create < 1) {
      await recordLastRun('queue_one_cap_exhausted', {
        action,
        campaign_session_id: campaignSessionId,
        market: safety.market,
        state: safety.state,
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        total_created_count: 0,
      })
      const updated = await loadSettings()
      return responseWithDiagnostics(request, {
        ok: false,
        action,
        campaign_session_id: campaignSessionId,
        error: 'queue_limited_cap_exhausted',
        reason: 'queue_limited_cap_exhausted',
        cap_basis: cap.cap_basis,
        effective_total_cap: cap.effective_total_cap,
        remaining_cap_before_create: cap.remaining_cap_before_create,
        total_created_count: 0,
      }, updated, 423)
    }

    const approvalMode = clean(body.approval_mode || body.approvalMode || body.approval) || null
    const noSendProvided =
      hasOwn(body, 'no_send') ||
      hasOwn(body, 'noSend') ||
      hasOwn(body, 'proof_no_send')
    const noSend = bodyBoolean(body, ['no_send', 'noSend', 'proof_no_send'], false)
    const proofMode = bodyBoolean(body, ['proof_mode', 'proofMode', 'proof'], false)
    const excludeFromKpis = bodyBoolean(body, ['exclude_from_kpis', 'excludeFromKpis'], noSend || proofMode)
    const now = new Date().toISOString()
    const { runSupabaseCandidateFeeder } = await import('@/lib/domain/outbound/supabase-candidate-feeder.js')
    const result = await runSupabaseCandidateFeeder({
      candidate_source: clean(body.candidate_source || 'v_feeder_candidates_fast'),
      limit: 1,
      max_created_count: 1,
      scan_limit: Math.max(1, Math.min(5000, Number(body.scan_limit || values.queue_scan_limit) || 1000)),
      market: safety.market,
      state: safety.state,
      dry_run: false,
      now,
      within_contact_window_now: asBoolean(body.within_contact_window_now ?? body.respect_contact_window, true),
      routing_safe_only: true,
      campaign_session_id: campaignSessionId,
      campaign_mode: 'live_limited',
      approval_mode: approvalMode,
      ...(noSendProvided ? { no_send: noSend } : {}),
      proof_mode: proofMode,
      exclude_from_kpis: excludeFromKpis,
      cap_basis: cap.cap_basis,
      cap_basis_snapshot: cap.cap_basis,
      effective_total_cap: 1,
      remaining_cap_before_create: 1,
      queue_limited_request_context: {
        action,
        campaign_session_id: campaignSessionId,
        campaign_mode: 'live_limited',
        approval_mode: approvalMode,
        no_send: noSendProvided ? noSend : null,
        proof_mode: proofMode,
        cap_basis: cap.cap_basis,
        effective_total_cap: 1,
        remaining_cap_before_create: 1,
        market: safety.market,
        state: safety.state,
        requested_limit: 1,
      },
      batch_name: clean(body.batch_name || body.proof_key) || campaignSessionId,
      schedule_spread: false,
      allow_internal_test_phones: false,
    }, {
      getSystemValue: async (key) => {
        if (key === 'campaign_mode') return 'live_limited'
        if (key === 'queue_auto_enqueue_enabled') return 'false'
        if (key === 'queue_emergency_stop_at') return ''
        return values[key] ?? null
      },
    })

    const createdTotal = totalCreatedCount(result)
    const firstItem = Array.isArray(result?.sample_created_queue_items) ? result.sample_created_queue_items[0] : null
    let queueRowId = clean(firstItem?.queue_row_id || firstItem?.id || result?.queue_row_id)
    let queueKey = clean(firstItem?.queue_key || result?.queue_key)
    if (!queueRowId || !queueKey) {
      const { data, error } = await supabase
        .from('send_queue')
        .select('id,queue_key')
        .eq('metadata->>campaign_session_id', campaignSessionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!error && data) {
        queueRowId ||= clean(data.id)
        queueKey ||= clean(data.queue_key)
      }
    }

    await recordLastRun(result?.ok === false ? 'queue_one_failed' : 'queue_one_complete', {
      action,
      campaign_session_id: campaignSessionId,
      campaign_mode: 'live_limited',
      approval_mode: approvalMode,
      no_send: noSendProvided ? noSend : null,
      market: safety.market,
      state: safety.state,
      queue_row_id: queueRowId || null,
      queue_key: queueKey || null,
      queued_count: result?.queued_count || 0,
      scheduled_count: result?.scheduled_count || 0,
      total_created_count: createdTotal,
      cap_basis: cap.cap_basis,
      error: result?.error || null,
    })
    const updated = await loadSettings()
    return responseWithDiagnostics(request, {
      ok: result?.ok !== false && createdTotal === 1 && Boolean(queueRowId),
      action,
      campaign_session_id: campaignSessionId,
      queue_row_id: queueRowId || null,
      queue_key: queueKey || null,
      rows_created: Number(result?.queued_count || 0),
      rows_scheduled: Number(result?.scheduled_count || 0),
      total_created_count: createdTotal,
      cap_basis: cap.cap_basis,
      effective_total_cap: 1,
      remaining_cap_before_create: 1,
      diagnostics_result: result,
    }, updated, result?.ok === false || createdTotal !== 1 || !queueRowId ? Number(result?.status || 500) : 200)
  }

  if (action === 'safe_batch' || action === 'run_due_queue' || action === 'run_small_queue_batch') {
    const safety = normalizeSafetyInput(body, values)
    const runtimeBrake = evaluateQueueSendRuntimeBrakes(values, {
      action,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return corsJson(request, blockedRuntimeBrakeResult(runtimeBrake, action), runtimeBrake.status)
    }
    const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true })
    if (!validation.ok) {
      return corsJson(request, blockedSafetyResult(validation, action), validation.status)
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
    return responseWithDiagnostics(request, {
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

  if (action === 'send_one_queue_row') {
    const queue_row_id = clean(body.queue_row_id || body.queue_item_id || body.item_id || body.id)
    if (!queue_row_id) {
      return corsJson(request,{ ok: false, action, error: 'queue_row_id_required', reason: 'queue_row_id_required' }, 400)
    }
    if (normalizeCampaignMode(body.campaign_mode) !== 'live_limited') {
      return corsJson(request,{ ok: false, action, error: 'campaign_mode_live_limited_required', reason: 'campaign_mode_live_limited_required' }, 423)
    }
    if (clean(body.confirm) !== SEND_ONE_CONFIRM) {
      return corsJson(request,{ ok: false, action, error: 'confirm_string_required', reason: 'confirm_string_required' }, 423)
    }

    const { loadQueueRowById, processSendQueue } = await import('@/lib/domain/queue/process-send-queue.js')
    const row = await loadQueueRowById(queue_row_id)
    if (!row) return corsJson(request,{ ok: false, action, error: 'missing_queue_row', reason: 'missing_queue_row', queue_row_id }, 404)

    const metadata = rowMetadata(row)
    if (normalizeCampaignMode(metadata.campaign_mode || row.campaign_mode || 'paused') !== 'live_limited') {
      return corsJson(request,{ ok: false, action, error: 'queue_row_not_live_limited', reason: 'queue_row_not_live_limited', queue_row_id }, 423)
    }

    const statusReason = rejectOneRowStatusReason(row)
    if (statusReason) {
      return corsJson(request,{
        ok: false,
        action,
        error: statusReason,
        reason: statusReason,
        queue_row_id,
        queue_status: row.queue_status || null,
      }, 423)
    }

    if (isEmergencyStopActive(values.queue_emergency_stop_at) && !asBoolean(body.clear_one_send_window, false)) {
      return corsJson(request,{
        ok: false,
        action,
        error: 'queue_emergency_stop_active',
        reason: 'queue_emergency_stop_active',
        message: 'Emergency stop is active; pass clear_one_send_window=true only after explicit approval for this one row.',
        queue_row_id,
      }, 423)
    }

    if (queueRowIsNoSend(row)) {
      const stoppedAt = asBoolean(body.clear_one_send_window, false)
        ? await rearmEmergencyStopAfterOneSend(action, 'send_one_no_send_refused', { queue_row_id })
        : null
      const updated = stoppedAt ? await loadSettings() : values
      return responseWithDiagnostics(request, {
        ok: false,
        action,
        error: 'no_send_queue_row',
        reason: 'no_send_queue_row',
        queue_row_id,
        queue_status: row.queue_status || null,
        provider_message_id: null,
        message_event_id: null,
        emergency_stop_rearmed_at: stoppedAt,
      }, updated, 423)
    }

    if (rowScheduledInFuture(row)) {
      return corsJson(request,{
        ok: false,
        action,
        error: 'queue_row_scheduled_for_future',
        reason: 'queue_row_scheduled_for_future',
        queue_row_id,
        scheduled_for: row.scheduled_for_utc || row.scheduled_for || null,
      }, 423)
    }

    let result = null
    let stoppedAt = null
    try {
      result = await processSendQueue({ queue_row: row }, {
        processing_run_id: `send-one-${queue_row_id}-${Date.now()}`,
        getSystemValue: async (key) => {
          if (key === 'queue_processor_mode') return 'live'
          if (key === 'queue_emergency_stop_at') return ''
          return values[key] ?? null
        },
      })
    } finally {
      stoppedAt = await rearmEmergencyStopAfterOneSend(action, result?.sent ? 'send_one_complete' : 'send_one_window_closed', {
        queue_row_id,
        provider_message_id: result?.provider_message_id || result?.message_id || result?.sid || null,
        queue_status: result?.final_queue_status || result?.queue_status || null,
        sent: Boolean(result?.sent),
        reason: result?.reason || null,
      })
    }
    const updated = await loadSettings()
    return responseWithDiagnostics(request, {
      ok: result?.ok !== false && result?.sent === true,
      action,
      queue_row_id,
      provider_message_id: result?.provider_message_id || result?.message_id || result?.sid || null,
      message_event_id: result?.outbound_event?.item_id || result?.outbound_event?.id || null,
      queue_status: result?.final_queue_status || result?.queue_status || null,
      result,
      emergency_stop_rearmed_at: stoppedAt,
    }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  if (action === 'run_targeted_queue_row') {
    const queue_row_id = clean(body.queue_row_id || body.queue_item_id || body.item_id || body.id)
    if (!queue_row_id) {
      return corsJson(request,{ ok: false, action, error: 'queue_row_id_required' }, 400)
    }
    const { loadQueueRowById, processSendQueue } = await import('@/lib/domain/queue/process-send-queue.js')
    const row = await loadQueueRowById(queue_row_id)
    if (!row) return corsJson(request,{ ok: false, action, error: 'missing_queue_row', queue_row_id }, 404)

    const proof = queueRowIsProof(row)
    const runtimeBrake = evaluateQueueSendRuntimeBrakes(values, {
      action,
      failClosed: true,
    })
    if (!runtimeBrake.ok) {
      return corsJson(request, blockedRuntimeBrakeResult(runtimeBrake, action), runtimeBrake.status)
    }
    if (isInternalTestPhone(row.to_phone_number) && !proof) {
      return corsJson(request,{ ok: false, action, error: 'internal_test_phone_requires_proof_mode', queue_row_id }, 423)
    }
    if (!proof) {
      const safety = normalizeSafetyInput(body, values)
      const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true })
      if (!validation.ok) {
        return corsJson(request, blockedSafetyResult(validation, action), validation.status)
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
    return responseWithDiagnostics(request, { ok: result?.ok !== false, action, queue_row_id, result }, updated, result?.ok === false ? Number(result?.status || 500) : 200)
  }

  const patch = parseBody(body)
  const result = await setSystemValues(patch)
  if (!result.ok) {
    return corsJson(request,{ ok: false, error: 'queue_control_update_failed' }, 500)
  }
  const updated = await loadSettings()
  return responseWithDiagnostics(request, { ok: true, action: 'queue-control:set' }, updated, 200)
}

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemFlags } from '@/lib/system-control.js'
import { createInboxSendNowQueueRow } from '@/lib/domain/inbox/send-now-service.js'

function clean(value) {
  return String(value ?? '').trim()
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const v = clean(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return fallback
}

function toStatus(value) {
  return clean(value).toLowerCase()
}

export function isCanonicalThreadKey(threadKey) {
  // Canonical thread_key is strictly E.164: +1 followed by 10 digits.
  // Previous regex allowed colons and other chars, permitting composite legacy keys.
  return /^\+1\d{10}$/.test(clean(threadKey))
}

export function isNegativeOrWrongNumberIntent(intentValue) {
  const intent = toStatus(intentValue)
  return new Set([
    'not_interested',
    'wrong_number',
    'wrong_person',
    'not_owner',
    'opt_out',
    'hostile_or_legal',
    'hostile',
    'legal_threat',
    'already_sold',
  ]).has(intent)
}

function isPausedReview(row) {
  const status = toStatus(row?.queue_status)
  const pausedReason = toStatus(row?.paused_reason)
  return status === 'paused_review' || pausedReason === 'paused_review'
}

function isIncidentQuarantine(row) {
  const status = toStatus(row?.queue_status)
  const blockedReason = toStatus(row?.blocked_reason)
  const metadata = row?.metadata || {}
  return (
    status === 'incident_quarantine' ||
    blockedReason === 'incident_quarantine' ||
    metadata.incident_quarantine === true ||
    metadata.quarantine === true
  )
}

function hasValidPhone(phone) {
  const normalized = clean(phone).replace(/\D/g, '')
  return normalized.length >= 10
}

function okResponse(action, extras = {}) {
  return { ok: true, action, ...extras }
}

function blockedResponse(action, reason, extras = {}) {
  return { ok: false, action, blocked: true, reason, ...extras }
}

export async function getCockpitHealth({ getFlags = getSystemFlags } = {}) {
  const flags = await getFlags([
    'dashboard_live_enabled',
    'outbound_sms_enabled',
    'queue_runner_enabled',
    'auto_reply_enabled',
    'followup_enabled',
  ])

  return okResponse('health', { diagnostics: { flags } })
}

export async function getCockpitQueueStatus({ supabase = defaultSupabase } = {}) {
  const { data, error } = await supabase
    .from('send_queue')
    .select('queue_status,type')
    .limit(10000)

  if (error) throw error

  const counts = {}
  for (const row of data || []) {
    const status = toStatus(row.queue_status || 'unknown')
    const type = toStatus(row.type || 'outbound')
    counts[status] = (counts[status] || 0) + 1
    counts[`${type}:${status}`] = (counts[`${type}:${status}`] || 0) + 1
  }

  return okResponse('queue_status', { diagnostics: { counts } })
}

export async function runQueueAction({ action, payload = {}, supabase = defaultSupabase, getFlags = getSystemFlags } = {}) {
  const queueItemId = clean(payload.queue_item_id || payload.queue_id || payload.id)
  const dryRun = asBoolean(payload.dry_run, true)
  if (!queueItemId) return blockedResponse(action, 'missing_queue_item_id')

  const flags = await getFlags([
    'outbound_sms_enabled',
    'queue_runner_enabled',
    'followup_enabled',
  ])

  const { data: row, error } = await supabase
    .from('send_queue')
    .select('*')
    .eq('id', queueItemId)
    .maybeSingle()

  if (error) throw error
  if (!row) return blockedResponse(action, 'queue_item_not_found', { queue_item_id: queueItemId, dry_run: dryRun })

  if (isPausedReview(row)) return blockedResponse(action, 'paused_review', { queue_item_id: queueItemId, dry_run: dryRun })
  if (isIncidentQuarantine(row)) return blockedResponse(action, 'incident_quarantine', { queue_item_id: queueItemId, dry_run: dryRun })

  const requiresOutbound = new Set(['approve', 'retry', 'retry-routing']).has(action)
  if (requiresOutbound && !flags.outbound_sms_enabled) {
    return blockedResponse(action, 'outbound_sms_disabled', { queue_item_id: queueItemId, dry_run: dryRun })
  }
  if (requiresOutbound && !flags.queue_runner_enabled) {
    return blockedResponse(action, 'queue_runner_disabled', { queue_item_id: queueItemId, dry_run: dryRun })
  }
  if (action === 'retry-routing' && !flags.followup_enabled) {
    return blockedResponse(action, 'followup_disabled', { queue_item_id: queueItemId, dry_run: dryRun })
  }

  if (['retry', 'retry-routing'].includes(action)) {
    const statuses = ['queued', 'scheduled', 'sending', 'sent', 'delivered']
    const dupQuery = supabase
      .from('send_queue')
      .select('id', { head: true, count: 'exact' })
      .neq('id', queueItemId)
      .eq('thread_key', row.thread_key || '')
      .eq('to_phone_number', row.to_phone_number || '')
      .in('queue_status', statuses)
      .limit(1)

    const { count: dupCount, error: dupErr } = await dupQuery
    if (dupErr) throw dupErr
    if ((dupCount || 0) > 0) {
      return blockedResponse(action, 'duplicate_active_or_sent_queue_row', {
        queue_item_id: queueItemId,
        dry_run: dryRun,
      })
    }
  }

  if (dryRun) {
    return okResponse(action, {
      dry_run: true,
      queue_item_id: queueItemId,
      diagnostics: {
        queue_status: row.queue_status,
        thread_key: row.thread_key || null,
      },
    })
  }

  const statusMap = {
    approve: 'queued',
    cancel: 'cancelled',
    retry: 'queued',
    hold: 'held',
    reschedule: 'scheduled',
    'retry-routing': 'queued',
  }

  const patch = {
    queue_status: statusMap[action] || row.queue_status,
    updated_at: new Date().toISOString(),
    metadata: {
      ...(row.metadata || {}),
      cockpit_action: action,
      cockpit_action_at: new Date().toISOString(),
    },
  }

  if (action === 'reschedule') {
    const scheduledFor = clean(payload.scheduled_for)
    if (!scheduledFor) return blockedResponse(action, 'missing_scheduled_for', { queue_item_id: queueItemId })
    patch.scheduled_for = scheduledFor
  }

  const { data: updated, error: updateErr } = await supabase
    .from('send_queue')
    .update(patch)
    .eq('id', queueItemId)
    .select('id,queue_status,thread_key')
    .maybeSingle()

  if (updateErr) throw updateErr

  return okResponse(action, {
    dry_run: false,
    queue_item_id: queueItemId,
    thread_key: updated?.thread_key || row.thread_key || null,
  })
}

export async function runInboxAction({ action, payload = {}, supabase = defaultSupabase, getFlags = getSystemFlags } = {}) {
  const dryRun = asBoolean(payload.dry_run, true)

  // Resolve thread_key with fallbacks:
  // 1. payload.thread_key (top-level, set by buildQueueRoutingColumns when thread.threadKey is truthy)
  // 2. payload.metadata.thread_key (buried in metadata object)
  // 3. payload.to_phone_number (for inbox sends thread_key == seller E.164 phone)
  const threadKey = clean(payload.thread_key)
    || clean(payload.metadata?.thread_key)
    || clean(payload.to_phone_number)

  if (!isCanonicalThreadKey(threadKey)) {
    return blockedResponse(action, 'invalid_canonical_thread_key', { dry_run: dryRun, thread_key: threadKey || null })
  }

  const flags = await getFlags([
    'outbound_sms_enabled',
    'queue_runner_enabled',
    'auto_reply_enabled',
    'followup_enabled',
  ])

  if (!flags.outbound_sms_enabled) return blockedResponse(action, 'outbound_sms_disabled', { dry_run: dryRun, thread_key: threadKey })
  if (!flags.queue_runner_enabled) return blockedResponse(action, 'queue_runner_disabled', { dry_run: dryRun, thread_key: threadKey })

  if (action === 'auto-reply' && !flags.auto_reply_enabled) {
    return blockedResponse(action, 'auto_reply_disabled', { dry_run: dryRun, thread_key: threadKey })
  }

  if (['queue-reply', 'schedule-reply'].includes(action) && !flags.followup_enabled) {
    return blockedResponse(action, 'followup_disabled', { dry_run: dryRun, thread_key: threadKey })
  }

  const intent = clean(payload.intent || payload.last_intent || payload.detected_intent)
  if (action === 'auto-reply' && isNegativeOrWrongNumberIntent(intent)) {
    return blockedResponse(action, 'negative_or_wrong_number_intent_blocked', {
      dry_run: dryRun,
      thread_key: threadKey,
      diagnostics: { intent },
    })
  }

  const toPhone = clean(payload.to_phone_number || payload.phone)
  const fromPhone = clean(payload.from_phone_number || payload.our_number)

  if (['send-now', 'queue-reply', 'schedule-reply'].includes(action)) {
    if (!hasValidPhone(toPhone)) {
      return blockedResponse(action, 'invalid_to_phone_number', { dry_run: dryRun, thread_key: threadKey })
    }
    if (!hasValidPhone(fromPhone)) {
      return blockedResponse(action, 'invalid_from_phone_number', { dry_run: dryRun, thread_key: threadKey })
    }
  }

  // Check thread-level state to enforce pause/quarantine gate.
  const { data: threadState, error: stateErr } = await supabase
    .from('inbox_thread_state')
    .select('thread_key,status,automation_status,is_suppressed,metadata')
    .eq('thread_key', threadKey)
    .maybeSingle()

  if (stateErr) throw stateErr
  if (toStatus(threadState?.status) === 'paused_review') {
    return blockedResponse(action, 'paused_review', { dry_run: dryRun, thread_key: threadKey })
  }
  if ((threadState?.metadata || {}).incident_quarantine === true) {
    return blockedResponse(action, 'incident_quarantine', { dry_run: dryRun, thread_key: threadKey })
  }

  if (dryRun) {
    return okResponse(action, {
      dry_run: true,
      thread_key: threadKey,
      diagnostics: {
        queue_item_id: clean(payload.queue_item_id) || null,
      },
    })
  }

  // ── send-now: create queue row and return result ─────────────────────────
  if (action === 'send-now') {
    const sendResult = await createInboxSendNowQueueRow(
      { ...payload, thread_key: threadKey },
      { supabase }
    )

    if (!sendResult.ok) {
      return blockedResponse(action, sendResult.error || 'send_queue_insert_failed', {
        dry_run: false,
        thread_key: threadKey,
        diagnostics: { send_error: sendResult.error },
      })
    }

    return okResponse(action, {
      dry_run: false,
      thread_key: threadKey,
      queue_id: sendResult.queue_id || null,
      queue_key: sendResult.queue_key || null,
      queue_created: sendResult.queue_created,
    })
  }

  return blockedResponse(action, 'action_not_implemented', {
    dry_run: false,
    thread_key: threadKey,
  })
}

const THREAD_STATE_ALLOWED_FIELDS = new Set([
  // visibility / workflow flags
  'is_read',
  'is_pinned',
  'is_archived',
  'assigned_user',
  'manual_review',
  // operator-settable state fields
  'conversation_status',
  'seller_stage',
  'temperature',
  'autopilot_mode',
])

const THREAD_STATE_FORBIDDEN_FIELDS = new Set([
  'seller_status',
  'seller_state',
  'is_hot_lead',
  'positive_flag',
  'classification',
])

const SAFE_STATE_VALUES = {
  conversation_status: new Set(['new_reply','active_communication','waiting','follow_up','offer_sent','contract_sent','under_contract','closed']),
  seller_stage:        new Set(['s1_ownership','s2_interest','s3_pricing','s4_condition','s5_offer','s6_negotiation','s7_follow_up','s8_closing']),
  temperature:         new Set(['hot','warm','cold','dead']),
  autopilot_mode:      new Set(['autopilot_on','autopilot_paused','manual_only']),
}

export async function patchThreadStateSafe({ payload = {}, supabase = defaultSupabase } = {}) {
  const dryRun = asBoolean(payload.dry_run, false)
  const threadKey = clean(payload.thread_key)
  if (!isCanonicalThreadKey(threadKey)) {
    return blockedResponse('thread-state', 'invalid_canonical_thread_key', { thread_key: threadKey || null, dry_run: dryRun })
  }

  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload
  const keys = Object.keys(patch || {})

  const forbiddenAttempt = keys.find((k) => THREAD_STATE_FORBIDDEN_FIELDS.has(k))
  if (forbiddenAttempt) {
    return blockedResponse('thread-state', `forbidden_patch_field:${forbiddenAttempt}`, { thread_key: threadKey, dry_run: dryRun })
  }

  const allowedPatch = {}
  for (const k of keys) {
    if (THREAD_STATE_ALLOWED_FIELDS.has(k)) allowedPatch[k] = patch[k]
  }

  if (Object.keys(allowedPatch).length === 0) {
    return blockedResponse('thread-state', 'no_allowed_patch_fields', { thread_key: threadKey, dry_run: dryRun })
  }

  // Validate enum values for state fields — reject unknown values to prevent data corruption
  for (const [field, allowed] of Object.entries(SAFE_STATE_VALUES)) {
    if (field in allowedPatch && !allowed.has(clean(allowedPatch[field]))) {
      return blockedResponse('thread-state', `invalid_value:${field}`, { thread_key: threadKey, value: allowedPatch[field] })
    }
  }

  const now = new Date().toISOString()
  const rowPatch = {
    thread_key: threadKey,
    updated_at: now,
    ...('is_read' in allowedPatch ? { is_read: asBoolean(allowedPatch.is_read, false), read_at: asBoolean(allowedPatch.is_read, false) ? now : null } : {}),
    ...('is_pinned' in allowedPatch ? { is_pinned: asBoolean(allowedPatch.is_pinned, false) } : {}),
    ...('is_archived' in allowedPatch ? { is_archived: asBoolean(allowedPatch.is_archived, false), archived_at: asBoolean(allowedPatch.is_archived, false) ? now : null } : {}),
    ...('assigned_user' in allowedPatch ? { assigned_user: clean(allowedPatch.assigned_user) || null } : {}),
    ...('manual_review' in allowedPatch ? { manual_review: asBoolean(allowedPatch.manual_review, false) } : {}),
    // Operator-settable state fields
    ...('conversation_status' in allowedPatch ? { conversation_status: clean(allowedPatch.conversation_status) } : {}),
    ...('seller_stage' in allowedPatch ? { seller_stage: clean(allowedPatch.seller_stage) } : {}),
    ...('temperature' in allowedPatch ? { temperature: clean(allowedPatch.temperature) } : {}),
    ...('autopilot_mode' in allowedPatch ? { autopilot_mode: clean(allowedPatch.autopilot_mode) } : {}),
  }

  if (dryRun) {
    return okResponse('thread-state', { dry_run: true, thread_key: threadKey, diagnostics: { patch: rowPatch } })
  }

  const { data, error } = await supabase
    .from('inbox_thread_state')
    .upsert(rowPatch, { onConflict: 'thread_key' })
    .select('thread_key,is_read,is_pinned,is_archived,assigned_user,manual_review,conversation_status,seller_stage,temperature,autopilot_mode,updated_at')
    .maybeSingle()

  if (error) {
    // Column may not exist yet — degrade gracefully and retry without state fields
    if (error.code === '42703' || error.message?.includes('column')) {
      const coreFields = ['thread_key','updated_at','is_read','read_at','is_pinned','is_archived','archived_at','assigned_user','manual_review']
      const coreRowPatch = Object.fromEntries(Object.entries(rowPatch).filter(([k]) => coreFields.includes(k)))
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('inbox_thread_state')
        .upsert(coreRowPatch, { onConflict: 'thread_key' })
        .select('thread_key,updated_at')
        .maybeSingle()
      if (fallbackError) throw fallbackError
      return okResponse('thread-state', {
        dry_run: false,
        thread_key: threadKey,
        partial: true,
        note: 'state_columns_pending_migration',
        diagnostics: { row: fallbackData || null },
      })
    }
    throw error
  }

  return okResponse('thread-state', {
    dry_run: false,
    thread_key: threadKey,
    diagnostics: { row: data || null },
  })
}


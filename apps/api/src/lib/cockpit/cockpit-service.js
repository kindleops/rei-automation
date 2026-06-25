import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemFlags } from '@/lib/system-control.js'
import { createInboxSendNowQueueRow, executeManualInboxSendNow } from '@/lib/domain/inbox/send-now-service.js'
import { child } from '@/lib/logging/logger.js'

const logger = child({ module: 'cockpit.cockpit_service' })

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

const CANONICAL_ACTIVE_QUEUE_STATUSES = ['queued', 'pending', 'approval', 'scheduled', 'processing']
const CANONICAL_TERMINAL_QUEUE_STATUSES = ['sent', 'delivered', 'failed', 'blocked', 'cancelled', 'expired', 'duplicate_blocked']

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

function buildInboxActionLogMeta(action, payload = {}, threadKey, flags = null) {
  const meta = {
    action,
    thread_key: threadKey || null,
    to_phone_number: clean(payload.to_phone_number || payload.phone) || null,
    from_phone_number: clean(payload.from_phone_number || payload.our_number) || null,
    message_body_length: clean(payload.message_body || payload.message_text).length,
    operator_override: asBoolean(payload.operator_override, false) || asBoolean(payload.force, false),
  }

  if (flags && typeof flags === 'object') meta.flags = flags
  return meta
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
  const canonical_statuses = [
    ...CANONICAL_ACTIVE_QUEUE_STATUSES,
    ...CANONICAL_TERMINAL_QUEUE_STATUSES,
    'sending',
    'ready',
    'approved',
    'paused_invalid_queue_row',
    'paused_max_retries',
    'paused_name_missing',
    'incident_quarantine',
    'unknown',
  ]

  const count_queries = canonical_statuses.map((status) =>
    supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('queue_status', status)
  )

  const total_query = supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })

  const settled = await Promise.all([...count_queries, total_query])
  const counts = {}
  canonical_statuses.forEach((status, idx) => {
    counts[status] = settled[idx]?.count ?? 0
  })
  counts.total = settled[settled.length - 1]?.count ?? 0
  counts.active_total = CANONICAL_ACTIVE_QUEUE_STATUSES.reduce((sum, s) => sum + (counts[s] || 0), 0)
  counts.terminal_total = CANONICAL_TERMINAL_QUEUE_STATUSES.reduce((sum, s) => sum + (counts[s] || 0), 0)

  return okResponse('queue_status', {
    diagnostics: {
      counts,
      canonical_active_statuses: CANONICAL_ACTIVE_QUEUE_STATUSES,
      canonical_terminal_statuses: CANONICAL_TERMINAL_QUEUE_STATUSES,
    },
  })
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

export async function runInboxAction({
  action,
  payload = {},
  supabase = defaultSupabase,
  getFlags = getSystemFlags,
} = {}) {
  const dryRun = asBoolean(payload.dry_run, true)
  const operatorOverride = asBoolean(payload.operator_override, false) || asBoolean(payload.force, false)
  const requestedToPhone = clean(payload.to_phone_number || payload.phone)

  if (action === 'send-now' && !hasValidPhone(requestedToPhone)) {
    return blockedResponse(action, 'invalid_number', { status: 400, dry_run: dryRun, thread_key: null })
  }

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
    'automation_enabled',
    'operator_send_enabled',
    'outbound_sms_enabled',
    'queue_runner_enabled',
    'auto_reply_enabled',
    'followup_enabled',
    'feeder_enabled',
    'queue_auto_enqueue_enabled',
  ])

  const isManualOperatorSend = action === 'send-now'
  const overrideAllowed = isManualOperatorSend && operatorOverride === true
  const logMeta = buildInboxActionLogMeta(action, payload, threadKey, flags)

  if (isManualOperatorSend) {
    logger.info('cockpit_send_now.requested', logMeta)
    if (flags.automation_enabled === false) {
      logger.info('cockpit_send_now.gate_bypassed', { ...logMeta, reason: 'automation_disabled' })
    }
    if (flags.feeder_enabled === false) {
      logger.info('cockpit_send_now.gate_bypassed', { ...logMeta, reason: 'feeder_disabled' })
    }
    if (flags.queue_auto_enqueue_enabled === false) {
      logger.info('cockpit_send_now.gate_bypassed', { ...logMeta, reason: 'queue_batch_disabled' })
    }
    if (flags.operator_send_enabled === false) {
      logger.info('cockpit_send_now.gate_bypassed', {
        ...logMeta,
        reason: 'operator_send_disabled',
      })
    }
  }

  if (!isManualOperatorSend && !flags.outbound_sms_enabled && !overrideAllowed) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'outbound_sms_disabled' })
    return blockedResponse(action, 'outbound_sms_disabled', { status: 423, dry_run: dryRun, thread_key: threadKey })
  }
  if (!isManualOperatorSend && !flags.queue_runner_enabled && !overrideAllowed) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'queue_runner_disabled' })
    return blockedResponse(action, 'queue_runner_disabled', { status: 423, dry_run: dryRun, thread_key: threadKey })
  }

  if (action === 'auto-reply' && !flags.auto_reply_enabled) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'auto_reply_disabled' })
    return blockedResponse(action, 'auto_reply_disabled', { status: 423, dry_run: dryRun, thread_key: threadKey })
  }

  if (['queue-reply', 'schedule-reply'].includes(action) && !flags.followup_enabled) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'followup_disabled' })
    return blockedResponse(action, 'followup_disabled', { status: 423, dry_run: dryRun, thread_key: threadKey })
  }

  const intent = clean(payload.intent || payload.last_intent || payload.detected_intent)
  if (action === 'auto-reply' && isNegativeOrWrongNumberIntent(intent)) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'negative_or_wrong_number_intent_blocked', intent })
    return blockedResponse(action, 'negative_or_wrong_number_intent_blocked', {
      status: 423,
      dry_run: dryRun,
      thread_key: threadKey,
      diagnostics: { intent },
    })
  }

  const toPhone = clean(payload.to_phone_number || payload.phone)
  const fromPhone = clean(payload.from_phone_number || payload.our_number)

  if (['send-now', 'queue-reply', 'schedule-reply'].includes(action)) {
    if (!hasValidPhone(toPhone)) {
      const reason = action === 'send-now' ? 'invalid_number' : 'invalid_to_phone_number'
      logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason })
      return blockedResponse(action, reason, { status: 400, dry_run: dryRun, thread_key: threadKey })
    }
    if (action !== 'send-now' && !hasValidPhone(fromPhone)) {
      logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'invalid_from_phone_number' })
      return blockedResponse(action, 'invalid_from_phone_number', { status: 400, dry_run: dryRun, thread_key: threadKey })
    }
    if (action === 'send-now' && clean(fromPhone) && !hasValidPhone(fromPhone)) {
      logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'missing_routing' })
      return blockedResponse(action, 'missing_routing', { status: 400, dry_run: dryRun, thread_key: threadKey })
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
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'paused_review' })
    return blockedResponse(action, 'paused_review', { status: 423, dry_run: dryRun, thread_key: threadKey })
  }
  if ((threadState?.metadata || {}).incident_quarantine === true) {
    logger.warn('cockpit_inbox_action.early_exit', { ...logMeta, reason: 'incident_quarantine' })
    return blockedResponse(action, 'incident_quarantine', { status: 423, dry_run: dryRun, thread_key: threadKey })
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
    const sendResult = await executeManualInboxSendNow(
      {
        ...payload,
        thread_key: threadKey,
        source: 'manual_inbox',
        action: 'send_now',
        created_from: clean(payload.created_from) || 'leadcommand_inbox',
      },
      { supabase }
    )

    if (!sendResult.ok) {
      logger.warn('cockpit_inbox_action.early_exit', {
        ...logMeta,
        reason: sendResult.reason || sendResult.error || 'queue_insert_failure',
        detail_reason: sendResult.detail_reason || null,
        queue_inserted: sendResult.queue_inserted === true,
        queue_row_id: sendResult.queue_row_id || sendResult.queue_audit_id || null,
        queue_status: sendResult.queue_status || null,
      })
      return blockedResponse(action, sendResult.reason || sendResult.error || 'queue_insert_failure', {
        status: sendResult.status || 423,
        dry_run: false,
        thread_key: threadKey,
        queue_created: sendResult.queue_created === true,
        queue_inserted: sendResult.queue_inserted === true,
        queue_row_id: sendResult.queue_row_id || sendResult.queue_audit_id || null,
        queue_audit_id: sendResult.queue_audit_id || sendResult.queue_row_id || null,
        queue_id: sendResult.queue_id || sendResult.queue_audit_id || null,
        queue_key: sendResult.queue_key || null,
        queue_status: sendResult.queue_status || null,
        message_event_id: sendResult.message_event_id || null,
        provider_message_id: sendResult.provider_message_id || sendResult.provider_message_sid || null,
        delivery_status_display: sendResult.delivery_status_display || null,
        hard_block: sendResult.hard_block === true,
        operator_override_allowed: sendResult.operator_override_allowed === true,
        diagnostics: {
          send_error: sendResult.error || null,
          detail_reason: sendResult.detail_reason || null,
          send_now_proof: sendResult.proof || null,
          warning_codes: sendResult.warning_codes || [],
        },
      })
    }

      logger.info('cockpit_send_now.completed', {
        ...logMeta,
        queue_created: sendResult.queue_created === true,
        queue_inserted: sendResult.queue_inserted === true,
        queue_row_id: sendResult.queue_row_id || sendResult.queue_audit_id || null,
        queue_id: sendResult.queue_id || sendResult.queue_audit_id || null,
        queue_status: sendResult.queue_status || 'queued',
        warning_codes: sendResult.warning_codes || [],
      })
    return okResponse(action, {
      dry_run: false,
      thread_key: threadKey,
      queue_id: sendResult.queue_id || sendResult.queue_audit_id || null,
      queue_row_id: sendResult.queue_row_id || sendResult.queue_audit_id || null,
      queue_audit_id: sendResult.queue_audit_id || sendResult.queue_row_id || null,
      queue_key: sendResult.queue_key || null,
      queue_created: sendResult.queue_created,
      queue_inserted: sendResult.queue_inserted === true,
      queue_status: sendResult.queue_status || 'sent',
      message_event_id: sendResult.message_event_id || null,
      provider_message_id: sendResult.provider_message_id || sendResult.provider_message_sid || null,
      delivery_status_display: sendResult.delivery_status_display || 'sent',
      diagnostics: {
        send_now_proof: sendResult.proof || null,
        queue_send_result: sendResult.diagnostics?.queue_send_result || null,
        warning_codes: sendResult.warning_codes || [],
      },
    })
  }

  if (action === 'queue-reply' || action === 'schedule-reply' || action === 'auto-reply') {
    const messageType = action === 'auto-reply' ? 'auto_reply' : (action === 'schedule-reply' ? 'manual_scheduled_reply' : 'manual_reply')
    const useCaseTemplate = clean(payload.use_case_template || payload.useCaseTemplate || (action === 'auto-reply' ? 'auto_reply' : 'manual_reply'))
    const scheduledFor = clean(payload.scheduled_for || payload.scheduled_for_utc || payload.scheduledAt)

    const queueResult = await createInboxSendNowQueueRow(
      {
        ...payload,
        thread_key: threadKey,
        source: clean(payload.source) || 'inbox',
        action: action === 'auto-reply' ? 'auto_reply' : (action === 'schedule-reply' ? 'schedule_reply' : 'queue_reply'),
        created_from: clean(payload.created_from) || 'leadcommand_inbox',
        message_type: messageType,
        use_case_template: useCaseTemplate,
        type: 'outbound',
        scheduled_for: scheduledFor || undefined,
      },
      { supabase }
    )

    if (!queueResult.ok || !queueResult.queue_id) {
      return blockedResponse(action, queueResult.error || 'send_queue_insert_failed', {
        status: queueResult.status || 423,
        dry_run: false,
        thread_key: threadKey,
        diagnostics: { send_error: queueResult.error },
      })
    }

    if (action === 'schedule-reply' && scheduledFor) {
      const patch = {
        queue_status: 'scheduled',
        scheduled_for: scheduledFor,
        scheduled_for_utc: scheduledFor,
        scheduled_for_local: scheduledFor,
        updated_at: new Date().toISOString(),
      }
      const { error: scheduleError } = await supabase
        .from('send_queue')
        .update(patch)
        .eq('id', queueResult.queue_row_id || queueResult.queue_id)
      if (scheduleError) throw scheduleError
    }

    return okResponse(action, {
      dry_run: false,
      thread_key: threadKey,
      queue_id: queueResult.queue_id,
      queue_key: queueResult.queue_key || null,
      queue_created: true,
      queue_status: action === 'schedule-reply' ? 'scheduled' : 'queued',
    })
  }

  return blockedResponse(action, 'action_not_implemented', {
    status: 400,
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
    ...('is_read' in allowedPatch ? { is_read: asBoolean(allowedPatch.is_read, false), last_read_at: asBoolean(allowedPatch.is_read, false) ? now : null } : {}),
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
    .select('thread_key,is_read,is_pinned,is_archived,last_read_at,archived_at,updated_at')
    .maybeSingle()

  if (error) {
    // Column may not exist yet — degrade gracefully and retry without state fields
    if (error.code === '42703' || error.code === 'PGRST204' || error.message?.includes('column')) {
      const coreFields = ['thread_key','updated_at','is_read','last_read_at','is_pinned','is_archived','archived_at','assigned_user','manual_review']
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

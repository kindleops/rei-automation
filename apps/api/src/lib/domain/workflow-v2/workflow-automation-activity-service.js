import { createClient } from '@supabase/supabase-js'

function db(deps = {}) {
  if (deps.supabase) return deps.supabase
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('supabase_not_configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function clean(value) {
  return String(value ?? '').trim()
}

function lower(value) {
  return clean(value).toLowerCase()
}

function md(row) {
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
}

function payloadOf(row) {
  return row?.payload && typeof row.payload === 'object' ? row.payload : {}
}

function isFollowUpQueueRow(row) {
  const meta = md(row)
  const touch = Number(row.touch_number ?? meta.touch_number ?? 0)
  const useCase = lower(row.use_case ?? meta.use_case ?? '')
  if (touch > 1) return true
  if (meta.is_follow_up === true || lower(meta.is_follow_up) === 'true') return true
  if (useCase.includes('follow')) return true
  if (lower(meta.action) === 'no_reply_follow_up') return true
  if (lower(meta.send_action) === 'no_reply_follow_up') return true
  return false
}

function mapEnrollment(row) {
  const ctx = row.context && typeof row.context === 'object' ? row.context : {}
  return {
    id: row.id,
    source: 'workflow_v2',
    status: row.status,
    seller_stage: clean(ctx.seller_stage ?? ctx.stage),
    seller_status: clean(ctx.seller_status ?? ctx.status),
    seller_temperature: clean(ctx.temperature ?? ctx.seller_temperature),
    human_review_required: row.status === 'waiting' && Boolean(row.pause_reason ?? row.waiting_reason),
    stopped_reason: row.pause_reason ?? row.waiting_reason ?? null,
    next_scheduled_send: row.next_execution_at ?? null,
    seller_label: clean(ctx.seller_display_name ?? ctx.seller_name ?? row.subject_id),
    property_label: clean(ctx.property_address ?? ctx.property_id),
    workflow_definition_id: row.workflow_definition_id,
    current_node_id: row.current_node_id,
    enrolled_at: row.enrolled_at,
    updated_at: row.updated_at,
  }
}

function mapScheduledTask(row) {
  const payload = payloadOf(row)
  return {
    id: row.id,
    source: 'workflow_v2',
    status: row.status,
    seller_stage: clean(payload.seller_stage ?? payload.stage),
    seller_status: clean(payload.seller_status ?? payload.status),
    seller_temperature: clean(payload.seller_temperature ?? payload.temperature),
    human_review_required: row.status === 'failed' || row.status === 'cancelled',
    stopped_reason: row.reason ?? null,
    next_scheduled_send: row.scheduled_for ?? null,
    seller_label: clean(payload.seller_display_name ?? payload.seller_name ?? payload.subject_id),
    property_label: clean(payload.property_address ?? payload.property_id),
    workflow_definition_id: row.workflow_definition_id,
    node_id: row.node_id,
    task_type: row.task_type ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapSendQueueFollowUp(row) {
  const meta = md(row)
  return {
    id: row.id,
    source: 'send_queue_followup',
    status: row.queue_status ?? row.status,
    seller_stage: clean(meta.seller_stage ?? meta.canonical_stage ?? row.stage),
    seller_status: clean(meta.seller_status ?? meta.universal_status),
    seller_temperature: clean(meta.seller_temperature ?? meta.temperature),
    human_review_required: row.queue_status === 'approval' || row.requires_approval === true,
    stopped_reason: row.failed_reason ?? row.blocked_reason ?? row.paused_reason ?? null,
    next_scheduled_send: row.scheduled_for ?? row.scheduled_for_utc ?? null,
    seller_label: clean(meta.seller_display_name ?? meta.seller_name ?? row.seller_name),
    property_label: clean(row.property_address ?? meta.property_address),
    touch_number: Number(row.touch_number ?? meta.touch_number ?? 0) || null,
    use_case: clean(row.use_case ?? meta.use_case),
    auto_reply_authority: lower(meta.auto_reply_authority) || lower(meta.auto_reply_mode) || null,
    campaign_id: row.campaign_id ?? meta.campaign_id ?? null,
    thread_key: clean(meta.thread_key ?? meta.conversation_thread_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function fetchSource(label, queryPromise) {
  try {
    const result = await queryPromise
    if (result?.error) {
      return { rows: [], warning: `${label}: ${result.error.message || String(result.error)}` }
    }
    return { rows: result.data ?? [], warning: null }
  } catch (error) {
    return { rows: [], warning: `${label}: ${error?.message || String(error)}` }
  }
}

/**
 * Read-only aggregation of real automation activity across workflow tables and send_queue.
 * Schema-safe: uses only columns present in current migrations. Partial source failures
 * degrade gracefully so send_queue follow-up activity can still be returned.
 */
export async function listWorkflowAutomationActivity(options = {}, deps = {}) {
  const client = db(deps)
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 300)
  const warnings = []

  const enrollmentSelect = [
    'id',
    'workflow_definition_id',
    'subject_type',
    'subject_id',
    'status',
    'context',
    'current_node_id',
    'enrolled_at',
    'updated_at',
    'next_execution_at',
    'waiting_reason',
    'pause_reason',
    'paused_at',
    'terminated_at',
    'completed_at',
  ].join(', ')

  const taskSelect = [
    'id',
    'workflow_definition_id',
    'enrollment_id',
    'run_id',
    'node_id',
    'task_type',
    'status',
    'scheduled_for',
    'reason',
    'payload',
    'created_at',
    'updated_at',
    'completed_at',
  ].join(', ')

  const queueSelect = [
    'id',
    'queue_status',
    'status',
    'touch_number',
    'use_case',
    'stage',
    'seller_name',
    'property_address',
    'scheduled_for',
    'scheduled_for_utc',
    'failed_reason',
    'blocked_reason',
    'paused_reason',
    'requires_approval',
    'campaign_id',
    'metadata',
    'created_at',
    'updated_at',
  ].join(', ')

  const [enrollmentsFetch, tasksFetch, queueFetch] = await Promise.all([
    fetchSource('workflow_enrollments', client
      .from('workflow_enrollments')
      .select(enrollmentSelect)
      .order('updated_at', { ascending: false })
      .limit(limit)),
    fetchSource('workflow_scheduled_tasks', client
      .from('workflow_scheduled_tasks')
      .select(taskSelect)
      .order('updated_at', { ascending: false })
      .limit(limit)),
    fetchSource('send_queue', client
      .from('send_queue')
      .select(queueSelect)
      .gt('touch_number', 1)
      .in('queue_status', ['scheduled', 'queued', 'ready', 'sending', 'sent', 'approval', 'blocked', 'failed', 'cancelled', 'expired'])
      .order('updated_at', { ascending: false })
      .limit(limit * 2)),
  ])

  for (const fetch of [enrollmentsFetch, tasksFetch, queueFetch]) {
    if (fetch.warning) warnings.push(fetch.warning)
  }

  const enrollments = enrollmentsFetch.rows.map(mapEnrollment)
  const scheduled_tasks = tasksFetch.rows.map(mapScheduledTask)
  const queue_followups = queueFetch.rows.filter(isFollowUpQueueRow).map(mapSendQueueFollowUp)

  const activity = [...enrollments, ...scheduled_tasks, ...queue_followups]
    .sort((a, b) => String(b.updated_at ?? b.next_scheduled_send ?? '').localeCompare(String(a.updated_at ?? a.next_scheduled_send ?? '')))
    .slice(0, limit)

  const payload = {
    ok: true,
    activity,
    counts: {
      workflow_enrollments: enrollments.length,
      workflow_scheduled_tasks: scheduled_tasks.length,
      send_queue_followups: queue_followups.length,
      total: activity.length,
    },
    sources_present: {
      workflow_v2: enrollments.length > 0 || scheduled_tasks.length > 0,
      send_queue_followup: queue_followups.length > 0,
      seller_flow: activity.some((row) => row.source === 'send_queue_followup' && row.auto_reply_authority === 'seller_flow'),
      auto_reply: activity.some((row) => lower(row.auto_reply_authority).includes('auto')),
    },
  }

  if (warnings.length) {
    payload.degraded = true
    payload.warnings = warnings
  }

  return payload
}
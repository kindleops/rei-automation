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
    human_review_required: row.status === 'paused' && Boolean(row.block_reason),
    stopped_reason: row.block_reason ?? row.waiting_reason ?? null,
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
  return {
    id: row.id,
    source: 'workflow_v2',
    status: row.status,
    seller_stage: clean(row.seller_stage),
    seller_status: clean(row.seller_status),
    seller_temperature: clean(row.seller_temperature),
    human_review_required: row.status === 'blocked' || row.status === 'paused',
    stopped_reason: row.block_reason ?? row.cancel_reason ?? null,
    next_scheduled_send: row.scheduled_for ?? row.execute_at ?? null,
    seller_label: clean(row.subject_id),
    property_label: clean(row.property_id),
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

/**
 * Read-only aggregation of real automation activity across workflow tables and send_queue.
 * No writes. No SMS. No enable/disable controls.
 */
export async function listWorkflowAutomationActivity(options = {}, deps = {}) {
  const client = db(deps)
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 300)

  const [enrollmentsRes, tasksRes, queueRes] = await Promise.all([
    client
      .from('workflow_enrollments')
      .select('id, workflow_definition_id, workflow_run_id, subject_id, status, context, current_node_id, enrolled_at, updated_at, next_execution_at, waiting_reason, block_reason')
      .order('updated_at', { ascending: false })
      .limit(limit),
    client
      .from('workflow_scheduled_tasks')
      .select('id, workflow_definition_id, node_id, subject_id, property_id, status, task_type, scheduled_for, execute_at, seller_stage, seller_status, seller_temperature, block_reason, cancel_reason, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit),
    client
      .from('send_queue')
      .select('id, queue_status, status, touch_number, use_case, stage, seller_name, property_address, scheduled_for, scheduled_for_utc, failed_reason, blocked_reason, paused_reason, requires_approval, campaign_id, metadata, created_at, updated_at')
      .gt('touch_number', 1)
      .in('queue_status', ['scheduled', 'queued', 'ready', 'sending', 'sent', 'approval', 'blocked', 'failed', 'cancelled', 'expired'])
      .order('updated_at', { ascending: false })
      .limit(limit * 2),
  ])

  if (enrollmentsRes.error) throw enrollmentsRes.error
  if (tasksRes.error) throw tasksRes.error
  if (queueRes.error) throw queueRes.error

  const enrollments = (enrollmentsRes.data ?? []).map(mapEnrollment)
  const scheduled_tasks = (tasksRes.data ?? []).map(mapScheduledTask)
  const queue_followups = (queueRes.data ?? []).filter(isFollowUpQueueRow).map(mapSendQueueFollowUp)

  const activity = [...enrollments, ...scheduled_tasks, ...queue_followups]
    .sort((a, b) => String(b.updated_at ?? b.next_scheduled_send ?? '').localeCompare(String(a.updated_at ?? a.next_scheduled_send ?? '')))
    .slice(0, limit)

  return {
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
}
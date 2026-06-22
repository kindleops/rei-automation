/**
 * Canonical failure contract — target preparation vs execution failures.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const EXECUTION_FAILURE_STATUSES = ['failed', 'expired', 'blocked', 'suppressed']
const TARGET_FAILURE_STATUSES = ['failed', 'blocked', 'suppressed', 'skipped']

function clean(value) {
  return String(value ?? '').trim()
}

function classifyExecutionFailure(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const explicit = clean(row.failure_category || meta.failure_category)
  if (explicit) return explicit

  const reason = clean(row.failed_reason || meta.failed_reason || meta.provider_error).toLowerCase()
  if (reason.includes('21610') || reason.includes('opt-out') || reason.includes('suppression')) {
    return 'compliance_terminalization'
  }
  if (reason.includes('invalid') && (reason.includes('phone') || reason.includes('recipient'))) {
    return 'invalid_destination'
  }
  if (reason.includes('template')) return 'missing_template'
  if (reason.includes('sender') || reason.includes('routing')) return 'routing_failure'
  if (reason.includes('duplicate')) return 'duplicate_prevention'
  if (reason.includes('retry')) return 'retry_exhaustion'
  if (reason.includes('provider') || reason.includes('textgrid')) return 'provider_failure'
  if (clean(row.queue_status) === 'blocked') return 'queue_validation'
  return 'internal_execution_error'
}

function classifyTargetFailure(target = {}) {
  const block = clean(target.block_reason).toLowerCase()
  const suppression = clean(target.suppression_status).toLowerCase()
  const routing = clean(target.routing_status).toLowerCase()
  const template = clean(target.template_status).toLowerCase()
  const identity = clean(target.identity_status).toLowerCase()

  if (suppression === 'blocked' || block.includes('suppression') || block.includes('21610')) {
    return 'compliance_suppression'
  }
  if (block.includes('phone') || block.includes('invalid') || identity === 'blocked') {
    return 'invalid_destination'
  }
  if (routing === 'blocked' || block.includes('sender') || block.includes('routing')) {
    return 'no_sender_coverage'
  }
  if (template === 'missing' || template === 'blocked' || block.includes('template')) {
    return 'missing_template'
  }
  if (block.includes('language')) return 'language_coverage_missing'
  if (block.includes('history')) return 'history_unavailable'
  if (block.includes('linkage') || block.includes('canonical')) return 'missing_canonical_linkage'
  if (clean(target.target_status) === 'failed') return 'eligibility_routing_failed'
  return 'target_preparation_failure'
}

async function loadCurrentRunId(supabase, campaignId) {
  const { data } = await supabase
    .from('campaign_runs')
    .select('id')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

function groupFailures(rows, keyField) {
  const groups = new Map()
  for (const row of rows) {
    const key = row[keyField]
    if (!groups.has(key)) {
      groups.set(key, {
        failure_category: key,
        count: 0,
        severity: key.includes('compliance') ? 'critical' : 'warning',
        sample_numbers: [],
        sample_reasons: [],
      })
    }
    const g = groups.get(key)
    g.count += 1
    const sample = row.recipient || row.to_phone_number || row.seller_full_name
    if (sample && g.sample_numbers.length < 5) g.sample_numbers.push(String(sample))
    const reason = row.failure_reason || row.block_reason
    if (reason && g.sample_reasons.length < 5) g.sample_reasons.push(String(reason))
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count)
}

export async function fetchCampaignFailureRows(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) {
    return {
      ok: false,
      error: 'campaign_id_required',
      target_preparation: { total: 0, failures: [], groups: [] },
      execution: { total: 0, failures: [], groups: [] },
      total: 0,
    }
  }

  const runId = await loadCurrentRunId(supabase, campaignId)

  const [{ data: targetRows, error: targetErr }, { data: queueRows, error: queueErr }] = await Promise.all([
    supabase
      .from('campaign_targets')
      .select('id,seller_full_name,property_address_full,language,market,target_status,block_reason,suppression_status,routing_status,template_status,identity_status,to_phone_number,updated_at')
      .eq('campaign_id', campaignId)
      .in('target_status', TARGET_FAILURE_STATUSES)
      .limit(1000),
    supabase
      .from('send_queue')
      .select('id,campaign_id,campaign_target_id,queue_status,scheduled_for,updated_at,failed_reason,failure_category,template_id,from_phone_number,to_phone_number,metadata')
      .eq('campaign_id', campaignId)
      .in('queue_status', EXECUTION_FAILURE_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(500),
  ])

  if (targetErr) throw targetErr
  if (queueErr) throw queueErr

  const targetPreparationFailures = (targetRows || []).map((target) => {
    const category = classifyTargetFailure(target)
    return {
      id: target.id,
      campaign_id: campaignId,
      campaign_target_id: target.id,
      queue_row_id: null,
      failure_class: 'target_preparation',
      recipient: target.seller_full_name || target.to_phone_number || null,
      property: target.property_address_full || null,
      target_id: target.id,
      failure_category: category,
      failure_reason: target.block_reason || target.target_status || null,
      language: target.language || null,
      terminal: true,
      retryable: false,
      campaign_run_id: runId,
      last_event_at: target.updated_at,
    }
  })

  const scopedQueue = (queueRows || []).filter((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    return !runId || !rowRun || rowRun === runId
  })

  const targetIds = scopedQueue.map((r) => r.campaign_target_id).filter(Boolean)
  let targetMap = new Map()
  if (targetIds.length) {
    const { data: targets } = await supabase
      .from('campaign_targets')
      .select('id,seller_full_name,property_address_full,language,market')
      .in('id', targetIds)
    for (const t of targets || []) targetMap.set(t.id, t)
  }

  const executionFailures = scopedQueue.map((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const target = row.campaign_target_id ? targetMap.get(row.campaign_target_id) : null
    const category = classifyExecutionFailure(row)
    const retryable = category === 'provider_failure'
    return {
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_target_id: row.campaign_target_id,
      queue_row_id: row.id,
      failure_class: 'execution',
      recipient: target?.seller_full_name || row.to_phone_number || null,
      property: target?.property_address_full || null,
      target_id: row.campaign_target_id,
      stage_touch: clean(meta.stage_code || meta.touch_number) || null,
      template_id: row.template_id || meta.template_id || null,
      template_name: clean(meta.template_name) || null,
      sender: row.from_phone_number || null,
      language: target?.language || meta.language || null,
      scheduled_time: row.scheduled_for,
      attempted_time: row.updated_at,
      provider: clean(meta.provider) || 'textgrid',
      provider_code: clean(meta.provider_code || meta.error_code) || null,
      failure_category: category,
      failure_reason: row.failed_reason || meta.failed_reason || null,
      retryable,
      terminal: true,
      suppression_action: category === 'compliance_terminalization' ? 'suppressed' : null,
      next_retry: null,
      campaign_run_id: runId,
      last_event_at: row.updated_at,
    }
  })

  const targetGroups = groupFailures(targetPreparationFailures, 'failure_category')
  const executionGroups = groupFailures(executionFailures, 'failure_category')

  return {
    ok: true,
    campaign_id: campaignId,
    run_id: runId,
    target_preparation: {
      total: targetPreparationFailures.length,
      failures: targetPreparationFailures,
      groups: targetGroups,
    },
    execution: {
      total: executionFailures.length,
      failures: executionFailures,
      groups: executionGroups,
    },
    total: targetPreparationFailures.length + executionFailures.length,
    failures: [...targetPreparationFailures, ...executionFailures],
    groups: [...targetGroups, ...executionGroups],
  }
}
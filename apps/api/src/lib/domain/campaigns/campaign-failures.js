/**
 * Canonical failure contract for Campaign Command — current campaign + run scope.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const FAILURE_STATUSES = ['failed', 'expired', 'blocked', 'suppressed']

function clean(value) {
  return String(value ?? '').trim()
}

function classifyFailure(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const explicit = clean(row.failure_category || meta.failure_category)
  if (explicit) return explicit

  const reason = clean(row.failed_reason || meta.failed_reason || meta.provider_error).toLowerCase()
  if (reason.includes('21610') || reason.includes('opt-out') || reason.includes('suppression')) {
    return 'compliance_suppression'
  }
  if (reason.includes('invalid') && reason.includes('phone')) return 'invalid_destination'
  if (reason.includes('template')) return 'missing_template'
  if (reason.includes('sender') || reason.includes('routing')) return 'routing_failure'
  if (reason.includes('duplicate')) return 'duplicate_prevention'
  if (reason.includes('provider') || reason.includes('textgrid')) return 'provider_rejection'
  return 'internal_execution_error'
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

export async function fetchCampaignFailureRows(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required', failures: [], total: 0 }

  const runId = await loadCurrentRunId(supabase, campaignId)

  const { data: queueRows, error: queueErr } = await supabase
    .from('send_queue')
    .select(`
      id,
      campaign_id,
      campaign_target_id,
      queue_status,
      scheduled_for,
      updated_at,
      failed_reason,
      failure_category,
      template_id,
      from_phone_number,
      to_phone_number,
      metadata
    `)
    .eq('campaign_id', campaignId)
    .in('queue_status', FAILURE_STATUSES)
    .order('updated_at', { ascending: false })
    .limit(500)

  if (queueErr) throw queueErr

  const scoped = (queueRows || []).filter((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    return !runId || !rowRun || rowRun === runId
  })

  const targetIds = scoped.map((r) => r.campaign_target_id).filter(Boolean)
  let targetMap = new Map()
  if (targetIds.length) {
    const { data: targets } = await supabase
      .from('campaign_targets')
      .select('id,seller_full_name,property_address_full,language,market,target_status,block_reason')
      .in('id', targetIds)
    for (const t of targets || []) targetMap.set(t.id, t)
  }

  const failures = scoped.map((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const target = row.campaign_target_id ? targetMap.get(row.campaign_target_id) : null
    const category = classifyFailure(row)
    const retryable = category === 'transient_provider_failure' || category === 'provider_rejection'
    return {
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_target_id: row.campaign_target_id,
      queue_row_id: row.id,
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
      suppression_action: category === 'compliance_suppression' ? 'suppressed' : null,
      next_retry: null,
      campaign_run_id: runId,
      last_event_at: row.updated_at,
    }
  })

  const groups = new Map()
  for (const f of failures) {
    const key = f.failure_category
    if (!groups.has(key)) {
      groups.set(key, {
        campaign_id: campaignId,
        failure_category: key,
        count: 0,
        severity: key === 'compliance_suppression' ? 'critical' : 'warning',
        sample_numbers: [],
        sample_reasons: [],
      })
    }
    const g = groups.get(key)
    g.count += 1
    if (f.recipient && g.sample_numbers.length < 5) g.sample_numbers.push(String(f.recipient))
    if (f.failure_reason && g.sample_reasons.length < 5) g.sample_reasons.push(f.failure_reason)
  }

  return {
    ok: true,
    campaign_id: campaignId,
    run_id: runId,
    total: failures.length,
    failures,
    groups: Array.from(groups.values()).sort((a, b) => b.count - a.count),
  }
}
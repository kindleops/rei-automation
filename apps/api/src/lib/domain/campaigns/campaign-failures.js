/**
 * Canonical failure contract — target preparation vs execution failures.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

/**
 * Terminal queue statuses whose name already says what happened. Each one ends
 * a message without sending it, so each is an exception — and was invisible
 * here while only failed/expired/blocked/suppressed were read (Miami: 84 held
 * by the template block, 13 undelivered, 8 held for missing details).
 * `cancelled` and `duplicate_blocked` stay out: a withdrawal and a stopped
 * duplicate are the system working, not a message that failed.
 */
const STATUS_CATEGORY = {
  failed_transport: (reason) => (reason === 'delivery_failed' ? 'undelivered' : 'transport_failure'),
  blocked_by_health_guard: (reason) => {
    if (reason.includes('template')) return 'template_held'
    if (reason.includes('sender')) return 'sender_held'
    return 'health_guard_hold'
  },
  carrier_blocked: () => 'content_filtered',
  invalid_number: () => 'invalid_destination',
  opted_out: () => 'compliance_terminalization',
  paused_invalid_queue_row: () => 'held_incomplete',
  paused_name_missing: () => 'held_incomplete',
  paused_deferred_unresolved: () => 'held_incomplete',
  paused_global_lock: () => 'held_incomplete',
  paused_max_retries: () => 'retry_exhaustion',
  incident_quarantine: () => 'incident_quarantine',
}

export const EXECUTION_FAILURE_STATUSES = ['failed', 'expired', 'blocked', 'suppressed', ...Object.keys(STATUS_CATEGORY)]
const TARGET_FAILURE_STATUSES = ['failed', 'blocked', 'suppressed', 'skipped']

/**
 * Counts come from every failure row, not from a sample.
 *
 * Totals and groups used to be counted from the 500 most recently updated
 * queue rows. Miami has 612 — 595 expired, 15 refused by the carrier (21610),
 * one blacklisted pair, one unconfirmed send — and the page reported
 * "internal_execution_error ×499, compliance ×1": the cap cut 15 of the 16
 * carrier refusals, and the expired rows had no category of their own.
 *
 * The scan reads only the light columns grouping needs, paged. The row-level
 * detail list stays a bounded sample of the most recent rows.
 */
const SCAN_PAGE_SIZE = 1000
const SCAN_MAX_PAGES = 25
const EXECUTION_SAMPLE_LIMIT = 500
const TARGET_LIST_LIMIT = 1000
// 500 ids in one `in.(…)` filter is a ~19 KB URL. The request failed (the
// response overflowed Node's header limit), took ~9 s to do it, and because
// the error wasn't read, every recipient silently lost its name.
const TARGET_LOOKUP_CHUNK = 100

// The metadata keys this module reads, selected one by one. Selecting the
// whole document pulled 3.1 MB for Miami's 500-row sample.
const SCAN_META_KEYS = ['failure_category', 'failed_reason', 'provider_error', 'run_id', 'campaign_run_id']
const SAMPLE_META_KEYS = [
  ...SCAN_META_KEYS,
  'stage_code', 'touch_number', 'template_id', 'template_name', 'language', 'provider', 'provider_code', 'error_code',
]
const metaSelect = (keys) => keys.map((key) => `meta_${key}:metadata->>${key}`).join(',')
const QUEUE_SCAN_SELECT = `id,queue_status,failed_reason,to_phone_number,updated_at,${metaSelect(SCAN_META_KEYS)}`
const QUEUE_SAMPLE_SELECT =
  `id,campaign_id,campaign_target_id,queue_status,scheduled_for,updated_at,failed_reason,template_id,from_phone_number,to_phone_number,${metaSelect(SAMPLE_META_KEYS)}`
const TARGET_SELECT =
  'id,owner_name,property_address,language,market,target_status,block_reason,suppression_status,routing_status,template_status,identity_status,to_phone_number,updated_at'

function clean(value) {
  return String(value ?? '').trim()
}

/** Rebuild a metadata object from the `meta_<key>` columns selected above. */
function metaFrom(row, keys) {
  const meta = {}
  for (const key of keys) {
    const value = row[`meta_${key}`]
    if (value !== null && value !== undefined && value !== '') meta[key] = value
  }
  return meta
}

function executionReason(row = {}, meta = {}) {
  return clean(row.failed_reason || meta.failed_reason || meta.provider_error)
}

function classifyExecutionFailure(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const explicit = clean(row.failure_category || meta.failure_category)
  if (explicit) return explicit

  const reason = executionReason(row, meta).toLowerCase()
  const byStatus = STATUS_CATEGORY[clean(row.queue_status)]
  if (byStatus) return byStatus(reason)
  if (reason.includes('21610') || reason.includes('blacklist') || reason.includes('opt-out') || reason.includes('suppression')) {
    return 'compliance_terminalization'
  }
  if (reason.includes('invalid') && (reason.includes('phone') || reason.includes('recipient'))) {
    return 'invalid_destination'
  }
  if (reason.includes('template')) return 'missing_template'
  if (reason.includes('sender') || reason.includes('routing')) return 'routing_failure'
  if (reason.includes('duplicate')) return 'duplicate_prevention'
  if (reason.includes('retry')) return 'retry_exhaustion'
  // finalizeSendQueueSuccess throws this when the provider call returns without
  // a message id: the send cannot be confirmed either way.
  if (reason.includes('no sid')) return 'provider_unconfirmed'
  if (reason.includes('provider') || reason.includes('textgrid')) return 'provider_failure'
  if (clean(row.queue_status) === 'blocked') return 'queue_validation'
  // Stale expiry only takes rows with no send evidence, so nothing went out.
  if (clean(row.queue_status) === 'expired') return 'expired_before_send'
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
        // When this last happened — an old problem and a live one read differently.
        latest_at: null,
      })
    }
    const g = groups.get(key)
    g.count += 1
    const at = row.last_event_at ? String(row.last_event_at) : null
    if (at && (!g.latest_at || Date.parse(at) > Date.parse(g.latest_at))) g.latest_at = at
    const sample = row.recipient || row.to_phone_number || row.seller_full_name
    if (sample && g.sample_numbers.length < 5) g.sample_numbers.push(String(sample))
    // Distinct reasons: five copies of one expiry code say less than one does.
    const reason = row.failure_reason || row.block_reason
    if (reason && g.sample_reasons.length < 5 && !g.sample_reasons.includes(String(reason))) {
      g.sample_reasons.push(String(reason))
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count)
}

/**
 * Read every row a query matches, a page at a time. The first page asks for an
 * exact count, so a server-side row cap smaller than the page cannot end the
 * scan early and pass a partial count off as the total.
 */
async function scanAll(buildQuery) {
  const rows = []
  let total = null
  let lastPageFull = false
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const from = rows.length
    const { data, error, count } = await buildQuery(page === 0).range(from, from + SCAN_PAGE_SIZE - 1)
    if (error) throw error
    const batch = Array.isArray(data) ? data : []
    if (page === 0 && Number.isFinite(count)) total = count
    rows.push(...batch)
    lastPageFull = batch.length >= SCAN_PAGE_SIZE
    if (batch.length === 0) break
    if (total !== null ? rows.length >= total : !lastPageFull) break
  }
  return { rows, truncated: total !== null ? rows.length < total : lastPageFull }
}

async function loadTargetsById(supabase, ids) {
  const unique = [...new Set(ids)]
  const chunks = []
  for (let i = 0; i < unique.length; i += TARGET_LOOKUP_CHUNK) chunks.push(unique.slice(i, i + TARGET_LOOKUP_CHUNK))
  const results = await Promise.all(chunks.map((chunk) => supabase
    .from('campaign_targets')
    .select('id,owner_name,property_address,language,market')
    .in('id', chunk)))
  const map = new Map()
  for (const { data, error } of results) {
    // Names are enrichment: a failed lookup leaves the phone number, not an error page.
    if (error) continue
    for (const target of data || []) map.set(target.id, target)
  }
  return map
}

/**
 * @param {string} campaignId
 * @param {{ supabase?: object, includeRows?: boolean }} deps
 *   `includeRows: false` returns totals and groups without the row-level
 *   lists, which are most of the payload and which the dashboard doesn't read.
 */
export async function fetchCampaignFailureRows(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const includeRows = deps.includeRows !== false
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
  const inCurrentRun = (meta) => {
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    return !runId || !rowRun || rowRun === runId
  }

  const [targetScan, queueScan, sample] = await Promise.all([
    scanAll((withCount) => supabase
      .from('campaign_targets')
      .select(TARGET_SELECT, withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .in('target_status', TARGET_FAILURE_STATUSES)
      .order('id', { ascending: true })),
    scanAll((withCount) => supabase
      .from('send_queue')
      .select(QUEUE_SCAN_SELECT, withCount ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .in('queue_status', EXECUTION_FAILURE_STATUSES)
      .order('id', { ascending: true })),
    includeRows
      ? supabase
        .from('send_queue')
        .select(QUEUE_SAMPLE_SELECT)
        .eq('campaign_id', campaignId)
        .in('queue_status', EXECUTION_FAILURE_STATUSES)
        .order('updated_at', { ascending: false })
        .limit(EXECUTION_SAMPLE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (sample.error) throw sample.error

  const targetPreparationFailures = targetScan.rows.map((target) => {
    const category = classifyTargetFailure(target)
    return {
      id: target.id,
      campaign_id: campaignId,
      campaign_target_id: target.id,
      queue_row_id: null,
      failure_class: 'target_preparation',
      recipient: target.owner_name || target.to_phone_number || null,
      property: target.property_address || null,
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

  // Every failure row in the current run, classified — this is what's counted.
  const executionCounted = []
  for (const row of queueScan.rows) {
    const meta = metaFrom(row, SCAN_META_KEYS)
    if (!inCurrentRun(meta)) continue
    executionCounted.push({
      failure_category: classifyExecutionFailure({ ...row, metadata: meta }),
      failure_reason: executionReason(row, meta) || null,
      to_phone_number: row.to_phone_number || null,
      last_event_at: row.updated_at || null,
    })
  }

  // The most recent rows, in detail.
  let executionFailures = []
  if (includeRows) {
    const scoped = (sample.data || [])
      .map((row) => ({ row, meta: metaFrom(row, SAMPLE_META_KEYS) }))
      .filter(({ meta }) => inCurrentRun(meta))
    const targetMap = await loadTargetsById(
      supabase,
      scoped.map(({ row }) => row.campaign_target_id).filter(Boolean),
    )
    executionFailures = scoped.map(({ row, meta }) => {
      const target = row.campaign_target_id ? targetMap.get(row.campaign_target_id) : null
      const category = classifyExecutionFailure({ ...row, metadata: meta })
      // `reason` was never declared here, so the first provider_failure row
      // threw a ReferenceError and failed the whole request.
      const reason = executionReason(row, meta).toLowerCase()
      const retryable = category === 'provider_failure' && !reason.includes('21610') && !reason.includes('blacklist')
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        campaign_target_id: row.campaign_target_id,
        queue_row_id: row.id,
        failure_class: 'execution',
        recipient: target?.owner_name || row.to_phone_number || null,
        property: target?.property_address || null,
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
  }

  const targetGroups = groupFailures(targetPreparationFailures, 'failure_category')
  const executionGroups = groupFailures(executionCounted, 'failure_category')
  const targetList = includeRows ? targetPreparationFailures.slice(0, TARGET_LIST_LIMIT) : []

  return {
    ok: true,
    campaign_id: campaignId,
    run_id: runId,
    target_preparation: {
      total: targetPreparationFailures.length,
      truncated: targetScan.truncated,
      failures: targetList,
      groups: targetGroups,
    },
    execution: {
      total: executionCounted.length,
      truncated: queueScan.truncated,
      failures: executionFailures,
      sample_limit: EXECUTION_SAMPLE_LIMIT,
      groups: executionGroups,
    },
    total: targetPreparationFailures.length + executionCounted.length,
    failures: [...targetList, ...executionFailures],
    groups: [...targetGroups, ...executionGroups],
  }
}

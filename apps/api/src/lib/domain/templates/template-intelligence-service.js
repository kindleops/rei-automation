import { supabase } from '@/lib/supabase/client.js'
import { chunk, unique } from '@/lib/utils/arrays.js'
import {
  buildCanonicalDisplayName,
  deriveFollowUpNumber,
  deriveTouchNumber,
  normalizeStageCode,
  resolveStageLabel,
} from './template-stage-labels.js'
import {
  buildCountMetric,
  buildRateMetric,
  DEFAULT_AUTOPILOT_MODE,
  emptyMetrics,
  kpiRowToMetrics,
} from './template-intelligence-contract.js'
import {
  buildCohortBaseline,
  cohortKey,
  computeCopyScore,
  evaluateTemplateAutopilot,
} from './template-autopilot-policy.js'

const KPI_WINDOWS = ['today', '24h', '7d', '30d', 'all_time']

function clean(value) {
  return String(value ?? '').trim()
}

function templateKey(row) {
  return clean(row.template_id) || clean(row.id)
}

function mapRangeToKpiWindow(range) {
  const r = clean(range).toLowerCase()
  if (KPI_WINDOWS.includes(r)) return r
  if (r === 'today') return 'today'
  if (r === '24h') return '24h'
  if (r === '7d') return '7d'
  if (r === '30d' || r === '90d') return '30d'
  if (r === 'all' || r === 'all_time') return 'all_time'
  return '7d'
}

function priorKpiWindow(window) {
  const map = { today: '24h', '24h': '7d', '7d': '30d', '30d': 'all_time', all_time: 'all_time' }
  return map[window] ?? '30d'
}

function parseSort(sort, sortDir) {
  const allowed = new Set([
    'template_name', 'stage_code', 'sends', 'delivered', 'reply_rate',
    'positive_rate', 'opt_out_rate', 'rotation_state', 'traffic_weight', 'copy_score',
  ])
  const field = allowed.has(sort) ? sort : 'template_name'
  const ascending = sortDir === 'asc'
  return { field, ascending }
}

function applyTemplateFilters(query, filters = {}) {
  if (filters.stage) query = query.eq('stage_code', filters.stage)
  if (filters.use_case) query = query.eq('use_case', filters.use_case)
  if (filters.language) query = query.eq('language', filters.language)
  if (filters.persona) query = query.eq('agent_persona', filters.persona)
  if (filters.asset_type) query = query.eq('property_type_scope', filters.asset_type)
  if (filters.lifecycle) query = query.eq('lifecycle', filters.lifecycle)
  if (filters.source) query = query.eq('source', filters.source)
  if (filters.active_state === 'active') query = query.eq('is_active', true)
  if (filters.active_state === 'inactive') query = query.eq('is_active', false)
  if (filters.query) query = query.ilike('template_name', `%${filters.query}%`)
  if (filters.touch_number != null) query = query.eq('touch_number', filters.touch_number)
  if (filters.follow_up_number != null) query = query.eq('follow_up_number', filters.follow_up_number)
  return query
}

const KPI_FETCH_BATCH = 100

async function fetchKpiMap(templateKeys, timeWindow) {
  if (!templateKeys.length) return new Map()
  const map = new Map()
  for (const batch of chunk(unique(templateKeys), KPI_FETCH_BATCH)) {
    const { data, error } = await supabase
      .from('template_performance_kpis_v')
      .select('*')
      .eq('time_window', timeWindow)
      .in('template_key', batch)
    if (error) throw error
    for (const row of data ?? []) map.set(row.template_key, row)
  }
  return map
}

async function fetchAllKpiRowsForKeys(templateKeys) {
  if (!templateKeys.length) return []
  const rows = []
  for (const batch of chunk(unique(templateKeys), KPI_FETCH_BATCH)) {
    const { data, error } = await supabase
      .from('template_performance_kpis_v')
      .select('*')
      .in('template_key', batch)
    if (error) throw error
    rows.push(...(data ?? []))
  }
  return rows
}

function kpiMapsFromRows(rows, kpiWindow, priorWindow) {
  const currentMap = new Map()
  const priorMap = new Map()
  const baselineMap = new Map()
  for (const row of rows) {
    if (row.time_window === kpiWindow) currentMap.set(row.template_key, row)
    if (row.time_window === priorWindow) priorMap.set(row.template_key, row)
    if (row.time_window === 'all_time') baselineMap.set(row.template_key, row)
  }
  return { currentMap, priorMap, baselineMap }
}

async function fetchKpiMapsForWindows(templateKeys, kpiWindow, priorWindow) {
  const rows = await fetchAllKpiRowsForKeys(templateKeys)
  return kpiMapsFromRows(rows, kpiWindow, priorWindow)
}

async function fetchAllKpiRowsForWindow(timeWindow) {
  const rows = []
  let from = 0
  const batchSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('template_performance_kpis_v')
      .select('*')
      .eq('time_window', timeWindow)
      .range(from, from + batchSize - 1)
    if (error) throw error
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < batchSize) break
    from += batchSize
  }
  return rows
}

function buildIdentity(row) {
  const stageCode = normalizeStageCode(row.stage_code)
  const touch = deriveTouchNumber(row)
  const followUp = deriveFollowUpNumber(row)
  return {
    template_id: templateKey(row),
    template_uuid: clean(row.id) || null,
    template_name: clean(row.template_name) || clean(row.name) || templateKey(row),
    canonical_display_name: buildCanonicalDisplayName(row),
    template_version: clean(row.version ?? row.metadata?.version) || '1',
    stage_code: stageCode,
    stage_label: resolveStageLabel(stageCode, row.stage_label),
    touch_number: touch,
    follow_up_number: followUp,
    use_case: clean(row.use_case) || clean(row.use_case_slug) || null,
    language: clean(row.language) || 'English',
    persona: clean(row.agent_persona) || clean(row.agent_style) || null,
    asset_scope: clean(row.property_type_scope) || null,
    deal_strategy: clean(row.deal_strategy) || null,
    source: clean(row.source) || 'sms_templates',
    lifecycle: clean(row.lifecycle) || (row.is_active ? 'active' : 'inactive'),
    active_state: row.is_active ? 'active' : 'inactive',
    canonical_body: clean(row.template_body) || clean(row.template_text) || '',
    english_translation: clean(row.english_translation) || null,
    variable_contract: Array.isArray(row.variables) ? row.variables : (row.metadata?.variables ?? []),
    allowed_property_groups: row.allowed_property_groups ?? [],
    prohibited_property_groups: row.prohibited_property_groups ?? [],
  }
}

function buildMetricsBlock(currentRow, priorRow, baselineRow) {
  const current = kpiRowToMetrics(currentRow)
  const prior = kpiRowToMetrics(priorRow)
  const baseline = kpiRowToMetrics(baselineRow)

  const countFields = [
    'sends', 'delivered', 'failed', 'replies', 'positive_replies', 'negative_replies',
    'ownership_confirmed', 'selling_interest', 'price_captured', 'opt_outs',
    'wrong_numbers', 'hostile_legal', 'unclear',
  ]
  const metrics = {}
  for (const field of countFields) {
    metrics[field] = buildCountMetric(current[field], prior[field], baseline[field])
  }

  const rates = {}
  for (const key of Object.keys(current.rates)) {
    rates[key] = buildRateMetric(current.rates[key], prior.rates[key], baseline.rates[key])
  }

  return {
    current,
    comparison: { metrics, rates },
    confidence: {
      current_range: current.confidence,
      historical: baseline.confidence,
    },
    performance_label: current.performance_label,
  }
}

function buildAutopilotControl(row) {
  return {
    rotation_state: clean(row.rotation_state ?? row.rotation_status) || 'cold_start',
    traffic_weight: Number(row.traffic_weight ?? 1),
    daily_cap: Number(row.daily_cap ?? 0) || null,
    manual_lock: Boolean(row.manual_lock ?? row.autopilot_locked),
    block_reason: clean(row.block_reason) || null,
  }
}

function buildDataQuality(row, metrics) {
  const vars = Array.isArray(row.variables) ? row.variables : []
  const body = clean(row.template_body)
  const unresolved = vars.some((v) => body.includes(`[[${v}]]`) || body.includes(`{{${v}}}`))
  return {
    variable_contract_valid: vars.length > 0,
    asset_scope_match: true,
    language_quality: clean(row.language) ? 'ok' : 'unknown',
    attribution_status: metrics.sends > 0 ? 'attributed' : 'no_sends',
    render_failures: unresolved ? 1 : 0,
    metadata_issues: [],
    attribution_healthy: metrics.sends > 0,
    variable_rendering_healthy: !unresolved,
    unresolved_merge_variable: unresolved,
    wrong_language: false,
    asset_mismatch: false,
    prohibited_content: false,
    duplicate_outreach_violation: false,
    carrier_content_rejection_spike: false,
  }
}

function sortTemplates(rows, { field, ascending }) {
  const dir = ascending ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = field === 'copy_score'
      ? a.autopilot?.intelligence?.copy_score ?? 0
      : field === 'reply_rate'
        ? a.metrics?.comparison?.rates?.reply?.current?.value ?? 0
        : a.identity?.[field] ?? a.metrics?.current?.[field] ?? a.autopilot?.[field] ?? ''
    const bv = field === 'copy_score'
      ? b.autopilot?.intelligence?.copy_score ?? 0
      : field === 'reply_rate'
        ? b.metrics?.comparison?.rates?.reply?.current?.value ?? 0
        : b.identity?.[field] ?? b.metrics?.current?.[field] ?? b.autopilot?.[field] ?? ''
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
}

function filterByIntelligence(rows, filters = {}) {
  return rows.filter((row) => {
    if (filters.rotation_state && row.autopilot?.rotation_state !== filters.rotation_state) return false
    if (filters.performance_label && row.metrics?.performance_label !== filters.performance_label) return false
    if (filters.confidence && row.metrics?.confidence?.current_range?.bucket !== filters.confidence) return false
    if (filters.risk_flag) {
      const flags = row.autopilot?.intelligence?.risk_flags ?? []
      if (!flags.includes(filters.risk_flag)) return false
    }
    if (filters.market && !(row.execution?.markets ?? []).includes(filters.market)) return false
    if (filters.campaign && !(row.execution?.campaigns ?? []).includes(filters.campaign)) return false
    if (filters.sender && !(row.execution?.senders ?? []).includes(filters.sender)) return false
    if (filters.agent && row.identity?.persona !== filters.agent) return false
    return true
  })
}

export async function fetchTemplateIntelligence({
  page = 0,
  pageSize = 500,
  sort = 'template_name',
  sortDir = 'asc',
  filters = {},
  range = '7d',
  autopilotMode = DEFAULT_AUTOPILOT_MODE,
}) {
  const kpiWindow = mapRangeToKpiWindow(range)
  const priorWindow = priorKpiWindow(kpiWindow)
  const sortSpec = parseSort(sort, sortDir)
  const from = Math.max(0, page) * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from('sms_templates')
    .select('*', { count: 'exact' })
    .order('template_name', { ascending: true })
    .range(from, to)

  query = applyTemplateFilters(query, filters)
  const { data: templates, error, count } = await query
  if (error) throw error

  const keys = (templates ?? []).map(templateKey).filter(Boolean)
  const { currentMap, priorMap, baselineMap } = await fetchKpiMapsForWindows(keys, kpiWindow, priorWindow)

  let rows = (templates ?? []).map((row) => {
    const key = templateKey(row)
    const identity = buildIdentity(row)
    const metrics = buildMetricsBlock(currentMap.get(key), priorMap.get(key), baselineMap.get(key))
    const dataQuality = buildDataQuality(row, metrics.current)
    const control = buildAutopilotControl(row)
    return {
      identity,
      metrics,
      execution: {
        selected: 0,
        queued: 0,
        scheduled: 0,
        due: 0,
        claimed: 0,
        guard_passed: 0,
        blocked: 0,
        sent: metrics.current.sends,
        delivered: metrics.current.delivered,
        failed: metrics.current.failed,
        retries: metrics.current.retries,
        rotations: metrics.current.rotations,
        cost: metrics.current.cost,
        sender_mix: [],
        markets: [],
        campaigns: [],
      },
      data_quality: dataQuality,
      autopilot: null,
      control,
    }
  })

  const cohortBaselines = buildCohortBaseline(rows.map((r) => ({
    ...r.identity,
    metrics: r.metrics.current,
    intelligence: { copy_score: computeCopyScore(r.metrics.current) },
  })))

  rows = rows.map((row) => {
    const baseline = cohortBaselines.get(cohortKey(row.identity))
    const peers = rows
      .filter((r) => cohortKey(r.identity) === cohortKey(row.identity))
      .map((r) => ({ copy_score: computeCopyScore(r.metrics.current) }))
    const autopilot = evaluateTemplateAutopilot({
      template: row.identity,
      metrics: row.metrics.current,
      cohortBaseline: baseline,
      cohortPeers: peers,
      dataQuality: row.data_quality,
      currentControl: row.control,
      mode: autopilotMode,
    })
    return { ...row, autopilot }
  })

  rows = filterByIntelligence(rows, filters)
  rows = sortTemplates(rows, sortSpec)

  return {
    ok: true,
    data: rows,
    meta: {
      page,
      page_size: pageSize,
      total_count: count ?? rows.length,
      filtered_count: rows.length,
      range: kpiWindow,
      prior_range: priorWindow,
      baseline_range: 'all_time',
      kpi_source: 'template_performance_kpis_v',
      autopilot_mode: autopilotMode,
      shadow_mode: autopilotMode === 'shadow',
      production_mutations_enabled: false,
    },
  }
}

export async function fetchTemplateIntelligenceSummary(params = {}) {
  const filters = params.filters ?? {}
  const kpiWindow = mapRangeToKpiWindow(params.range ?? '7d')
  const priorWindow = priorKpiWindow(kpiWindow)

  let activeQuery = supabase.from('sms_templates').select('id', { count: 'exact', head: true }).eq('is_active', true)
  activeQuery = applyTemplateFilters(activeQuery, filters)
  const { count: activeTemplates, error: activeError } = await activeQuery
  if (activeError) throw activeError

  let totalQuery = supabase.from('sms_templates').select('id', { count: 'exact', head: true })
  totalQuery = applyTemplateFilters(totalQuery, filters)
  const { count: totalTemplates, error: totalError } = await totalQuery
  if (totalError) throw totalError

  const [currentRows, priorRows, baselineRows] = await Promise.all([
    fetchAllKpiRowsForWindow(kpiWindow),
    fetchAllKpiRowsForWindow(priorWindow),
    fetchAllKpiRowsForWindow('all_time'),
  ])

  const sumField = (rows, field) => rows.reduce((acc, row) => acc + (Number(row[field]) || 0), 0)
  const sends = sumField(currentRows, 'sends')
  const delivered = sumField(currentRows, 'delivered')
  const replies = sumField(currentRows, 'inbound_replies')
  const positive = sumField(currentRows, 'positive_replies')
  const ownership = sumField(currentRows, 'ownership_confirmed_replies')
  const stageAdvanced = sumField(currentRows, 'positive_replies')
  const optOuts = sumField(currentRows, 'opt_outs')
  const priorSends = sumField(priorRows, 'sends')
  const priorDelivered = sumField(priorRows, 'delivered')
  const priorReplies = sumField(priorRows, 'inbound_replies')
  const priorPositive = sumField(priorRows, 'positive_replies')
  const priorOwnership = sumField(priorRows, 'ownership_confirmed_replies')
  const priorStage = sumField(priorRows, 'positive_replies')
  const priorOptOuts = sumField(priorRows, 'opt_outs')
  const baselineSends = sumField(baselineRows, 'sends')
  const baselineDelivered = sumField(baselineRows, 'delivered')
  const usedTemplates = currentRows.filter((row) => Number(row.sends) > 0).length

  return {
    ok: true,
    cards: {
      active_templates: buildCountMetric(activeTemplates ?? 0, activeTemplates ?? 0, activeTemplates ?? 0),
      templates_used: buildCountMetric(usedTemplates, usedTemplates, usedTemplates),
      sends: buildCountMetric(sends, priorSends, baselineSends),
      delivery_rate: buildRateMetric(
        { numerator: delivered, denominator: sends, value: sends > 0 ? Math.round((delivered / sends) * 10000) / 100 : null },
        { numerator: priorDelivered, denominator: priorSends, value: priorSends > 0 ? Math.round((priorDelivered / priorSends) * 10000) / 100 : null },
        { numerator: baselineDelivered, denominator: baselineSends, value: baselineSends > 0 ? Math.round((baselineDelivered / baselineSends) * 10000) / 100 : null },
      ),
      reply_rate: buildRateMetric(
        { numerator: replies, denominator: delivered || sends, value: (delivered || sends) > 0 ? Math.round((replies / (delivered || sends)) * 10000) / 100 : null },
        { numerator: priorReplies, denominator: priorDelivered || priorSends, value: (priorDelivered || priorSends) > 0 ? Math.round((priorReplies / (priorDelivered || priorSends)) * 10000) / 100 : null },
        { numerator: 0, denominator: 0, value: null },
      ),
      positive_rate: buildRateMetric(
        { numerator: positive, denominator: replies, value: replies > 0 ? Math.round((positive / replies) * 10000) / 100 : null },
        { numerator: priorPositive, denominator: priorReplies, value: priorReplies > 0 ? Math.round((priorPositive / priorReplies) * 10000) / 100 : null },
        { numerator: 0, denominator: 0, value: null },
      ),
      ownership_confirmed: buildCountMetric(ownership, priorOwnership, ownership),
      stage_advanced: buildCountMetric(stageAdvanced, priorStage, stageAdvanced),
      opt_out_rate: buildRateMetric(
        { numerator: optOuts, denominator: delivered || sends, value: (delivered || sends) > 0 ? Math.round((optOuts / (delivered || sends)) * 10000) / 100 : null },
        { numerator: priorOptOuts, denominator: priorDelivered || priorSends, value: (priorDelivered || priorSends) > 0 ? Math.round((priorOptOuts / (priorDelivered || priorSends)) * 10000) / 100 : null },
        { numerator: 0, denominator: 0, value: null },
      ),
      cost: buildCountMetric(0, 0, 0),
    },
    meta: {
      page: 0,
      page_size: 0,
      total_count: totalTemplates ?? 0,
      filtered_count: totalTemplates ?? 0,
      range: kpiWindow,
      prior_range: priorWindow,
      baseline_range: 'all_time',
      kpi_source: 'template_performance_kpis_v',
      autopilot_mode: params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE,
      shadow_mode: (params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE) === 'shadow',
      production_mutations_enabled: false,
      catalog_mode: 'summary_aggregate',
    },
  }
}

export async function fetchTemplateDossier(templateId, params = {}) {
  const cleanId = clean(templateId)
  const { data: templateRow, error: templateError } = await supabase
    .from('sms_templates')
    .select('*')
    .or(`template_id.eq.${cleanId},id.eq.${cleanId}`)
    .limit(1)
    .maybeSingle()
  if (templateError) throw templateError
  if (!templateRow) return { ok: false, error: 'template_not_found' }

  const kpiWindow = mapRangeToKpiWindow(params.range ?? '7d')
  const priorWindow = priorKpiWindow(kpiWindow)
  const autopilotMode = params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE
  const key = templateKey(templateRow)
  const allKpiRows = await fetchAllKpiRowsForKeys([key])
  const { currentMap, priorMap, baselineMap } = kpiMapsFromRows(allKpiRows, kpiWindow, priorWindow)

  const identity = buildIdentity(templateRow)
  const metrics = buildMetricsBlock(currentMap.get(key), priorMap.get(key), baselineMap.get(key))
  const dataQuality = buildDataQuality(templateRow, metrics.current)
  const control = buildAutopilotControl(templateRow)
  const cohortBaselines = buildCohortBaseline([{ ...identity, metrics: metrics.current, intelligence: { copy_score: computeCopyScore(metrics.current) } }])
  const autopilot = evaluateTemplateAutopilot({
    template: identity,
    metrics: metrics.current,
    cohortBaseline: cohortBaselines.get(cohortKey(identity)),
    cohortPeers: [{ copy_score: computeCopyScore(metrics.current) }],
    dataQuality,
    currentControl: control,
    mode: autopilotMode,
  })
  const row = {
    identity,
    metrics,
    execution: {
      selected: 0, queued: 0, scheduled: 0, due: 0, claimed: 0, guard_passed: 0, blocked: 0,
      sent: metrics.current.sends, delivered: metrics.current.delivered, failed: metrics.current.failed,
      retries: metrics.current.retries, rotations: metrics.current.rotations, cost: metrics.current.cost,
      sender_mix: [], markets: [], campaigns: [],
    },
    data_quality: dataQuality,
    autopilot,
    control,
  }

  const kpiByWindow = {}
  for (const kpiRow of allKpiRows) kpiByWindow[kpiRow.time_window] = kpiRowToMetrics(kpiRow)

  const { data: queueRows } = await supabase
    .from('send_queue')
    .select('id, queue_status, message_body, template_id, selected_template_id, template_selection_reason, selected_template_score, market, campaign_id, from_phone_number, created_at, updated_at')
    .or(`template_id.eq.${cleanId},selected_template_id.eq.${cleanId}`)
    .order('updated_at', { ascending: false })
    .limit(100)

  const executions = (queueRows ?? []).map((q) => ({
    queue_id: q.id,
    status: q.queue_status,
    rendered_body: q.message_body,
    provider: 'textgrid',
    market: q.market,
    sender: q.from_phone_number,
    created_at: q.created_at,
    updated_at: q.updated_at,
  }))

  const resolver = {
    candidate_pool_size: null,
    selected_rank: null,
    ranking_inputs: [],
    selection_reason: queueRows?.[0]?.template_selection_reason ?? null,
    fallback: null,
    excluded_candidates: [],
    exclusion_reasons: [],
    rotation_history: [],
  }

  return {
    ok: true,
    template: row,
    dossier: {
      overview: {
        canonical_body: row.identity.canonical_body,
        english_translation: row.identity.english_translation,
        variable_contract: row.identity.variable_contract,
        recent_rendered_executions: executions.slice(0, 5).map((e) => ({
          queue_id: e.queue_id,
          preview: String(e.rendered_body ?? '').slice(0, 160),
          status: e.status,
        })),
      },
      performance: { ...row.metrics, all_windows: kpiByWindow },
      funnel: {
        stages: [
          { key: 'sent', value: row.metrics.current.sends },
          { key: 'delivered', value: row.metrics.current.delivered },
          { key: 'replied', value: row.metrics.current.replies },
          { key: 'ownership_confirmed', value: row.metrics.current.ownership_confirmed },
          { key: 'selling_interest', value: row.metrics.current.selling_interest },
          { key: 'price', value: row.metrics.current.price_captured },
          { key: 'offer', value: row.metrics.current.offer_delivered },
          { key: 'contract', value: row.metrics.current.contracts_signed },
        ],
      },
      cohorts: { market: [], asset: [], sender: [], campaign: [], contact_confidence: [], phone_position: [], day_time: [] },
      executions,
      resolver,
      autopilot: row.autopilot,
      decision_history: [],
    },
  }
}

export async function applyTemplateControl({
  templateId,
  action,
  reason,
  actor,
  values = {},
  mode = DEFAULT_AUTOPILOT_MODE,
}) {
  const { data: existing } = await supabase
    .from('sms_templates')
    .select('*')
    .or(`template_id.eq.${templateId},id.eq.${templateId}`)
    .limit(1)
    .maybeSingle()

  if (!existing) return { ok: false, error: 'template_not_found' }

  const before = {
    rotation_state: existing.rotation_state ?? 'cold_start',
    traffic_weight: Number(existing.traffic_weight ?? 1),
    daily_cap: Number(existing.daily_cap ?? 0) || null,
    manual_lock: Boolean(existing.manual_lock),
  }

  const after = { ...before }
  switch (action) {
    case 'set_weight': after.traffic_weight = Number(values.weight ?? before.traffic_weight); break
    case 'set_daily_cap': after.daily_cap = Number(values.daily_cap ?? before.daily_cap); break
    case 'pause': after.rotation_state = 'paused'; after.traffic_weight = 0; break
    case 'resume': after.rotation_state = 'testing'; break
    case 'cooldown': after.rotation_state = 'cooldown'; break
    case 'promote_control': after.rotation_state = 'champion'; break
    case 'retire': after.rotation_state = 'retired'; after.traffic_weight = 0; break
    case 'lock_autopilot': after.manual_lock = true; break
    default: return { ok: false, error: 'invalid_action' }
  }

  const audit = {
    template_id: templateId,
    action,
    actor: actor ?? 'operator',
    reason: reason ?? 'manual_control',
    policy_version: 'template-intelligence-shadow-v1',
    mode,
    before_state: before,
    after_state: after,
    applied: false,
    shadow_only: mode === 'shadow' || mode === 'recommend' || mode === 'off',
    timestamp: new Date().toISOString(),
  }

  const { error: logError } = await supabase
    .from('template_autopilot_decision_log')
    .insert(audit)

  if (logError && !String(logError.message).includes('does not exist')) throw logError

  return {
    ok: true,
    audit,
    message: audit.shadow_only
      ? 'Shadow mode — control recorded in audit log only; no production mutation.'
      : 'Controlled mode not enabled in this release.',
  }
}

export { emptyMetrics, mapRangeToKpiWindow, priorKpiWindow }
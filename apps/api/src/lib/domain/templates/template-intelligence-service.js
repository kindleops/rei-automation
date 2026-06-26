import { supabase } from '@/lib/supabase/client.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
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
  buildRate,
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
import {
  aggregatePortfolioAttribution,
  detectUndeclaredPlaceholders,
} from './template-attribution-contract.js'
import {
  buildIntelligenceRail,
  buildStageFunnel,
  fetchQueueExecutionAggregates,
  fetchReplyIntentAggregates,
  mergeAggregateIntoMetrics,
  mergeKpiAndIntentAggregates,
  priorWindowLabel,
  senderDiversityFromBucket,
} from './template-intelligence-aggregates.js'

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

async function fetchAllKpiRowsForKeys(templateKeys, timeWindows = null) {
  if (!templateKeys.length) return []
  const windows = Array.isArray(timeWindows) && timeWindows.length
    ? [...new Set(timeWindows)]
    : null
  const rows = []
  for (const batch of chunk(unique(templateKeys), KPI_FETCH_BATCH)) {
    let query = supabase
      .from('template_performance_kpis_v')
      .select('*')
      .in('template_key', batch)
    if (windows) query = query.in('time_window', windows)
    const { data, error } = await query
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
  const rows = await fetchAllKpiRowsForKeys(templateKeys, [kpiWindow, priorWindow, 'all_time'])
  return kpiMapsFromRows(rows, kpiWindow, priorWindow)
}

function keysNeedingIntentAggregates(templateKeys, kpiMap) {
  return templateKeys.filter((key) => {
    const row = kpiMap.get(key)
    if (!row) return true
    if (String(row.metric_status ?? 'ok') === 'missing_source') return true
    return row.inbound_replies == null && Number(row.sends ?? row.sample_size ?? 0) > 0
  })
}

function keysNeedingQueueExecution(templateKeys, kpiMap) {
  return templateKeys.filter((key) => {
    const row = kpiMap.get(key)
    return !row || Number(row.sends ?? row.sample_size ?? 0) === 0
  })
}

async function fetchFilteredTemplateCatalog(filters = {}) {
  const rows = []
  let from = 0
  const batchSize = 500
  while (true) {
    let query = supabase
      .from('sms_templates')
      .select('*')
      .order('template_name', { ascending: true })
      .range(from, from + batchSize - 1)
    query = applyTemplateFilters(query, filters)
    const { data, error } = await query
    if (error) throw error
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < batchSize) break
    from += batchSize
  }
  return rows
}

function hasIntelligenceFilters(filters = {}) {
  return Boolean(
    filters.rotation_state
    || filters.performance_label
    || filters.confidence
    || filters.risk_flag
    || filters.market
    || filters.campaign
    || filters.sender
    || filters.agent,
  )
}

function buildSummaryRowsFromCatalog(templateRows, kpiWindow, priorWindow) {
  const keys = templateRows.map(templateKey).filter(Boolean)
  return fetchKpiMapsForWindows(keys, kpiWindow, priorWindow).then(({ currentMap, priorMap, baselineMap }) =>
    templateRows.map((row) => {
      const key = templateKey(row)
      return {
        identity: buildIdentity(row),
        metrics: buildMetricsBlock(currentMap.get(key), priorMap.get(key), baselineMap.get(key)),
      }
    }),
  )
}

function templateIntelCacheKey(kind, params = {}) {
  const filters = params.filters ?? {}
  return [
    `cockpit:template-intel:${kind}`,
    params.range ?? '7d',
    params.page ?? 0,
    params.pageSize ?? 500,
    params.sort ?? 'template_name',
    params.sortDir ?? 'asc',
    params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE,
    filters.query ?? '',
    filters.stage ?? '',
    filters.touch_number ?? '',
    filters.follow_up_number ?? '',
    filters.use_case ?? '',
    filters.language ?? '',
    filters.persona ?? '',
    filters.asset_type ?? '',
    filters.lifecycle ?? '',
    filters.source ?? '',
    filters.active_state ?? '',
    filters.rotation_state ?? '',
    filters.performance_label ?? '',
    filters.confidence ?? '',
    filters.risk_flag ?? '',
    filters.market ?? '',
    filters.campaign ?? '',
    filters.sender ?? '',
    filters.agent ?? '',
  ].join(':')
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
    'ownership_confirmed', 'selling_interest', 'stage_advanced', 'price_captured', 'opt_outs',
    'wrong_numbers', 'hostile_legal', 'unclear', 'cost',
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

function buildDataQuality(row, metrics, identity = null) {
  const vars = Array.isArray(row.variables) ? row.variables : (row.metadata?.variables ?? [])
  const body = clean(row.template_body) || clean(row.template_text)
  const touch = identity?.touch_number ?? deriveTouchNumber(row)
  const undeclared = detectUndeclaredPlaceholders(body, vars)
  const issues = []
  if (!vars.length) issues.push({ code: 'variables_undeclared', message: 'Missing required variables in catalog', field: 'variables' })
  if (!clean(row.stage_code)) issues.push({ code: 'stage_missing', message: 'Stage metadata missing', field: 'stage' })
  if (touch == null) issues.push({ code: 'touch_missing', message: 'Touch metadata missing', field: 'touch' })
  if (!clean(row.use_case)) issues.push({ code: 'use_case_missing', message: 'Use case missing', field: 'use_case' })
  if (!clean(row.language)) issues.push({ code: 'language_missing', message: 'Language metadata missing', field: 'language' })
  if (!body) issues.push({ code: 'body_empty', message: 'Template body is empty', field: 'body' })
  for (const placeholder of undeclared) {
    issues.push({ code: 'unsupported_placeholder', message: `Unsupported placeholder: ${placeholder}`, field: 'variables' })
  }
  if (metrics.sends <= 0) issues.push({ code: 'no_sends', message: 'No sends in selected period', field: 'sends' })
  else if (metrics.attribution_partial) issues.push({ code: 'partial_attribution', message: 'Reply tracking partially unavailable', field: 'attribution' })
  else if (metrics.replies == null) issues.push({ code: 'no_attribution', message: 'No attributable replies — tracking unavailable', field: 'attribution' })
  const messageErrors = undeclared.length
  const recommended = issues[0]?.message ?? 'No issues detected'
  return {
    variable_contract_valid: vars.length > 0,
    variable_contract_detail: vars.length > 0 ? 'Declared' : 'Missing seller-name or property variables',
    asset_scope_match: Boolean(clean(row.property_type_scope)),
    asset_scope_detail: clean(row.property_type_scope) ? 'Matched' : 'Property match not set',
    language_quality: clean(row.language) ? row.language : 'Missing',
    attribution_status: metrics.sends > 0
      ? (metrics.attribution_partial ? 'partial' : metrics.replies == null ? 'unavailable' : Number(metrics.replies) > 0 ? 'attributed' : 'no_replies')
      : 'no_sends',
    render_failures: messageErrors,
    render_failure_detail: messageErrors > 0 ? `${messageErrors} unsupported placeholder(s)` : 'None',
    metadata_issues: issues,
    recommended_fix: recommended,
    attribution_healthy: metrics.sends > 0 && metrics.attribution_available && metrics.replies != null,
    variable_rendering_healthy: messageErrors === 0,
    unresolved_merge_variable: messageErrors > 0,
    wrong_language: false,
    asset_mismatch: !clean(row.property_type_scope),
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

async function loadTemplateIntelligence({
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
  const intentKeys = keysNeedingIntentAggregates(keys, currentMap)
  const execKeys = keysNeedingQueueExecution(keys, currentMap)
  const [intentCurrent, intentPrior, execCurrent] = await Promise.all([
    intentKeys.length ? fetchReplyIntentAggregates(intentKeys, kpiWindow) : Promise.resolve(new Map()),
    intentKeys.length ? fetchReplyIntentAggregates(intentKeys, priorWindow) : Promise.resolve(new Map()),
    execKeys.length ? fetchQueueExecutionAggregates(execKeys, kpiWindow) : Promise.resolve(new Map()),
  ])

  let rows = (templates ?? []).map((row) => {
    const key = templateKey(row)
    const identity = buildIdentity(row)
    const attrCurrent = mergeKpiAndIntentAggregates(currentMap.get(key), intentCurrent.get(key))
    const attrPrior = mergeKpiAndIntentAggregates(priorMap.get(key), intentPrior.get(key))
    const baseCurrent = kpiRowToMetrics(currentMap.get(key))
    const basePrior = kpiRowToMetrics(priorMap.get(key))
    const enrichedCurrent = mergeAggregateIntoMetrics(baseCurrent, attrCurrent, execCurrent.get(key))
    const enrichedPrior = mergeAggregateIntoMetrics(basePrior, attrPrior, null)
    const metrics = buildMetricsBlock(
      {
        ...currentMap.get(key),
        inbound_replies: enrichedCurrent.replies,
        positive_inbound_count: enrichedCurrent.positive_replies,
        positive_replies: enrichedCurrent.positive_replies,
        ownership_confirmed_replies: enrichedCurrent.ownership_confirmed,
        stage_advanced_count: enrichedCurrent.stage_advanced,
        opt_out_count: enrichedCurrent.opt_outs,
        opt_outs: enrichedCurrent.opt_outs,
      },
      {
        ...priorMap.get(key),
        inbound_replies: enrichedPrior.replies,
        positive_inbound_count: enrichedPrior.positive_replies,
        positive_replies: enrichedPrior.positive_replies,
        ownership_confirmed_replies: enrichedPrior.ownership_confirmed,
        stage_advanced_count: enrichedPrior.stage_advanced,
        opt_out_count: enrichedPrior.opt_outs,
        opt_outs: enrichedPrior.opt_outs,
      },
      baselineMap.get(key),
    )
    metrics.current = enrichedCurrent
    const execBucket = execCurrent.get(key)
    const senderDiv = senderDiversityFromBucket(execBucket)
    const dataQuality = buildDataQuality(row, metrics.current, identity)
    const control = buildAutopilotControl(row)
    return {
      identity,
      metrics,
      execution: {
        queue_rows: execBucket?.selected ?? 0,
        selected: execBucket?.selected ?? 0,
        queued: execBucket?.queued ?? 0,
        scheduled: 0,
        due: 0,
        claimed: 0,
        guard_passed: 0,
        blocked: execBucket?.blocked ?? 0,
        sent: metrics.current.sends,
        delivered: metrics.current.delivered,
        failed: metrics.current.failed,
        retries: execBucket?.retries ?? metrics.current.retries,
        rotations: metrics.current.rotations,
        cost: metrics.current.cost_available ? metrics.current.cost : null,
        cost_available: metrics.current.cost_available ?? false,
        sender_diversity: senderDiv,
        sender_mix: senderDiv.label,
        markets: [...(execBucket?.markets ?? attrCurrent?.markets ?? [])],
        campaigns: [...(execBucket?.campaigns ?? [])],
        last_used: execBucket?.last_used ?? null,
      },
      data_quality: dataQuality,
      funnel: buildStageFunnel(identity.stage_code, { ...metrics.current, ...attrCurrent }),
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
      matching_templates: rows.length,
      displayed_rows: rows.length,
      tracked_templates: rows.filter((r) => (r.metrics?.current?.sends ?? 0) > 0).length,
      range: kpiWindow,
      prior_range: priorWindow,
      prior_label: priorWindowLabel(kpiWindow),
      baseline_range: 'all_time',
      kpi_source: 'template_performance_kpis_v+performance_message_events_v+send_queue',
      autopilot_mode: autopilotMode,
      shadow_mode: autopilotMode === 'shadow',
      production_mutations_enabled: false,
    },
  }
}

export async function fetchTemplateIntelligence(params = {}) {
  return readThroughCache(templateIntelCacheKey('list', params), 15_000, () => loadTemplateIntelligence(params))
}

async function loadTemplateIntelligenceSummary(params = {}) {
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

  let rows = []
  if (hasIntelligenceFilters(filters)) {
    const list = await loadTemplateIntelligence({
      page: 0,
      pageSize: 5000,
      sort: 'template_name',
      sortDir: 'asc',
      filters,
      range: params.range ?? '7d',
      autopilotMode: params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE,
    })
    rows = list.data ?? []
  } else {
    const catalog = await fetchFilteredTemplateCatalog(filters)
    rows = await buildSummaryRowsFromCatalog(catalog, kpiWindow, priorWindow)
  }
  const sumPrior = (field) => rows.reduce((n, r) => n + (Number(r.metrics?.comparison?.metrics?.[field]?.prior) || 0), 0)
  const sumBaseline = (field) => rows.reduce((n, r) => n + (Number(r.metrics?.comparison?.metrics?.[field]?.baseline) || 0), 0)

  const portfolio = aggregatePortfolioAttribution(rows)
  const priorSends = sumPrior('sends')
  const priorDelivered = sumPrior('delivered')
  const priorReplies = sumPrior('replies')
  const priorPositive = sumPrior('positive_replies')
  const priorNegative = sumPrior('negative_replies')
  const priorOwnership = sumPrior('ownership_confirmed')
  const priorStage = sumPrior('stage_advanced')
  const priorOptOuts = sumPrior('opt_outs')
  const priorWrong = sumPrior('wrong_numbers')
  const baselineSends = sumBaseline('sends')
  const baselineDelivered = sumBaseline('delivered')
  const usedTemplates = rows.filter((r) => (r.metrics?.current?.sends ?? 0) > 0).length
  const costRows = rows.filter((r) => r.metrics?.current?.cost_available)
  const cost = costRows.reduce((n, r) => n + (Number(r.metrics?.current?.cost) || 0), 0)
  const priorCost = sumPrior('cost')
  const baselineCost = sumBaseline('cost')
  const costAvailable = costRows.length > 0

  const { sends, delivered, replies, positive_replies: positive, negative_replies: negative, ownership_confirmed: ownership, stage_advanced: stageAdvanced, opt_outs: optOuts, wrong_numbers: wrongNumbers, rates } = portfolio

  return {
    ok: true,
    cards: {
      active_templates: buildCountMetric(activeTemplates ?? 0, activeTemplates ?? 0, activeTemplates ?? 0),
      templates_used: buildCountMetric(usedTemplates, usedTemplates, usedTemplates),
      sends: buildCountMetric(sends, priorSends, baselineSends),
      delivery_rate: buildRateMetric(
        rates.delivery,
        buildRate(priorDelivered, priorSends),
        buildRate(baselineDelivered, baselineSends),
      ),
      replies: buildCountMetric(replies ?? 0, priorReplies, sumBaseline('replies')),
      reply_rate: buildRateMetric(
        rates.reply,
        buildRate(priorReplies, priorDelivered),
        buildRate(sumBaseline('replies'), baselineDelivered),
      ),
      average_reply_time: {
        current: portfolio.average_response_time,
        prior: null,
        baseline: null,
        delta_absolute: null,
        unavailable: portfolio.average_response_time == null,
        unavailable_reason: portfolio.average_response_time == null ? 'Average reply time unavailable for range' : null,
      },
      positive_rate: buildRateMetric(
        rates.positive_reply,
        buildRate(priorPositive, priorReplies),
        buildRate(sumBaseline('positive_replies'), sumBaseline('replies')),
      ),
      negative_rate: buildRateMetric(
        rates.negative_reply,
        buildRate(priorNegative, priorReplies),
        buildRate(sumBaseline('negative_replies'), sumBaseline('replies')),
      ),
      ownership_confirmed: buildCountMetric(ownership ?? 0, priorOwnership, sumBaseline('ownership_confirmed')),
      stage_advanced: buildCountMetric(stageAdvanced ?? 0, priorStage, sumBaseline('stage_advanced')),
      opt_out_rate: buildRateMetric(
        rates.opt_out,
        buildRate(priorOptOuts, priorDelivered),
        buildRate(sumBaseline('opt_outs'), baselineDelivered),
      ),
      wrong_number_rate: buildRateMetric(
        rates.wrong_number,
        buildRate(priorWrong, priorReplies),
        buildRate(sumBaseline('wrong_numbers'), sumBaseline('replies')),
      ),
      cost: costAvailable
        ? buildCountMetric(cost, priorCost, baselineCost)
        : { current: null, prior: null, baseline: null, delta_absolute: null, unavailable: true, unavailable_reason: 'Estimated cost unavailable — no cost data on queue rows in range' },
    },
    intelligence_rail: buildIntelligenceRail(rows),
    meta: {
      page: 0,
      page_size: 0,
      total_count: totalTemplates ?? 0,
      filtered_count: rows.length,
      matching_templates: rows.length,
      tracked_templates: rows.filter((r) => (r.metrics?.current?.sends ?? 0) > 0).length,
      range: kpiWindow,
      prior_range: priorWindow,
      prior_label: priorWindowLabel(kpiWindow),
      baseline_range: 'all_time',
      kpi_source: 'template_performance_kpis_v+performance_message_events_v+send_queue',
      autopilot_mode: params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE,
      shadow_mode: (params.autopilotMode ?? DEFAULT_AUTOPILOT_MODE) === 'shadow',
      production_mutations_enabled: false,
      catalog_mode: hasIntelligenceFilters(filters) ? 'summary_full' : 'summary_kpi_aggregate',
    },
  }
}

export async function fetchTemplateIntelligenceSummary(params = {}) {
  return readThroughCache(templateIntelCacheKey('summary', params), 15_000, () => loadTemplateIntelligenceSummary(params))
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
  const allKpiRows = await fetchAllKpiRowsForKeys([key], [kpiWindow, priorWindow, 'all_time'])
  const { currentMap, priorMap, baselineMap } = kpiMapsFromRows(allKpiRows, kpiWindow, priorWindow)

  const identity = buildIdentity(templateRow)
  const [intentCurrent, intentPrior, execCurrent] = await Promise.all([
    fetchReplyIntentAggregates([key], kpiWindow),
    fetchReplyIntentAggregates([key], priorWindow),
    fetchQueueExecutionAggregates([key], kpiWindow),
  ])
  const attrCurrent = mergeKpiAndIntentAggregates(currentMap.get(key), intentCurrent.get(key))
  const attrPrior = mergeKpiAndIntentAggregates(priorMap.get(key), intentPrior.get(key))
  const baseCurrent = kpiRowToMetrics(currentMap.get(key))
  const basePrior = kpiRowToMetrics(priorMap.get(key))
  const enrichedCurrent = mergeAggregateIntoMetrics(baseCurrent, attrCurrent, execCurrent.get(key))
  const enrichedPrior = mergeAggregateIntoMetrics(basePrior, attrPrior, null)
  const metrics = buildMetricsBlock(
    {
      ...currentMap.get(key),
      inbound_replies: enrichedCurrent.replies,
      positive_replies: enrichedCurrent.positive_replies,
      ownership_confirmed_replies: enrichedCurrent.ownership_confirmed,
      stage_advanced_count: enrichedCurrent.stage_advanced,
    },
    {
      ...priorMap.get(key),
      inbound_replies: enrichedPrior.replies,
    },
    baselineMap.get(key),
  )
  metrics.current = enrichedCurrent
  const dataQuality = buildDataQuality(templateRow, metrics.current, identity)
  const control = buildAutopilotControl(templateRow)
  const execBucket = execCurrent.get(key)
  const senderDiv = senderDiversityFromBucket(execBucket)
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
      selected: execBucket?.selected ?? 0, queued: execBucket?.queued ?? 0, scheduled: 0, due: 0, claimed: 0, guard_passed: 0, blocked: execBucket?.blocked ?? 0,
      sent: metrics.current.sends, delivered: metrics.current.delivered, failed: metrics.current.failed,
      retries: execBucket?.retries ?? metrics.current.retries, rotations: metrics.current.rotations,
      cost: metrics.current.cost_available ? metrics.current.cost : null,
      cost_available: metrics.current.cost_available ?? false,
      sender_diversity: senderDiv, sender_mix: senderDiv.label, markets: [...(execBucket?.markets ?? [])], campaigns: [...(execBucket?.campaigns ?? [])],
      last_used: execBucket?.last_used ?? null,
    },
    data_quality: dataQuality,
    autopilot,
    control,
  }

  const kpiByWindow = {}
  for (const kpiRow of allKpiRows) kpiByWindow[kpiRow.time_window] = kpiRowToMetrics(kpiRow)

  const { data: queueRows } = await supabase
    .from('send_queue')
    .select('id, queue_status, message_body, template_id, selected_template_id, template_selection_reason, selected_template_score, market, campaign_id, from_phone_number, created_at, updated_at, seller_id, property_id')
    .or(`template_id.eq.${cleanId},selected_template_id.eq.${cleanId}`)
    .order('updated_at', { ascending: false })
    .limit(100)

  const executions = (queueRows ?? []).map((q) => ({
    queue_id: q.id,
    status: q.queue_status,
    rendered_body: q.message_body,
    provider: 'textgrid',
    market: q.market,
    campaign: q.campaign_id,
    sender: q.from_phone_number,
    seller_id: q.seller_id,
    property_id: q.property_id,
    selection_reason: q.template_selection_reason,
    selected_at: q.created_at,
    sent_at: ['sent', 'delivered'].includes(String(q.queue_status ?? '').toLowerCase()) ? q.updated_at : null,
    delivery_result: q.queue_status,
    created_at: q.created_at,
    updated_at: q.updated_at,
  }))

  const selectionReason = queueRows?.[0]?.template_selection_reason ?? null
  const resolver = {
    eligible_reason: selectionReason ? 'Matched stage, language, and property scope for this seller' : 'Eligible when stage, language, and variables are satisfied',
    selected_reason: selectionReason ?? 'Selected as best match among eligible templates',
    alternatives_considered: null,
    language_match: identity.language,
    property_match: identity.asset_scope ?? 'Any property type',
    variables_available: row.identity.variable_contract?.length ? 'All required variables available' : 'Variable availability unknown',
    concentration_limits: senderDiv.warning ? `Sender concentration ${senderDiv.concentration_pct}% — rotation recommended` : 'Within sender concentration limits',
    fallback_used: selectionReason?.toLowerCase().includes('fallback') ?? false,
    selection_reason: selectionReason,
  }

  let decisionHistory = []
  try {
    const { data: decisions } = await supabase
      .from('template_autopilot_decision_log')
      .select('*')
      .eq('template_id', cleanId)
      .order('timestamp', { ascending: false })
      .limit(50)
    decisionHistory = (decisions ?? []).map((d) => ({
      action: d.action,
      actor: d.actor,
      reason: d.reason,
      timestamp: d.timestamp,
      before: d.before_state,
      after: d.after_state,
      applied: d.applied,
    }))
  } catch {
    decisionHistory = []
  }

  const attributedPct = metrics.current.replies != null && metrics.current.sends > 0 ? 100 : 0
  const cohortNote = metrics.current.replies == null
    ? `${100 - attributedPct}% of sends lack reply tracking in this range — breakdowns show attributed slice only`
    : 'Breakdowns reflect attributed sends in selected period'

  return {
    ok: true,
    template: row,
    dossier: {
      overview: {
        canonical_body: row.identity.canonical_body,
        english_translation: row.identity.english_translation,
        variable_contract: row.identity.variable_contract,
        stage_code: identity.stage_code,
        stage_label: identity.stage_label,
        touch_number: identity.touch_number,
        follow_up_number: identity.follow_up_number,
        use_case: identity.use_case,
        language: identity.language,
        asset_scope: identity.asset_scope,
        active_state: identity.active_state,
        last_used: execBucket?.last_used ?? null,
        sends: metrics.current.sends,
        replies: metrics.current.replies,
        latest_campaign: execBucket?.campaigns ? [...execBucket.campaigns][0] : null,
        latest_sender: senderDiv.dominant_sender,
        recent_rendered_executions: executions.slice(0, 5).map((e) => ({
          queue_id: e.queue_id,
          preview: String(e.rendered_body ?? '').slice(0, 160),
          status: e.status,
        })),
      },
      performance: {
        range: kpiWindow,
        prior_range: priorWindow,
        all_windows: kpiByWindow,
        current: metrics.current,
        comparison: metrics.comparison,
        confidence: metrics.confidence,
      },
      funnel: {
        stage_code: identity.stage_code,
        stages: buildStageFunnel(identity.stage_code, { ...metrics.current, ...attrCurrent }),
      },
      cohorts: {
        market: [...(execBucket?.markets ?? [])].map((m) => ({ key: m, sends: metrics.current.sends })),
        language: identity.language ? [{ key: identity.language, sends: metrics.current.sends }] : [],
        asset: identity.asset_scope ? [{ key: identity.asset_scope, sends: metrics.current.sends }] : [],
        sender: senderDiv.distinct > 0 ? [{ key: senderDiv.dominant_sender, sends: metrics.current.sends, concentration_pct: senderDiv.concentration_pct }] : [],
        campaign: [...(execBucket?.campaigns ?? [])].map((c) => ({ key: String(c), sends: metrics.current.sends })),
        attributed_pct: attributedPct,
        missing_fields: metrics.current.replies == null ? ['reply_tracking'] : [],
        backfill_note: cohortNote,
      },
      executions,
      resolver,
      optimization: row.autopilot,
      decision_history: decisionHistory,
      tabs_available: {
        overview: true,
        performance: true,
        funnel: (metrics.current.delivered ?? 0) > 0,
        cohorts: (metrics.current.sends ?? 0) > 0,
        executions: executions.length > 0,
        selection_logic: Boolean(selectionReason) || (metrics.current.sends ?? 0) > 0,
        optimization: Boolean(row.autopilot),
        change_history: decisionHistory.length > 0,
      },
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
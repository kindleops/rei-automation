import * as backendClient from '../api/backendClient'
import type {
  AutopilotMode,
  ColumnPreset,
  RateValue,
  TemplateIntelligenceFilters,
  TemplateIntelligenceMeta,
  TemplateIntelligenceRow,
  TemplateKpiCard,
  TemplateTimeRange,
} from '../../domain/templates/template-intelligence.types'

function mapRange(range: TemplateTimeRange): string {
  if (range === 'all') return 'all_time'
  if (range === '90d') return '30d'
  if (range === 'custom') return '7d'
  return range
}

function buildQuery(filters: TemplateIntelligenceFilters, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams()
  params.set('range', mapRange(filters.range))
  if (filters.query) params.set('query', filters.query)
  if (filters.stage && filters.stage !== 'all') params.set('stage', filters.stage)
  if (filters.touch != null) params.set('touch', String(filters.touch))
  if (filters.followUp != null) params.set('follow_up', String(filters.followUp))
  if (filters.useCase && filters.useCase !== 'all') params.set('use_case', filters.useCase)
  if (filters.language && filters.language !== 'all') params.set('language', filters.language)
  if (filters.persona) params.set('persona', filters.persona)
  if (filters.assetType) params.set('asset_type', filters.assetType)
  if (filters.market) params.set('market', filters.market)
  if (filters.campaign) params.set('campaign', filters.campaign)
  if (filters.sender) params.set('sender', filters.sender)
  if (filters.agent) params.set('agent', filters.agent)
  if (filters.lifecycle) params.set('lifecycle', filters.lifecycle)
  if (filters.activeState) params.set('active_state', filters.activeState)
  if (filters.rotationState) params.set('rotation_state', filters.rotationState)
  if (filters.performanceLabel) params.set('performance_label', filters.performanceLabel)
  if (filters.confidence) params.set('confidence', filters.confidence)
  if (filters.riskFlag) params.set('risk_flag', filters.riskFlag)
  if (filters.source) params.set('source', filters.source)
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  return params.toString()
}

export interface TemplateIntelligenceListResult {
  ok: boolean
  data: TemplateIntelligenceRow[]
  meta: TemplateIntelligenceMeta
  error?: string
}

export async function fetchTemplateIntelligenceList(
  filters: TemplateIntelligenceFilters,
  page = 0,
  pageSize = 500,
  sort = 'template_name',
  sortDir: 'asc' | 'desc' = 'asc',
  autopilotMode: AutopilotMode = 'shadow',
): Promise<TemplateIntelligenceListResult> {
  const qs = buildQuery(filters, {
    page,
    page_size: pageSize,
    sort,
    sort_dir: sortDir,
    autopilot_mode: autopilotMode,
  })
  const result = await backendClient.callBackend<TemplateIntelligenceListResult>(
    `/api/cockpit/templates/intelligence?${qs}`,
  )
  if (!result.ok) {
    return { ok: false, data: [], meta: {} as TemplateIntelligenceMeta, error: result.message ?? result.error }
  }
  if (!result.data) {
    return { ok: false, data: [], meta: {} as TemplateIntelligenceMeta, error: 'empty_response' }
  }
  return result.data
}

export async function fetchTemplateIntelligenceSummary(
  filters: TemplateIntelligenceFilters,
  autopilotMode: AutopilotMode = 'shadow',
): Promise<{ ok: boolean; cards: Record<string, unknown>; meta?: TemplateIntelligenceMeta; error?: string }> {
  const qs = buildQuery(filters, { summary: '1', autopilot_mode: autopilotMode })
  const result = await backendClient.callBackend<{ ok: boolean; cards: Record<string, unknown>; meta?: TemplateIntelligenceMeta }>(
    `/api/cockpit/templates/intelligence?${qs}`,
  )
  if (!result.ok) return { ok: false, cards: {}, error: result.message ?? result.error }
  if (!result.data) return { ok: false, cards: {}, error: 'empty_response' }
  return result.data
}

export async function fetchTemplateDossier(
  templateId: string,
  filters: TemplateIntelligenceFilters,
  autopilotMode: AutopilotMode = 'shadow',
) {
  const qs = buildQuery(filters, { autopilot_mode: autopilotMode })
  const result = await backendClient.callBackend<{ ok: boolean; template: TemplateIntelligenceRow; dossier: Record<string, unknown> }>(
    `/api/cockpit/templates/intelligence/${encodeURIComponent(templateId)}?${qs}`,
  )
  if (!result.ok) return { ok: false, error: result.message ?? result.error }
  if (!result.data) return { ok: false, error: 'empty_response' }
  return result.data
}

export async function applyTemplateControlShadow(params: {
  templateId: string
  action: string
  reason: string
  actor?: string
  values?: Record<string, unknown>
}) {
  const result = await backendClient.callBackend<{ ok: boolean; audit: Record<string, unknown>; message?: string }>(
    '/api/cockpit/templates/intelligence/controls',
    {
      method: 'POST',
      body: JSON.stringify({ ...params, template_id: params.templateId, mode: 'shadow' }),
    },
  )
  if (!result.ok) return { ok: false, error: result.message ?? result.error }
  if (!result.data) return { ok: false, error: 'empty_response' }
  return result.data
}

export function kpiCardsFromSummary(cards: Record<string, unknown>, meta?: TemplateIntelligenceMeta): TemplateKpiCard[] {
  const priorLabel = (meta as { prior_label?: string })?.prior_label ?? 'vs previous period'
  const defs: Array<{ key: string; label: string; rate?: boolean }> = [
    { key: 'active_templates', label: 'Active Templates' },
    { key: 'templates_used', label: 'Templates Used' },
    { key: 'sends', label: 'Sends' },
    { key: 'delivery_rate', label: 'Delivery Rate', rate: true },
    { key: 'reply_rate', label: 'Reply Rate', rate: true },
    { key: 'positive_rate', label: 'Positive Reply Rate', rate: true },
    { key: 'ownership_confirmed', label: 'Ownership Confirmed' },
    { key: 'stage_advanced', label: 'Stage Advanced' },
    { key: 'opt_out_rate', label: 'Opt-Out Rate', rate: true },
    { key: 'cost', label: 'Estimated Cost' },
  ]
  return defs.map(({ key, label, rate }) => {
    const raw = cards[key] as Record<string, unknown> | undefined
    if (!raw) return { key, label, current: null, priorLabel }
    if (raw.unavailable) {
      return {
        key,
        label,
        current: null,
        unavailable: true,
        unavailableReason: String(raw.unavailable_reason ?? 'Unavailable'),
        priorLabel,
      }
    }
    if (rate) {
      const current = raw.current as RateValue | undefined
      const denom = current?.denominator ?? 0
      const insufficient = denom > 0 && denom < 10
      return {
        key,
        label,
        current: current?.value ?? (denom === 0 ? null : current?.value ?? null),
        numerator: current?.numerator,
        denominator: current?.denominator,
        priorDelta: raw.delta_absolute as number | null,
        baseline: (raw.baseline as RateValue | undefined)?.value ?? null,
        priorLabel,
        insufficientData: insufficient,
      }
    }
    const cur = raw.current as number
    return {
      key,
      label,
      current: cur,
      priorDelta: raw.delta_absolute as number,
      baseline: raw.baseline as number,
      priorLabel,
    }
  })
}

const FUNNEL_BY_STAGE: Record<string, string[]> = {
  S1: ['delivered', 'replied', 'ownership_confirmed', 'wrong_person', 'selling_interest', 'advanced_s2'],
  S1F: ['delivered', 'replied', 'ownership_confirmed', 'wrong_person', 'selling_interest', 'advanced_s2'],
  S2: ['delivered', 'replied', 'seller_open', 'not_interested', 'timeline_captured', 'advanced_s3'],
  S3: ['delivered', 'replied', 'asking_price', 'price_objection', 'advanced_s4'],
  S4: ['delivered', 'replied', 'condition_captured', 'repairs_captured', 'occupancy_captured', 'advanced_s5'],
  S5: ['delivered', 'replied', 'offer_presented', 'counteroffer', 'accepted', 'advanced_s6'],
  S6: ['delivered', 'replied', 'agreement_sent', 'agreement_viewed', 'agreement_signed', 'closing_milestone', 'completed'],
}

export const COLUMN_PRESETS: Record<ColumnPreset, (stage?: string) => string[]> = {
  performance: () => ['identity', 'rotation_state', 'sends', 'delivery', 'replies', 'reply_rate', 'positive', 'positive_rate', 'stage_advancement', 'stage_rate', 'opt_out', 'confidence', 'trend'],
  execution: () => ['identity', 'selected', 'queued', 'sent', 'delivered', 'failed', 'blocked', 'retries', 'sender_diversity', 'cost', 'last_used'],
  funnel: (stage) => ['identity', ...(FUNNEL_BY_STAGE[stage ?? ''] ?? ['delivered', 'replied', 'ownership_confirmed', 'selling_interest', 'advanced_s2'])],
  autopilot: () => ['identity', 'state', 'weight', 'daily_cap', 'proposed_weight', 'proposed_state', 'decision', 'confidence', 'reevaluation'],
  data_quality: () => ['identity', 'variable_contract', 'asset_scope', 'language_quality', 'attribution', 'render_failures', 'metadata_issues', 'recommended_fix'],
}

export async function exportFilteredTemplates(
  filters: TemplateIntelligenceFilters,
  sort: string,
  sortDir: 'asc' | 'desc',
  totalCount: number,
  pageSize = 500,
): Promise<TemplateIntelligenceRow[]> {
  const pages = Math.ceil(totalCount / pageSize)
  const all: TemplateIntelligenceRow[] = []
  for (let page = 0; page < pages; page++) {
    const res = await fetchTemplateIntelligenceList(filters, page, pageSize, sort, sortDir, 'shadow')
    if (!res.ok) break
    all.push(...res.data)
    if (res.data.length < pageSize) break
  }
  return all
}

export const SAVED_VIEW_KEY = 'occ-template-intelligence-views'
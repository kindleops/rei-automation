import { useCallback, useMemo } from 'react'
import type { TemplateIntelligenceFilters, TemplateTimeRange } from '../../../domain/templates/template-intelligence.types'

function readParam(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key)
  return v && v !== 'all' ? v : undefined
}

export function filtersFromSearchParams(params: URLSearchParams): TemplateIntelligenceFilters {
  const range = (params.get('tpl_range') ?? '7d') as TemplateTimeRange
  const touch = params.get('tpl_touch')
  const followUp = params.get('tpl_follow_up')
  return {
    range,
    customStart: params.get('tpl_from') ?? undefined,
    customEnd: params.get('tpl_to') ?? undefined,
    stage: params.get('tpl_stage') ?? undefined,
    touch: touch ? Number(touch) : undefined,
    followUp: followUp ? Number(followUp) : undefined,
    useCase: readParam(params, 'tpl_use_case'),
    language: readParam(params, 'tpl_language'),
    persona: readParam(params, 'tpl_persona'),
    assetType: readParam(params, 'tpl_asset'),
    market: readParam(params, 'tpl_market'),
    campaign: readParam(params, 'tpl_campaign'),
    sender: readParam(params, 'tpl_sender'),
    agent: readParam(params, 'tpl_agent'),
    lifecycle: readParam(params, 'tpl_lifecycle'),
    activeState: readParam(params, 'tpl_active'),
    rotationState: readParam(params, 'tpl_rotation'),
    performanceLabel: readParam(params, 'tpl_perf'),
    confidence: readParam(params, 'tpl_confidence'),
    riskFlag: readParam(params, 'tpl_risk'),
    source: readParam(params, 'tpl_source'),
    query: params.get('tpl_q') ?? undefined,
  }
}

export function searchParamsFromFilters(filters: TemplateIntelligenceFilters): URLSearchParams {
  const params = new URLSearchParams()
  params.set('tpl_range', filters.range)
  if (filters.customStart) params.set('tpl_from', filters.customStart)
  if (filters.customEnd) params.set('tpl_to', filters.customEnd)
  if (filters.stage) params.set('tpl_stage', filters.stage)
  if (filters.touch != null) params.set('tpl_touch', String(filters.touch))
  if (filters.followUp != null) params.set('tpl_follow_up', String(filters.followUp))
  if (filters.useCase) params.set('tpl_use_case', filters.useCase)
  if (filters.language) params.set('tpl_language', filters.language)
  if (filters.persona) params.set('tpl_persona', filters.persona)
  if (filters.assetType) params.set('tpl_asset', filters.assetType)
  if (filters.market) params.set('tpl_market', filters.market)
  if (filters.campaign) params.set('tpl_campaign', filters.campaign)
  if (filters.sender) params.set('tpl_sender', filters.sender)
  if (filters.agent) params.set('tpl_agent', filters.agent)
  if (filters.lifecycle) params.set('tpl_lifecycle', filters.lifecycle)
  if (filters.activeState) params.set('tpl_active', filters.activeState)
  if (filters.rotationState) params.set('tpl_rotation', filters.rotationState)
  if (filters.performanceLabel) params.set('tpl_perf', filters.performanceLabel)
  if (filters.confidence) params.set('tpl_confidence', filters.confidence)
  if (filters.riskFlag) params.set('tpl_risk', filters.riskFlag)
  if (filters.source) params.set('tpl_source', filters.source)
  if (filters.query) params.set('tpl_q', filters.query)
  return params
}

export function useTemplateIntelligenceFilters(searchParams: URLSearchParams, setSearchParams: (next: URLSearchParams) => void) {
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])

  const updateFilters = useCallback((patch: Partial<TemplateIntelligenceFilters>) => {
    const next = searchParamsFromFilters({ ...filters, ...patch })
    setSearchParams(next)
  }, [filters, setSearchParams])

  const resetFilters = useCallback(() => {
    setSearchParams(new URLSearchParams({ tpl_range: '7d' }))
  }, [setSearchParams])

  return { filters, updateFilters, resetFilters }
}
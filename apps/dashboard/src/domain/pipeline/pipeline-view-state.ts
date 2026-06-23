import type {
  PipelineCardDesign,
  PipelineFilterGroup,
  PipelineSortSpec,
  PipelineViewState,
} from './pipeline-card-design.types'
import type { PipelineGroupByMode, PipelineSavedView } from './pipeline-opportunity.types'
import {
  DEFAULT_PIPELINE_CARD_DESIGN,
  getRecommendedCardDesign,
  normalizeCardDesign,
} from './pipeline-card-presets'
import { loadPipelineGroupBy, loadPipelineScope, type PipelineScope } from './pipeline-display-helpers'

const VIEW_STATE_KEY = 'pipeline_view_state_v2'
const CARD_DESIGNS_KEY = 'pipeline_card_designs_by_group_v1'

const DEFAULT_SORTS: PipelineSortSpec[] = [
  { field: 'last_activity_at', direction: 'desc', nulls: 'last' },
]

const EMPTY_FILTERS: PipelineFilterGroup = { logic: 'and', clauses: [] }

function sanitizeFilters(raw: unknown): PipelineFilterGroup {
  if (!raw || typeof raw !== 'object') return EMPTY_FILTERS
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.clauses)) {
    const clauses = obj.clauses.filter((c) => {
      if (!c || typeof c !== 'object') return false
      if ('clauses' in c) return Array.isArray((c as PipelineFilterGroup).clauses)
      return typeof (c as { field?: string }).field === 'string'
    })
    return { logic: obj.logic === 'or' ? 'or' : 'and', clauses }
  }
  // Legacy flat filters: { conversation_state: "needs_reply" }
  const clauses = Object.entries(obj)
    .filter(([k, v]) => k !== 'logic' && v !== undefined && v !== null && v !== '')
    .map(([field, value]) => ({ field, operator: 'is', value: String(value) }))
  return clauses.length > 0 ? { logic: 'and', clauses } : EMPTY_FILTERS
}

function sanitizeSorts(raw: unknown): PipelineSortSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_SORTS
  const sorts = raw
    .filter((s) => s && typeof s === 'object' && typeof s.field === 'string')
    .map((s) => ({
      field: s.field,
      direction: s.direction === 'asc' ? 'asc' as const : 'desc' as const,
      nulls: s.nulls === 'first' ? 'first' as const : 'last' as const,
    }))
  return sorts.length > 0 ? sorts : DEFAULT_SORTS
}

export function resetPipelineViewState(): PipelineViewState {
  try {
    localStorage.removeItem(VIEW_STATE_KEY)
    localStorage.removeItem('pipeline_view_state_v1')
    localStorage.removeItem(CARD_DESIGNS_KEY)
  } catch { /* ignore */ }
  return loadPipelineViewState()
}

export function loadCardDesignsByGroup(): Partial<Record<PipelineGroupByMode, PipelineCardDesign>> {
  try {
    const raw = localStorage.getItem(CARD_DESIGNS_KEY)
    if (raw) return JSON.parse(raw) as Partial<Record<PipelineGroupByMode, PipelineCardDesign>>
  } catch { /* ignore */ }
  return {}
}

export function saveCardDesignsByGroup(designs: Partial<Record<PipelineGroupByMode, PipelineCardDesign>>) {
  try { localStorage.setItem(CARD_DESIGNS_KEY, JSON.stringify(designs)) } catch { /* ignore */ }
}

export function getCardDesignForGroup(
  groupBy: PipelineGroupByMode,
  designsByGroup?: Partial<Record<PipelineGroupByMode, PipelineCardDesign>>,
): PipelineCardDesign {
  const stored = designsByGroup ?? loadCardDesignsByGroup()
  if (stored[groupBy]) return normalizeCardDesign(stored[groupBy], groupBy)
  return getRecommendedCardDesign(groupBy)
}

export function loadPipelineViewState(): PipelineViewState {
  const groupBy = loadPipelineGroupBy()
  const scope = loadPipelineScope()
  const cardDesignsByGroup = loadCardDesignsByGroup()
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PipelineViewState>
      const resolvedGroup = parsed.groupBy ?? groupBy
      const designs = parsed.cardDesignsByGroup ?? cardDesignsByGroup
      return {
        scope: parsed.scope ?? scope,
        groupBy: resolvedGroup,
        filters: sanitizeFilters(parsed.filters),
        sorts: sanitizeSorts(parsed.sorts),
        cardDesign: normalizeCardDesign(
          parsed.cardDesign ?? getCardDesignForGroup(resolvedGroup, designs),
          resolvedGroup,
        ),
        cardDesignsByGroup: Object.fromEntries(
          Object.entries(designs).map(([k, d]) => [k, normalizeCardDesign(d, k as PipelineGroupByMode)]),
        ) as Partial<Record<PipelineGroupByMode, PipelineCardDesign>>,
        density: parsed.density ?? 'standard',
        activeViewId: parsed.activeViewId ?? null,
      }
    }
  } catch { /* ignore */ }
  return {
    scope,
    groupBy,
    filters: EMPTY_FILTERS,
    sorts: DEFAULT_SORTS,
    cardDesign: getCardDesignForGroup(groupBy, cardDesignsByGroup),
    cardDesignsByGroup,
    density: 'standard',
    activeViewId: null,
  }
}

export function savePipelineViewState(state: PipelineViewState) {
  try { localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
  saveCardDesignsByGroup(state.cardDesignsByGroup)
}

export function applySavedViewToState(view: PipelineSavedView, current: PipelineViewState): PipelineViewState {
  const legacyMap: Record<string, PipelineGroupByMode> = {
    acquisition_stage: 'stage',
    opportunity_status: 'status',
    conversation_state: 'status',
    queue_execution: 'queue_status',
    workflow_state: 'workflow_status',
    follow_up: 'follow_up_state',
    asset_class: 'property_type',
  }
  const groupBy = legacyMap[String(view.group_by)] ?? (view.group_by as PipelineGroupByMode) ?? current.groupBy
  const filters = sanitizeFilters(view.filters)
  const sorts = sanitizeSorts(view.sorts)
  const cardDesignsByGroup = { ...current.cardDesignsByGroup }
  if (view.card_designs_by_group && typeof view.card_designs_by_group === 'object') {
    Object.assign(cardDesignsByGroup, view.card_designs_by_group)
  }
  const cardDesign = normalizeCardDesign(
    view.card_design && Object.keys(view.card_design).length > 0
      ? view.card_design as unknown as PipelineCardDesign
      : getCardDesignForGroup(groupBy, cardDesignsByGroup),
    groupBy,
  )

  return {
    ...current,
    scope: (view.scope as PipelineScope) ?? current.scope,
    groupBy,
    filters,
    sorts,
    cardDesign,
    cardDesignsByGroup,
    density: (view.density as PipelineViewState['density']) ?? current.density,
    activeViewId: view.id,
  }
}

export function viewStateToSavePayload(state: PipelineViewState, label: string, viewKey?: string): Partial<PipelineSavedView> {
  return {
    view_key: viewKey ?? label.toLowerCase().replace(/\s+/g, '_'),
    label,
    filters: state.filters as unknown as Record<string, unknown>,
    group_by: state.groupBy,
    scope: state.scope,
    sorts: state.sorts,
    card_design: state.cardDesign as unknown as Record<string, unknown>,
    card_designs_by_group: state.cardDesignsByGroup,
    density: state.density,
    is_system: false,
  }
}

export { DEFAULT_PIPELINE_CARD_DESIGN, DEFAULT_SORTS, EMPTY_FILTERS }
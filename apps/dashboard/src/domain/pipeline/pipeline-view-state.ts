import type {
  PipelineCardDesign,
  PipelineFilterGroup,
  PipelineSortSpec,
  PipelineViewState,
} from './pipeline-card-design.types'
import type { PipelineGroupByMode, PipelineSavedView } from './pipeline-opportunity.types'
import { cloneCardDesign, DEFAULT_PIPELINE_CARD_DESIGN, getRecommendedCardDesign } from './pipeline-card-presets'
import { loadPipelineGroupBy, loadPipelineScope, type PipelineScope } from './pipeline-display-helpers'

const VIEW_STATE_KEY = 'pipeline_view_state_v1'
const CARD_DESIGNS_KEY = 'pipeline_card_designs_by_group_v1'

const DEFAULT_SORTS: PipelineSortSpec[] = [
  { field: 'last_activity_at', direction: 'desc', nulls: 'last' },
]

const EMPTY_FILTERS: PipelineFilterGroup = { logic: 'and', clauses: [] }

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
  if (stored[groupBy]) return cloneCardDesign(stored[groupBy]!)
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
      return {
        scope: parsed.scope ?? scope,
        groupBy: parsed.groupBy ?? groupBy,
        filters: parsed.filters ?? EMPTY_FILTERS,
        sorts: parsed.sorts ?? DEFAULT_SORTS,
        cardDesign: parsed.cardDesign ?? getCardDesignForGroup(groupBy, cardDesignsByGroup),
        cardDesignsByGroup: parsed.cardDesignsByGroup ?? cardDesignsByGroup,
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
  const filters = (view.filters && typeof view.filters === 'object' && 'clauses' in view.filters)
    ? view.filters as PipelineFilterGroup
    : current.filters
  const sorts = Array.isArray(view.sorts) && view.sorts.length > 0
    ? view.sorts as PipelineSortSpec[]
    : current.sorts
  const cardDesignsByGroup = { ...current.cardDesignsByGroup }
  if (view.card_designs_by_group && typeof view.card_designs_by_group === 'object') {
    Object.assign(cardDesignsByGroup, view.card_designs_by_group)
  }
  const cardDesign = view.card_design && Object.keys(view.card_design).length > 0
    ? view.card_design as PipelineCardDesign
    : getCardDesignForGroup(groupBy, cardDesignsByGroup)

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
    filters: state.filters,
    group_by: state.groupBy,
    scope: state.scope,
    sorts: state.sorts,
    card_design: state.cardDesign,
    card_designs_by_group: state.cardDesignsByGroup,
    density: state.density,
    is_system: false,
  }
}

export { DEFAULT_PIPELINE_CARD_DESIGN, DEFAULT_SORTS, EMPTY_FILTERS }
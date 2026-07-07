import { DEFAULT_ADVANCED_FILTERS } from '../inbox/inbox-advanced-filter-engine'
import type { InboxAdvancedFilters } from '../../modules/inbox/inbox-ui-helpers'
import type { MapStatusValue } from './inbox-to-map-filter-expression'
import { stripMapExcludedFilters } from './map-filter-field-exclusions'

export interface MapAppliedFilterDraft {
  filters: InboxAdvancedFilters
  mapStatus: MapStatusValue
}

export function mergeMapFilterDraft(
  source?: Partial<InboxAdvancedFilters> | Record<string, unknown> | null,
): InboxAdvancedFilters {
  if (!source || typeof source !== 'object') {
    return { ...DEFAULT_ADVANCED_FILTERS }
  }
  return {
    ...DEFAULT_ADVANCED_FILTERS,
    ...stripMapExcludedFilters(source as Record<string, unknown>),
  } as InboxAdvancedFilters
}

export function createMapAppliedFilterDraft(
  filters: InboxAdvancedFilters,
  mapStatus: MapStatusValue,
): MapAppliedFilterDraft {
  return {
    filters: mergeMapFilterDraft(filters),
    mapStatus,
  }
}
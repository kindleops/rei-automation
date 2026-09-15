import type { EntityGraphFilters, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { activeFilterEntries, compactCount, type EntityScope } from './entity-graph-mobile-format'
import type {
  EntityGraphFieldFilter,
  EntityGraphFilterCatalog,
} from '../../../domain/entity-graph/entity-graph-field-filters'
import {
  completeFieldFilters,
  describeFieldFilter,
  findCatalogField,
} from '../../../domain/entity-graph/entity-graph-field-filters'

/**
 * Translate an Entity Graph cohort into campaign target filters.
 *
 * Only field keys the campaign filter pipeline actually resolves are emitted.
 * The mapping is verified against PREVIEW_SUPPORTED_FIELD_KEYS and
 * FULL_REACH_GRAPH_FILTER_COLUMNS in the campaign service — a filter the
 * pipeline would drop is worse than no filter, because the operator would
 * believe the cohort was narrower than what actually gets targeted.
 */

export type CampaignFilter = {
  field_key: string
  operator: string
  value: string | number | boolean | Array<string | number>
}

const ASSET_TYPE_TO_PROPERTY_TYPE: Record<string, string[]> = {
  sfr: ['Single Family'],
  multifamily: ['Multi-Family'],
  apartment: ['Apartment'],
  condo: ['Condo'],
  townhome: ['Townhouse'],
  land: ['Vacant Land'],
  'mobile home': ['Mobile Home'],
  other: ['Other'],
}

/**
 * Catalog field filters ARE campaign filters -- same field_key, same operator,
 * same value shape, resolved by the same compiler. A cohort built in the field
 * builder therefore carries over verbatim, with no second translation to drift.
 *
 * Only the ones the campaign pipeline can resolve are emitted. 27 of the 101
 * property fields are `supported_in_preview`; handing over one of the other 74
 * would now be rejected as `unresolved_target_filters` (it used to be dropped,
 * which is how a five-property selection became 64,878 rows). The ones that
 * cannot carry are reported separately so the operator sees the campaign cohort
 * will be WIDER than the list they are looking at.
 */
export function campaignReadyFieldFilters(
  fieldFilters: EntityGraphFieldFilter[],
  catalog: EntityGraphFilterCatalog | null,
): { carried: CampaignFilter[]; dropped: string[] } {
  const carried: CampaignFilter[] = []
  const dropped: string[] = []
  for (const filter of completeFieldFilters(fieldFilters)) {
    const field = findCatalogField(catalog, filter.field_key)
    // No catalog yet means we cannot prove the field carries. Report rather
    // than assume -- an assumed filter is the widening failure.
    if (!field?.supported_in_preview) {
      dropped.push(describeFieldFilter(filter, field))
      continue
    }
    carried.push({
      field_key: filter.field_key,
      operator: filter.operator,
      value: filter.value as CampaignFilter['value'],
    })
  }
  return { carried, dropped }
}

export function cohortToCampaignFilters({
  scope,
  filters,
  fieldFilters = [],
  catalog = null,
  mode,
  selected,
}: {
  scope: EntityScope
  filters: EntityGraphFilters
  fieldFilters?: EntityGraphFieldFilter[]
  catalog?: EntityGraphFilterCatalog | null
  mode: 'cohort' | 'selection'
  selected: EntitySearchResult[]
}): CampaignFilter[] {
  if (mode === 'selection') {
    if (selected.length === 0) return []
    // Property ids are the anchor the campaign target graph keys on. Other
    // scopes hand over their owner ids, which the graph also indexes.
    if (scope === 'properties') {
      return [{ field_key: 'properties.property_id', operator: 'in', value: selected.map((r) => r.entityId) }]
    }
    const ownerIds = selected
      .map((r) => r.contextIds?.masterOwnerId ?? (scope === 'master_owners' ? r.entityId : null))
      .filter((id): id is string => Boolean(id))
    if (ownerIds.length === 0) return []
    return [{ field_key: 'properties.master_owner_id', operator: 'in', value: [...new Set(ownerIds)] }]
  }

  const out: CampaignFilter[] = []
  const push = (field_key: string, operator: string, value: CampaignFilter['value']) => {
    out.push({ field_key, operator, value })
  }

  if (filters.market) push('properties.market', 'contains', filters.market)
  if (filters.city) push('properties.property_address_city', 'contains', filters.city)
  if (filters.state) push('properties.property_address_state', 'equals', filters.state.toUpperCase())
  if (filters.zip) push('properties.property_address_zip', 'equals', filters.zip)

  if (filters.assetType) {
    const values = ASSET_TYPE_TO_PROPERTY_TYPE[filters.assetType.toLowerCase()] ?? [filters.assetType]
    push('properties.property_type', 'in', values)
  }

  if (filters.unitsMin) push('properties.units_count', 'gte', Number(filters.unitsMin))
  if (filters.unitsMax) push('properties.units_count', 'lte', Number(filters.unitsMax))
  if (filters.scoreMin) push('properties.final_acquisition_score', 'gte', Number(filters.scoreMin))
  if (filters.scoreMax) push('properties.final_acquisition_score', 'lte', Number(filters.scoreMax))
  if (filters.ownerType) push('properties.owner_type_guess', 'contains', filters.ownerType)

  // The field builder's filters, verbatim.
  out.push(...campaignReadyFieldFilters(fieldFilters, catalog).carried)

  // Deliberately not emitted, because the campaign pipeline has no equivalent:
  //   priorityTier / coverageMin — master_owners rollup columns, no graph column
  //   language                   — prospects.language_preference is scoped to the
  //                                person, not the property target row
  //   contactStatus / reachable  — contact-method state, resolved by Campaigns'
  //                                own routing and suppression pass, not by the
  //                                target filter
  return out
}

/**
 * Operators whose meaning is entirely in the operator. Rendering a value for
 * one of these printed "Tax delinquent is undefined" -- the filter was correct,
 * the description was not, and a description the operator cannot read is how a
 * handoff gets approved without being understood.
 */
const VALUELESS_CAMPAIGN_OPERATORS = new Set(['is_true', 'is_false', 'is_empty', 'is_not_empty'])

const CAMPAIGN_OPERATOR_LABELS: Record<string, string> = {
  in: 'is any of',
  is_any_of: 'is any of',
  is_not_any_of: 'is none of',
  gte: '≥',
  lte: '≤',
  gt: '>',
  lt: '<',
  between: 'between',
  contains: 'contains',
  contains_any: 'contains any of',
  on_or_after: 'on or after',
  on_or_before: 'on or before',
  is_true: 'is true',
  is_false: 'is false',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

export function describeCampaignFilters(
  filters: CampaignFilter[],
): Array<{ key: string; label: string; value: string }> {
  return filters.map((filter) => {
    const label = filter.field_key.split('.').pop()!.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
    const operator = CAMPAIGN_OPERATOR_LABELS[filter.operator] ?? 'is'
    if (VALUELESS_CAMPAIGN_OPERATORS.has(filter.operator)) {
      return { key: `${filter.field_key}:${filter.operator}`, label: `${label} ${operator}`, value: '' }
    }
    const value = Array.isArray(filter.value)
      ? (filter.value.length > 4
          ? `${filter.value.length} values`
          : filter.value.join(', '))
      : filter.value === undefined || filter.value === null
        ? ''
        : String(filter.value)
    return { key: `${filter.field_key}:${filter.operator}`, label: `${label} ${operator}`, value }
  })
}

/**
 * Filters that this screen applies but does NOT hand to Campaigns. Surfacing
 * them keeps the handoff honest — the operator can see that the campaign
 * cohort will be wider than what they are looking at.
 */
export function unmappedCohortFilters(
  filters: EntityGraphFilters,
  fieldFilters: EntityGraphFieldFilter[] = [],
  catalog: EntityGraphFilterCatalog | null = null,
): string[] {
  const unmapped: string[] = [...campaignReadyFieldFilters(fieldFilters, catalog).dropped]
  if (filters.priorityTier) unmapped.push(`Priority tier ${filters.priorityTier}`)
  if (filters.coverageMin) unmapped.push(`Coverage ≥ ${filters.coverageMin}%`)
  if (filters.language) unmapped.push(`Language ${filters.language}`)
  if (filters.contactStatus) unmapped.push(`Contact status ${filters.contactStatus}`)
  if (filters.reachable) unmapped.push('Reachable only')
  if (filters.entityType) unmapped.push(`Entity type ${filters.entityType}`)
  return unmapped
}

/** Short human label for a saved cohort, e.g. "GA SFR · 1.1K". */
export function cohortLabelFor(scope: EntityScope, filters: EntityGraphFilters, total: number | null): string {
  const entries = activeFilterEntries(filters, scope)
  const head = entries.length > 0 ? entries.slice(0, 2).map((e) => e.value).join(' ') : 'All'
  return `${head}${total !== null ? ` · ${compactCount(total)}` : ''}`
}

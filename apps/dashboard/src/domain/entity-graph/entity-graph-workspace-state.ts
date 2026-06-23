import type { EntityGraphFilters, EntityGraphTab, EntityGraphVisualMode } from './entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from './entity-graph.types'
import type { UniversalEntityType } from './entity-graph.types'

export type EntityGraphWorkspaceState = {
  tab: EntityGraphTab
  visualMode: EntityGraphVisualMode
  query: string
  contactSubtype: 'phone' | 'email'
  cursor: number
  sortBy: string
  ascending: boolean
  scrollTop: number
  filters: EntityGraphFilters
  inspectorOpen: boolean
  graphFocusOnly: boolean
}

export const DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE: EntityGraphWorkspaceState = {
  tab: 'properties',
  visualMode: 'table',
  query: '',
  contactSubtype: 'phone',
  cursor: 0,
  sortBy: '',
  ascending: true,
  scrollTop: 0,
  filters: { ...EMPTY_ENTITY_GRAPH_FILTERS },
  inspectorOpen: false,
  graphFocusOnly: false,
}

const ENTITY_TYPE_TO_TAB: Record<string, EntityGraphTab> = {
  property: 'properties',
  master_owner: 'master_owners',
  prospect: 'people',
  organization: 'organizations',
  phone: 'contact_methods',
  email: 'contact_methods',
  market: 'markets',
  zip: 'zips',
}

export function entityTabForType(entityType: UniversalEntityType): EntityGraphTab | null {
  if (!entityType) return null
  return ENTITY_TYPE_TO_TAB[entityType] ?? null
}

const VALID_TABS = new Set<EntityGraphTab>([
  'properties',
  'master_owners',
  'people',
  'organizations',
  'contact_methods',
  'markets',
  'zips',
])

const FILTER_KEYS = Object.keys(EMPTY_ENTITY_GRAPH_FILTERS) as Array<keyof EntityGraphFilters>

function readFilters(params: URLSearchParams): EntityGraphFilters {
  const filters = { ...EMPTY_ENTITY_GRAPH_FILTERS }
  for (const key of FILTER_KEYS) {
    const paramKey = `eg_f_${key}`
    const raw = params.get(paramKey)
    if (raw === null) continue
    if (key === 'reachable') {
      filters.reachable = raw === '1'
    } else {
      filters[key] = raw as never
    }
  }
  return filters
}

function writeFilters(params: URLSearchParams, filters: EntityGraphFilters): void {
  for (const key of FILTER_KEYS) {
    const paramKey = `eg_f_${key}`
    const value = filters[key]
    if (key === 'reachable') {
      if (value) params.set(paramKey, '1')
      else params.delete(paramKey)
      continue
    }
    if (value) params.set(paramKey, String(value))
    else params.delete(paramKey)
  }
}

const SESSION_KEY = 'nexus:entity-graph:workspace'

export function readEntityGraphWorkspaceState(search?: string): EntityGraphWorkspaceState {
  const params = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
  const rawTab = params.get('eg_tab') as EntityGraphTab
  const tab = VALID_TABS.has(rawTab) ? rawTab : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.tab
  const visualMode = (params.get('eg_mode') as EntityGraphVisualMode) || DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.visualMode
  const cursor = Number(params.get('eg_cursor') ?? 0)

  const fromUrl: EntityGraphWorkspaceState = {
    tab: ENTITY_TYPE_TO_TAB[tab] ? tab : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.tab,
    visualMode: ['table', 'cards', 'graph'].includes(visualMode) ? visualMode : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.visualMode,
    query: params.get('eg_q') ?? '',
    contactSubtype: params.get('eg_subtype') === 'email' ? 'email' : 'phone',
    cursor: Number.isFinite(cursor) && cursor >= 0 ? cursor : 0,
    sortBy: params.get('eg_sort') ?? '',
    ascending: params.get('eg_asc') !== '0',
    scrollTop: Number(params.get('eg_scroll') ?? 0) || 0,
    filters: readFilters(params),
    inspectorOpen: params.get('eg_inspector') === '1',
    graphFocusOnly: params.get('eg_graph_focus') === '1',
  }

  if (typeof window === 'undefined') return fromUrl

  try {
    const cached = sessionStorage.getItem(SESSION_KEY)
    if (!cached) return fromUrl
    const parsed = JSON.parse(cached) as Partial<EntityGraphWorkspaceState>
    return {
      ...DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE,
      ...parsed,
      ...fromUrl,
      filters: { ...EMPTY_ENTITY_GRAPH_FILTERS, ...parsed.filters, ...fromUrl.filters },
    }
  } catch {
    return fromUrl
  }
}

export function writeEntityGraphWorkspaceState(
  state: EntityGraphWorkspaceState,
  options: { replace?: boolean } = {},
): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const params = url.searchParams
  params.set('eg_tab', state.tab)
  params.set('eg_mode', state.visualMode)
  params.set('eg_q', state.query)
  params.set('eg_subtype', state.contactSubtype)
  params.set('eg_cursor', String(state.cursor))
  if (state.sortBy) params.set('eg_sort', state.sortBy)
  else params.delete('eg_sort')
  params.set('eg_asc', state.ascending ? '1' : '0')
  params.set('eg_scroll', String(Math.max(0, Math.round(state.scrollTop))))
  writeFilters(params, state.filters)
  if (state.inspectorOpen) params.set('eg_inspector', '1')
  else params.delete('eg_inspector')
  if (state.graphFocusOnly) params.set('eg_graph_focus', '1')
  else params.delete('eg_graph_focus')

  const nextUrl = `${url.pathname}?${params}`
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state))
  } catch {
    // ignore quota errors
  }
  if (options.replace) window.history.replaceState({ egWorkspace: state }, '', nextUrl)
  else window.history.pushState({ egWorkspace: state }, '', nextUrl)
}

export function replaceEntityGraphWorkspaceQuery(state: Partial<EntityGraphWorkspaceState>): void {
  const current = readEntityGraphWorkspaceState()
  writeEntityGraphWorkspaceState({ ...current, ...state }, { replace: true })
}

export function filtersToApiParams(filters: EntityGraphFilters): Record<string, string | undefined> {
  return {
    market: filters.market || undefined,
    city: filters.city || undefined,
    state: filters.state || undefined,
    zip: filters.zip || undefined,
    asset_type: filters.assetType || undefined,
    owner_type: filters.ownerType || undefined,
    priority_tier: filters.priorityTier || undefined,
    contact_status: filters.contactStatus || undefined,
    reachable: filters.reachable ? '1' : undefined,
    units_min: filters.unitsMin || undefined,
    units_max: filters.unitsMax || undefined,
    score_min: filters.scoreMin || undefined,
    score_max: filters.scoreMax || undefined,
    coverage_min: filters.coverageMin || undefined,
    language: filters.language || undefined,
    entity_type: filters.entityType || undefined,
  }
}
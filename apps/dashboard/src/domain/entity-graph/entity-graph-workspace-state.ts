import type { EntityGraphTab, EntityGraphVisualMode } from './entity-graph.types'
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

export function readEntityGraphWorkspaceState(search?: string): EntityGraphWorkspaceState {
  const params = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
  const rawTab = params.get('eg_tab') as EntityGraphTab
  const tab = VALID_TABS.has(rawTab) ? rawTab : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.tab
  const visualMode = (params.get('eg_mode') as EntityGraphVisualMode) || DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.visualMode
  const cursor = Number(params.get('eg_cursor') ?? 0)
  return {
    tab: ENTITY_TYPE_TO_TAB[tab] ? tab : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.tab,
    visualMode: ['table', 'cards', 'graph'].includes(visualMode) ? visualMode : DEFAULT_ENTITY_GRAPH_WORKSPACE_STATE.visualMode,
    query: params.get('eg_q') ?? '',
    contactSubtype: params.get('eg_subtype') === 'email' ? 'email' : 'phone',
    cursor: Number.isFinite(cursor) && cursor >= 0 ? cursor : 0,
    sortBy: params.get('eg_sort') ?? '',
    ascending: params.get('eg_asc') !== '0',
    scrollTop: Number(params.get('eg_scroll') ?? 0) || 0,
  }
}

export function writeEntityGraphWorkspaceState(
  state: EntityGraphWorkspaceState,
  options: { replace?: boolean; preserveEntityPath?: boolean } = {},
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

  const nextUrl = `${url.pathname}?${params}`
  if (options.replace) window.history.replaceState({ egWorkspace: state }, '', nextUrl)
  else window.history.pushState({ egWorkspace: state }, '', nextUrl)
}

export function replaceEntityGraphWorkspaceQuery(state: Partial<EntityGraphWorkspaceState>): void {
  const current = readEntityGraphWorkspaceState()
  writeEntityGraphWorkspaceState({ ...current, ...state }, { replace: true })
}
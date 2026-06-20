import type { PropertyFilterClause, PropertyFilters, PropertySort } from '../../lib/data/propertyData'
import type { PropertyWorkspaceView, QuickFilterKey } from './propertyFilters'

export type PropertyIntelligenceListState = {
  page: number
  searchInput: string
  sort: PropertySort
  filters: PropertyFilters
  quickFilters: string[]
  advancedFilters: PropertyFilterClause[]
  view: PropertyWorkspaceView
  scrollTop: number
}

const STORAGE_KEY = 'nexus:property-intelligence:list-state'

const DEFAULT_FILTERS: PropertyFilters = {
  market: 'All Markets',
  propertyType: 'All Types',
  ownerType: 'All Owners',
  equity: 'all',
  taxDelinquent: 'all',
  activeLien: 'all',
  search: '',
}

export const DEFAULT_LIST_STATE: PropertyIntelligenceListState = {
  page: 1,
  searchInput: '',
  sort: { column: 'final_acquisition_score', ascending: false },
  filters: DEFAULT_FILTERS,
  quickFilters: [],
  advancedFilters: [],
  view: 'command',
  scrollTop: 0,
}

function parseSort(value: string | null): PropertySort {
  if (!value) return DEFAULT_LIST_STATE.sort
  const [column, direction] = value.split(':')
  if (!column) return DEFAULT_LIST_STATE.sort
  return { column, ascending: direction === 'asc' }
}

export function readPropertyIntelligenceStateFromUrl(): Partial<PropertyIntelligenceListState> {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const next: Partial<PropertyIntelligenceListState> = {}

  const page = Number(params.get('pi_page') ?? '')
  if (Number.isFinite(page) && page > 0) next.page = page

  const view = params.get('pi_view')
  if (view) next.view = view as PropertyWorkspaceView

  const searchInput = params.get('pi_q')
  if (searchInput !== null) next.searchInput = searchInput

  const sort = parseSort(params.get('pi_sort'))
  next.sort = sort

  next.filters = {
    ...DEFAULT_FILTERS,
    market: params.get('pi_market') ?? DEFAULT_FILTERS.market,
    propertyType: params.get('pi_type') ?? DEFAULT_FILTERS.propertyType,
    ownerType: params.get('pi_owner') ?? DEFAULT_FILTERS.ownerType,
    equity: (params.get('pi_equity') as PropertyFilters['equity']) ?? DEFAULT_FILTERS.equity,
    taxDelinquent: (params.get('pi_tax') as PropertyFilters['taxDelinquent']) ?? DEFAULT_FILTERS.taxDelinquent,
    activeLien: (params.get('pi_lien') as PropertyFilters['activeLien']) ?? DEFAULT_FILTERS.activeLien,
    search: searchInput ?? '',
  }

  const quick = params.get('pi_quick')
  if (quick) next.quickFilters = quick.split('|').filter(Boolean)

  return next
}

export function writePropertyIntelligenceStateToUrl(state: PropertyIntelligenceListState, propertyId?: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const params = url.searchParams

  if (propertyId) params.set('propertyId', propertyId)
  else params.delete('propertyId')

  params.set('pi_page', String(state.page))
  params.set('pi_view', state.view)
  params.set('pi_q', state.searchInput)
  params.set('pi_sort', `${state.sort.column}:${state.sort.ascending ? 'asc' : 'desc'}`)
  params.set('pi_market', state.filters.market ?? 'All Markets')
  params.set('pi_type', state.filters.propertyType ?? 'All Types')
  params.set('pi_owner', state.filters.ownerType ?? 'All Owners')
  params.set('pi_quick', state.quickFilters.join('|'))

  window.history.replaceState({ piState: state }, '', `${url.pathname}${params.toString() ? `?${params}` : ''}`)
}

export function pushPropertyDetailState(state: PropertyIntelligenceListState, propertyId: string): void {
  if (typeof window === 'undefined') return
  persistPropertyIntelligenceListState(state)
  const url = new URL(window.location.href)
  url.searchParams.set('propertyId', propertyId)
  window.history.pushState({ piState: state, propertyId }, '', `${url.pathname}?${url.searchParams}`)
}

export function persistPropertyIntelligenceListState(state: PropertyIntelligenceListState): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function restorePropertyIntelligenceListState(): PropertyIntelligenceListState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return { ...DEFAULT_LIST_STATE, ...JSON.parse(raw) } as PropertyIntelligenceListState
  } catch {
    return null
  }
}

export function quickFiltersFromState(state: PropertyIntelligenceListState): QuickFilterKey[] {
  return state.quickFilters as QuickFilterKey[]
}
/**
 * ENTITY GRAPH DESK · PERSISTED WORKSPACE STATE (owner defect 2026-10-08:
 * "filters reset when you click a property or switch to Graph view").
 *
 * The desk's scope, search, filters (per scope), Grid ↔ Graph ↔ fullscreen
 * and contact subtype live in TWO places, so no hop loses them:
 *
 *   URL (this pane's own address)   egs · q · ff · egv · egfs · egc
 *     — reload, Back/Forward, a shared link, and the workspace's per-pane
 *       path all carry it; a property click only renames the PATH
 *       (/entity-graph/property/:id) and preserves the search params
 *   sessionStorage                  every scope's filters, not just the
 *     visible one, so switching Properties → People → Properties brings the
 *     Properties filters back; also the fallback when a remount reads a URL
 *     that carries no desk params
 *
 * Pure (no React): tested in desk-state.test.ts.
 */
import { parseFieldFiltersParam, type EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import type { EntityScope } from '../mobile/entity-graph-mobile-format'

export type DeskCenter = 'grid' | 'graph'

export type DeskState = {
  scope: EntityScope
  query: string
  filtersByScope: Partial<Record<EntityScope, EntityGraphFieldFilter[]>>
  center: DeskCenter
  graphFull: boolean
  contactSubtype: 'phone' | 'email'
}

export const DESK_STATE_KEY = 'lc.entityGraph.desk.state.v1'
export const DESK_URL_KEYS = ['egs', 'q', 'ff', 'egv', 'egfs', 'egc'] as const
const SCOPES: EntityScope[] = ['properties', 'master_owners', 'buyers', 'organizations', 'people', 'contact_methods']

export const DEFAULT_DESK_STATE: DeskState = {
  scope: 'properties',
  query: '',
  filtersByScope: {},
  center: 'grid',
  graphFull: false,
  contactSubtype: 'phone',
}

const isScope = (v: unknown): v is EntityScope => typeof v === 'string' && (SCOPES as string[]).includes(v)

function sanitizeFilters(raw: unknown): EntityGraphFieldFilter[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is EntityGraphFieldFilter => Boolean(f) && typeof f === 'object' && typeof (f as EntityGraphFieldFilter).field_key === 'string' && typeof (f as EntityGraphFieldFilter).operator === 'string')
}

export function readSessionDeskState(storage: Pick<Storage, 'getItem'> | null = safeSession()): Partial<DeskState> {
  try {
    const parsed = JSON.parse(storage?.getItem(DESK_STATE_KEY) || 'null') as Partial<DeskState> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<DeskState> = {}
    if (isScope(parsed.scope)) out.scope = parsed.scope
    if (typeof parsed.query === 'string') out.query = parsed.query
    if (parsed.center === 'graph' || parsed.center === 'grid') out.center = parsed.center
    if (typeof parsed.graphFull === 'boolean') out.graphFull = parsed.graphFull
    if (parsed.contactSubtype === 'email' || parsed.contactSubtype === 'phone') out.contactSubtype = parsed.contactSubtype
    if (parsed.filtersByScope && typeof parsed.filtersByScope === 'object') {
      const byScope: DeskState['filtersByScope'] = {}
      for (const s of SCOPES) {
        const f = sanitizeFilters((parsed.filtersByScope as Record<string, unknown>)[s])
        if (f.length) byScope[s] = f
      }
      out.filtersByScope = byScope
    }
    return out
  } catch {
    return {}
  }
}

export function writeSessionDeskState(state: DeskState, storage: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try { storage?.setItem(DESK_STATE_KEY, JSON.stringify(state)) } catch { /* private mode / full */ }
}

/** Does this address carry any desk state of its own? */
export function urlHasDeskState(params: URLSearchParams): boolean {
  return DESK_URL_KEYS.some((k) => params.has(k))
}

/**
 * The state a (re)mount starts from: the URL's own desk params when it has
 * any (a shared link / reload / Back), otherwise the session. The session
 * always supplies the OTHER scopes' filters.
 */
export function initialDeskState(params: URLSearchParams, session: Partial<DeskState> = readSessionDeskState()): DeskState {
  const base: DeskState = { ...DEFAULT_DESK_STATE, ...session, filtersByScope: { ...(session.filtersByScope ?? {}) } }
  if (!urlHasDeskState(params)) return base
  const scope = isScope(params.get('egs')) ? (params.get('egs') as EntityScope) : 'properties'
  const filters = parseFieldFiltersParam(params.get('ff'))
  return {
    ...base,
    scope,
    query: params.get('q') ?? '',
    filtersByScope: { ...base.filtersByScope, [scope]: filters },
    center: params.get('egv') === 'graph' ? 'graph' : 'grid',
    graphFull: params.get('egv') === 'graph' && params.get('egfs') === '1',
    contactSubtype: params.get('egc') === 'email' ? 'email' : 'phone',
  }
}

/** Write the desk's state into a search string, leaving every other param alone. */
export function deskSearch(current: string, state: DeskState): string {
  const params = new URLSearchParams(current.startsWith('?') ? current.slice(1) : current)
  for (const k of DESK_URL_KEYS) params.delete(k)
  const filters = state.filtersByScope[state.scope] ?? []
  if (state.scope !== 'properties') params.set('egs', state.scope)
  if (state.query.trim()) params.set('q', state.query.trim())
  if (filters.length) params.set('ff', JSON.stringify(filters))
  if (state.center === 'graph') params.set('egv', 'graph')
  if (state.center === 'graph' && state.graphFull) params.set('egfs', '1')
  if (state.scope === 'contact_methods' && state.contactSubtype === 'email') params.set('egc', 'email')
  const s = params.toString()
  return s ? `?${s}` : ''
}

/**
 * Opening a saved view puts ITS filters on ITS scope. The desk's setFilters
 * closes over the scope being left, so a Properties view opened from the
 * People tab used to land its filters on People (audit 2026-10-09).
 */
export function withViewFilters(
  byScope: DeskState['filtersByScope'],
  view: { scope: EntityScope; fieldFilters: EntityGraphFieldFilter[] },
): DeskState['filtersByScope'] {
  return { ...byScope, [view.scope]: sanitizeFilters(view.fieldFilters) }
}

function safeSession(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null } catch { return null }
}

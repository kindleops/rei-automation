/**
 * ENTITY GRAPH DESK · PERSISTED WORKSPACE STATE (owner defect 2026-10-08:
 * "filters reset when you click a property or switch to Graph view").
 *
 * The desk's scope, search, filters (per scope), Grid ↔ Graph ↔ fullscreen
 * and contact subtype live in TWO places, so no hop loses them:
 *
 *   URL (this pane's own address)   egs · q · ff · egv · egfs · egc
 *   localStorage                    the last view per scope (Overview · Grid ·
 *     Graph) — a scope opens in the view the operator left it in, Overview
 *     the first time
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

/** The centre view. Overview is the landing view of every scope (owner 2026-10-10); Grid and Graph are one click away. */
export type DeskCenter = 'overview' | 'grid' | 'graph'

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
  center: 'overview',
  graphFull: false,
  contactSubtype: 'phone',
}

const isScope = (v: unknown): v is EntityScope => typeof v === 'string' && (SCOPES as string[]).includes(v)
const isCenter = (v: unknown): v is DeskCenter => v === 'overview' || v === 'grid' || v === 'graph'

/* ── the last view per scope (localStorage, per operator) ────────────────── */

export const DESK_VIEW_KEY = 'nexus.entityGraph.desk.viewByScope.v1'
export type ViewByScope = Partial<Record<EntityScope, DeskCenter>>

export function readViewByScope(uid: string, storage: Pick<Storage, 'getItem'> | null = safeLocal()): ViewByScope {
  try {
    const parsed = JSON.parse(storage?.getItem(`${DESK_VIEW_KEY}:${uid}`) || 'null') as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ViewByScope = {}
    for (const s of SCOPES) if (isCenter(parsed[s])) out[s] = parsed[s] as DeskCenter
    return out
  } catch {
    return {}
  }
}

export function writeViewByScope(uid: string, views: ViewByScope, storage: Pick<Storage, 'setItem'> | null = safeLocal()): void {
  try { storage?.setItem(`${DESK_VIEW_KEY}:${uid}`, JSON.stringify(views)) } catch { /* private mode / full */ }
}

/** The view a scope opens in: the operator's last one there, else Overview. */
export const viewForScope = (views: ViewByScope, scope: EntityScope): DeskCenter => views[scope] ?? 'overview'

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
    if (isCenter(parsed.center)) out.center = parsed.center
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
export function initialDeskState(params: URLSearchParams, session: Partial<DeskState> = readSessionDeskState(), views: ViewByScope = {}): DeskState {
  const base: DeskState = { ...DEFAULT_DESK_STATE, ...session, filtersByScope: { ...(session.filtersByScope ?? {}) } }
  if (!urlHasDeskState(params)) return { ...base, center: session.center ?? viewForScope(views, base.scope) }
  const scope = isScope(params.get('egs')) ? (params.get('egs') as EntityScope) : 'properties'
  const filters = parseFieldFiltersParam(params.get('ff'))
  const egv = params.get('egv')
  // an explicit view in the address wins; else the scope's remembered view; else Overview
  const center: DeskCenter = isCenter(egv) ? egv : viewForScope(views, scope)
  return {
    ...base,
    scope,
    query: params.get('q') ?? '',
    filtersByScope: { ...base.filtersByScope, [scope]: filters },
    center,
    graphFull: center === 'graph' && params.get('egfs') === '1',
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
  if (state.center !== 'overview') params.set('egv', state.center)
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

function safeLocal(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

function safeSession(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null } catch { return null }
}

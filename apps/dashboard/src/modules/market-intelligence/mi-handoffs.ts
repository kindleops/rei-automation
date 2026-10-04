/**
 * MARKET INTELLIGENCE → other apps (brief §25–§29). Opens only; nothing here
 * writes business data, launches, queues, sends, wakes routing or touches
 * sender assignment.
 *
 *   Create campaign audience  Campaign Composer opens with the geography as its
 *                             filter. Composer computes the authoritative audience.
 *   Show on Map               the Map opens/focuses beside, frames the area through
 *                             its own area search, and can switch to an MI lens.
 *                             A pinned Map is never moved.
 *   Open beside               Shell 6.0 grammar: beside when the workspace has room,
 *                             else a real navigation (Back returns).
 */
import { pushRoutePath } from '../../app/router'
import { announceWorkspace, getWorkspace, isWorkspaceRunning, openApp } from '../desktop/workspace/workspace-store'
import * as L from '../desktop/workspace/layout'
import type { MiGeoSummary } from './mi-types'

export const MAP_AREA_PENDING_KEY = 'nexus:map-open-area:pending'
export const MAP_LENS_PENDING_KEY = 'nexus:map-set-lens:pending'
export const MAP_SET_LENS_EVENT = 'nexus:map-set-lens'
export const MAP_OPEN_AREA_EVENT_NAME = 'nexus:map-open-area'
export const MI_OPEN_GEO_EVENT = 'nexus:market-intel-open-geo'
const PENDING_TTL_MS = 30_000

type Geo = Pick<MiGeoSummary, 'id' | 'level' | 'name' | 'label' | 'state'>

/** The Composer path that prefills this geography, or a reason it can't. Pure. */
export function composerPathFor(g: Geo): { ok: true; path: string } | { ok: false; reason: string } {
  const q = new URLSearchParams({ compose: '1' })
  const key = g.id.slice(g.id.indexOf(':') + 1)
  switch (g.level) {
    case 'market': q.set('market', g.name); break
    case 'zip': q.set('geo_level', 'zip'); q.set('geo', key); break
    case 'state': q.set('geo_level', 'state'); q.set('geo', key); break
    case 'city': q.set('geo_level', 'city'); q.set('geo', g.name); if (g.state) q.set('geo_state', g.state); break
    case 'county': q.set('geo_level', 'county'); q.set('geo', g.name.replace(/\s+County$/i, '')); if (g.state) q.set('geo_state', g.state); break
    default: return { ok: false, reason: 'Pick a state or smaller area. A nationwide audience is not a geography filter.' }
  }
  q.set('label', g.label)
  return { ok: true, path: `/campaign-command?${q.toString()}` }
}

/** The Map area-search address for a geography (mv_map_search_areas kinds). Pure. */
export function mapAreaFor(g: Geo): { kind: string; key: string; label: string } | null {
  const key = g.id.slice(g.id.indexOf(':') + 1)
  switch (g.level) {
    case 'zip': case 'city': case 'county': case 'state': return { kind: g.level, key, label: g.label }
    case 'market': return { kind: 'market', key: g.name, label: g.label }
    default: return null
  }
}

export const lensIdForMetric = (metricId: string) => `mi_${metricId}`

export interface HandoffDeps {
  running: () => boolean
  openBeside: (path: string) => 'opened' | 'moved' | 'focused' | 'refused'
  navigate: (path: string) => void
  announce: (text: string) => void
  mapPinned: () => { label: string | null } | null
  storage: Pick<Storage, 'setItem'> | null
  dispatch: (name: string, detail: unknown) => void
}

const defaults = (): HandoffDeps => ({
  running: isWorkspaceRunning,
  openBeside: (path) => openApp(path, 'beside'),
  navigate: pushRoutePath,
  announce: announceWorkspace,
  mapPinned: () => {
    if (!isWorkspaceRunning()) return null
    const m = L.instanceForApp(getWorkspace().layout, 'map')
    return m?.pinned ? { label: m.pinLabel ?? null } : null
  },
  storage: typeof window !== 'undefined' ? window.sessionStorage : null,
  dispatch: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
})

export type OpenOutcome = 'beside' | 'focused' | 'navigated' | 'pinned' | 'unavailable'

export function openBeside(path: string, deps: Partial<HandoffDeps> = {}): OpenOutcome {
  const d = { ...defaults(), ...deps }
  if (d.running()) {
    const r = d.openBeside(path)
    if (r === 'focused') return 'focused'
    if (r !== 'refused') return 'beside'
    d.announce('Opened here: the workspace has no room beside Market Intelligence. Back returns.')
  }
  d.navigate(path)
  return 'navigated'
}

/** Create Campaign Audience: Composer opens prefilled. Never launches anything. */
export function openComposerFor(g: Geo, deps: Partial<HandoffDeps> = {}): OpenOutcome {
  const p = composerPathFor(g)
  if (!p.ok) { ({ ...defaults(), ...deps }).announce(p.reason); return 'unavailable' }
  return openBeside(p.path, deps)
}

/**
 * Show on Map. The area request (and optional MI lens) is staged in session
 * storage for a Map that is still mounting, and also dispatched for one
 * that is already open.
 */
export function showGeoOnMap(g: Geo, opts: { lensMetric?: string | null } = {}, deps: Partial<HandoffDeps> = {}): OpenOutcome {
  const d = { ...defaults(), ...deps }
  const pinned = d.mapPinned()
  if (pinned) {
    d.announce(`Map is pinned${pinned.label ? ` to ${pinned.label}` : ''}. Unpin it to show ${g.label} there.`)
    return 'pinned'
  }
  const area = mapAreaFor(g)
  const at = Date.now()
  try {
    if (area) d.storage?.setItem(MAP_AREA_PENDING_KEY, JSON.stringify({ ...area, at }))
    if (opts.lensMetric) d.storage?.setItem(MAP_LENS_PENDING_KEY, JSON.stringify({ lens: lensIdForMetric(opts.lensMetric), at }))
  } catch { /* private mode: the live event still reaches an open Map */ }
  const outcome = openBeside('/map', d)
  if (opts.lensMetric) d.dispatch(MAP_SET_LENS_EVENT, { lens: lensIdForMetric(opts.lensMetric) })
  if (area) d.dispatch(MAP_OPEN_AREA_EVENT_NAME, area)
  return outcome
}

/** Map side: read (and clear) a staged request no older than 30 s. */
export function consumePending<T>(key: string, storage: Pick<Storage, 'getItem' | 'removeItem'> | null = typeof window !== 'undefined' ? window.sessionStorage : null, now = Date.now()): T | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    storage?.removeItem(key)
    const v = JSON.parse(raw) as T & { at?: number }
    return v && typeof v.at === 'number' && now - v.at <= PENDING_TTL_MS ? v : null
  } catch { return null }
}

/** Open a geography in Market Intelligence (from the Map's MI lens, the Deck, …). */
export function openGeoInMarketIntel(geoId: string, deps: Partial<HandoffDeps> = {}): OpenOutcome {
  const d = { ...defaults(), ...deps }
  d.dispatch(MI_OPEN_GEO_EVENT, { id: geoId })
  return openBeside(`/market-intelligence?geo=${encodeURIComponent(geoId)}`, d)
}

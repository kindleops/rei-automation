/**
 * Workspace state: view, property scope and the inspected object live in the
 * app's own path (`/search-intelligence?p=…&v=…&o=kind:id`), read through
 * useRouteLocation so a pane instance keeps its own state and every capture
 * or shared link reproduces the exact surface.
 */
import type { ObjectKind, ObjectRef } from '../domain/types'

export const VIEWS = [
  { id: 'home', label: 'Home', icon: 'home', key: '1' },
  { id: 'globe', label: 'Globe', icon: 'globe', key: '2' },
  { id: 'architecture', label: 'Architecture', icon: 'layers', key: '3' },
  { id: 'pages', label: 'Pages', icon: 'file-text', key: '4' },
  { id: 'keywords', label: 'Keywords', icon: 'hash', key: '5' },
  { id: 'geography', label: 'Geography', icon: 'map', key: '6' },
  { id: 'opportunities', label: 'Opportunities', icon: 'target', key: '7' },
  { id: 'launch', label: 'Launch', icon: 'flag', key: '8' },
  { id: 'analytics', label: 'Analytics', icon: 'activity', key: '9' },
  { id: 'conversions', label: 'Conversions', icon: 'trending-up', key: null },
  { id: 'connections', label: 'Connections', icon: 'link', key: '0' },
] as const

export type ViewId = (typeof VIEWS)[number]['id']
export const VIEW_IDS = new Set<string>(VIEWS.map((v) => v.id))

export interface SiState {
  view: ViewId
  /** null = Portfolio */
  property: string | null
  object: ObjectRef | null
  /** Pages view filter */
  pagesView: string
}

const KINDS = new Set<ObjectKind>(['property', 'page', 'keyword', 'cluster', 'geography', 'wave', 'opportunity'])

export function parseState(location: string, knownProperties: ReadonlySet<string>): SiState {
  const q = new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
  const v = q.get('v') ?? 'home'
  const p = q.get('p')
  const o = q.get('o')
  let object: ObjectRef | null = null
  if (o && o.includes(':')) {
    const i = o.indexOf(':')
    const kind = o.slice(0, i) as ObjectKind
    if (KINDS.has(kind)) object = { kind, id: o.slice(i + 1) }
  }
  return {
    view: (VIEW_IDS.has(v) ? v : 'home') as ViewId,
    property: p && knownProperties.has(p) ? p : null,
    object,
    pagesView: q.get('pv') ?? 'all',
  }
}

export function serializeState(base: string, s: SiState): string {
  const q = new URLSearchParams()
  if (s.view !== 'home') q.set('v', s.view)
  if (s.property) q.set('p', s.property)
  if (s.object) q.set('o', `${s.object.kind}:${s.object.id}`)
  if (s.pagesView !== 'all') q.set('pv', s.pagesView)
  const qs = q.toString()
  return qs ? `${base}?${qs}` : base
}

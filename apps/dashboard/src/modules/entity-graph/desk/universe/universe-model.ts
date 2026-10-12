/**
 * ENTITY GRAPH · OVERVIEW PAGE — the pure parts (no React, no fetch).
 *
 * The page is one dashboard across every table (owner 2026-10-12). Its cards
 * come from GET /api/cockpit/entity-graph/universe (one request per scope);
 * every number on a card is a DRILL: the card's scope, the global filters the
 * scope applies, and the clicked bucket's own rail chip — so the grid it opens
 * counts exactly the bar.
 */
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import type { EntityScope } from '../../mobile/entity-graph-mobile-format'
import type { UniverseGlobals } from '../desk-state'

export type UniverseBucket = { key: string | null; label: string; count: number; filter: EntityGraphFieldFilter | null; tone?: string }
export type UniverseChart = { key: string; label: string; form?: 'bars' | 'histogram'; buckets: UniverseBucket[]; unavailable?: string }
export type UniverseKpi = { key: string; label: string; value: number | null; filter: EntityGraphFieldFilter | null }
export type UniverseIgnored = { key: 'markets' | 'states'; values: string[]; reason: string }
export type UniverseSource = 'facts' | 'snapshot' | 'live' | null

export type UniverseCard = {
  id: string
  scope: EntityScope
  label: string
  total: number | null
  totalLabel?: string
  totalFilter?: EntityGraphFieldFilter | null
  kpis: UniverseKpi[]
  charts: UniverseChart[]
  applied: EntityGraphFieldFilter[]
  appliedMeans?: Array<{ field_key: string; means: string; value: string[] }>
  ignored: UniverseIgnored[]
  source: UniverseSource
  as_of: string | null
  ms?: number | null
  unavailable?: string
  partial?: string
}

export type UniverseOptions = { markets: Array<{ value: string; count: number }>; states: Array<{ value: string; count: number }> }
export type UniverseResponse = {
  ok: true
  scope: EntityScope
  cards: UniverseCard[]
  options: UniverseOptions | null
  cache?: string
  timings?: { totalMs: number; computedMs: number | null }
}

/** The scopes the page requests (one request each), in page order. */
export const UNIVERSE_PAGE_SCOPES: EntityScope[] = ['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations']

/** Every card the page shows, in order; the properties request answers the first three. */
export const UNIVERSE_CARD_ORDER = ['properties', 'pipeline', 'contacts', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'] as const
export const CARD_SCOPE: Record<(typeof UNIVERSE_CARD_ORDER)[number], EntityScope> = {
  properties: 'properties', pipeline: 'properties', contacts: 'properties',
  master_owners: 'master_owners', people: 'people', contact_methods: 'contact_methods', buyers: 'buyers', organizations: 'organizations',
}
export const CARD_TITLE: Record<(typeof UNIVERSE_CARD_ORDER)[number], string> = {
  properties: 'Properties', pipeline: 'Pipeline', contacts: 'Contacts & reach',
  master_owners: 'Owners', people: 'People', contact_methods: 'Phones', buyers: 'Buyers', organizations: 'Companies',
}
export const CARD_ICON: Record<(typeof UNIVERSE_CARD_ORDER)[number], 'home' | 'trending-up' | 'phone' | 'user' | 'users' | 'briefcase' | 'database'> = {
  properties: 'home', pipeline: 'trending-up', contacts: 'phone', master_owners: 'user', people: 'users', contact_methods: 'phone', buyers: 'briefcase', organizations: 'database',
}

const same = (a: EntityGraphFieldFilter, b: EntityGraphFieldFilter) => a.field_key === b.field_key && a.operator === b.operator && JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)

/**
 * The grid a click opens: the card's scope with the global filters it
 * applies AND the clicked chip. A chip on a field the globals already narrow
 * (a market bar under a market filter) replaces that global — its value is a
 * subset of it, so the cohort is the same and the rail shows one chip.
 */
export function drillTarget(card: Pick<UniverseCard, 'scope' | 'applied'>, chip: EntityGraphFieldFilter | null | undefined): { scope: EntityScope; filters: EntityGraphFieldFilter[] } {
  const base = (card.applied ?? []).map((f) => ({ field_key: f.field_key, operator: f.operator, value: f.value ?? null }) as EntityGraphFieldFilter)
  if (!chip) return { scope: card.scope, filters: base }
  const kept = base.filter((f) => f.field_key !== chip.field_key)
  const next = { field_key: chip.field_key, operator: chip.operator, value: chip.value ?? null } as EntityGraphFieldFilter
  return { scope: card.scope, filters: kept.some((f) => same(f, next)) ? kept : [...kept, next] }
}

/** The request's query string. Market names carry commas, so lists are JSON. */
export function universeQuery(scope: EntityScope, globals: UniverseGlobals): string {
  const qs = new URLSearchParams({ scope })
  if (globals.markets.length) qs.set('markets', JSON.stringify(globals.markets))
  if (globals.states.length) qs.set('states', JSON.stringify(globals.states))
  return qs.toString()
}

export const globalsKey = (g: UniverseGlobals) => JSON.stringify([g.markets, g.states])
export const hasGlobals = (g: UniverseGlobals) => g.markets.length > 0 || g.states.length > 0

export function toggleGlobal(g: UniverseGlobals, key: 'markets' | 'states', value: string): UniverseGlobals {
  const v = key === 'states' ? value.trim().toUpperCase() : value.trim()
  if (!v) return g
  const list = g[key].includes(v) ? g[key].filter((x) => x !== v) : [...g[key], v]
  return { ...g, [key]: list }
}

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (!Number.isFinite(s)) return null
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** "As of" in words: where the numbers came from and when. */
export function asOfText(source: UniverseSource, iso: string | null, now = Date.now()): string {
  const when = iso ? ago(iso, now) : null
  const stamp = iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  const at = when && stamp ? `${stamp} (${when})` : 'time not recorded'
  if (source === 'facts') return `As of ${at} · property facts read model, live indexed counts`
  if (source === 'snapshot') return `As of ${at} · universe snapshot`
  if (source === 'live') return `As of ${at} · computed live`
  return 'Not available'
}

/** The bar scale of a chart: the largest value bucket (context buckets never stretch it). */
export function chartMax(buckets: UniverseBucket[]): number {
  const values = buckets.filter((b) => b.tone !== 'none' && b.tone !== 'other').map((b) => b.count)
  return Math.max(1, ...(values.length ? values : buckets.map((b) => b.count)))
}

export const share = (n: number | null | undefined, d: number | null | undefined): string => {
  if (typeof n !== 'number' || typeof d !== 'number' || d <= 0) return ''
  const p = (n / d) * 100
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`
}

/** The cards in page order from whichever scope answers have landed (missing ones are null = loading). */
export function orderCards(byScope: Partial<Record<EntityScope, UniverseCard[]>>): Array<{ id: (typeof UNIVERSE_CARD_ORDER)[number]; card: UniverseCard | null }> {
  return UNIVERSE_CARD_ORDER.map((id) => ({ id, card: byScope[CARD_SCOPE[id]]?.find((c) => c.id === id) ?? null }))
}

/** The headline across the page: the records the page describes (each table counted once). */
export function universeHeadline(byScope: Partial<Record<EntityScope, UniverseCard[]>>): Array<{ id: string; label: string; value: number | null }> {
  return UNIVERSE_PAGE_SCOPES.map((scope) => {
    const card = byScope[scope]?.find((c) => c.id === scope) ?? null
    return { id: scope, label: CARD_TITLE[scope as keyof typeof CARD_TITLE], value: card ? card.total : null }
  })
}

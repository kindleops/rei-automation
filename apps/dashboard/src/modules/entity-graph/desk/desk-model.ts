/**
 * ENTITY GRAPH DESK — the pure parts: which network a row opens, how a header
 * sort reaches the server, the header KPIs, facet filters and saved views.
 * No React, no fetch: everything here is tested in desk-model.test.ts.
 */
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import {
  IDENTITY_SORT_COLUMN,
  SCOPE_TABLE_COLUMNS,
  type HeaderSort,
  type TableColumn,
} from '../mobile/entity-graph-table-columns'
import { IDENTITY_COLUMN_KEY } from '../mobile/entity-graph-table-layout'
import { SCOPE_DEFAULT_SORT_KEY, SCOPE_SORTS, type EntityScope } from '../mobile/entity-graph-mobile-format'
import type { NetworkNode } from '../console/entity-network-api'
import { PROPERTY_CLUSTER_ID } from '../console/network-layout'

export type NetworkAnchor = { type: 'property' | 'owner' | 'person'; id: string }

/** The relationship network a row belongs to (organizations / contacts resolve through their owner). */
export function anchorForResult(r: EntitySearchResult): NetworkAnchor | null {
  const t = r.entityType
  if (t === 'property') return { type: 'property', id: r.entityId }
  if (t === 'master_owner' || t === 'owner') return { type: 'owner', id: r.entityId }
  if (t === 'prospect' || t === 'person') return { type: 'person', id: r.entityId }
  const ids = r.contextIds ?? {}
  if (ids.masterOwnerId) return { type: 'owner', id: ids.masterOwnerId }
  if (ids.prospectId) return { type: 'person', id: ids.prospectId }
  if (ids.propertyId) return { type: 'property', id: ids.propertyId }
  return null
}

export const anchorKey = (a: NetworkAnchor | null): string => (a ? `${a.type}:${a.id}` : '')

/**
 * What the server is asked to order by. A header column with a backend sort
 * column orders the WHOLE cohort (index or keyset, entity-graph-property-sort);
 * without one — or while searching, since search results are ranked — the
 * loaded rows are ordered locally and the grid says so. No header sort = the
 * scope's default triage order.
 */
export function serverSortFor(scope: EntityScope, header: HeaderSort | null, searching: boolean): { sortBy: string; ascending: boolean; source: 'header' | 'default' } {
  if (header && !searching) {
    const col = header.key === IDENTITY_COLUMN_KEY ? IDENTITY_SORT_COLUMN[scope] : SCOPE_TABLE_COLUMNS[scope].find((c) => c.key === header.key)?.sortBy
    if (col) return { sortBy: col, ascending: header.dir === 'asc', source: 'header' }
  }
  const def = SCOPE_SORTS[scope].find((s) => s.key === SCOPE_DEFAULT_SORT_KEY[scope]) ?? SCOPE_SORTS[scope][0]
  return { sortBy: def.sortBy, ascending: def.ascending, source: 'default' }
}

/** A header sort the server cannot run is a local sort of the loaded rows. */
export function headerSortIsLocal(scope: EntityScope, header: HeaderSort | null, searching: boolean): boolean {
  if (!header) return false
  return serverSortFor(scope, header, searching).source !== 'header'
}

export function columnByKey(scope: EntityScope, key: string): TableColumn | null {
  return SCOPE_TABLE_COLUMNS[scope].find((c) => c.key === key) ?? null
}

/* ── Header KPIs ─────────────────────────────────────────────────────────── */

export type DeskKpis = {
  properties: number | null
  linkedProperties: number | null
  owners: number | null
  portfolioOwners: number | null
  entities: number | null
  ownersWithPhone: number | null
  definitions?: Record<string, string>
  measuredAt?: string
}

export type KpiTile = { key: string; label: string; value: number | null; unit?: '%'; basis: string }

const share = (n: number | null, d: number | null): number | null =>
  n === null || d === null || d <= 0 ? null : Math.round((n / d) * 1000) / 10

/**
 * Six honest tiles. A count the server could not produce is null and renders
 * as "not available" — never 0, never derived from a sample.
 */
export function kpiTiles(k: DeskKpis | null): KpiTile[] {
  const v = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const props = v(k?.properties)
  const owners = v(k?.owners)
  return [
    { key: 'universe', label: 'Universe', value: props, basis: 'property records' },
    { key: 'owners', label: 'Owners', value: owners, basis: 'resolved master owners' },
    { key: 'entities', label: 'Entities', value: v(k?.entities), basis: 'title-holding names' },
    { key: 'stacks', label: 'Portfolio stacks', value: v(k?.portfolioOwners), basis: 'owners with 2+ properties' },
    { key: 'contactable', label: 'Contactable', value: v(k?.ownersWithPhone), basis: `ranked phone on file${share(v(k?.ownersWithPhone), owners) !== null ? ` · ${share(v(k?.ownersWithPhone), owners)}%` : ''}` },
    { key: 'coverage', label: 'Owner coverage', value: share(v(k?.linkedProperties), props), unit: '%', basis: v(k?.linkedProperties) !== null ? `${v(k?.linkedProperties)!.toLocaleString('en-US')} linked to an owner` : 'properties linked to an owner' },
  ]
}

/* ── Facet filters (multi-select `is_any_of` on one catalog field) ──────── */

export function facetValues(filters: EntityGraphFieldFilter[], fieldKey: string): string[] {
  const f = filters.find((x) => x.field_key === fieldKey && x.operator === 'is_any_of')
  return Array.isArray(f?.value) ? (f!.value as unknown[]).map(String) : []
}

export function toggleFacetValue(filters: EntityGraphFieldFilter[], fieldKey: string, value: string): EntityGraphFieldFilter[] {
  const current = facetValues(filters, fieldKey)
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  const rest = filters.filter((x) => !(x.field_key === fieldKey && x.operator === 'is_any_of'))
  return next.length ? [...rest, { field_key: fieldKey, operator: 'is_any_of', value: next }] : rest
}

/** A facet counts the cohort WITHOUT its own selection, so the other values stay pickable. */
export function filtersExcept(filters: EntityGraphFieldFilter[], fieldKey: string): EntityGraphFieldFilter[] {
  return filters.filter((x) => x.field_key !== fieldKey)
}

/* ── Saved views (this operator, this device) ────────────────────────────── */

export type DeskView = {
  id: string
  name: string
  scope: EntityScope
  query: string
  fieldFilters: EntityGraphFieldFilter[]
  sort: HeaderSort | null
  columns: string[] | null
  savedAt: string
}

const VIEWS_KEY = 'nexus.entityGraph.desk.views.v1'

/**
 * Saved views store the DEFINITION (scope, search, filters, sort, columns),
 * never rows: reopening one re-resolves against live data. There is no saved
 * list table in the schema, so this is deliberately local, per operator.
 */
export function readViews(uid: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): DeskView[] {
  try {
    const raw = storage?.getItem(`${VIEWS_KEY}:${uid}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.scope === 'string' && SCOPE_TABLE_COLUMNS[v.scope as EntityScope]) : []
  } catch {
    return []
  }
}

export function writeViews(uid: string, views: DeskView[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(`${VIEWS_KEY}:${uid}`, JSON.stringify(views.slice(0, 40))) } catch { /* storage full or disabled */ }
}

export function makeView(input: Omit<DeskView, 'id' | 'savedAt'>, now = Date.now()): DeskView {
  return { ...input, name: input.name.trim() || 'Untitled view', id: `v_${now.toString(36)}`, savedAt: new Date(now).toISOString() }
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

export function fmtCount(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
}

export function fmtMoney(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

/** Vendor contact-matching tags → a quiet class for colour (evidence, never a verdict). */
export function matchingTagTone(tag: string): 'ok' | 'attn' | 'neutral' {
  const t = tag.trim().toLowerCase()
  if (t === 'likely owner' || t === 'linked to company') return 'ok'
  if (t === 'resident' || t === 'likely renting') return 'attn'
  return 'neutral'
}

/* ── Relationship view layers + facets ───────────────────────────────────── */

export const GRAPH_LAYERS: Array<{ type: string; label: string }> = [
  { type: 'property', label: 'Properties' },
  { type: 'entity', label: 'Entities' },
  { type: 'person', label: 'People' },
  { type: 'phone', label: 'Contacts' },
  { type: 'mailing', label: 'Mailing' },
  { type: 'related_owner', label: 'Related owners' },
  { type: 'sale', label: 'Transactions' },
  { type: 'mortgage', label: 'Debt' },
  { type: 'lien', label: 'Liens' },
  { type: 'conversation', label: 'Conversations' },
]

/** The network a node opens when clicked (owners, properties, people), else null. */
export function nodeAnchor(node: NetworkNode): NetworkAnchor | null {
  const [kind, ...rest] = node.id.split(':')
  const id = rest.join(':')
  if (!id || node.id === PROPERTY_CLUSTER_ID) return null
  if (kind === 'property') return { type: 'property', id }
  if (kind === 'owner' || kind === 'related') return { type: 'owner', id }
  if (kind === 'person') return { type: 'person', id }
  return null
}

export type DeskFacet = { dimension: string; label: string; fieldKey: string }

/** Categorical facets per scope: composition dimension → the catalog field its buckets filter. */
export const DESK_FACETS: Partial<Record<EntityScope, DeskFacet[]>> = {
  properties: [
    { dimension: 'market', label: 'Market', fieldKey: 'properties.market' },
    { dimension: 'state', label: 'State', fieldKey: 'properties.property_address_state' },
    { dimension: 'county', label: 'County', fieldKey: 'properties.property_address_county_name' },
    { dimension: 'property_type', label: 'Property type', fieldKey: 'properties.property_type' },
  ],
  buyers: [
    { dimension: 'market', label: 'Primary market', fieldKey: 'buyers.primary_market' },
    { dimension: 'activity', label: 'Activity', fieldKey: 'buyers.activity_status' },
    { dimension: 'archetype', label: 'Archetype', fieldKey: 'buyers.archetype' },
    { dimension: 'kind', label: 'Company vs individual', fieldKey: 'buyers.entity_type' },
  ],
}

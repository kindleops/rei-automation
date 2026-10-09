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
import { IDENTITY_COLUMN_KEY, TABLE_LAYOUT_VERSION } from '../mobile/entity-graph-table-layout'
import { SCOPE_DEFAULT_SORT_KEY, SCOPE_SORTS, type EntityScope } from '../mobile/entity-graph-mobile-format'
import type { NetworkNode } from '../console/entity-network-api'
import { PROPERTY_CLUSTER_ID } from '../console/network-layout'
import { PRESETS, type PresetGroup } from '../mobile/entity-graph-presets'

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

/* ── Facet filters (multi-select on one catalog field) ─────────────────── */

/**
 * A facet selection is `is_any_of` (OR within the list) or — for a stacking
 * facet (property flags) — `is_all_of` (every selected value).
 */
export type FacetMatch = 'all' | 'any'
export const FACET_OPERATORS = new Set(['is_any_of', 'is_all_of'])
const matchOperator = (match: FacetMatch) => (match === 'all' ? 'is_all_of' : 'is_any_of')
const isFacetFilter = (x: EntityGraphFieldFilter, fieldKey: string) => x.field_key === fieldKey && FACET_OPERATORS.has(x.operator)

export function facetValues(filters: EntityGraphFieldFilter[], fieldKey: string): string[] {
  const f = filters.find((x) => isFacetFilter(x, fieldKey))
  return Array.isArray(f?.value) ? (f!.value as unknown[]).map(String) : []
}

/** The facet's match mode: the active filter's operator, else the facet default. */
export function facetMatch(filters: EntityGraphFieldFilter[], fieldKey: string, fallback: FacetMatch = 'any'): FacetMatch {
  const f = filters.find((x) => isFacetFilter(x, fieldKey))
  return f ? (f.operator === 'is_all_of' ? 'all' : 'any') : fallback
}

export function toggleFacetValue(filters: EntityGraphFieldFilter[], fieldKey: string, value: string, fallback: FacetMatch = 'any'): EntityGraphFieldFilter[] {
  const current = facetValues(filters, fieldKey)
  const operator = matchOperator(facetMatch(filters, fieldKey, fallback))
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  const rest = filters.filter((x) => !isFacetFilter(x, fieldKey))
  return next.length ? [...rest, { field_key: fieldKey, operator, value: next }] : rest
}

/** Switch a facet's selection between "all of" and "any of" (values kept). */
export function setFacetMatch(filters: EntityGraphFieldFilter[], fieldKey: string, match: FacetMatch): EntityGraphFieldFilter[] {
  return filters.map((x) => (isFacetFilter(x, fieldKey) ? { ...x, operator: matchOperator(match) } : x))
}

/**
 * The filters a facet's bucket counts are computed under. An "any of" facet
 * counts WITHOUT its own selection so the other values stay pickable; an
 * "all of" facet counts WITH it — each count is the cohort if that value is
 * added (the selected ones read the cohort total).
 */
export function facetCountFilters(filters: EntityGraphFieldFilter[], fieldKey: string, fallback: FacetMatch = 'any'): EntityGraphFieldFilter[] {
  return facetMatch(filters, fieldKey, fallback) === 'all' ? filters : filtersExcept(filters, fieldKey)
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
  /** layout version the columns were saved under (absent = 1) — migrated on open */
  layoutVersion?: number
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
  return { layoutVersion: TABLE_LAYOUT_VERSION, ...input, name: input.name.trim() || 'Untitled view', id: `v_${now.toString(36)}`, savedAt: new Date(now).toISOString() }
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
  // 'owner:unlinked' is the name-on-title node of a property with no master owner — not a network
  // (clicking it asked for owner "unlinked" → 404 → "The relationship network didn't load")
  if (kind === 'owner' && id === 'unlinked') return null
  if (kind === 'owner' || kind === 'related') return { type: 'owner', id }
  if (kind === 'person') return { type: 'person', id }
  // every linked item opens a network: a phone / email opens its person (else the owner),
  // a title entity its master owner
  const meta = (node.meta ?? {}) as { personId?: unknown; ownerId?: unknown }
  const personId = typeof meta.personId === 'string' && meta.personId && !meta.personId.startsWith('pj:') ? meta.personId : null
  const ownerId = typeof meta.ownerId === 'string' && meta.ownerId ? meta.ownerId : null
  if (kind === 'phone' || kind === 'email') return personId ? { type: 'person', id: personId } : ownerId ? { type: 'owner', id: ownerId } : null
  if (kind === 'entity') return ownerId ? { type: 'owner', id: ownerId } : null
  return null
}

/** `match` = the facet stacks (default all of, with an all/any toggle); absent = any of. */
export type DeskFacet = { dimension: string; label: string; fieldKey: string; match?: FacetMatch }

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

/**
 * DISTRESS & CONDITION (owner 2026-10-07: "vacant AND poor/unsound, by
 * market"). Three exact facets — property flags as whole tokens, building
 * condition, rehab level (source values only) — and the boolean distress
 * columns that hold data. Flags: ALL selected by default (any-of toggle);
 * other facets OR within; AND across facets and toggles.
 */
export const DESK_DISTRESS_FACETS: DeskFacet[] = [
  // flags STACK (owner 2026-10-09): default all of — each flag narrows the cohort
  { dimension: 'flags', label: 'Property flags', fieldKey: 'properties.flags', match: 'all' },
  { dimension: 'condition', label: 'Building condition', fieldKey: 'properties.building_condition' },
  { dimension: 'rehab', label: 'Rehab level', fieldKey: 'properties.rehab_level' },
]

export type DeskToggle = { key: string; label: string; filter: EntityGraphFieldFilter }
export const DESK_DISTRESS_TOGGLES: DeskToggle[] = [
  { key: 'taxdel', label: 'Tax delinquent', filter: { field_key: 'properties.tax_delinquent_any', operator: 'is_true' } },
  // recorded lien documents (not UCC filings / affidavits / probate) — and the vendor's own flag, which disagrees with the record
  { key: 'reclien', label: 'Recorded lien', filter: { field_key: 'records.has_lien', operator: 'is_true' } },
  { key: 'lien', label: 'Active lien (vendor flag)', filter: { field_key: 'properties.active_lien', operator: 'is_true' } },
  { key: 'fc', label: 'Foreclosure filing', filter: { field_key: 'records.foreclosure_count', operator: 'gte', value: 1 } },
  { key: 'probate', label: 'Probate filing', filter: { field_key: 'records.has_probate', operator: 'is_true' } },
]

/* ── The rail, organised (owner 2026-10-08: "clear groups", People filters) ── */

export type DeskFacetGroup = { id: string; label: string; facets: DeskFacet[]; toggles?: DeskToggle[] }

/**
 * Facet groups per scope — each facet is a composition dimension (exact
 * counts, one GROUP BY) whose bucket taps become an ordinary catalog filter.
 * Every dimension named here exists server-side (entity-graph-composition.js).
 */
export const DESK_FACET_GROUPS: Partial<Record<EntityScope, DeskFacetGroup[]>> = {
  properties: [
    { id: 'distress', label: 'Distress & condition', facets: DESK_DISTRESS_FACETS, toggles: DESK_DISTRESS_TOGGLES },
    { id: 'location', label: 'Location', facets: [
      { dimension: 'market', label: 'Market', fieldKey: 'properties.market' },
      { dimension: 'state', label: 'State', fieldKey: 'properties.property_address_state' },
      { dimension: 'county', label: 'County', fieldKey: 'properties.property_address_county_name' },
      { dimension: 'city', label: 'City', fieldKey: 'properties.property_address_city' },
    ] },
    { id: 'asset', label: 'Asset', facets: [
      { dimension: 'property_type', label: 'Property type', fieldKey: 'properties.property_type' },
    ] },
    { id: 'records', label: 'Debt & sale records', facets: [
      { dimension: 'loan_type', label: 'Loan type', fieldKey: 'records.first_loan_type' },
      { dimension: 'last_deed', label: 'Last sale document', fieldKey: 'records.last_sale_doc_type' },
    ] },
  ],
  people: [
    { id: 'matching', label: 'Owner matching', facets: [
      { dimension: 'matching', label: 'Matching tags', fieldKey: 'prospects.matching_flags' },
      { dimension: 'person_flags', label: 'Person flags', fieldKey: 'prospects.person_flags_text' },
    ] },
    { id: 'demographics', label: 'Demographics', facets: [
      { dimension: 'language', label: 'Language', fieldKey: 'prospects.language_preference' },
      { dimension: 'gender', label: 'Gender', fieldKey: 'prospects.gender' },
      { dimension: 'marital', label: 'Marital status', fieldKey: 'prospects.marital_status' },
      { dimension: 'occupation', label: 'Occupation', fieldKey: 'prospects.occupation_group' },
      { dimension: 'education', label: 'Education', fieldKey: 'prospects.education_model' },
    ] },
    { id: 'financial', label: 'Financial', facets: [
      { dimension: 'income', label: 'Household income', fieldKey: 'prospects.est_household_income' },
      { dimension: 'net_assets', label: 'Net asset value', fieldKey: 'prospects.net_asset_value' },
      { dimension: 'buying_power', label: 'Buying power', fieldKey: 'prospects.buying_power' },
    ] },
    { id: 'contact', label: 'Contact', facets: [
      { dimension: 'timezone', label: 'Time zone', fieldKey: 'prospects.timezone' },
      { dimension: 'contact_window', label: 'Contact window', fieldKey: 'prospects.contact_window' },
    ] },
  ],
  master_owners: [
    { id: 'profile', label: 'Owner profile', facets: [
      { dimension: 'owner_type', label: 'Owner type', fieldKey: 'master_owners.owner_type_guess' },
      { dimension: 'tier', label: 'Priority tier', fieldKey: 'master_owners.priority_tier' },
      { dimension: 'cadence', label: 'Follow-up cadence', fieldKey: 'master_owners.follow_up_cadence' },
    ] },
  ],
  contact_methods: [
    { id: 'phone', label: 'Phone line', facets: [
      { dimension: 'line', label: 'Line type', fieldKey: 'phones.phone_type' },
      { dimension: 'phone_owner', label: 'Phone owner', fieldKey: 'phones.phone_owner' },
      { dimension: 'activity', label: 'Activity', fieldKey: 'phones.activity_status' },
      { dimension: 'usage12', label: 'Usage, 12 months', fieldKey: 'phones.usage_12_months' },
      { dimension: 'usage2', label: 'Usage, 2 months', fieldKey: 'phones.usage_2_months' },
    ] },
  ],
  buyers: [
    { id: 'buyers', label: 'Buyer profile', facets: DESK_FACETS.buyers ?? [] },
  ],
}

const pf = (field_key: string, operator: string, value?: unknown): EntityGraphFieldFilter => ({ field_key, operator, value })

/** Desk-only quick filters for the scopes the phone never had them for; ordinary catalog filters. */
const DESK_EXTRA_PRESETS: Partial<Record<EntityScope, PresetGroup[]>> = {
  people: [
    { label: 'Owner matching', presets: [
      { key: 'likely_owner', label: 'Likely owner', tone: 'info', filter: pf('prospects.matching_flags', 'is_any_of', ['Likely Owner']) },
      { key: 'linked_company', label: 'Linked to company', filter: pf('prospects.matching_flags', 'is_any_of', ['Linked To Company']) },
      { key: 'renting', label: 'Likely renting', tone: 'warn', filter: pf('prospects.matching_flags', 'is_any_of', ['Likely Renting']) },
      { key: 'decision_maker', label: 'Primary decision maker', filter: pf('prospects.person_flags_text', 'is_any_of', ['Primary Decision Maker']) },
    ] },
    { label: 'Age & language', presets: [
      { key: 'age65', label: 'Age 65+', filter: pf('prospects.age_years', 'gte', 65) },
      { key: 'age55', label: 'Age 55–64', filter: pf('prospects.age_years', 'between', [55, 64]) },
      { key: 'age_u45', label: 'Under 45', filter: pf('prospects.age_years', 'lte', 44) },
      { key: 'spanish', label: 'Spanish', filter: pf('prospects.language_preference', 'is_any_of', ['Spanish']) },
      { key: 'english', label: 'English', filter: pf('prospects.language_preference', 'is_any_of', ['English']) },
    ] },
    { label: 'Reachability', presets: [
      { key: 'sms', label: 'SMS eligible', filter: pf('prospects.sms_eligible', 'is_true') },
      { key: 'email', label: 'Email eligible', filter: pf('prospects.email_eligible', 'is_true') },
    ] },
  ],
  master_owners: [
    { label: 'Portfolio', presets: [
      { key: 'p2', label: '2+ properties', filter: pf('master_owners.property_count', 'gte', 2) },
      { key: 'p5', label: '5+ properties', filter: pf('master_owners.property_count', 'gte', 5) },
      { key: 'p10', label: '10+ properties', filter: pf('master_owners.property_count', 'gte', 10) },
      { key: 'held20', label: 'Held 20+ years', filter: pf('master_owners.max_ownership_years', 'gte', 20) },
    ] },
    { label: 'Pressure', presets: [
      { key: 'taxdel', label: 'Tax-delinquent property', tone: 'warn', filter: pf('master_owners.tax_delinquent_count', 'gte', 1) },
      { key: 'liens', label: 'Property with a vendor lien flag', tone: 'warn', filter: pf('master_owners.active_lien_count', 'gte', 1) },
    ] },
  ],
}

export function deskPresets(scope: EntityScope): PresetGroup[] {
  return [...(PRESETS[scope] ?? []), ...(DESK_EXTRA_PRESETS[scope] ?? [])]
}

/** Every facet field a scope's rail renders (to tell facet filters from field filters). */
export function deskFacetFields(scope: EntityScope): DeskFacet[] {
  return (DESK_FACET_GROUPS[scope] ?? []).flatMap((g) => g.facets)
}
export function deskToggles(scope: EntityScope): DeskToggle[] {
  return (DESK_FACET_GROUPS[scope] ?? []).flatMap((g) => g.toggles ?? [])
}

/** Rail group open/closed — remembered per operator, per scope. */
const RAIL_GROUPS_KEY = 'nexus.entityGraph.desk.railGroups.v1'
export function readRailGroups(uid: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): Record<string, boolean> {
  try { const v = JSON.parse(storage?.getItem(`${RAIL_GROUPS_KEY}:${uid}`) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
export function writeRailGroups(uid: string, groups: Record<string, boolean>, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(`${RAIL_GROUPS_KEY}:${uid}`, JSON.stringify(groups)) } catch { /* private mode */ }
}

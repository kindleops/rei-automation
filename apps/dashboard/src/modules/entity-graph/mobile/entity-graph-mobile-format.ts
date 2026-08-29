import type { IconName } from '../../../shared/icons'
import type {
  EntityGraphFilters,
  EntityGraphTab,
  EntitySearchResult,
} from '../../../domain/entity-graph/entity-graph.types'

/**
 * Presentation truth layer for the mobile Entity Graph.
 *
 * The backend hands the UI raw enrichment state — `Address incomplete`,
 * `Unmapped · Cincinnati, OH` — and the desktop surface printed those strings
 * as the record's primary identity. On a 375px row that means ~40% of the
 * property universe identifies itself by what the pipeline failed to resolve
 * rather than by the address, city, and ZIP that are sitting right there.
 *
 * Everything here answers one question: what is the best *identifying* string
 * this row actually has, and what is merely a data-quality note that belongs in
 * the margin?
 */

export type EntityScope = 'properties' | 'master_owners' | 'people' | 'organizations' | 'contact_methods'

/** Scopes that are real entity universes. Markets/ZIPs are filter dimensions. */
export const MOBILE_SCOPES: Array<{ key: EntityScope; label: string; countKey: string; noun: string }> = [
  { key: 'properties', label: 'Properties', countKey: 'properties', noun: 'properties' },
  { key: 'master_owners', label: 'Owners', countKey: 'master_owners', noun: 'owners' },
  { key: 'people', label: 'People', countKey: 'people', noun: 'people' },
  { key: 'organizations', label: 'Entities', countKey: 'organizations', noun: 'entities' },
  { key: 'contact_methods', label: 'Contacts', countKey: 'contact_methods', noun: 'contacts' },
]

export type SortOption = { key: string; label: string; sortBy: string; ascending: boolean }

/**
 * Sort choices per scope. The desktop default was the table's first column
 * with ascending=false, which opened Properties on "Wooden Shoe Hollow Dr" and
 * Owners on "Zzyzxx LLC" — reverse alphabetical is not a triage order.
 *
 * "Top value" is back: `idx_properties_estimated_value_desc` is built
 * `DESC NULLS LAST` to match the exact ORDER BY PostgREST emits, so the sort is
 * an index scan (measured 3355ms -> 10.7ms). Score ranking is index-driven once
 * the adapter bounds the column, and it excludes the 65,580 unscored rows — the
 * UI states that whenever it is on.
 */
export const SCOPE_SORTS: Record<EntityScope, SortOption[]> = {
  properties: [
    { key: 'score', label: 'Top score', sortBy: 'final_acquisition_score', ascending: false },
    { key: 'address', label: 'A–Z', sortBy: 'property_address_full', ascending: true },
    { key: 'market', label: 'Market', sortBy: 'market', ascending: true },
    { key: 'value', label: 'Top value', sortBy: 'estimated_value', ascending: false },
  ],
  master_owners: [
    { key: 'priority', label: 'Priority', sortBy: 'priority_score', ascending: false },
    { key: 'portfolio', label: 'Portfolio', sortBy: 'property_count', ascending: false },
    { key: 'name', label: 'A–Z', sortBy: 'display_name', ascending: true },
  ],
  people: [
    { key: 'contact', label: 'Contact', sortBy: 'contact_score_final', ascending: false },
    { key: 'name', label: 'A–Z', sortBy: 'full_name', ascending: true },
  ],
  organizations: [
    { key: 'name', label: 'A–Z', sortBy: 'owner_name', ascending: true },
  ],
  contact_methods: [
    // sort_rank 1 is the best contact on the ladder, so ascending is "best first".
    { key: 'rank', label: 'Rank', sortBy: 'sort_rank', ascending: true },
    { key: 'score', label: 'Score', sortBy: 'contact_score_final', ascending: false },
  ],
}

export const SCOPE_DEFAULT_SORT_KEY: Record<EntityScope, string> = {
  properties: 'score',
  master_owners: 'priority',
  people: 'contact',
  organizations: 'name',
  contact_methods: 'rank',
}

const PLACEHOLDER_TITLES = new Set(['address incomplete', 'unknown', 'unnamed', ''])

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s && s.toLowerCase() !== 'null' && s !== '—' ? s : null
}

export type ResolvedIdentity = {
  /** The line the operator reads first. Never an enrichment-failure string. */
  primary: string
  /** Supporting locality line. Null when it would just repeat `primary`. */
  secondary: string | null
  /** Set when the record genuinely lacks the field we'd prefer to show. */
  gap: string | null
}

/**
 * Property identity, in descending order of what actually identifies a parcel:
 * street → city/ZIP locality → property id. `Address incomplete` and a title
 * that merely echoes the city both fall through to the locality form.
 */
export function resolvePropertyIdentity(result: EntitySearchResult): ResolvedIdentity {
  const d = result.details ?? {}
  const title = text(result.title)
  const city = text(d.city)
  const state = text(d.state)
  const zip = text(d.zip)
  const locality = [city, state].filter(Boolean).join(', ')
  const subtitle = text(result.subtitle)

  const titleIsPlaceholder = !title || PLACEHOLDER_TITLES.has(title.toLowerCase())
  // 553 rows parse a street segment that is really just the city again — the
  // row then reads "Wichita / Wichita, KS 67211" and identifies nothing.
  const titleEchoesCity = Boolean(title && city && title.toLowerCase() === city.toLowerCase())

  if (!titleIsPlaceholder && !titleEchoesCity) {
    return {
      primary: title as string,
      secondary: subtitle ?? (locality || null),
      gap: null,
    }
  }

  // A state on its own is not an identity. `property_address_full` is
  // literally ", Az" on these rows, and falling back to "AZ" made thousands of
  // records indistinguishable from each other. City or ZIP is the floor.
  if (city || zip) {
    return {
      primary: zip && locality ? `${locality} ${zip}` : (locality || `ZIP ${zip}`),
      secondary: `Parcel ${result.entityId}`,
      gap: 'No street on file',
    }
  }

  return {
    primary: `Parcel ${result.entityId}`,
    secondary: state,
    gap: 'No address on file',
  }
}

/** People carry a `· …f72bdd` id tail in the title; that is a debug affordance, not a name. */
export function resolvePersonIdentity(result: EntitySearchResult): ResolvedIdentity {
  const raw = text(result.title) ?? ''
  const name = text(raw.split('·')[0]) ?? raw
  const d = result.details ?? {}
  const isPlaceholder = !name || PLACEHOLDER_TITLES.has(name.toLowerCase())
  return {
    primary: isPlaceholder ? `Person ${result.entityId.slice(-6)}` : name,
    secondary: text(d.occupation) ?? text(d.ownerName),
    gap: isPlaceholder ? 'No name on file' : null,
  }
}

export function resolveOwnerIdentity(result: EntitySearchResult): ResolvedIdentity {
  const title = text(result.title)
  const d = result.details ?? {}
  const isPlaceholder = !title || title === result.entityId || PLACEHOLDER_TITLES.has(title.toLowerCase())
  return {
    primary: isPlaceholder ? `Owner ${result.entityId.slice(-6)}` : (title as string),
    secondary: humanizeEnum(d.ownerType),
    gap: isPlaceholder ? 'No owner name on file' : null,
  }
}

export function resolveOrganizationIdentity(result: EntitySearchResult): ResolvedIdentity {
  const title = text(result.title)
  const d = result.details ?? {}
  const isPlaceholder = !title || title === result.entityId
  return {
    primary: isPlaceholder ? `Entity ${result.entityId.slice(-6)}` : (title as string),
    secondary: text(d.mailingAddress),
    gap: isPlaceholder ? 'No entity name on file' : null,
  }
}

export function resolveContactIdentity(result: EntitySearchResult): ResolvedIdentity {
  return {
    primary: text(result.title) ?? result.entityId,
    secondary: text(result.subtitle),
    gap: null,
  }
}

export function resolveIdentity(scope: EntityScope, result: EntitySearchResult): ResolvedIdentity {
  switch (scope) {
    case 'properties': return resolvePropertyIdentity(result)
    case 'master_owners': return resolveOwnerIdentity(result)
    case 'people': return resolvePersonIdentity(result)
    case 'organizations': return resolveOrganizationIdentity(result)
    case 'contact_methods': return resolveContactIdentity(result)
  }
}

export type ResolvedMarket = {
  /** "Cincinnati, OH" — the place, always. */
  label: string | null
  /** False when the locality is outside the configured sending zones. */
  isSendingZone: boolean
}

/**
 * `Unmapped · Cincinnati, OH` conflates two facts: where the property is, and
 * whether we have a sending zone configured for it. ~38% of the universe is
 * off-zone, so the prefix became the loudest text on the screen. Split it: the
 * place is the label, the zone status is a quiet flag.
 */
export function resolveMarket(result: EntitySearchResult): ResolvedMarket {
  const d = result.details ?? {}
  const raw = text(d.marketLabel) ?? text(d.marketKey)
  const flagged = d.isUnmappedMarket === true || Boolean(raw && /^unmapped\s*·/i.test(raw))

  if (!raw) {
    const fallback = [text(d.city), text(d.state)].filter(Boolean).join(', ')
    return { label: fallback || null, isSendingZone: false }
  }

  const stripped = raw.replace(/^unmapped\s*·\s*/i, '').trim()
  const label = stripped && stripped.toLowerCase() !== 'unknown' ? stripped : null
  if (!label) {
    const fallback = [text(d.city), text(d.state)].filter(Boolean).join(', ')
    return { label: fallback || null, isSendingZone: false }
  }
  return { label, isSendingZone: !flagged }
}

export type Contactability = {
  /** Null when the adapter did not resolve links — we show nothing, not a guess. */
  people: number | null
  contacts: number | null
  reachable: boolean | null
  label: string | null
}

/**
 * Property rows used to advertise "2 reachable contacts" on every single row —
 * `propertyToResult` hardcoded `contacts: 2`. Anything the adapter did not
 * genuinely resolve returns null here and renders as absent.
 */
export function resolveContactability(scope: EntityScope, result: EntitySearchResult): Contactability {
  const counts = result.linkedCounts ?? {}
  const people = typeof counts.prospects === 'number' ? counts.prospects : null
  const contacts = typeof counts.contacts === 'number' ? counts.contacts : null
  const reachableCount = typeof counts.reachableContacts === 'number' ? counts.reachableContacts : null

  if (scope === 'contact_methods') {
    const d = result.details ?? {}
    const reachable = d.wrongNumber ? false : d.reachability === 'Reachable' ? true : null
    return { people: null, contacts: null, reachable, label: text(d.reachability) }
  }

  const effective = reachableCount ?? contacts
  if (effective === null) return { people, contacts: null, reachable: null, label: null }
  return {
    people,
    contacts: effective,
    reachable: effective > 0,
    label: effective > 0 ? `${effective} reachable` : 'No contacts',
  }
}

export function compactCurrency(value?: number | null): string | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}M`
  if (num >= 1_000) return `$${Math.round(num / 1_000)}K`
  return `$${Math.round(num)}`
}

export function compactCount(value?: number | null): string | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 10_000) return `${Math.round(num / 1_000)}K`
  return num.toLocaleString()
}

/**
 * Raw enum → operator English. `INDIVIDUAL | ABSENTEE` and `TIER_1` are
 * storage encodings; they were reaching the row verbatim.
 */
export function humanizeEnum(value?: string | null): string | null {
  const raw = text(value)
  if (!raw) return null
  return raw
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tier = /^tier[_\s-]?(\d+)$/i.exec(part)
      if (tier) return `Tier ${tier[1]}`
      if (/^[A-Z0-9_\s/]+$/.test(part) && part.length > 1) {
        return part
          .toLowerCase()
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      }
      return part
    })
    .join(' · ')
}

/** Acquisition flags are a `;`-joined blob. Take the ones an operator acts on. */
const FLAG_PRIORITY = [
  'tax delinquent',
  'pre foreclosure',
  'preforeclosure',
  'vacant',
  'tired landlord',
  'absentee owner',
  'free and clear',
  'high equity',
  'cash buyer',
]

/**
 * Tags are for signal the row does not already carry. The owner row was
 * printing `INDIVIDUAL | ABSENTEE` and `TIER_1` three times over — once in the
 * meta line, once in the pill, and again as badge chips — because badges are
 * literally `[owner_type_guess, priority_tier]`. Anything already rendered
 * elsewhere in the row is passed in as `shown` and dropped here.
 */
export function resolveTags(
  scope: EntityScope,
  result: EntitySearchResult,
  shown: Array<string | null | undefined> = [],
  limit = 3,
): string[] {
  const d = result.details ?? {}

  if (scope === 'properties') {
    const raw = text(d.flags)
    if (!raw) return []
    const parts = raw.split(/[;,|]/).map((p) => p.trim()).filter(Boolean)
    const ranked = [...parts].sort((a, b) => {
      const ai = FLAG_PRIORITY.indexOf(a.toLowerCase())
      const bi = FLAG_PRIORITY.indexOf(b.toLowerCase())
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
    // "No Updates" is a pipeline bookkeeping note, not an acquisition signal.
    return ranked.filter((tag) => !/^no updates$/i.test(tag)).slice(0, limit)
  }

  const seen = new Set(
    shown
      .map((value) => text(value)?.toLowerCase())
      .filter(Boolean)
      .flatMap((value) => (value as string).split(/[·|]/).map((p) => p.trim())),
  )

  return (result.badges ?? [])
    .map((badge) => humanizeEnum(badge))
    .filter((badge): badge is string => Boolean(badge))
    .filter((badge) => !badge.split(' · ').every((part) => seen.has(part.toLowerCase())))
    .slice(0, limit)
}

export function scopeNoun(scope: EntityScope, count: number): string {
  const entry = MOBILE_SCOPES.find((s) => s.key === scope)
  if (!entry) return 'records'
  if (count === 1) return entry.noun.replace(/ies$/, 'y').replace(/s$/, '')
  return entry.noun
}

export function tabForScope(scope: EntityScope): EntityGraphTab {
  return scope as EntityGraphTab
}

/* ── Filter vocabulary (shared by the sheet and the toolbar badge) ──────── */

export type FilterKey = keyof EntityGraphFilters

/**
 * Only the fields the browse/search adapter genuinely applies. Anything the
 * backend would silently drop is absent rather than rendered and ignored —
 * a filter that does nothing is worse than a filter that isn't offered.
 *
 * Backing implementations: applyPropertyFilters / applyOwnerFilters /
 * applyProspectFilters / applyPhoneFilters in entity-graph-service.js.
 */
const FILTER_LABELS: Partial<Record<FilterKey, string>> = {
  market: 'Market',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  assetType: 'Asset type',
  unitsMin: 'Units min',
  unitsMax: 'Units max',
  scoreMin: 'Score min',
  scoreMax: 'Score max',
  ownerType: 'Owner type',
  priorityTier: 'Priority tier',
  coverageMin: 'Coverage min',
  language: 'Language',
  contactStatus: 'Contact status',
  reachable: 'Reachable only',
  entityType: 'Entity type',
}

/**
 * The asset-type vocabulary the adapter can actually resolve. Free text here
 * invited "SFR", which used to match 4 rows because the column stores
 * "Single Family"; the adapter now translates these labels, and offering them
 * as a closed list stops the operator guessing at storage spellings.
 */
export const ASSET_TYPES = ['SFR', 'Multifamily', 'Apartment', 'Condo', 'Townhome', 'Land', 'Mobile Home', 'Other']

export type FilterGroupKey = 'geography' | 'property' | 'ownership' | 'people' | 'contactability' | 'acquisition'

export const FILTER_GROUPS: Array<{ key: FilterGroupKey; label: string; hint: string }> = [
  { key: 'geography', label: 'Geography', hint: 'Market, state, city, ZIP' },
  { key: 'property', label: 'Property', hint: 'Asset type and unit count' },
  { key: 'acquisition', label: 'Score & value', hint: 'Acquisition score band' },
  { key: 'ownership', label: 'Ownership', hint: 'Owner type, tier, coverage' },
  { key: 'people', label: 'People', hint: 'Language' },
  { key: 'contactability', label: 'Contactability', hint: 'Contact status and reachability' },
]

/**
 * Which group each filter belongs to. A filter appears in the cohort builder
 * only when the active scope actually applies it (SCOPE_FILTERS below), so the
 * builder never offers a control the query would ignore.
 */
export const FILTER_GROUP_BY_KEY: Partial<Record<FilterKey, FilterGroupKey>> = {
  market: 'geography',
  city: 'geography',
  state: 'geography',
  zip: 'geography',
  assetType: 'property',
  unitsMin: 'property',
  unitsMax: 'property',
  scoreMin: 'acquisition',
  scoreMax: 'acquisition',
  ownerType: 'ownership',
  priorityTier: 'ownership',
  coverageMin: 'ownership',
  language: 'people',
  contactStatus: 'contactability',
  reachable: 'contactability',
  entityType: 'ownership',
}

/** Which scopes actually apply which filter, mirroring the service. */
const SCOPE_FILTERS: Record<EntityScope, FilterKey[]> = {
  properties: ['market', 'city', 'state', 'zip', 'assetType', 'unitsMin', 'unitsMax', 'scoreMin', 'scoreMax'],
  master_owners: ['market', 'ownerType', 'priorityTier', 'coverageMin'],
  people: ['language', 'reachable'],
  organizations: ['entityType'],
  contact_methods: ['contactStatus', 'reachable'],
}

export function activeFilterEntries(
  filters: EntityGraphFilters,
  scope: EntityScope,
): Array<{ key: FilterKey; label: string; value: string }> {
  const applicable = new Set(SCOPE_FILTERS[scope])
  return (Object.keys(filters) as FilterKey[])
    .filter((key) => applicable.has(key))
    .filter((key) => (key === 'reachable' ? filters[key] === true : Boolean(filters[key])))
    .map((key) => ({
      key,
      label: FILTER_LABELS[key] ?? key,
      value: key === 'reachable' ? 'on' : String(filters[key]),
    }))
}

/** Count only what this scope will actually send — an inactive filter from a
 *  previous scope must not inflate the badge. */
export function countActiveFilters(filters: EntityGraphFilters, scope: EntityScope): number {
  return activeFilterEntries(filters, scope).length
}

/* ── Bulk-action capability map ─────────────────────────────────────────── */

export type BulkActionKey = 'campaign' | 'list' | 'map' | 'copy' | 'export'

export type BulkAction = {
  key: BulkActionKey
  label: string
  icon: IconName
  /** Null when the action runs today. A string is the reason it cannot. */
  unavailable: string | null
  primary?: boolean
}

/**
 * What the backend can actually do with a set of selected entity ids, as of
 * this build. Verified rather than assumed:
 *
 *  - Add to Campaign: campaign targets are built from *filters*, not id lists.
 *    `POST /campaigns/preview-targets` with `properties.property_id in [...]`
 *    answers `unknown_campaign_field` and drops the filter, so an id-list
 *    handoff would silently target the wrong set.
 *  - Add to List: there is no list/collection/tag table in the schema.
 *    `list_rows_view` is the conversation list view, not a saved list.
 *  - Open in Map / Copy / Export: real today.
 *
 * Unavailable actions stay visible and disabled with the reason attached —
 * hiding them would make the gap invisible, and faking them would make the
 * operator act on a set the backend never received.
 */
export function bulkActionsForScope(scope: EntityScope, count: number): BulkAction[] {
  const canMap = scope === 'properties' && count === 1
  return [
    {
      key: 'campaign',
      label: 'Add to Campaign',
      icon: 'send',
      primary: true,
      // Real now: `properties.property_id` was already mapped in the campaign
      // target graph and already preview-supported; it was simply missing from
      // the field catalog, so validation rejected it as an unknown field before
      // the mapping was consulted. With it registered, an explicit id list
      // resolves and Campaigns runs its normal readiness pipeline over it.
      unavailable: count === 0 ? 'Select records first.' : null,
    },
    {
      key: 'list',
      label: 'Add to List',
      icon: 'bookmark',
      unavailable: 'No saved-list table exists in the schema yet.',
    },
    {
      key: 'map',
      label: 'Open in Map',
      icon: 'map',
      unavailable: canMap
        ? null
        : scope === 'properties'
          ? 'Map opens one property at a time.'
          : 'Map handoff is property-scoped.',
    },
    { key: 'copy', label: 'Copy IDs', icon: 'file-text', unavailable: null },
    { key: 'export', label: 'Export CSV', icon: 'archive', unavailable: null },
  ]
}

/**
 * Snapshot loader: unpacks the importer's provenance-stamped JSON into the
 * SearchDataset the workspace renders.
 *
 * `assembleDataset` is pure (tests feed it fixtures); `loadPortfolioDataset`
 * lazily imports the JSON chunks so the planning data never lands in the
 * shell's entry bundle.
 */
import { CONNECTIONS, PROPERTY_META } from './properties'
import { OFFERR_CLUSTERS, OFFERR_PAGES } from './offerr'
import { PLACE_COORDINATES } from './geo-reference'
import type {
  CoverageExpectation, InternalLink, KeywordCluster, LaunchWave, LinkKind, MeasureStore, PropertyConnection, Provenance,
  SearchDataset, SearchGeography, SearchKeyword, SearchPage, SearchProperty,
} from '../domain/types'

/** The importer's packed format (`si-snapshot/1`). */
export interface PackedSnapshot {
  format: 'si-snapshot/1'
  propertyId: string
  provenance: { repo: string; branch: string; commit: string; dirty: boolean }
  sources: Record<string, Provenance>
  texts: string[]
  pages: Array<Record<string, unknown>>
  links: Array<[string, string, number] | [string, string, number, string]>
  clusters: Array<Record<string, unknown>>
  keywords: Array<Record<string, unknown>>
  waves: Array<Record<string, unknown>>
  places: Array<{ id: string; kind: SearchGeography['kind']; name: string; code: string | null; parentId: string | null; stateCode: string | null; lat?: number; lng?: number }>
  operatingStates?: string[]
  operatingStatesSource?: Provenance
  situations?: Array<{ key: string; slug: string; label: string }>
  navTargets?: string[]
  audit?: Record<string, unknown> & { source: Provenance }
}

const LINK_KIND: LinkKind[] = ['parent', 'related', 'nav', 'content', 'planned']

function unpacker(s: PackedSnapshot) {
  const src = (v: unknown): Provenance => (typeof v === 'string' ? s.sources[v] : (v as Provenance)) ?? { kind: 'repo-doc', label: 'unknown source' }
  const txt = (v: unknown): string | null => (typeof v === 'number' ? s.texts[v] ?? null : typeof v === 'string' ? v : null)
  return { src, txt }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function unpackPages(s: PackedSnapshot): SearchPage[] {
  const { src, txt } = unpacker(s)
  return s.pages.map((p) => {
    const copy = (p.copy ?? {}) as Record<string, unknown>
    const legacy = p.legacy as Record<string, unknown> | undefined
    const fields: Array<{ label: string; value: string }> = []
    if (typeof p.cluster === 'string') fields.push({ label: 'Gate cluster', value: p.cluster })
    if (typeof p.qualityStatus === 'string') fields.push({ label: 'Quality status', value: p.qualityStatus })
    if (typeof p.governance === 'string') fields.push({ label: 'Governance', value: p.governance })
    const issues = arr(p.technicalIssues)
    if (issues.length) fields.push({ label: 'Technical issues', value: issues.join('; ') })
    return {
      id: String(p.id), propertyId: String(p.propertyId), path: String(p.path), family: String(p.family), parentId: str(p.parentId),
      geographyIds: arr(p.geographyIds), intent: txt(p.intent), primaryClusterId: str(p.primaryClusterId), secondaryClusterIds: arr(p.secondaryClusterIds),
      secondaryKeywords: arr(p.secondaryKeywords), primaryKeyword: str(p.primaryKeyword),
      copy: { title: str(copy.title), h1: str(copy.h1), meta: txt(copy.meta), state: (copy.state as SearchPage['copy']['state']) ?? 'NOT_WRITTEN', source: src(p.source) },
      canonical: str(p.canonical), schemaTypes: arr(p.schemaTypes), indexability: (p.indexability as SearchPage['indexability']) ?? 'UNDECIDED',
      robots: str(p.robots), inSitemap: typeof p.inSitemap === 'boolean' ? p.inSitemap : null, launchWaveId: str(p.launchWaveId),
      status: p.status as SearchPage['status'],
      stage: p.stage as SearchPage['stage'], thesis: txt(p.thesis), notes: txt(p.notes), aliases: arr(p.aliases), source: src(p.source),
      legacy: legacy ? {
        label: String(legacy.label), window: legacy.window as { start: string; end: string },
        clicks: typeof legacy.clicks === 'number' ? legacy.clicks : null, impressions: typeof legacy.impressions === 'number' ? legacy.impressions : null,
        averagePosition: typeof legacy.averagePosition === 'number' ? legacy.averagePosition : null,
        tier: str(legacy.tier), decision: str(legacy.decision), legacyPath: str(legacy.legacyPath), source: src(legacy.source),
      } : null,
      sourceFields: fields,
    }
  })
}

function unpackLinks(s: PackedSnapshot): InternalLink[] {
  return s.links.map((l) => ({ fromPageId: l[0], toPageId: l[1], kind: LINK_KIND[l[2]] ?? 'content', anchorClusterId: l[3] ?? null }))
}

function unpackClusters(s: PackedSnapshot): KeywordCluster[] {
  const { src, txt } = unpacker(s)
  return s.clusters.map((c) => ({
    id: String(c.id), propertyId: String(c.propertyId), label: String(c.label), primaryKeyword: str(c.primaryKeyword), parentTopic: str(c.parentTopic),
    intent: txt(c.intent), geoLevel: (str(c.geoLevel) as KeywordCluster['geoLevel']) ?? null, ownerPageId: str(c.ownerPageId), ownerRef: str(c.ownerRef),
    priority: null, wave: str(c.wave), source: (c.source as KeywordCluster['source']) ?? 'PLANNED', provenance: src(c.provenance), notes: txt(c.notes),
  }))
}

function unpackKeywords(s: PackedSnapshot): SearchKeyword[] {
  const { src, txt } = unpacker(s)
  return s.keywords.map((k) => ({
    id: String(k.id), propertyId: String(k.propertyId), query: String(k.query), clusterId: str(k.clusterId), intent: txt(k.intent),
    geographyId: str(k.geographyId), assignedPageId: str(k.assignedPageId), status: (k.status as SearchKeyword['status']) ?? 'PLANNED',
    priority: null, source: (k.source as SearchKeyword['source']) ?? 'PLANNED', provenance: src(k.provenance),
  }))
}

function unpackWaves(s: PackedSnapshot): LaunchWave[] {
  const { src, txt } = unpacker(s)
  return s.waves.map((w) => ({
    id: String(w.id), propertyId: String(w.propertyId), label: String(w.label), order: Number(w.order), status: w.status as LaunchWave['status'],
    targetDate: str(w.targetDate), dependsOn: arr(w.dependsOn), blockers: arr(w.blockers), notes: txt(w.notes), source: src(w.source),
  }))
}

/** Places from every snapshot, de-duplicated, placed only where a reference coordinate exists. */
export function mergeGeographies(snaps: readonly PackedSnapshot[]): SearchGeography[] {
  const out = new Map<string, SearchGeography>()
  out.set('us', { id: 'us', kind: 'COUNTRY', name: 'United States', code: 'US', parentId: null, stateCode: null, lat: 39.5, lng: -98.35 })
  for (const s of snaps) for (const p of s.places) {
    const prev = out.get(p.id)
    const ref = PLACE_COORDINATES[`${p.name}|${p.stateCode}`]
    const lat = typeof p.lat === 'number' ? p.lat : ref?.[0] ?? null
    const lng = typeof p.lng === 'number' ? p.lng : ref?.[1] ?? null
    // keep the most specific parent seen (a county beats the state)
    const parentId = prev && prev.parentId && prev.parentId !== `us-${(p.stateCode ?? '').toLowerCase()}` ? prev.parentId : p.parentId
    out.set(p.id, { id: p.id, kind: p.kind, name: p.name, code: p.code, parentId, stateCode: p.stateCode, lat, lng })
  }
  return [...out.values()]
}

function expectationsFor(id: string, s: PackedSnapshot | undefined): CoverageExpectation[] {
  if (!s) return []
  const out: CoverageExpectation[] = []
  if (s.operatingStates?.length && s.operatingStatesSource) {
    out.push({
      kind: 'geo-family', id: `${id}:x:operating-states`, label: 'Operating states with a state market page',
      family: 'market-state', geographyIds: s.operatingStates.map((c) => `us-${c.toLowerCase()}`), source: s.operatingStatesSource,
    })
  }
  if (s.situations?.length && s.operatingStatesSource) {
    out.push({
      kind: 'dimension', id: `${id}:x:state-situations`, label: 'Defined seller situations per state market page',
      parentFamily: 'market-state', family: 'market-situation', values: s.situations, source: { ...s.operatingStatesSource, path: 'lib/market-pages.ts', label: 'Prominent seller situations (SITUATIONS)' },
    })
  }
  return out
}

function factsFor(s: PackedSnapshot | undefined): SearchProperty['facts'] {
  const a = s?.audit
  if (!a) return []
  const f = (label: string, v: unknown) => ({ label, value: String(v), source: a.source })
  return [
    f('Audit generated', String(a.generatedAt).slice(0, 10)), f('Routes audited', a.routes), f('Orphan routes', a.orphanRoutes),
    f('Weak contextual inbound (< 2 sources)', a.weakContextualRoutes), f('Missing parent → child links', a.missingParentToChild),
    f('Sitemap entries (production build)', a.sitemapCount), f('Redirects incl. compatibility', a.redirects),
    f('High-similarity pages (review signal)', a.highSimilarity), f('Legacy records', a.legacyRecords),
  ]
}

const RESERVED: Record<string, SearchProperty['reservedFamilies']> = {
  reivesti: [
    { family: 'county', route: '/markets/[state]/[market]/[county]', note: 'Reserved. A county page is justified only when the county is the unit investors search and transact in.' },
    { family: 'role-market', route: '/for/[role]/[state]/[market]', note: 'Reserved. Built only after both parents publish and the crossing has its own demand evidence.' },
    { family: 'asset-class-market', route: '/markets/[state]/[market]/[assetClass]', note: 'Reserved.' },
    { family: 'provider-category', route: '/providers/[category]', note: 'Reserved.' },
    { family: 'provider-category-market', route: '/providers/[category]/[state]/[market]', note: 'Reserved.' },
  ],
}

export const EMPTY_MEASURES: MeasureStore = { page: new Map(), keyword: new Map() }

export function assembleDataset(
  snaps: readonly PackedSnapshot[],
  meta = PROPERTY_META,
  connections: readonly PropertyConnection[] = CONNECTIONS,
  extra: { pages?: readonly SearchPage[]; clusters?: readonly KeywordCluster[] } = { pages: OFFERR_PAGES, clusters: OFFERR_CLUSTERS },
): SearchDataset {
  const byId = new Map(snaps.map((s) => [s.propertyId, s]))
  const properties: SearchProperty[] = meta.map((m) => ({
    ...m,
    expectations: expectationsFor(m.id, byId.get(m.id)),
    facts: factsFor(byId.get(m.id)),
    reservedFamilies: RESERVED[m.id] ?? [],
  })).sort((a, b) => a.order - b.order)
  return {
    properties,
    pages: [...snaps.flatMap(unpackPages), ...(extra.pages ?? [])],
    links: snaps.flatMap(unpackLinks),
    clusters: [...snaps.flatMap(unpackClusters), ...(extra.clusters ?? [])],
    keywords: snaps.flatMap(unpackKeywords),
    geographies: mergeGeographies(snaps),
    waves: snaps.flatMap(unpackWaves),
    connections,
    measures: EMPTY_MEASURES,
  }
}

/** The navigation-reachable page ids a snapshot recorded (sitewide nav is not copied as edges). */
export function navTargetsOf(snaps: readonly PackedSnapshot[]): Set<string> {
  return new Set(snaps.flatMap((s) => s.navTargets ?? []))
}

let cached: Promise<{ dataset: SearchDataset; navTargets: Set<string>; snapshots: Array<PackedSnapshot['provenance'] & { propertyId: string }> }> | null = null

export function loadPortfolioDataset() {
  if (!cached) {
    cached = Promise.all([
      import('./snapshots/prominent.json').then((m) => m.default as unknown as PackedSnapshot),
      import('./snapshots/reivesti.json').then((m) => m.default as unknown as PackedSnapshot),
    ]).then((snaps) => ({
      dataset: assembleDataset(snaps),
      navTargets: navTargetsOf(snaps),
      snapshots: snaps.map((s) => ({ propertyId: s.propertyId, ...s.provenance })),
    }))
  }
  return cached
}

/**
 * SEARCH INTELLIGENCE OS — the domain vocabulary.
 *
 * Search Intelligence is a cross-brand product. Nothing in this module knows
 * about sellers, campaigns, deals or any LeadCommand runtime table; the only
 * bridge to LeadCommand is the declared journey contract in ./bridge.ts.
 *
 * Two kinds of truth live here and are never mixed:
 *
 *   PLANS     — pages, clusters, geographies and launch waves. A plan is real
 *               data (it is what the team intends to build) and is shown as a
 *               plan: "planned", "published", never as traffic.
 *   MEASURES  — impressions, clicks, sessions, conversions, revenue. A measure
 *               exists only when a connected provider reported it. Otherwise it
 *               is `UNAVAILABLE` with a reason, and the UI says that reason in
 *               words. There is no numeric fallback anywhere (see ./metrics.ts).
 */

/* ── Properties ─────────────────────────────────────────────────────────── */

/** The lifecycle of a web property, in order. A property only moves forward by evidence. */
export const LIFECYCLE = [
  'PLANNED',
  'BUILDING',
  'READY_FOR_VERIFICATION',
  'LIVE',
  'CONNECTED',
  'BASELINE_COLLECTION',
  'ACTIVE_INTELLIGENCE',
] as const
export type PropertyLifecycle = (typeof LIFECYCLE)[number]

/** Whether a property's surfaces render plans only, or plans plus live measures. */
export type IntelligenceMode = 'PLANNING' | 'LIVE_INTELLIGENCE'

/**
 * What the property is for. Free text is allowed so a future brand never needs
 * a code change; the known values only select presentation defaults.
 */
export type PropertyStrategy =
  | 'seller-acquisition-nationwide'
  | 'ai-offer-product'
  | 'investment-platform'
  | 'saas-marketing'
  | (string & {})

/** One level of a property's own architecture (Prominent and Reivesti differ on purpose). */
export interface HierarchyLevel {
  /** page family id at this level */
  family: string
  label: string
}

export interface SearchProperty {
  id: string
  brand: string
  domain: string
  /** https origin pages resolve against */
  origin: string
  strategy: PropertyStrategy
  /** one line, from the source documents — never marketing copy written here */
  thesis: string
  lifecycle: PropertyLifecycle
  /** why the property sits at this lifecycle step (evidence, not aspiration) */
  lifecycleNote: string
  /** ISO date the new site went live, when it has */
  launchedAt: string | null
  /** semantic accent token key used for this brand on the globe and graph */
  accent: 'exec' | 'flow' | 'ok' | 'attn' | 'cobalt' | 'neutral'
  /** architecture levels in reading order; families outside it still render */
  hierarchy: readonly HierarchyLevel[]
  /** hosts on the same apex that are NOT part of this SEO property */
  excludedHosts: readonly string[]
  sources: readonly Provenance[]
  /** display order in the switcher; data-driven, not a fixed list */
  order: number
  /** what the source plan says should exist — the basis for coverage gaps */
  expectations: readonly CoverageExpectation[]
  /** headline facts reported by the source repository's own audits (not search measures) */
  facts: ReadonlyArray<{ label: string; value: string; source: Provenance }>
  /** page families the architecture reserves but has not populated */
  reservedFamilies: ReadonlyArray<{ family: string; route: string; note: string }>
}

/**
 * A coverage expectation declared by (or mechanically read from) a plan.
 *
 * `geo-family`: every listed geography should have a page of `family`.
 * `dimension`: every page of `parentFamily` may carry a child of `family` per
 *   value; a missing value is reported as coverage, never as a must-build.
 */
export type CoverageExpectation =
  | { kind: 'geo-family'; id: string; label: string; family: string; geographyIds: readonly string[]; source: Provenance }
  | {
    kind: 'dimension'; id: string; label: string; parentFamily: string; family: string
    values: ReadonlyArray<{ key: string; slug: string; label: string }>; source: Provenance
  }

/* ── Provenance ─────────────────────────────────────────────────────────── */

export type ProvenanceKind =
  /** a page/cluster registry committed in a site repository */
  | 'repo-registry'
  /** a governance or planning document in a repository */
  | 'repo-doc'
  /** an operator entered it in Search Intelligence */
  | 'operator'
  /** a file export (e.g. a historical Search Console CSV) imported once */
  | 'import'
  /** a live connector */
  | 'provider'

export interface Provenance {
  kind: ProvenanceKind
  label: string
  /** absolute or repo-relative path of the source */
  path?: string
  repo?: string
  branch?: string
  commit?: string
  /** when the snapshot was taken, ISO date */
  capturedAt?: string
}

/* ── Pages: the URL OS ──────────────────────────────────────────────────── */

/** Editorial + build status. Mirrors the brief; equivalents in source registries map onto it. */
export const PAGE_STATUS = ['PLANNED', 'RESEARCHED', 'COPY_READY', 'BUILDING', 'QA', 'READY', 'PUBLISHED', 'INDEXED', 'NEEDS_WORK'] as const
export type PageStatus = (typeof PAGE_STATUS)[number]

/** The four registry stages a URL passes through. Distinct facts, never inferred from each other. */
export const REGISTRY_STAGE = ['PLANNED_URL', 'BUILT_ROUTE', 'PUBLISHED_URL', 'INDEXED_URL'] as const
export type RegistryStage = (typeof REGISTRY_STAGE)[number]

export type SearchIntent =
  | 'transactional'
  | 'commercial-investigation'
  | 'informational'
  | 'navigational'
  | 'local'
  | (string & {})

/**
 * Copy is never written here. `APPROVED` needs a recorded owner sign-off;
 * text that exists in a governed source repository without one is shown with
 * the COPY NOT APPROVED marker; `NOT_WRITTEN` shows only the marker.
 */
export type CopyState = 'APPROVED' | 'SOURCE_UNAPPROVED' | 'NOT_WRITTEN'

export interface PageCopy {
  title: string | null
  h1: string | null
  meta: string | null
  state: CopyState
  source?: Provenance
}

export type Indexability = 'INDEX' | 'NOINDEX' | 'COMPUTED_BY_GATE' | 'UNDECIDED'

/** Historical evidence imported from a legacy site — labelled, windowed, never a live measure. */
export interface LegacyEvidence {
  label: string
  window: { start: string; end: string }
  clicks: number | null
  impressions: number | null
  averagePosition: number | null
  tier: string | null
  decision: string | null
  legacyPath: string | null
  source: Provenance
}

export interface SearchPage {
  id: string
  propertyId: string
  /** leading slash, no trailing slash, no origin */
  path: string
  family: string
  parentId: string | null
  geographyIds: readonly string[]
  intent: SearchIntent | null
  primaryClusterId: string | null
  /** clusters the page supports but does not own */
  secondaryClusterIds: readonly string[]
  secondaryKeywords: readonly string[]
  copy: PageCopy
  canonical: string | null
  schemaTypes: readonly string[]
  indexability: Indexability
  robots: string | null
  inSitemap: boolean | null
  launchWaveId: string | null
  status: PageStatus
  /** the page's own primary keyword, when its source registry declares one */
  primaryKeyword: string | null
  /** facts that place the URL on the registry ladder */
  stage: {
    planned: boolean
    builtRoute: boolean
    published: boolean
    /** only a connected Search Console can set this */
    indexed: boolean | null
  }
  /** why this page exists, quoted/condensed from the source plan */
  thesis: string | null
  notes: string | null
  /** alias paths that must redirect here (prevents accidental duplicates) */
  aliases: readonly string[]
  source: Provenance
  legacy?: LegacyEvidence | null
  /** source-specific facts shown verbatim in the inspector (gate cluster, quality status, issues) */
  sourceFields?: ReadonlyArray<{ label: string; value: string }>
}

export type LinkKind = 'parent' | 'related' | 'nav' | 'content' | 'planned'

export interface InternalLink {
  fromPageId: string
  toPageId: string
  kind: LinkKind
  /** the cluster the anchor text speaks to, when declared */
  anchorClusterId?: string | null
}

/* ── Keywords ───────────────────────────────────────────────────────────── */

export const KEYWORD_SOURCES = ['PLANNED', 'SEARCH_CONSOLE', 'EXTERNAL_RESEARCH', 'OPERATOR', 'IMPORT'] as const
export type KeywordSource = (typeof KEYWORD_SOURCES)[number]

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export interface KeywordCluster {
  id: string
  propertyId: string
  label: string
  /** null when the family is named but no keyword research exists yet */
  primaryKeyword: string | null
  parentTopic: string | null
  intent: SearchIntent | null
  /** geographic template level when the cluster is programmatic ({state}, {market}, …) */
  geoLevel: GeoKind | null
  /** the canonical owner page id named by the plan (may be a page not yet registered) */
  ownerPageId: string | null
  /** the owner as the source plan names it (route, registry id or template), even when unresolved */
  ownerRef: string | null
  priority: Priority | null
  wave: string | null
  source: KeywordSource
  provenance: Provenance
  notes: string | null
}

export type KeywordStatus = 'PLANNED' | 'MAPPED' | 'TARGETED' | 'RANKING' | 'RETIRED'

export interface SearchKeyword {
  id: string
  propertyId: string
  query: string
  clusterId: string | null
  intent: SearchIntent | null
  geographyId: string | null
  assignedPageId: string | null
  status: KeywordStatus
  priority: Priority | null
  source: KeywordSource
  provenance: Provenance
}

/* ── Geography ──────────────────────────────────────────────────────────── */

export type GeoKind = 'COUNTRY' | 'STATE' | 'METRO' | 'COUNTY' | 'CITY'

/** Shared across properties: one Miami, many brands' pages. */
export interface SearchGeography {
  id: string
  kind: GeoKind
  name: string
  /** USPS code for states; FIPS for counties when known */
  code: string | null
  parentId: string | null
  stateCode: string | null
  lat: number | null
  lng: number | null
}

/* ── Launch waves ───────────────────────────────────────────────────────── */

export type WaveStatus = 'PLANNED' | 'IN_PROGRESS' | 'READY' | 'LAUNCHED' | 'BLOCKED'

export interface LaunchWave {
  id: string
  propertyId: string
  label: string
  order: number
  /** the status recorded by the plan; readiness is derived from pages separately */
  status: WaveStatus
  targetDate: string | null
  dependsOn: readonly string[]
  /** named blockers from the plan */
  blockers: readonly string[]
  notes: string | null
  source: Provenance
}

/* ── Connections / providers ────────────────────────────────────────────── */

export const PROVIDERS = ['SEARCH_CONSOLE', 'GA4', 'FIRST_PARTY', 'CLOUDFLARE', 'EXTERNAL_RESEARCH', 'LEADCOMMAND'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export type ConnectionState =
  | 'NOT_CONFIGURED'
  | 'AWAITING_SITE'
  | 'AWAITING_ACCESS'
  | 'VERIFYING'
  | 'CONNECTED'
  | 'SYNCING'
  | 'DEGRADED'
  | 'ERROR'
  | 'PAUSED'
  | 'NOT_APPLICABLE'

export interface PropertyConnection {
  propertyId: string
  provider: ProviderId
  state: ConnectionState
  /** e.g. DATAFORSEO for EXTERNAL_RESEARCH; null when none is chosen */
  vendor: string | null
  lastSyncAt: string | null
  /** the provider's own last complete day */
  dataThrough: string | null
  /** honest context ("legacy property exists; no connector configured") */
  note: string | null
}

/* ── Objects + opportunities ────────────────────────────────────────────── */

export type ObjectKind = 'property' | 'page' | 'keyword' | 'cluster' | 'geography' | 'wave' | 'opportunity'
export interface ObjectRef {
  kind: ObjectKind
  id: string
}

export type Severity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW'
export type RulePhase = 'PRE_LAUNCH' | 'LIVE'

export interface Opportunity {
  /** stable: rule + subject */
  id: string
  ruleId: string
  propertyId: string
  phase: RulePhase
  severity: Severity
  title: string
  /** the rule's reasoning in words — every opportunity says WHY */
  why: string
  evidence: ReadonlyArray<{ label: string; value: string }>
  subject: ObjectRef
  related: readonly ObjectRef[]
}

/* ── The dataset ────────────────────────────────────────────────────────── */

export interface SearchDataset {
  properties: readonly SearchProperty[]
  pages: readonly SearchPage[]
  links: readonly InternalLink[]
  clusters: readonly KeywordCluster[]
  keywords: readonly SearchKeyword[]
  geographies: readonly SearchGeography[]
  waves: readonly LaunchWave[]
  connections: readonly PropertyConnection[]
  /** facts reported by connected providers; empty until a connector exists */
  measures: MeasureStore
}

/** Provider-reported facts keyed by object. Empty in V1 by construction. */
export interface MeasureStore {
  page: ReadonlyMap<string, PageMeasures>
  keyword: ReadonlyMap<string, KeywordMeasures>
}

export interface PageMeasures {
  provider: ProviderId
  through: string
  impressions: number
  clicks: number
  position: number | null
  sessions?: number | null
  conversions?: number | null
}

export interface KeywordMeasures {
  provider: ProviderId
  through: string
  impressions: number
  clicks: number
  position: number | null
  previousPosition?: number | null
}

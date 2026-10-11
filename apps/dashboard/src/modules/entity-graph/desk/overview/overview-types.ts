/**
 * The Overview contract (GET /api/cockpit/entity-graph/overview, spec 9 §4.2) —
 * mirrors apps/api/src/lib/domain/entity-graph/entity-graph-overview-service.js.
 * Every count is exact for the cohort; `filter` is the rail's own chip.
 */
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'

export type OverviewKind = 'categorical' | 'tokens' | 'array' | 'numeric' | 'derived_number' | 'date' | 'boolean' | 'derived_boolean' | 'coverage' | 'banded_text' | 'derived_categorical'
export type BucketTone = 'value' | 'other' | 'none' | 'yes' | 'no'

export type OverviewBucket = {
  key: string
  label: string
  count: number
  filter: EntityGraphFieldFilter | null
  tone?: BucketTone
  lo?: number | null
  hi?: number | null
}

export type OverviewField = {
  key: string
  label: string
  kind: OverviewKind
  format?: string
  section: string
  column?: string
  privacy?: 'values' | 'coverage_only'
  /** protected-class-adjacent (age, gender, marital status, language…): charted, marked, never priced */
  sensitive?: boolean
  computedFact?: boolean
  emptySource?: boolean
  pinned?: boolean
  caution?: string
  coverage?: { known: number; total: number; share: number | null }
  buckets?: OverviewBucket[]
  windows?: OverviewBucket[]
  stats?: { min: number | string | null; p25?: number | null; p50?: number | null; p75?: number | null; max: number | string | null } | null
  grain?: 'year' | 'month'
  distinct?: number | null
  additive?: boolean
  note?: string
  ghost?: { total: number; buckets: OverviewBucket[] }
  /** set when the field cannot be computed on this relation yet (never an estimate) */
  unavailable?: string
  /** the read ran past its budget (still warming server-side): a retry can succeed — shown as a card, not "waiting on the read model" */
  retry?: boolean
  /** counted on the rail's facet path (the canonical property type before the read model serves it) */
  liveFact?: boolean
  /** a whole-universe count that only the snapshot / read model answers */
  computing?: boolean
}

export type OverviewSection = { id: string; label: string; fields: OverviewField[]; unavailable?: string; snapshot?: boolean; computing?: boolean }

export type OverviewMetric = { key: string; label: string; value: number | null; basis: string; filter?: EntityGraphFieldFilter; unavailable?: string | null; sensitive?: boolean }

export type DistressByMarket = {
  signals: Array<{ key: string; label: string; filter: EntityGraphFieldFilter }>
  markets: Array<{ key: string; label: string; total: number; filter: EntityGraphFieldFilter | null; counts: Record<string, number> }>
  note?: string
}

export type OverviewHeadline = {
  metrics: OverviewMetric[]
  distress: OverviewBucket[]
  distressNote?: string
  stack: OverviewBucket[] | null
  stackNote?: string
  distressByMarket?: DistressByMarket | null
  pipeline: OverviewBucket[] | null
  inbox: OverviewBucket[] | null
  smsReasons: OverviewBucket[] | null
  definitions?: Record<string, string>
}

export type OverviewResponse = {
  ok: boolean
  tab: string
  supported: boolean
  total: number | null
  /** the unfiltered universe is precomputed by the snapshot job and not live yet (never scanned live) */
  computing?: boolean
  source?: { relation: string; mode: 'facts' | 'view' | 'base' | 'snapshot'; note: string; factsFiltersExecutable: boolean }
  refreshed_at?: { facts: string | null; engagement: string | null; snapshot?: string | null }
  headline: OverviewHeadline | null
  sections: OverviewSection[]
  unavailable: Array<{ section?: string; field?: string; reason: string; retry?: boolean; computing?: boolean }>
  timings?: { totalMs: number; statements: Array<{ label: string; ms: number; cached: boolean | 'stale' }> }
  error?: string
  message?: string
}

export type OverviewCatalogSection = { id: string; label: string; fields: Array<Pick<OverviewField, 'key' | 'label' | 'kind' | 'section' | 'computedFact' | 'emptySource' | 'pinned'> & { inCatalog?: boolean }> }
export type OverviewCatalog = { ok: boolean; tab: string; supported: boolean; pinned: string[]; sections: OverviewCatalogSection[] }

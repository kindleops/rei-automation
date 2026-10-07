/**
 * Shapes of the read-only Acquisition OS intelligence APIs (agent A2):
 *   apps/api/src/lib/domain/campaigns/ranking-v2/*.js
 * Every number is the server's. `fixture: true` is set only by proof captures.
 */

export type Tier = 'A' | 'B' | 'C' | 'UNKNOWN'
export type Band = 'A' | 'B' | 'C' | 'UNKNOWN' | 'FALLBACK' | 'UNRANKED'
export type RankSource = 'v2' | 'legacy_fallback' | 'v2_no_situation' | 'unranked'
export type EquityClass = 'high' | 'low' | 'unknown'
export interface RankLayersCompact { contact: number; pressure: number; deal: number; market: number }

export interface Counted { key: string; count: number }

export interface MetricCoverage {
  key: string
  label: string
  source: string
  known: number
  total: number
  ratio: number
  threshold: number
  exposed: boolean
}

export interface CatalogMetric {
  key: string
  label: string
  source: 'graph' | 'situation' | 'market' | 'derived' | 'rank' | string
  type: 'text' | 'number' | 'boolean' | string
  column: string | null
  formula: string | null
  threshold: number
  coverage: { ratio: number; known: number; total: number } | null
  exposed: boolean
  reason: 'coverage_below_threshold' | 'coverage_not_measured' | null | string
}

export interface ScreenerCatalog {
  ok: true
  flag: string
  coverage_sample: { at: string; rows: number; method: string; ms: number }
  metrics: CatalogMetric[]
  fixture?: boolean
}

export type ScreenerOp = 'eq' | 'neq' | 'in' | 'nin' | 'gte' | 'gt' | 'lte' | 'lt' | 'between' | 'is_true' | 'is_false' | 'known' | 'unknown'
export interface ScreenerLeaf { m: string; op: ScreenerOp; v?: unknown }
export type ScreenerExpr = { all: ScreenerExpr[] } | { any: ScreenerExpr[] } | { not: ScreenerExpr } | ScreenerLeaf

export interface WhyItem { code: string; label: string; kind: 'situation' | 'fact' | 'market' | 'contact' | string; source?: string }

export interface ScreenerSeller {
  property_id: string
  address: string | null
  market: string | null
  zip: string | null
  property_type: string | null
  tier: Tier
  seller_situation: string | null
  rank: { band: Band; score: number | null; priority_score: number | null; rank_source: RankSource; layers?: RankLayersCompact; equity_class?: EquityClass } | null
  components: Record<string, number | null> | null
  sell365: number | null
  why: WhyItem[]
}

export interface Histogram { buckets: Array<{ lo: number; hi: number; n: number }>; unknown: number }

export interface ScreenerResult {
  ok: true
  version: string
  scanned: number
  truncated: boolean
  matched: number
  pushed_down: number
  unknown_rows: number
  unknown_excluded: Record<string, number>
  tiers: Record<Tier, number>
  markets: Array<{ market: string; count: number }>
  zips: Array<{ zip: string; market: string | null; count: number; high_pressure: number; tier_a: number; contact_high?: number; median_equity_percent_known: number | null; equity_known?: number; equity_class?: Record<EquityClass, number>; market_quality: number | null; market_label: string }>
  score_distribution: { rank_score: Histogram; forced_sale_pressure: Histogram }
  sellers: ScreenerSeller[]
  coverage_in_cohort?: Record<string, MetricCoverage>
  timings_ms?: Record<string, number>
  fixture?: boolean
}

export interface ScreenerRefusal { metric: string; reason: string; ratio?: number; threshold?: number }

export interface MarketTerms { liquidity: number | null; buyer_depth: number | null; investor_activity: number | null }

export interface DiscoveryZip {
  zip: string
  asset: string
  market: string | null
  state: string | null
  sellers_in_graph: number
  reachable: number
  tiers: Record<Tier, number>
  high_pressure: number
  pressure_pool: number
  median_equity_percent_known: number | null
  equity_known?: number
  equity_class?: Record<EquityClass, number>
  contact_high?: number
  cohort_ready?: number
  market_quality: number | null
  market_label: string
  market_terms: MarketTerms | null
  market_inputs: Record<string, number | null> | null
  market_quality_assumed: boolean
  discovery_score: number
  headline: string
}

export interface DiscoveryResult {
  ok: true
  version: string
  zips: DiscoveryZip[]
  zips_considered: number
  scanned: number
  truncated: boolean
  constants?: Record<string, number>
  fixture?: boolean
}

export interface SituationRead {
  score_version: string
  input_model_version: string
  scored_at: string
  opportunity_tier: Tier
  tier_reasons: string[]
  seller_situation: string
  conversation_angle: string | null
  components: Record<string, number | null>
  sell_probability: { d90: number | null; d180: number | null; d365: number | null }
  coverage: { fields_known: number; fields_total: number; ratio: number; missing: string[] }
  confidence: number
  evidence: Array<{ code: string; points: number; component: string; source: string; provenance: string }>
  computed: string
}

export interface LayerEvidence { code: string; points: number; source: string }
export interface RankLayers {
  contact: { score: number; weight: number; line: string; identity: string; tag: string; known_signals: number; evidence: LayerEvidence[] }
  pressure: { score: number; gate: number; effective: number; weight: number; source: string; terms: Array<{ key: string; value: number | null; used_prior: boolean; weight: number; points: number }> }
  deal: { score: number; weight: number; equity: { known: boolean; percent: number | null; class: EquityClass; rule: string }; value_known: boolean }
  market: { score: number; weight: number; market_quality: number | null; used_prior: boolean; response_context_points: number | null }
}
export interface RankTerm { key: string; weight: number; value: number | null; used_prior: boolean; prior: number; points: number }

export interface WhyTargetedProperty {
  property_id: string
  market_name: string | null
  zip: string | null
  situation: SituationRead | null
  market: { score: number | null; label: string; terms: MarketTerms; inputs: Record<string, number | null>; provenance: Record<string, unknown> } | null
  rank: {
    ranking_version: string; rank_source: RankSource; band: Band; score: number | null; priority_score: number | null; fallback_reason: string | null
    coverage: { contact_signals_known?: number; situation?: boolean; equity_known?: boolean; market_known?: boolean; terms_known?: number; terms_total?: number }
    terms?: RankTerm[]
    layers?: RankLayers
  } | null
  why: WhyItem[]
}

export interface WhyTargetedResult { ok: true; ms: number; missing: string[]; properties: WhyTargetedProperty[]; fixture?: boolean }

export interface QualityReport {
  ok: true
  version: string
  denominator: number
  requested?: number
  source?: string
  at?: string
  segments: Array<{ key: string; label: string; count: number }>
  tiers: Record<Tier, number>
  ranking: Record<RankSource, number>
  coverage: Record<string, MetricCoverage>
  markets: Counted[]
  zips: Counted[]
  situations: { known: Counted[]; unknown: number }
  language: { known: Counted[]; unknown: number }
  contactability: { line_type: { mobile: number; landline: number; unknown: number }; identity: Counted[] }
  prior_property_touch: { touched: number; never: number; unknown: number }
  expected_review_only: { count: number; rule: string }
  buyer_liquidity: { strong: number; moderate: number; thin: number; unknown: number }
  equity?: { high: number; low: number; unknown: number; known_percent: number; rule: string }
  contact_confidence?: { high: number; medium: number; low: number; unknown: number }
  matching_tags?: Counted[]
  examples: { top_ranked: QualityExample[]; soft_only: QualityExample[] }
  fixture?: boolean
}

export interface QualityExample { property_id: string; market: string | null; zip: string | null; tier: Tier; band: Band | null; score: number | null; why: string[] }

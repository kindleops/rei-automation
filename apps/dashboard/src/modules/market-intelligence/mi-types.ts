/**
 * Market Intelligence wire types. The API (apps/api …/market-intelligence) is
 * the only authority for values, samples and statuses; the dashboard renders.
 */
export type MiLevel = 'nation' | 'state' | 'market' | 'county' | 'city' | 'zip'
export type MiStatus = 'ok' | 'insufficient' | 'unavailable' | 'not_loaded'
export type MiUnit = 'count' | 'usd' | 'pct' | 'pct100' | 'year' | 'number'

export interface MiValue {
  value: number | null
  n: number
  status: MiStatus
  reason?: string
  coverage?: number | null
  basis?: string
  current?: number
  prior?: number
}
export type MiValues = Record<string, MiValue>

export interface MiMetric {
  id: string
  group: 'sales' | 'multifamily' | 'investors' | 'ownership' | 'demand' | 'universe' | 'stock' | 'demographics'
  label: string
  description: string
  formula: string
  source: string
  unit: MiUnit
  levels: MiLevel[]
  assets: string[]
  min_sample: number
  sample: string
  freshness: 'sales' | 'graph' | 'areas' | 'census'
  aggregation: string
  windowed: boolean
  rankable: boolean
  screenable: boolean
  heatable: boolean
}

export interface MiRegistry {
  ok: true
  metrics: MiMetric[]
  unsupported: Record<string, string>
  levels: MiLevel[]
  asset_filters: Array<{ id: string; label: string }>
  periods: Array<{ id: string; label: string }>
}

export interface MiGeoSummary {
  id: string
  level: MiLevel
  level_label: string
  name: string
  label: string
  state: string | null
  parent_id: string | null
  parents: Partial<Record<MiLevel, string>>
  centroid: [number, number] | null
  bbox: [number, number, number, number] | null
  geometry: 'census_zcta' | 'census_state' | 'none'
  coverage?: { sales?: number; properties?: number; zips?: number }
  match?: 'exact' | 'prefix' | 'contains'
  lineage?: Array<{ id: string; level: MiLevel; label: string }>
  county_via?: string | null
}

export interface MiWarming {
  ok: true
  /** summary_missing: the market summary has no ready build (or is not installed). Nothing streams. */
  status: 'loading' | 'deferred' | 'error' | 'cold' | 'summary_missing'
  progress: { rows: number; est: number | null; phase: string } | null
  error: string | null
  message?: string
  detail?: string
}

export interface MiSummaryBuild {
  build_id: number; built_at: string | null; started_at: string | null; source_as_of: string; source_rows: number
  db_ms: number; ticks: number; rows_written: number; unmapped_types: string[]
}

export interface MiStatusPayload {
  ok: true
  status: 'ready'
  /** summary = the nightly market summary (production); raw_dev = the dev-only full stream */
  mode: 'summary' | 'raw_dev'
  summary: MiSummaryBuild | null
  as_of: string
  first_sale: string
  rows: number
  loaded_at: string
  coverage: { coverage_start: string | null; complete_through: string | null; months: Array<{ label: string; n: number; status: MiMonthStatus }> }
  membership: { sales_with_zip: number; sales_with_county: number; sales_with_market: number; sales_total: number }
  sources: Record<string, Record<string, unknown>>
  asset_filters: Array<{ id: string; label: string; available: boolean }>
  periods: Array<{ id: string; label: string }>
}

export type MiMonthStatus = 'covered' | 'pre_coverage' | 'incomplete' | 'partial'

export interface MiWindow { period: string; from: string; to: string; asset: string; asset_label: string }

export interface MiTrendPoint {
  month: string
  status: MiMonthStatus
  sales: number
  median_price: number | null
  price_n?: number
  median_ppsf: number | null
  investor_purchases: number
  buyer_known: number
  investor_share: number | null
  cash_known: number
  cash_share: number | null
  company_acquisitions: number
}

export interface MiTopBuyer { name: string; purchases: number; priced_volume: number; priced_n: number; last_purchase: string; assets: Array<{ asset: string; n: number }> }

export interface MiDossier {
  ok: true
  geography: MiGeoSummary
  window: MiWindow
  values: MiValues
  rank_context: Array<{ metric: string; parent_id: string; parent_label: string; rank: number; of: number; level: MiLevel }>
  children: { level: MiLevel; count: number } | null
  sales: { asset_mix: Array<{ asset: string; label: string; n: number }>; source_mix: { mls: number; public_record: number }; price_deciles: Array<{ q: number; value: number }> | null; latest_sale: string | null }
  investors: { top_buyers: MiTopBuyer[]; buyer_kinds: { company_named: number; lender_or_agency: number } }
  multifamily: { unit_distribution: Array<{ label: string; n: number }>; size_distribution: Array<{ label: string; n: number }> }
  universe: {
    loaded_states: string[]; missing_states: string[]
    stock: Array<{ field: string; label: string; median: number | null; n: number; coverage: number }> | null
    types: Array<{ asset: string; label: string; n: number }> | null
    corporate_owner_count: number | null; never_contacted_count: number | null; property_count: number | null; phone_type_coverage: number | null
    authority: string
  }
  trends: MiTrendPoint[]
  data_quality: Record<string, string | number | null>
  brief: Array<{ text: string; metrics: string[] }>
  /** Present only when the owner-based inference API ships it. */
  inferred_investors?: MiInferredInvestors | null
}

export interface MiRow { id: string; level: MiLevel; label: string; state: string | null; rank: number | null; centroid: [number, number] | null; values: MiValues; reason?: string }

export interface MiRankResult {
  ok: true; level: MiLevel; within: MiGeoSummary; metric: string; dir: 'asc' | 'desc'; window: MiWindow; min_sales: number
  total: number; unranked_count: number; rows: MiRow[]; unranked: MiRow[]; universe: { states: string[]; loaded: string[] }
}

export interface MiScreenFilter { metric: string; op: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
export interface MiScreenResult {
  ok: true; level: MiLevel; within: MiGeoSummary; match: 'all' | 'any'; filters: MiScreenFilter[]; rejected: Array<{ metric: string; reason: string }>
  window: MiWindow; sort: string; considered: number; total: number; rows: MiRow[]; universe: { states: string[]; loaded: string[] }; universe_incomplete: boolean
}

export interface MiCompareResult {
  ok: true; window: MiWindow; metrics: string[]
  items: Array<{ id: string; level: MiLevel; label: string; state: string | null; values: MiValues; window: MiWindow }>
  series: Array<{ id: string; label: string; months: MiTrendPoint[] }>
}

export interface MiRecentSale {
  comp_id: string; sold_on: string; price: number | null; ppsf: number | null; address: string | null; city: string | null; state: string | null; zip: string | null
  asset: string; asset_label: string; units: number | null; sqft: number | null; buyer: string | null; property_id: string | null; source: string; investor: boolean; cash: boolean | null
}

export interface MiFail { ok: false; status: number; error: string; message?: string }

/**
 * SLOT: inferred investors from CURRENT OWNER data (LLC/builder owner, absentee mailing,
 * portfolio stacking). Owned by the inferred-investor API work; this UI renders only what
 * the API returns and says "unavailable" otherwise. Every field optional on purpose.
 */
export interface MiInferredInvestors {
  status?: 'ok' | 'insufficient' | 'unavailable'
  label?: string
  share?: number | null
  count?: number | null
  base_n?: number | null
  base_label?: string
  tiers?: Array<{ id: string; label: string; n?: number | null; share?: number | null; definition?: string }>
  validation?: string | null
  source?: string | null
  as_of?: string | null
  reason?: string | null
}

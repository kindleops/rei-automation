import type { SaleOwnerRow } from './sale-owner/sale-owner-client'
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
  /** 'inferred_investor': available only when status.inferred_investor.available */
  requires?: string
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
  inferred_investor?: { available: boolean; reason: string | null; message: string | null; national?: { sales: number; linked: number; coverage: number | null; validation?: MiInferredValidation | null } | null }
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
  /** The shared buyer-of-record resolver (op=recent_sales carries it). */
  buyer_of_record?: SaleOwnerRow['buyer_of_record']; owner_link?: SaleOwnerRow['owner_link']; inferred?: SaleOwnerRow['inferred']
}

export interface MiFail { ok: false; status: number; error: string; message?: string }

/** Inferred investors (owner-based): the API's dossier.inferred_investors (INFERRED_INVESTOR_UI.txt §2). */
export interface MiInferredValidation {
  precision?: number | null; recall?: number | null; accuracy?: number | null; base_rate?: number | null; n?: number | null
  tiers?: Record<string, { n?: number; recorded_investor?: number; precision?: number | null }>
  matrix?: Record<string, { recorded_investor: number; recorded_other: number }>
  truth?: string | null
}
export interface MiInferredStack { stack: string; label: string; named: boolean; name_evidence?: string | null; linked_purchases: number; last_purchase?: string | null; properties_at_mailing_address: number; entity_share?: number | null; out_of_state_share?: number | null }
export interface MiInferredInvestors {
  available: boolean
  reason?: string | null
  message?: string | null
  label?: string
  recorded_label?: string
  sales?: number
  linked?: number
  coverage?: number | null
  tiers?: Array<{ id: string; label: string; n: number; counted: boolean }>
  validation?: { national: MiInferredValidation | null; local: MiInferredValidation | null; local_n: number }
  top_stacks?: MiInferredStack[]
  caveats?: string[]
  individuals_named?: false
}

/** op=points: ZIP centroids with one metric (hero map density / bubbles). `t` = rank 0..1 among ok values. */
export interface MiPoint { id: string; label: string; c: [number, number]; v: number | null; n: number; s: MiStatus; sales: number; t: number | null }
export interface MiPointsResult { ok: true; level: 'zip'; within: MiGeoSummary; parent?: string; metric: string; label: string; unit: MiUnit; window?: MiWindow; rows: MiPoint[]; without_value: number; max?: number | null; note: string | null }

/** op=heat: outlined areas (states, or ZIP outlines in a metro) with one metric. */
export interface MiHeatArea { key: string; id: string; label: string; v: number; n: number; t: number; tip: string; outline: GeoJSON.Geometry }
export interface MiHeatResult { ok: true; level: string; metric: string; label: string; unit: MiUnit; rows: MiHeatArea[]; without_value: number; note: string | null }

/** op=leaders: top areas by ONE registry metric, with a monthly sales series per row. */
export interface MiLeaderRow extends MiRow { spark: number[]; spark_investor: number[] }
export interface MiLeadersResult {
  ok: true; level: MiLevel; within: MiGeoSummary; parent: MiGeoSummary; sort: string; dir: 'asc' | 'desc'; min_sales: number; window: MiWindow
  total: number; unranked_count: number; months: Array<{ label: string; status: MiMonthStatus }>; rows: MiLeaderRow[]
}

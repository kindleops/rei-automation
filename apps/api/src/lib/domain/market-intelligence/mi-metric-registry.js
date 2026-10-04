/**
 * MARKET INTELLIGENCE: THE metric registry (brief §45). One definition per
 * metric, read by every surface: overview rail, rankings, screener, compare,
 * heat, inspector and the deterministic brief. The dashboard receives it from
 * GET ?op=registry and never re-defines a metric.
 *
 *   id, label, description, formula, source, unit, levels, assets, min_sample,
 *   sample (which count is the sample), freshness (which source clock),
 *   aggregation, group, windowed, better (for honest colouring only).
 *
 * A metric without real support is not in the registry. Unsupported asks
 * (cap rate, NOI, rent roll, DSCR, crime, age, education, employment) are in
 * UNSUPPORTED with the reason, so a screen/rank on them fails loudly.
 */
export const LEVELS = Object.freeze(['nation', 'state', 'market', 'county', 'city', 'zip'])
const ALL = LEVELS
const SALES_SRC = 'mv_map_market_sales (canonical deduplicated sales)'
const GRAPH_SRC = 'campaign_target_graph (Composer audience projection), summary only'
const AREA_SRC = 'mv_map_property_area_stats (geocoded property universe)'
const ACS_SRC = 'US Census ACS 5-year (exchange_market_fundamentals_cells)'
const SALES_ASSETS = Object.freeze(['all', 'sfr', 'mf_2_4', 'mf_5_plus', 'mf', 'land', 'commercial'])
const MF_ASSETS = Object.freeze(['all', 'mf_2_4', 'mf_5_plus', 'mf'])

const m = (def) => Object.freeze({
  levels: ALL, assets: SALES_ASSETS, min_sample: 1, windowed: true, aggregation: 'count', better: null,
  rankable: true, screenable: true, heatable: false, ...def,
})

export const METRICS = Object.freeze([
  // ── Sales ───────────────────────────────────────────────────────────────
  m({ id: 'sales_count', group: 'sales', label: 'Sales', unit: 'count', heatable: true, sample: 'sales_count',
    description: 'Recorded economic sales in the period: deduplicated deeds plus MLS closes, priced or not.',
    formula: 'count(sales in period)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'priced_sale_count', group: 'sales', label: 'Priced sales', unit: 'count', sample: 'priced_sale_count',
    description: 'Sales with a recorded price above zero (price evidence).', formula: 'count(price > 0)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'qualified_sale_count', group: 'sales', label: 'Qualified priced sales', unit: 'count', sample: 'qualified_sale_count', rankable: false,
    description: 'Priced sales usable for price statistics: arm\'s-length, single-parcel, not a nominal deed.',
    formula: 'count(price > 0 ∧ portfolio < 2 ∧ arm\'s-length ≠ false ∧ doc type not quit-claim/gift/TOD/correction/re-recorded/public action)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'median_sale_price', group: 'sales', label: 'Median price', unit: 'usd', aggregation: 'median', min_sample: 10, sample: 'qualified_sale_count', heatable: true,
    description: 'Median price of qualified priced sales.', formula: 'median(price | qualified)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'median_ppsf', group: 'sales', label: 'Median $/sq ft', unit: 'usd', aggregation: 'median', min_sample: 10, sample: 'ppsf_sample', heatable: true,
    description: 'Median price per building square foot of qualified priced sales with a recorded size.', formula: 'median(price ÷ sqft | qualified ∧ sqft > 0)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'median_price_per_unit', group: 'multifamily', label: 'Median price / unit', unit: 'usd', aggregation: 'median', min_sample: 5, sample: 'ppu_sample', assets: MF_ASSETS, heatable: true,
    description: 'Median price per unit of qualified 2–4 and 5+ sales with a valid unit count (≥ 350 sq ft per unit when size is known).',
    formula: 'median(price ÷ units | qualified ∧ units > 0 ∧ class ∈ {2–4, 5+})', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'monthly_sales_rate', group: 'sales', label: 'Sales / month', unit: 'number', aggregation: 'mean', sample: 'complete_months', min_sample: 1,
    description: 'Transaction velocity: average sales per complete, covered month inside the period.', formula: 'sales in complete months ÷ complete months', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'sales_growth', group: 'sales', label: 'Sales change', unit: 'pct', aggregation: 'ratio', min_sample: 20, sample: 'growth_prior_sales', heatable: true,
    description: 'Change in sales between two equal windows of complete months. Unavailable when the prior window starts before sales coverage.',
    formula: '(sales current window ÷ sales prior window) − 1', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'mf_sale_count', group: 'multifamily', label: 'Multifamily sales', unit: 'count', sample: 'mf_sale_count', assets: ['all'],
    description: '2–4 and 5+ sales plus multifamily sales without a usable unit count.', formula: 'count(class ∈ {2–4, 5+, MF unknown units})', source: SALES_SRC, freshness: 'sales' }),
  // ── Investors (three distinct things, brief §16) ─────────────────────────
  m({ id: 'investor_purchase_count', group: 'investors', label: 'Investor purchases', unit: 'count', heatable: true, sample: 'investor_purchase_count',
    description: 'Sales whose recorded buyer is an investor: a company buyer or an investor buyer archetype (IC8 isInvestorPurchase). Counted priced or not.',
    formula: 'count(is_investor)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'investor_purchase_share', group: 'investors', label: 'Investor share', unit: 'pct', aggregation: 'ratio', min_sample: 20, sample: 'buyer_known_count', heatable: true,
    description: 'Investor purchases as a share of sales WITH a recorded buyer. Most sales carry no buyer; coverage is shown beside it.',
    formula: 'investor purchases ÷ sales with a recorded buyer', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'buyer_evidence_coverage', group: 'investors', label: 'Buyer recorded', unit: 'pct', aggregation: 'ratio', min_sample: 1, sample: 'sales_count', rankable: false,
    description: 'Share of sales whose buyer is recorded at all: the evidence behind investor share.', formula: 'sales with a recorded buyer ÷ sales', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'cash_purchase_count', group: 'investors', label: 'Cash purchases', unit: 'count', sample: 'cash_purchase_count',
    description: 'Sales with deed-level cash evidence.', formula: 'count(is_cash_purchase = true)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'cash_purchase_share', group: 'investors', label: 'Cash share', unit: 'pct', aggregation: 'ratio', min_sample: 20, sample: 'cash_known_count', heatable: true,
    description: 'Cash purchases as a share of sales where cash/financed is recorded. Coverage is shown beside it.',
    formula: 'cash purchases ÷ sales with cash evidence', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'cash_evidence_coverage', group: 'investors', label: 'Cash recorded', unit: 'pct', aggregation: 'ratio', min_sample: 1, sample: 'sales_count', rankable: false,
    description: 'Share of sales with any cash/financed evidence.', formula: 'sales with cash evidence ÷ sales', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'entity_owned_count', group: 'ownership', label: 'Entity-owned now', unit: 'count', windowed: false, heatable: true, sample: 'entity_owned_count',
    description: 'Properties whose CURRENT owner is a company and whose latest recorded sale names no buyer. A current state, not purchases; never added to investor purchases.',
    formula: 'count(latest sale ∧ no buyer name ∧ current owner corporate)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'company_buyer_count', group: 'demand', label: 'Active company buyers', unit: 'count', sample: 'company_buyer_count', heatable: true,
    description: 'Distinct named company buyers with a purchase in the period. Lenders, servicers, GSEs and agencies excluded; individuals never counted as companies.',
    formula: 'count(distinct displayable company buyer, not lender)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'repeat_buyer_count', group: 'demand', label: 'Repeat acquirers', unit: 'count', sample: 'company_buyer_count',
    description: 'Company buyers with two or more purchases in the period.', formula: 'count(company buyers with ≥ 2 purchases)', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'top5_buyer_share', group: 'demand', label: 'Top-5 buyer share', unit: 'pct', aggregation: 'ratio', min_sample: 20, sample: 'named_buyer_purchases',
    description: 'Concentration: share of named-company purchases made by the five most active buyers.', formula: 'purchases by top 5 company buyers ÷ named-company purchases', source: SALES_SRC, freshness: 'sales' }),
  m({ id: 'median_investor_price', group: 'demand', label: 'Median investor price', unit: 'usd', aggregation: 'median', min_sample: 10, sample: 'investor_qualified_count',
    description: 'Median price of qualified priced investor purchases.', formula: 'median(price | qualified ∧ is_investor)', source: SALES_SRC, freshness: 'sales' }),
  // ── Seller universe (graph summary; Composer is the authority) ──────────
  ...[
    ['seller_record_count', 'Seller records', 'Rows in the campaign target graph for the geography.', 'count(graph rows)'],
    ['phone_on_file_count', 'Phone on file', 'Graph rows with a canonical E.164 phone.', 'count(canonical_e164 present)'],
    ['sms_eligible_count', 'SMS-eligible', 'Graph rows the graph marks sms_eligible.', 'count(sms_eligible)'],
    ['queue_eligible_count', 'Queue-eligible', 'Graph rows the graph marks queue_eligible.', 'count(queue_eligible)'],
    ['email_eligible_count', 'Email available', 'Graph rows the graph marks email_eligible.', 'count(email_eligible)'],
    ['suppressed_count', 'Suppressed', 'Post-contact suppression or wrong number.', 'count(true_post_contact_suppression ∨ wrong_number)'],
    ['recent_contact_hold_count', 'Recent-contact hold', 'A prior touch is pending (contact cooling).', 'count(pending_prior_touch)'],
    ['in_queue_count', 'In queue now', 'Graph rows with an active queue item.', 'count(active_queue_item)'],
  ].map(([id, label, description, formula]) => m({ id, group: 'universe', label, unit: 'count', windowed: false, assets: ['all', 'sfr', 'mf_2_4', 'mf_5_plus', 'mf', 'land'], sample: 'seller_record_count',
    heatable: id === 'sms_eligible_count' || id === 'seller_record_count', description: `${description} A summary only: Campaign Composer computes the authoritative audience.`, formula, source: GRAPH_SRC, freshness: 'graph' })),
  // ── Property stock ──────────────────────────────────────────────────────
  m({ id: 'property_count', group: 'stock', label: 'Property universe', unit: 'count', windowed: false, assets: ['all'], sample: 'property_count', heatable: true,
    description: 'Geocoded properties in the LeadCommand property universe.', formula: 'count(geocoded properties)', source: 'mv_map_search_areas', freshness: 'areas' }),
  ...[
    ['avg_equity_pct', 'Avg equity', 'pct100', 'Mean owner equity % (public record).'],
    ['avg_estimated_value', 'Avg est. value', 'usd', 'Mean estimated value (AVM), not a sale price.'],
    ['avg_year_built', 'Avg year built', 'year', 'Mean assessor year built.'],
    ['tax_delinquent_share', 'Tax delinquent', 'pct', 'Share of properties flagged tax-delinquent.'],
    ['free_clear_share', 'Free & clear', 'pct', 'Share of properties with no mortgage balance.'],
    ['avg_distress_score', 'Avg distress score', 'number', 'Mean distress-tag score.'],
  ].map(([id, label, unit, description]) => m({ id, group: 'stock', label, unit, windowed: false, assets: ['all'], levels: ['nation', 'state', 'county', 'zip'], aggregation: 'mean', min_sample: 30, sample: 'stock_sample',
    heatable: id === 'tax_delinquent_share' || id === 'avg_distress_score', description: `${description} An average over the property universe, not a median.`, formula: `mean(${id.replace(/^avg_|_share$/g, '')})`, source: AREA_SRC, freshness: 'areas' })),
  // ── Demographics (ACS) ──────────────────────────────────────────────────
  ...[
    ['population', 'Population', 'count', 'sum'], ['households', 'Households', 'count', 'sum'], ['housing_units', 'Housing units', 'count', 'sum'],
    ['median_household_income', 'Median HH income', 'usd', 'cell'], ['median_gross_rent', 'Median gross rent', 'usd', 'cell'],
    ['vacancy_rate', 'Vacancy', 'pct', 'cell'], ['renter_share', 'Renter-occupied', 'pct', 'cell'], ['owner_share', 'Owner-occupied', 'pct', 'cell'],
    ['acs_median_year_built', 'Median year built (ACS)', 'year', 'cell'], ['rent_burden', 'Rent burden', 'pct100', 'cell'],
    ['units_2_4_share', '2–4 unit housing', 'pct', 'cell'], ['units_5plus_share', '5+ unit housing', 'pct', 'cell'],
  ].map(([id, label, unit, agg]) => m({ id, group: 'demographics', label, unit, windowed: false, assets: ['all'], aggregation: agg === 'sum' ? 'sum' : 'census_cell', sample: 'census_cells',
    levels: agg === 'sum' ? ['nation', 'state', 'market', 'county', 'city', 'zip'] : ['state', 'county', 'city', 'zip'], heatable: id === 'median_household_income' || id === 'renter_share' || id === 'population',
    description: agg === 'sum' ? `${label}: ACS 5-year estimate; markets sum their member ZIP cells (coverage shown).` : `${label}: ACS 5-year estimate for the census geography. Not available for markets (a median cannot be summed).`,
    formula: agg === 'sum' ? `sum(${id}) over cells` : `ACS ${id}`, source: ACS_SRC, freshness: 'census' })),
])

export const METRIC_BY_ID = Object.freeze(Object.fromEntries(METRICS.map((x) => [x.id, x])))

export const UNSUPPORTED = Object.freeze({
  cap_rate: 'No rent roll or NOI evidence exists; a cap rate would be invented.',
  noi: 'No operating statements exist.',
  rent_roll: 'No rent rolls exist.',
  dscr: 'No debt-service or NOI evidence exists.',
  crime: 'No crime data source exists in production.',
  median_age: 'The production ACS cells do not carry age.',
  education: 'The production ACS cells do not carry education.',
  employment: 'The production ACS cells do not carry employment.',
})

export const metricSupports = (metric, { level, asset } = {}) => {
  if (!metric) return { ok: false, reason: 'unknown_metric' }
  if (level && !metric.levels.includes(level)) return { ok: false, reason: `${metric.label} is not available for ${level} geographies` }
  if (asset && asset !== 'all' && !metric.assets.includes(asset)) return { ok: false, reason: `${metric.label} is not defined for this asset class` }
  return { ok: true }
}

/** The registry as the dashboard receives it (stable, JSON-safe). */
export const registryPayload = () => ({ metrics: METRICS, unsupported: UNSUPPORTED, levels: LEVELS })

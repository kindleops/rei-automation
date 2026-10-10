/**
 * ENTITY GRAPH · OVERVIEW FIELD REGISTRY (spec 9 §4.5).
 *
 * Owner ask (2026-10-09): "an overview section where it shows the advanced
 * metrics and the graph and the charts and basically a breakdown of all the
 * fields filtered". Every chart here is a field the filter rail already
 * offers — the registry is GENERATED from getEntityGraphFilterFields
 * ('properties'), the same catalog the rail, the header filters and the
 * campaign builder compile, so:
 *
 *   - a bar's click filter is an ordinary chip in the rail's AST
 *     ({ field_key, operator, value }), resolved by the same resolver;
 *   - a bucket's COUNT is `count(*) FILTER (WHERE <that chip compiled>)`
 *     (numeric bands, date bins, booleans, derived fields, tokens) or an
 *     exact GROUP BY whose key IS the chip value (categorical) — so clicking
 *     a bar produces a cohort of exactly the size the bar shows.
 *
 * Fields the facts work adds to the catalog (facts.<col>: SMS eligibility,
 * pipeline, owner / person / contact / ZIP / company status …) appear here
 * automatically; they are computed only where the property facts relation
 * exists (see entity-graph-overview-service.js).
 *
 * EVERY SCOPE (owner 2026-10-10: "universal across all the tables, in one
 * overview"): properties, owners, people, contacts (phones), buyers and
 * companies (title-holding entities) each get a registry generated from THAT
 * tab's filter catalog, so a bar's chip is that tab's own filter.
 *
 * PRIVACY (never relaxed by a filter):
 *   - protected-class-adjacent fields (age, gender, marital status, language,
 *     …) ARE charted — per the owner and counsel every prospect field is a
 *     live targeting input, and a distribution is descriptive analytics — but
 *     each carries `sensitive: true` (the card shows a marker). They never
 *     feed pricing: nothing here is read by valuation / negotiation, and the
 *     negotiation state gates for age / marital status are untouched;
 *   - names, addresses, phones, emails, parcel / legal identifiers,
 *     coordinates, bodies: coverage only — a value never leaves the server;
 *   - a text field with more than 500 distinct values in the universe is
 *     coverage + distinct count (no bars of 100k addresses).
 */
import { getEntityGraphFilterFields } from './entity-graph-field-filters.js'
import { OVERVIEW_COLUMN_PROFILE } from './entity-graph-overview-profile.js'

export const OVERVIEW_TAB = 'properties'
/**
 * Spec §4.1: categorical bars for fields of ≤ 500 universe values. Fields of
 * 500–5,000 (city, ZIP, zoning, school district…) still chart — the cohort's
 * 500 largest values are counted exactly and the rest is an exact "Everything
 * else"; above 5,000 (addresses, subdivisions, legal text) coverage only.
 */
export const CATEGORICAL_MAX_DISTINCT = 500
export const CATEGORICAL_COVERAGE_ABOVE = 5000
export const CATEGORICAL_TOP = 12

export const OVERVIEW_SECTIONS = Object.freeze([
  { id: 'headline', label: 'Headline' },
  { id: 'outreach', label: 'Outreach & pipeline' },
  { id: 'geography', label: 'Geography' },
  { id: 'property', label: 'Property' },
  { id: 'distress', label: 'Distress & signals' },
  { id: 'value', label: 'Value & equity' },
  { id: 'debt', label: 'Debt, liens & sales' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'company', label: 'Owning company status' },
  { id: 'owner', label: 'Owner' },
  { id: 'people', label: 'People' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'decision', label: 'Decision Engine' },
  { id: 'zip', label: 'ZIP market' },
])
export const OVERVIEW_SECTION_IDS = Object.freeze(OVERVIEW_SECTIONS.map((s) => s.id))

/** The scopes the Overview charts (desk tab keys). */
export const OVERVIEW_TABS = Object.freeze(['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'])

/** Sections per scope (order = page order). */
export const OVERVIEW_SECTIONS_BY_TAB = Object.freeze({
  properties: OVERVIEW_SECTIONS,
  master_owners: Object.freeze([
    { id: 'headline', label: 'Headline' },
    { id: 'profile', label: 'Owner profile' },
    { id: 'portfolio', label: 'Portfolio & value' },
    { id: 'distress', label: 'Portfolio distress' },
    { id: 'scores', label: 'Scores' },
  ]),
  people: Object.freeze([
    { id: 'headline', label: 'Headline' },
    { id: 'demographics', label: 'Demographics' },
    { id: 'wealth', label: 'Income & net asset value' },
    { id: 'matching', label: 'Matching & eligibility' },
    { id: 'reach', label: 'Contact window' },
  ]),
  contact_methods: Object.freeze([
    { id: 'headline', label: 'Headline' },
    { id: 'quality', label: 'Line & activity' },
  ]),
  buyers: Object.freeze([
    { id: 'headline', label: 'Headline' },
    { id: 'activity', label: 'Activity' },
    { id: 'behaviour', label: 'Behaviour' },
    { id: 'assets', label: 'Assets & price' },
    { id: 'geography', label: 'Geography' },
    { id: 'portfolio', label: 'Portfolio & roles' },
    { id: 'identity', label: 'Identity' },
  ]),
  organizations: Object.freeze([
    { id: 'headline', label: 'Headline' },
    { id: 'entity', label: 'Entity class & mailing geography' },
  ]),
})

export const overviewSectionsFor = (tab = OVERVIEW_TAB) => OVERVIEW_SECTIONS_BY_TAB[String(tab || '').toLowerCase()] || null

/** Non-property scopes: catalog category → section; a field-key override wins. */
const SECTION_BY_CATEGORY_BY_TAB = Object.freeze({
  master_owners: { Profile: 'profile', Scores: 'scores', 'Portfolio Financials': 'portfolio', 'Portfolio Distress': 'distress' },
  people: { Demographics: 'demographics', 'Matching & Eligibility': 'matching' },
  contact_methods: { Quality: 'quality' },
  buyers: { Activity: 'activity', Behaviour: 'behaviour', Geography: 'geography', 'Assets & Price': 'assets', 'Portfolio & Roles': 'portfolio', Identity: 'identity' },
  organizations: { Entity: 'entity' },
})
const SECTION_BY_KEY = Object.freeze({
  'prospects.est_household_income': 'wealth',
  'prospects.net_asset_value': 'wealth',
  'prospects.buying_power': 'wealth',
  'prospects.timezone': 'reach',
  'prospects.contact_window': 'reach',
  'prospects.sms_eligible': 'matching',
  'prospects.email_eligible': 'matching',
})

const SECTION_BY_CATEGORY = Object.freeze({
  'Location & Market': 'geography',
  Geography: 'geography',
  'Asset Type & Structure': 'property',
  'Condition & Repair': 'property',
  'Land, Lot & Zoning': 'property',
  'Tax & Assessment': 'property',
  Property: 'property',
  'More property fields': 'property',
  'Identity & IDs': 'property',
  'Property facts': 'property',
  'Distress & Condition': 'distress',
  'Distress & Motivation': 'distress',
  Signals: 'distress',
  Foreclosure: 'distress',
  'Value, Equity & Debt': 'value',
  'Value & Equity': 'value',
  'Value & equity': 'value',
  'Mortgages & Debt': 'debt',
  'Recorded documents & liens': 'debt',
  'Sale History': 'debt',
  'Debt, liens & sales': 'debt',
  'Owner Relationship': 'ownership',
  'Buyer Crossover': 'ownership',
  Ownership: 'ownership',
  'Owner record': 'owner',
  'People / entity': 'people',
  Contacts: 'contacts',
  'Decision Engine': 'decision',
  'ZIP market': 'zip',
  'Outreach & pipeline': 'outreach',
  'Company status': 'company',
  'Owning company': 'company',
})

/**
 * The six charts of the collapsed band (spec §4.1: one row of six). Keys are
 * catalog field keys; a key the catalog does not offer is skipped.
 */
export const OVERVIEW_PINNED = Object.freeze([
  'properties.market',
  'properties.property_type',
  'properties.known_equity_percent',
  'properties.estimated_value',
  'properties.flags',
  'records.years_owned',
])
export const OVERVIEW_PINNED_BY_TAB = Object.freeze({
  properties: OVERVIEW_PINNED,
  master_owners: Object.freeze(['master_owners.owner_type_guess', 'master_owners.priority_tier', 'master_owners.property_count', 'master_owners.portfolio_total_value', 'master_owners.portfolio_total_equity', 'master_owners.tax_delinquent_count']),
  people: Object.freeze(['prospects.age_years', 'prospects.est_household_income', 'prospects.net_asset_value', 'prospects.language_preference', 'prospects.occupation_group', 'prospects.sms_eligible']),
  contact_methods: Object.freeze(['phones.phone_type', 'phones.activity_status', 'phones.usage_12_months', 'phones.usage_2_months', 'phones.phone_owner']),
  buyers: Object.freeze(['buyers.activity_status', 'buyers.archetype', 'buyers.dominant_family', 'buyers.acquisition_count', 'buyers.price_p50', 'buyers.entity_type']),
  organizations: Object.freeze(['organizations.entity_class', 'organizations.owner_address_state', 'organizations.has_master_owner', 'organizations.owner_address_city']),
})
export const overviewPinnedFor = (tab = OVERVIEW_TAB) => OVERVIEW_PINNED_BY_TAB[String(tab || '').toLowerCase()] || []

/**
 * Text columns whose values are money RANGES ("$35,000-$39,999", "$250,000 or
 * More"): charted as ordered currency bands. A band's chip is `is_any_of` the
 * exact stored values whose lower bound falls in it — the rail's own text
 * operator, so the bar's count IS the chip's cohort.
 */
export const BANDED_TEXT_FIELDS = Object.freeze({
  'prospects.est_household_income': { edges: [25000, 50000, 75000, 100000, 150000, 250000], format: 'money' },
  'prospects.net_asset_value': { edges: [25000, 100000, 250000, 500000, 1000000, 2000000], format: 'money' },
})
/** The lower bound of a money-range text ("$35,000-$39,999" → 35000, "$250,000 or More" → 250000, "0" → 0). */
export function moneyRangeFloor(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)/.exec(t)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Derived categorical fields: each value is its own chip, counted by that chip's predicate. */
export const DERIVED_CATEGORICAL_VALUES = Object.freeze({
  'organizations.entity_class': Object.freeze(['LLC/Corporation', 'Trust', 'Estate', 'Other']),
})

/**
 * The owning-company registry fields the facts read model carries
 * (seller.company via property_entity_contact_v1, entity-graph-company-status.js).
 * Listed so the section is stable before the facts fields land in the catalog:
 * a field the catalog does not offer yet renders "not in the field catalog yet".
 */
export const OVERVIEW_COMPANY_FIELDS = Object.freeze([
  { key: 'facts.company_status_class', label: 'Owning company · registry status', kind: 'categorical' },
  { key: 'facts.company_status_raw', label: 'Owning company · status as recorded', kind: 'categorical' },
  { key: 'facts.company_inactive', label: 'Owning company · inactive flag', kind: 'boolean' },
  { key: 'facts.company_dissolution_date', label: 'Owning company · dissolved on', kind: 'date' },
  { key: 'facts.company_incorporation_date', label: 'Owning company · incorporated on', kind: 'date' },
  { key: 'facts.company_jurisdiction', label: 'Owning company · jurisdiction', kind: 'categorical' },
])

/* ── privacy ──────────────────────────────────────────────────────────────── */

const PROTECTED = /(^|_)(gender|sex|marital|age|race|ethnic|ethnicity|religion|religious|national|origin|disability|disabled|familial|language|mob)(_|$)|language_preference|best_language/i
const IDENTIFIER = /(^|_)(phone|phones|e164|email|emails|apn|parcel|legal_description|latitude|longitude|hash|url|image|body|bodies)(_|$)|_id$|^id$|_key$|_key_full$|address_full$|address2$|^property_address$|owner_address|primary_owner_address|(^|_)(owner|seller|buyer|person|contact|entity|company|display|first|last|full)(_\d)?_?name$|^owner_\d_name$|^contact_person$|^contact_matching$|^owner_name$|^owner_display_name$/i

export function isProtectedField(field) {
  return PROTECTED.test(String(field?.source_column || '')) || PROTECTED.test(String(field?.key || '').split('.').pop())
}
const NOT_IDENTIFIER = /_(count|counts|activity|type|status|score|share|rows|eligible)$|^contact_phone_owner$|^phone_owner$|owner_address_(state|city|zip)$/
export function isIdentifierField(field) {
  // a derived field charts its computed class / yes-no, never the column it reads
  if (field?.derived) return false
  const c = String(field?.source_column || '')
  return IDENTIFIER.test(c) && !NOT_IDENTIFIER.test(c)
}

/* ── kinds & formats ──────────────────────────────────────────────────────── */

const MONEY = /(value|price|amount|balance|payment|tax_amt|loan_amt|offer|fee|equity_amount|equity_known_amount|_due)(_|$)|portfolio_total_(value|equity|loan|tax)|median_price|valuation_(low|mid|high)/
const PERCENT = /(percent|_pct|_rate|_share)(_|$)|first_rate|max_rate|cap_rate/
const SQFT = /square_feet|sqft/
const YEAR = /(^|_)year(_built)?$|year_built|_year$/

export function formatOf(field) {
  if (field?.format) return field.format === 'money' ? 'money' : field.format
  const c = String(field?.source_column || '')
  if (PERCENT.test(c)) return 'percent'
  if (MONEY.test(c)) return 'money'
  if (SQFT.test(c)) return 'sqft'
  if (YEAR.test(c)) return 'year'
  return 'number'
}

/** The chart a catalog field gets, before cardinality. */
export function baseKindOf(field) {
  const t = field?.type
  if (t === 'flags') return 'tokens'
  if (t === 'array') return 'array'
  if (t === 'boolean') return field.derived ? 'derived_boolean' : 'boolean'
  if (t === 'number') return field.derived ? 'derived_number' : 'numeric'
  if (t === 'date') return 'date'
  return 'categorical'
}

/* ── bins (fixed edges: a bin means the same range in every cohort) ─────── */

const fmtMoney = (n) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `$${+(a / 1e6).toFixed(a % 1e6 ? 1 : 0)}M` : a >= 1e3 ? `$${+(a / 1e3).toFixed(a % 1e3 ? 1 : 0)}K` : `$${+a.toFixed(2)}`
  return n < 0 ? `−${s}` : s
}
const fmtNum = (n) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(0)}K` : n.toLocaleString('en-US', { maximumFractionDigits: 2 }))
export function formatEdge(n, format) {
  if (format === 'money') return fmtMoney(n)
  if (format === 'share') return `${+(n * 100).toFixed(0)}%`
  if (format === 'percent') return `${+n.toFixed(2)}%`
  if (format === 'year') return String(Math.trunc(n))
  if (format === 'sqft') return `${fmtNum(n)} sqft`
  return fmtNum(n)
}

/**
 * Bands as inclusive [lo, hi] click filters over fixed edges. `integer`
 * columns close a band one whole unit under the next edge; others a hair
 * under (money to the cent). Returns [{ key, label, lo, hi }] with lo/hi null
 * for open ends.
 */
export function bandsFromEdges(edges, { format = 'number', integer = false, under = true, over = true } = {}) {
  const eps = integer ? 1 : format === 'money' ? 0.01 : 0.0001
  const out = []
  const f = (n) => formatEdge(n, format)
  // a first edge of 1 on a money / count column means "none": the band below it reads ≤ 0, not "Under $1"
  if (under) out.push({ key: `lt_${edges[0]}`, label: edges[0] === 1 ? `≤ ${f(0)}` : `Under ${f(edges[0])}`, lo: null, hi: +(edges[0] - eps).toFixed(6) })
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i]
    const hi = +(edges[i + 1] - eps).toFixed(6)
    const label = integer && hi === lo ? f(lo) : integer ? `${f(lo)}–${f(hi)}` : `${f(lo)}–${f(edges[i + 1])}`
    out.push({ key: `${lo}_${edges[i + 1]}`, label, lo, hi })
  }
  if (over) out.push({ key: `gte_${edges[edges.length - 1]}`, label: `${f(edges[edges.length - 1])}+`, lo: edges[edges.length - 1], hi: null })
  return out
}

const CURATED = Object.freeze({
  estimated_value: { edges: [50000, 100000, 150000, 250000, 350000, 500000, 750000, 1000000, 2000000] },
  assd_total_value: { edges: [50000, 100000, 150000, 250000, 350000, 500000, 1000000] },
  calculated_total_value: { edges: [50000, 100000, 150000, 250000, 350000, 500000, 1000000] },
  sale_price: { edges: [1, 50000, 100000, 200000, 300000, 500000, 1000000] },
  rec_last_sale_price: { edges: [1, 50000, 100000, 200000, 300000, 500000, 1000000] },
  equity_amount: { edges: [0, 25000, 50000, 100000, 200000, 350000, 500000, 1000000] },
  equity_known_amount: { edges: [0, 25000, 50000, 100000, 200000, 350000, 500000, 1000000] },
  total_loan_balance: { edges: [1, 50000, 100000, 200000, 300000, 500000, 1000000] },
  total_loan_amt: { edges: [1, 50000, 100000, 200000, 300000, 500000, 1000000] },
  rec_mortgage_balance: { edges: [1, 50000, 100000, 200000, 300000, 500000, 1000000] },
  equity_percent: { edges: [0, 20, 40, 60, 80, 100], format: 'percent' },
  known_equity_percent: { edges: [0, 20, 40, 60, 80], format: 'percent' },
  equity_known_pct: { edges: [0, 20, 40, 60, 80], format: 'percent' },
  rec_first_rate: { edges: [3, 4, 5, 6, 7, 8], format: 'percent' },
  rec_max_rate: { edges: [3, 4, 5, 6, 7, 8], format: 'percent' },
  year_built: { edges: [1900, 1940, 1960, 1980, 2000, 2010, 2020], format: 'year', integer: true },
  effective_year_built: { edges: [1900, 1940, 1960, 1980, 2000, 2010, 2020], format: 'year', integer: true },
  units_count: { edges: [1, 2, 3, 5, 10, 50], integer: true },
  // beds / baths: one bar per whole number (0, 1, 2 … 6+); a 2.5-bath home is in "2"
  total_bedrooms: { edges: [1, 2, 3, 4, 5, 6], unit: true },
  total_baths: { edges: [1, 2, 3, 4, 5, 6], unit: true },
  building_square_feet: { edges: [500, 800, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 10000], format: 'sqft' },
  // people: the owner's age buckets (18–34 · 35–49 · 50–64 · 65–74 · 75+); unknown is its own bar
  age_years: { edges: [18, 35, 50, 65, 75], integer: true },
  // owners
  portfolio_total_value: { edges: [50000, 100000, 250000, 500000, 1000000, 2500000, 5000000], format: 'money' },
  portfolio_total_equity: { edges: [0, 50000, 100000, 250000, 500000, 1000000, 2500000], format: 'money' },
  portfolio_total_loan_balance: { edges: [1, 50000, 100000, 250000, 500000, 1000000, 2500000], format: 'money' },
  portfolio_total_loan_payment: { edges: [1, 500, 1000, 2500, 5000, 10000], format: 'money' },
  portfolio_total_tax_amount: { edges: [1, 1000, 2500, 5000, 10000, 25000], format: 'money' },
  portfolio_total_units: { edges: [1, 2, 3, 5, 10, 50], integer: true },
  oldest_tax_delinquent_year: { edges: [2010, 2015, 2018, 2020, 2022, 2024], format: 'year', integer: true },
  max_ownership_years: { edges: [3, 6, 11, 21, 31], integer: true },
  // buyers
  days_since_last: { edges: [30, 90, 180, 365, 730], integer: true },
  trailing_90d: { edges: [1, 2, 3, 5, 10], integer: true },
  trailing_180d: { edges: [1, 2, 3, 5, 10], integer: true },
  trailing_365d: { edges: [1, 2, 3, 5, 10, 25], integer: true },
  acquisitions_per_year: { edges: [1, 2, 5, 10, 25] },
  cash_share: { edges: [0.25, 0.5, 0.75, 1], format: 'share' },
  confidence: { edges: [0.5, 0.7, 0.9], format: 'share' },
  price_p25: { edges: [50000, 100000, 200000, 300000, 500000, 1000000], format: 'money' },
  price_p50: { edges: [50000, 100000, 200000, 300000, 500000, 1000000], format: 'money' },
  price_p75: { edges: [50000, 100000, 200000, 300000, 500000, 1000000], format: 'money' },
  ownership_years: { edges: [3, 6, 11, 21, 31] },
  rec_years_owned: { edges: [3, 6, 11, 21, 31], integer: true },
  lot_acreage: { edges: [0.1, 0.25, 0.5, 1, 5] },
  tax_delinquent_year: { edges: [2015, 2018, 2020, 2022, 2024], format: 'year', integer: true },
  person_age: null, // protected (never reached: excluded upstream)
})
const COUNT_COLUMNS = /(_count|_rows|_phones|_purchases|_acquisitions|^campaign_count|^entity_count|^email_count|num_of_fireplaces|^stories)$/
const SCORE_COLUMNS = /(_score|^scores_aos_score|^scores_confidence|valuation_confidence|liquidity_score|buyer_demand_score)$/

function niceStep(raw) {
  if (!(raw > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

/** Edges for a numeric column: curated, else count / score conventions, else the universe profile (p02..p98, nice steps). */
/**
 * One bar per whole number: 0 · 1 · 2 … top+. An integer column's bar is
 * exactly that number ([3, 3]); a fractional column's bar holds the half
 * steps too (2.5 baths is in "2": [2, 2.99]).
 */
export function unitBands(edges, { integer = false } = {}) {
  const under = integer ? 1 : 0.01
  const out = [{ key: 'lt_1', label: '0', lo: null, hi: +(edges[0] - under).toFixed(6) }]
  for (let i = 0; i < edges.length - 1; i += 1) out.push({ key: `${edges[i]}_${edges[i + 1]}`, label: String(edges[i]), lo: edges[i], hi: +(edges[i + 1] - under).toFixed(6) })
  out.push({ key: `gte_${edges[edges.length - 1]}`, label: `${edges[edges.length - 1]}+`, lo: edges[edges.length - 1], hi: null })
  return out
}

export function numericBinsFor(column, { format = 'number', integer = false, profile = OVERVIEW_COLUMN_PROFILE[column], range = null } = {}) {
  const curated = CURATED[column]
  if (curated?.unit) return unitBands(curated.edges, { integer })
  if (curated) return bandsFromEdges(curated.edges, { format: curated.format || format, integer: curated.integer ?? integer })
  if (COUNT_COLUMNS.test(column)) return [
    { key: '0', label: '0', lo: 0, hi: 0 }, { key: '1', label: '1', lo: 1, hi: 1 }, { key: '2', label: '2', lo: 2, hi: 2 },
    { key: '3', label: '3', lo: 3, hi: 3 }, { key: '4_5', label: '4–5', lo: 4, hi: 5 }, { key: 'gte_6', label: '6+', lo: 6, hi: null },
  ]
  const src = range || (profile && Number.isFinite(profile.p02) && Number.isFinite(profile.p98) ? { lo: profile.p02, hi: profile.p98, integer: profile.integer } : null)
  if (SCORE_COLUMNS.test(column) && (!src || (src.lo >= 0 && src.hi <= 100))) return bandsFromEdges([20, 40, 60, 80], { format, integer: false, under: true, over: true })
  if (!src) return null
  let { lo, hi } = src
  if (lo === hi) hi = lo + 1
  const isInt = integer || Boolean(src.integer)
  const step = isInt ? Math.max(1, Math.ceil(niceStep((hi - lo) / 7))) : niceStep((hi - lo) / 7)
  const start = Math.floor(lo / step) * step
  const edges = []
  for (let e = start; e <= hi + step / 2 && edges.length < 10; e += step) edges.push(+e.toFixed(6))
  if (edges.length < 2) edges.push(+(start + step).toFixed(6))
  return bandsFromEdges(edges, { format, integer: isInt })
}

/* ── the registry ─────────────────────────────────────────────────────────── */

function sectionOf(field, tab = OVERVIEW_TAB) {
  if (tab !== OVERVIEW_TAB) {
    const sections = overviewSectionsFor(tab) || []
    return SECTION_BY_KEY[field.key] || SECTION_BY_CATEGORY_BY_TAB[tab]?.[field.category] || sections.find((x) => x.id !== 'headline')?.id || 'other'
  }
  const col = String(field.source_column || '')
  if (/^company_/.test(col)) return 'company'
  return SECTION_BY_CATEGORY[field.category] || 'property'
}

/** One Overview field per catalog field (deduplicated by column + kind), with privacy and cardinality applied. */
export function buildOverviewRegistry(tab = OVERVIEW_TAB, { fields = getEntityGraphFilterFields(tab), profile = tab === OVERVIEW_TAB ? OVERVIEW_COLUMN_PROFILE : {} } = {}) {
  const seen = new Set()
  const out = []
  const pinned = overviewPinnedFor(tab)
  for (const field of fields) {
    if (!field?.key || !field.source_column) continue
    // the campaign scope chip is a cohort, not a distribution
    if (field.scope_filter) continue
    let kind = baseKindOf(field)
    if (BANDED_TEXT_FIELDS[field.key]) kind = 'banded_text'
    if (DERIVED_CATEGORICAL_VALUES[field.key]) kind = 'derived_categorical'
    const dedupe = `${field.source_column}|${kind}|${field.derived || ''}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const p = profile[field.source_column] || null
    const computedFact = Boolean(field.computed_fact)
    let privacy = 'values'
    if (isIdentifierField(field)) { privacy = 'coverage_only'; kind = 'coverage' }
    else if (kind === 'categorical' && p && typeof p.distinct === 'number' && p.distinct > CATEGORICAL_COVERAGE_ABOVE) kind = 'coverage'
    // properties: a text column with no universe profile could be 100k addresses; other scopes' catalogs are
    // demographic / code fields, charted top-N with the exact "Everything else"
    else if (kind === 'categorical' && field.type === 'text' && !p && !computedFact && tab === OVERVIEW_TAB) kind = 'coverage'
    const banded = BANDED_TEXT_FIELDS[field.key]
    const format = banded ? banded.format : formatOf(field)
    const entry = {
      key: field.key,
      label: field.label,
      section: sectionOf(field, tab),
      kind,
      tab,
      sensitive: isProtectedField(field),
      column: field.source_column,
      format,
      privacy,
      operators: (field.operators || []).map((o) => o.key),
      derived: field.derived || null,
      computedFact,
      tokenSeparator: field.token_separator || (field.type === 'flags' ? '; ' : null),
      emptySource: Boolean(field.data_coverage === 'empty' || (p && p.known === 0)),
      universeDistinct: p?.distinct ?? null,
      pinned: pinned.includes(field.key),
      caution: field.caution || null,
      ...(banded ? { bandEdges: banded.edges } : {}),
      ...(DERIVED_CATEGORICAL_VALUES[field.key] ? { derivedValues: DERIVED_CATEGORICAL_VALUES[field.key] } : {}),
    }
    out.push(entry)
  }
  return out
}

const registryMemo = new Map()
export function overviewRegistry(tab = OVERVIEW_TAB) {
  const t = String(tab || OVERVIEW_TAB).toLowerCase()
  if (!registryMemo.has(t)) registryMemo.set(t, buildOverviewRegistry(t))
  return registryMemo.get(t)
}

/** GET …/overview/catalog — what each section charts (no counts). */
export function getOverviewCatalog(tab = OVERVIEW_TAB) {
  const t = String(tab || '').toLowerCase()
  const sectionsMeta = overviewSectionsFor(t)
  if (!sectionsMeta) return { tab, supported: false, sections: [] }
  const registry = overviewRegistry(t)
  const present = new Set(registry.map((f) => f.key))
  return {
    tab: t,
    supported: true,
    pinned: overviewPinnedFor(t).filter((k) => present.has(k)),
    sections: sectionsMeta.map((s) => ({
      id: s.id,
      label: s.label,
      fields: s.id === 'company'
        ? OVERVIEW_COMPANY_FIELDS.map((c) => {
          const f = registry.find((x) => x.key === c.key)
          return f ? publicField(f) : { key: c.key, label: c.label, kind: c.kind, section: 'company', inCatalog: false, computedFact: true }
        })
        : registry.filter((f) => f.section === s.id).map(publicField),
    })),
  }
}

function publicField(f) {
  return { key: f.key, label: f.label, section: f.section, kind: f.kind, format: f.format, privacy: f.privacy, sensitive: Boolean(f.sensitive), computedFact: f.computedFact, emptySource: f.emptySource, pinned: f.pinned, inCatalog: true, ...(f.caution ? { caution: f.caution } : {}) }
}

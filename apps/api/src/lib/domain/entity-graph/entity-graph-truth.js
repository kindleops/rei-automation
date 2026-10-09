/**
 * ENTITY GRAPH · TWO SHARED TRUTH RULES (owner, 2026-10-07)
 *
 * 1. EQUITY IS KNOWN ONLY WITH EVIDENCE (rule equity_known_v1, the same rule
 *    the campaign ranking applies). A blank OR zero loan balance is not
 *    evidence of no debt — the graph stores a missing mortgage as 0, and the
 *    vendor equity_percent then reads 100%: 96,910 of 176,610 properties are
 *    "100%" with no loan on file (measured 2026-10-07; Rocky Mount, NC rows).
 *    Equity is KNOWN only when
 *      a. total_loan_balance > 0 and estimated_value > 0 → (value − loan) / value
 *      b. no loan on file AND the vendor "Free And Clear" flag AND value > 0
 *         → free & clear (100%, provenance vendor_flag)
 *    A vendor "High Equity" / "Low Equity" flag alone gives a CLASS, no %.
 *    Everything else is UNKNOWN — never 100%, never 0.
 *
 * 2. TEST RECORDS ARE NOT THE UNIVERSE. Internal canary fixtures carry
 *    property_id "canaryprop_…" (7 rows: "0 Internal Canary Way, Irving, TX",
 *    flag INTERNAL_CANARY_SYNTHETIC_SUBJECT) and owner "canaryowner_…". One
 *    predicate excludes them from browse, search, facets, counts and KPIs;
 *    `include_test=1` brings them back for QA.
 */

export const TEST_PROPERTY_ID_PATTERN = 'canaryprop%'
export const TEST_OWNER_ID_PATTERN = 'canaryowner%'

export function isTestPropertyId(id) {
  return /^canaryprop/i.test(String(id ?? ''))
}

/** Properties query (any table/view keyed by property_id): drop test fixtures. */
export function excludeTestProperties(query, { includeTest = false } = {}) {
  return includeTest ? query : query.not('property_id', 'like', TEST_PROPERTY_ID_PATTERN)
}

/** Master owners query: drop test fixture owners. */
export function excludeTestOwners(query, { includeTest = false } = {}) {
  return includeTest ? query : query.not('master_owner_id', 'like', TEST_OWNER_ID_PATTERN)
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const tokens = (text) => new Set(String(text ?? '').split(/[;,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean))

export const EQUITY_HIGH_THRESHOLD = 40

/**
 * @returns {{ known: boolean, percent: number|null, amount: number|null, class: 'high'|'low'|'unknown', rule: string }}
 */
export function equityTruth(row = {}) {
  const value = num(row.estimated_value)
  const loan = num(row.total_loan_balance)
  const flags = tokens(row.property_flags_text)
  if (value !== null && value > 0 && loan !== null && loan > 0) {
    const percent = Math.max(-100, Math.min(100, Math.round(((value - loan) / value) * 1000) / 10))
    return { known: true, percent, amount: value - loan, class: percent >= EQUITY_HIGH_THRESHOLD ? 'high' : 'low', rule: 'loan_and_value' }
  }
  if (value !== null && value > 0 && (loan === null || loan === 0) && flags.has('free and clear')) {
    return { known: true, percent: 100, amount: value, class: 'high', rule: 'free_and_clear' }
  }
  /**
   * c. (Entity Graph rows only — v_entity_graph_properties carries rec_*): the
   *    county record says it. A recorded open-mortgage balance makes equity
   *    known; recorded documents captured with NO open mortgage mean equity
   *    is the whole value. Measured 2026-10-08: 327 of 356 sampled "High
   *    Equity (flag)" properties have recorded documents with 0 open
   *    mortgages — they read "High (flag)" while the record answered.
   */
  const recBalance = num(row.rec_mortgage_balance)
  const recCount = num(row.rec_mortgage_count)
  if (value !== null && value > 0 && (loan === null || loan === 0) && recBalance !== null && recBalance > 0) {
    const percent = Math.max(-100, Math.min(100, Math.round(((value - recBalance) / value) * 1000) / 10))
    return { known: true, percent, amount: value - recBalance, class: percent >= EQUITY_HIGH_THRESHOLD ? 'high' : 'low', rule: 'recorded_mortgage_balance' }
  }
  if (value !== null && value > 0 && (loan === null || loan === 0) && recCount === 0) {
    return { known: true, percent: 100, amount: value, class: 'high', rule: 'no_recorded_mortgage' }
  }
  if (flags.has('high equity')) return { known: false, percent: null, amount: null, class: 'high', rule: 'vendor_high_equity_flag' }
  if (flags.has('low equity')) return { known: false, percent: null, amount: null, class: 'low', rule: 'vendor_low_equity_flag' }
  return { known: false, percent: null, amount: null, class: 'unknown', rule: 'unknown' }
}

/**
 * 3. THE VENDOR REPAIR ESTIMATE IS NOT AN ENTITY GRAPH FIELD (owner,
 *    2026-10-08: "The repair est for the entity graph is completely fucked…
 *    I told you this"; valuation lanes, BINDING 2026-10-07: SFR = LLC
 *    investor cluster −13%, NO repairs; MLS ARV is a separate lane — repairs
 *    only there; MF5+ per door).
 *
 *    What the field is (measured 2026-10-08, 5% sample, 8,941 estimates):
 *    estimated_repair_cost = a flat vendor tier ($15 / $35 / $75 per sqft —
 *    p1..p99 of repair ÷ building sqft is exactly 35, 35, 35, 35, 35, 75, 75)
 *    × the record's building_square_feet. It says nothing about the property
 *    beyond its sqft and a tier, and where the sqft is wrong it is absurd
 *    ($13M on a 392-unit $111M property; $76M on a $3.4M one).
 *
 *    So it is never shown by default — not in the grid, hover card, network,
 *    exports, filters or sort. It survives ONLY as an "MLS ARV lane · vendor
 *    reference" detail labelled "vendor estimate · unverified", and only for
 *    the lanes where a repair figure means anything and when it passes
 *    plausibility bounds taken from the data:
 *      lane         Single Family (units ≤ 1) or Multi-Family 2–4 units —
 *                   never MF5+ (per door), commercial or land
 *      sqft / unit  400 – 4,000  (SFR p1 578 · p99 3,833; 2–4 p1 396 · p99 2,679)
 *      $ / sqft     ≤ $75        (the vendor's top tier — more is arithmetic error)
 *      $ / unit     ≤ $150,000   (SFR p99 $183K is the $75 tier on a wrong sqft)
 *      share        ≤ 50% of the estimated value (SFR median 18%)
 *    ~93% of SFR and ~93% of 2–4 estimates pass (5% sample); MF5+ is never applicable.
 */
export const REPAIR_LANE_REFERENCE_LABEL = 'vendor estimate · unverified'
export const REPAIR_BOUNDS = Object.freeze({ minSqftPerUnit: 400, maxSqftPerUnit: 4000, maxPerSqft: 75, maxPerUnit: 150000, maxShareOfValue: 0.5 })

/** 'sfr' | 'mf2_4' | null — the only lanes a vendor repair reference may appear in. */
export function repairReferenceLane(row = {}) {
  const type = String(row.property_type ?? '').trim().toLowerCase()
  const units = num(row.units_count)
  if (type === 'single family' && (units === null || units <= 1)) return 'sfr'
  if ((type === 'multi-family' || type === 'multifamily' || type === 'multi family') && units !== null && units >= 2 && units <= 4) return 'mf2_4'
  return null
}

/**
 * @returns {{ value: number|null, status: 'unknown'|'not_applicable'|'unreliable'|'vendor_reference', reason: string|null, lane: string|null, label: string|null }}
 */
export function repairTruth(row = {}) {
  const repair = num(row.estimated_repair_cost)
  const lane = repairReferenceLane(row)
  const out = (status, reason = null, value = null) => ({ value, status, reason, lane, label: value === null ? null : REPAIR_LANE_REFERENCE_LABEL })
  if (repair === null || repair <= 0) return out('unknown')
  if (!lane) return out('not_applicable', 'lane_without_repairs')
  const value = num(row.estimated_value)
  const sqft = num(row.building_square_feet)
  const units = lane === 'sfr' ? 1 : num(row.units_count)
  if (value === null || value <= 0) return out('unreliable', 'no_value_to_check_against')
  if (sqft === null || sqft <= 0) return out('unreliable', 'no_building_sqft')
  const perUnitSqft = sqft / units
  if (perUnitSqft < REPAIR_BOUNDS.minSqftPerUnit || perUnitSqft > REPAIR_BOUNDS.maxSqftPerUnit) return out('unreliable', 'building_sqft_implausible')
  if (repair / sqft > REPAIR_BOUNDS.maxPerSqft) return out('unreliable', 'rate_above_vendor_tiers')
  if (repair / units > REPAIR_BOUNDS.maxPerUnit) return out('unreliable', 'per_unit_implausible')
  if (repair > value * REPAIR_BOUNDS.maxShareOfValue) return out('unreliable', 'exceeds_share_of_value')
  return out('vendor_reference', null, repair)
}

/**
 * The vendor repair figure never travels as a property field: both raw
 * columns are removed from a row, and a plausible SFR / 2–4 figure moves to
 * `mls_arv_lane_reference` (label "vendor estimate · unverified").
 */
export function withRepairTruth(row) {
  if (!row || typeof row !== 'object') return row
  if (!('estimated_repair_cost' in row) && !('estimated_repair_cost_per_sqft' in row)) return row
  const t = repairTruth(row)
  const { estimated_repair_cost: _r, estimated_repair_cost_per_sqft: _rate, ...rest } = row
  return t.value === null ? rest : { ...rest, mls_arv_lane_reference: { vendor_repair_estimate: t.value, lane: t.lane, label: t.label } }
}

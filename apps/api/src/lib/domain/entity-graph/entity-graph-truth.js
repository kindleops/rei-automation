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
 * 3. A REPAIR ESTIMATE IS SHOWN ONLY WHEN IT IS PLAUSIBLE (owner, 2026-10-08:
 *    "$71M on a $3M property").
 *
 *    ROOT CAUSE: the vendor's estimated_repair_cost is a flat per-sqft rate
 *    (estimated_repair_cost_per_sqft, e.g. $35 for "Structural") × the
 *    record's building_square_feet. On large / multi-parcel records that sqft
 *    is wrong (an 18-unit building recorded at 2,184,392 sqft → $76.5M), so
 *    the product is absurd. Measured 2026-10-08: 1,909 properties carry a
 *    repair estimate larger than their whole estimated value.
 *
 *    The estimate is UNRELIABLE (withheld, with the reason) when the value is
 *    unknown, when it exceeds 60% of the value, or when the building sqft per
 *    unit is implausible (> 6,000 sqft/unit). Valuation lanes: a repair figure
 *    belongs only to the MLS-ARV lane — never the SFR investor-cluster lane —
 *    so Entity Graph labels it as a vendor reference, never as a valuation input.
 */
export const REPAIR_MAX_SHARE_OF_VALUE = 0.6
export const REPAIR_MAX_SQFT_PER_UNIT = 6000

export function repairTruth(row = {}) {
  const repair = num(row.estimated_repair_cost)
  if (repair === null || repair <= 0) return { value: null, status: 'unknown', reason: null }
  const value = num(row.estimated_value)
  const sqft = num(row.building_square_feet)
  const units = Math.max(1, num(row.units_count) || 1)
  if (value === null || value <= 0) return { value: null, status: 'unreliable', reason: 'no_value_to_check_against' }
  if (sqft !== null && sqft / units > REPAIR_MAX_SQFT_PER_UNIT) return { value: null, status: 'unreliable', reason: 'building_sqft_implausible' }
  if (repair > value * REPAIR_MAX_SHARE_OF_VALUE) return { value: null, status: 'unreliable', reason: 'exceeds_share_of_value' }
  return { value: repair, status: 'vendor_estimate', reason: null }
}

/** Replace a row's raw repair estimate with the checked one (+ status/reason columns). */
export function withRepairTruth(row) {
  if (!row || typeof row !== 'object' || !('estimated_repair_cost' in row)) return row
  const t = repairTruth(row)
  return { ...row, estimated_repair_cost: t.value, estimated_repair_cost_status: t.status, estimated_repair_cost_reason: t.reason }
}

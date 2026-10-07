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
  if (flags.has('high equity')) return { known: false, percent: null, amount: null, class: 'high', rule: 'vendor_high_equity_flag' }
  if (flags.has('low equity')) return { known: false, percent: null, amount: null, class: 'low', rule: 'vendor_low_equity_flag' }
  return { known: false, percent: null, amount: null, class: 'unknown', rule: 'unknown' }
}

// LeadCommand Global AI Agent — cost display contracts (S1).
//
// Pure ESM, no imports. Source of truth: global-ai-agent-architecture.md §5.8
// and entity-graph-deep-research-design.md §5, plus the owner-approved 10-08
// amendment + O6. The authoritative caps live in server config
// (lib/agent/budget/budget-config.js) and are enforced server-side; this file
// only describes what the UI receives and the default display values.
//
// UI rules:
//  * Show the estimate BEFORE execution and the actual AFTER — separately,
//    never collapsed into one number. An estimate is never "the cost".
//  * Estimates are labelled by basis: measured p50–p90, worst case (no
//    history), or structural zero (Quick Scan).
//  * Caps are ceilings, not targets. An operator may lower a cap per run,
//    never raise it above config.
//  * `cost_not_precisely_bounded` must be visible in the header, report and
//    brief footer when set.
//  * While models are disabled (S1), every billable estimate shows
//    `models_enabled: false` and the run cannot start billable work.

/** @typedef {'measured_p50_p90'|'worst_case'|'structural_zero'} EstimateBasis */
export const ESTIMATE_BASES = Object.freeze(['measured_p50_p90', 'worst_case', 'structural_zero'])

export const ESTIMATE_BASIS_LABELS = Object.freeze({
  measured_p50_p90: 'From measured p50–p90 of settled runs',
  worst_case: 'No measured history yet: worst case',
  structural_zero: 'Quick Scan: no billable operations ($0)',
})

/** @typedef {'model'|'web_search'|'paid_lookup'|'provider_fee'} BillableOpType */
export const BILLABLE_OP_TYPES = Object.freeze(['model', 'web_search', 'paid_lookup', 'provider_fee'])

/** Cap keys in evaluation order (§5.8 / DR §5). */
export const CAP_KEYS = Object.freeze([
  'per_op',
  'per_response',
  'per_property',
  'per_conversation_task',
  'per_background_task',
  'per_batch',
  'non_research_day',
  'non_research_month',
  'org_day',
  'org_month',
])

export const CAP_LABELS = Object.freeze({
  per_op: 'Per operation',
  per_response: 'Per model response',
  per_property: 'Per property',
  per_conversation_task: 'Per conversation task',
  per_background_task: 'Per background task',
  per_batch: 'Per batch',
  non_research_day: 'Non-research AI today',
  non_research_month: 'Non-research AI this month',
  org_day: 'All AI today',
  org_month: 'All AI this month',
})

/**
 * Owner-approved default caps (USD), 10-08. DISPLAY DEFAULTS ONLY — the server
 * reads its own config and never trusts a client value.
 */
export const DEFAULT_CAPS_USD = Object.freeze({
  research: Object.freeze({
    per_property: Object.freeze({ quick: 0, deep: 0.75, diligence: 2.0 }),
    per_batch: 25,
    max_queued_per_batch: 50,
    concurrency: 2,
    initial_test_batch: Object.freeze({ min: 5, max: 10 }),
  }),
  non_research: Object.freeze({
    per_response: 0.05,
    per_conversation_task: 0.5,
    per_background_task: 1.0,
    per_day: 15,
    per_month: 60,
  }),
  org: Object.freeze({ per_day: 50, per_month: 200 }),
  per_operator_day: null, // none until named-user identity exists (O6)
  opus_enabled: false,
})

/**
 * @typedef {Object} CostEstimate
 * @property {number} low_usd
 * @property {number} high_usd
 * @property {EstimateBasis} basis
 * @property {string} label               e.g. 'No measured history yet: worst case $7.50 = 10 × $0.75 cap'
 */

/**
 * @typedef {Object} CostCapRow
 * @property {string} cap_key             one of CAP_KEYS
 * @property {string} label
 * @property {number} limit_usd
 * @property {number} committed_usd       settled + open reserves + unbounded allowances
 * @property {number} remaining_usd
 * @property {boolean} binding            true for the cap that bound / would bind first
 */

/**
 * Cost display block (run header, batch panel, brief footer).
 * @typedef {Object} CostDisplay
 * @property {'USD'} currency
 * @property {CostEstimate|null} estimate              shown before execution
 * @property {{ settled_usd: number, open_reserve_usd: number, pending_late_usd: number,
 *              by_provider: Array<{provider: string, model: string|null, usd: number}>,
 *              by_op_type: Array<{op_type: BillableOpType, usd: number}> }} actual   shown after
 * @property {CostCapRow[]} caps
 * @property {{ cost_not_precisely_bounded: boolean, budget_stopped: boolean, stopped_cap: string|null }} flags
 * @property {boolean} models_enabled               false in S1 (gateway refuses all calls)
 * @property {boolean} external_hold                owner hold (agent_external_hold)
 */

/** Format USD for display: pennies precision under $1, cents otherwise. */
export function formatUsd(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0.00'
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** An empty cost display (no spend yet). */
export function emptyCostDisplay({ estimate = null, models_enabled = false, external_hold = true } = {}) {
  return {
    currency: 'USD',
    estimate,
    actual: { settled_usd: 0, open_reserve_usd: 0, pending_late_usd: 0, by_provider: [], by_op_type: [] },
    caps: [],
    flags: { cost_not_precisely_bounded: false, budget_stopped: false, stopped_cap: null },
    models_enabled,
    external_hold,
  }
}

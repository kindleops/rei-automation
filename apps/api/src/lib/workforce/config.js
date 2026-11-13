// LeadCommand Workforce (Phase A) — switches, runtime kinds and limits (docs/WORKFORCE.md §3, §9).
//
// BORN OFF, three times over:
//   • code gate   WORKFORCE_ENABLED=1 (absent ⇒ routes 404, handlers not registered)
//   • DB gate     agent.runtime_limits.kind_limits['workforce.*'] absent ⇒ the DB never claims the jobs
//   • schedule    runtime_schedule 'workforce-dispatch' seeded enabled=false
// WORKFORCE_MODEL_INTERPRET=1 additionally lets the COO ask a model to CHOOSE among the closed
// intent set when the deterministic parser returns unknown (never to create steps).
//
// No Workforce code path can send a seller message, write a stage, create or send an offer,
// launch a campaign or contact anyone (pinned by tests/critical/workforce-no-send-imports.test.mjs).

export const WORKFORCE_FLAG = 'WORKFORCE_ENABLED'
export const WORKFORCE_MODEL_INTERPRET_FLAG = 'WORKFORCE_MODEL_INTERPRET'

/** Only the literal '1' arms Workforce (trimmed). */
export function workforceEnabled(env = process.env) {
  return String(env?.[WORKFORCE_FLAG] ?? '').trim() === '1'
}
/** The optional model interpreter: only the literal '1', and only when Workforce itself is on. */
export function modelInterpretEnabled(env = process.env) {
  return workforceEnabled(env) && String(env?.[WORKFORCE_MODEL_INTERPRET_FLAG] ?? '').trim() === '1'
}

/** The single org (same id as the agent capability plane and the R2 runtime). */
export const WORKFORCE_ORG_ID = '00000000-0000-4000-8000-00000000a001'

// the three R2 runtime kinds (§3); absent from kind_limits ⇒ never claimed
export const COO_PLAN_KIND = 'workforce.coo_plan'
export const DISPATCH_KIND = 'workforce.dispatch'
export const MISSION_REVIEW_KIND = 'workforce.mission_review'
export const WORKFORCE_KINDS = Object.freeze([COO_PLAN_KIND, DISPATCH_KIND, MISSION_REVIEW_KIND])

/** The dispatch schedule definition (seeded DISABLED by the migration; kept in step by name). */
export const WORKFORCE_DISPATCH_SCHEDULE = Object.freeze({ name: 'workforce-dispatch', kind: DISPATCH_KIND, interval_seconds: 60, budget_cap_usd: 0 })

export const WORKFORCE_LIMITS = Object.freeze({
  /** assignments processed per dispatch pass */
  dispatch_max_per_pass: 25,
  dispatch_default_per_pass: 10,
  /** never start an inline capability with less than this much tick budget left */
  min_inline_ms: 3_000,
  /** an inline read may use at most this much of the remaining budget */
  inline_read_max_ms: 15_000,
  assignment_lease_seconds: 120,
  /** triage: N is bounded; the candidate pool is 2N (capped) */
  triage_default_n: 10,
  triage_max_n: 25,
  triage_pool_max: 30,
  /** property.research enqueues per mission (each job has its own runtime budget) */
  research_per_mission: 5,
  research_budget_cap_usd: 0.05,
  /** resource claims held by an acquisition agent for one mission */
  claim_ttl_seconds: 24 * 3600,
  directive_max_chars: 2000,
})

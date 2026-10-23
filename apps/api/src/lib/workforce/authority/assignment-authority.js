// The SHARED authority path for one assignment (docs/WORKFORCE-AGNTEI.md §2: "the authority engine is shared").
// The in-process engine (engine/dispatch.js) and the Action Gateway's Workforce actions
// (domain/action-gateway/actions/workforce) BOTH call these two functions, in this order, with the facts each
// reads from its own data path (the Workforce store / the gateway's principal-bound read):
//   1. assignmentResource({ assignment, missionAssignments })  → { resource, decision, cost_usd }
//        the capability's resource (its resourceOf), the economic context from THIS mission's own decision step
//        (step outputs only), and the paid-work cost of the capability (research.property is paid)
//   2. authorizeAssignment({ employee, assignment, resource, decision, cost_usd, … facts })  → the engine verdict
// Same inputs ⇒ the same decision from either entry point (pinned by tests/critical/workforce-authority-parity*.test.mjs).
// Pure: no I/O. The hold authority is consulted by the caller between 1 and 2 (holds/automation-hold, capability ai_action).
import { authorize } from './authority-engine.js'
import { getCapability } from '../capabilities/catalog.js'
import { num } from '../capabilities/shared.js'
import { WORKFORCE_LIMITS } from '../config.js'

/** The capabilities that spend (each enqueues a runtime job with its own budget cap). */
export const PAID_CAPABILITY_COST_USD = Object.freeze({ 'research.property': WORKFORCE_LIMITS.research_budget_cap_usd })

/** Per-capability counts of the employee's assignments created today (UTC day) that left pending (the charter / policy daily caps). */
export function usageToday(assignments = [], now = Date.now()) {
  const day = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString().slice(0, 10)
  const today = {}
  for (const a of Array.isArray(assignments) ? assignments : []) if (String(a.created_at || '').slice(0, 10) === day && a.status !== 'pending') today[a.capability_key] = (today[a.capability_key] || 0) + 1
  return today
}

/** The resource an assignment acts on + the decision context from its mission's completed decision step. */
export function assignmentResource({ assignment, missionAssignments = [], capability = null }) {
  const key = capability || assignment?.capability_key
  const cap = getCapability(key)
  const input = assignment?.input || {}
  const resource = cap?.resourceOf ? cap.resourceOf(null, input) : null
  let decision = null
  if (resource?.property_id) {
    const pr = input.property_ref
    const dec = (Array.isArray(missionAssignments) ? missionAssignments : []).find((x) => x.capability_key === 'intel.acquisition_decision' && x.input?.property_ref === pr && x.status === 'completed' && ['verified', 'partial'].includes(x.outcome_class))
    decision = dec?.output || null
    const prices = [decision?.ask, decision?.mao, decision?.valuation_mid, decision?.recommended_offer].map(num).filter((v) => v != null && v > 0)
    resource.price_usd = prices.length ? Math.max(...prices) : null
  }
  return { resource, decision, cost_usd: PAID_CAPABILITY_COST_USD[key] ?? 0, capability: key }
}

/**
 * @param {{ employee, assignment, capability?, resource, decision, cost_usd?, employeeAssignments?, policies?, settings?, env?, now?,
 *           emergencyStop?: boolean, hold?: object|null, budgets?: object[]|null }} o
 */
export function authorizeAssignment({ employee, assignment, capability = null, resource = null, decision = null, cost_usd = 0, employeeAssignments = [], policies = [], settings = null,
  env = process.env, now = Date.now(), emergencyStop = false, hold = null, budgets = [] }) {
  const key = capability || assignment?.capability_key
  const cap = getCapability(key)
  // today's usage counts the assignment under evaluation as taken (the dispatcher evaluates it leased): the same count
  // whichever entry point evaluates it, whatever its stored status is at that moment
  const others = (Array.isArray(employeeAssignments) ? employeeAssignments : []).filter((x) => x.assignment_id !== assignment?.assignment_id)
  const counted = assignment ? [...others, { ...assignment, capability_key: key, status: 'leased' }] : others
  return authorize({
    employee, capability: key, resource,
    context: {
      env, now, runtime: { emergency_stop: emergencyStop === true }, hold, policies, settings,
      usage: { today: cap?.class === 'internal' ? usageToday(counted, now) : {} },
      valuation_uncertain: decision?.valuation_uncertain === true, title_ambiguous: decision?.title_ambiguous === true, confidence: decision?.confidence ?? null,
      cost_usd, budgets,
    },
  })
}

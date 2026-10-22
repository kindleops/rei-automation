// Delegation & Authority Engine (docs/WORKFORCE.md §4.2). Pure: the dispatcher gathers the context
// (runtime limits, the hold lookup, policies, settings, today's usage) and this decides.
//
// authorize({ employee, capability, resource, context }) → { decision: allow | escalate | deny, reasons, … }
// In order (the first deny wins; escalations accumulate and apply only when nothing denies):
//   1. kill switches     WORKFORCE_ENABLED, the runtime emergency stop, the employee's status
//   2. charter           the capability is in the employee's role charter (and in the closed catalog)
//   3. tier              the capability's class ≤ the employee's effective tier ceiling (read T0, internal T1)
//   4. resource scope    market-scoped roles act only inside employee.markets
//   5. holds             Hartford / Maxwell (never revive) always; registry holds; suppression (fail closed)
//   6. policy            an active authority_policy covering it, else the charter default (read allow,
//                        internal allow up to the daily caps)
//   7. escalation        price ≥ exec_review_price_usd, valuation uncertainty, title ambiguity, a policy
//                        that requires review → escalate (an assignment for the CEO, never a silent block)
// T2+ (Action Gateway mutations) has no Phase A path. proposeGrants() only RENDERS the
// action_gateway.capability_grants rows an owner would mint; it never creates one.
import { workforceEnabled } from '../config.js'
import { charterFor, effectiveTierCeiling, roleHasCapability, tierRank } from '../org/charters.js'
import { getCapability, capabilityTier, isForbiddenAction } from '../capabilities/catalog.js'
import { exclusionCode, lower, marketLabel, num, sameMarket } from '../capabilities/shared.js'

export const AUTHORITY_VERSION = 'wf-authority.v1'
export const DEFAULT_EXEC_REVIEW_PRICE_USD = 5_000_000
/** Charter-default daily caps for INTERNAL capabilities, per employee (no policy present). */
export const DEFAULT_DAILY_CAPS = Object.freeze({ 'research.property': 25, 'work.assign': 200, 'ops.raise_work_item': 50, 'memory.assert': 200 })
const RISK = ['low', 'medium', 'high']
export const CAPABILITY_RISK = Object.freeze({
  'intel.active_opportunities': 'low', 'intel.conversation_state': 'low', 'intel.acquisition_decision': 'low', 'finance.review_opportunity': 'low',
  'acq.rank_opportunities': 'low', 'acq.next_action': 'medium', 'research.property': 'medium', 'work.assign': 'medium', 'ops.raise_work_item': 'low', 'memory.assert': 'low',
})

const deny = (reasons, extra = {}) => Object.freeze({ version: AUTHORITY_VERSION, decision: 'deny', reasons: Object.freeze([...reasons]), ...extra })

function policyCovers(p, { employee, capability, resource, now }) {
  if (!p || p.status !== 'active') return false
  if (p.action_key !== capability) return false
  if (p.employee_id ? p.employee_id !== employee.employee_id : p.role_key !== employee.role_key) return false
  const t = typeof now === 'number' ? now : Date.parse(now)
  if (p.valid_from && Date.parse(p.valid_from) > t) return false
  if (p.valid_until && Date.parse(p.valid_until) <= t) return false
  const s = p.scope || {}
  if (Array.isArray(s.markets) && s.markets.length && !(resource?.market && s.markets.some((m) => sameMarket(m, resource.market)))) return false
  if (Array.isArray(s.property_types) && s.property_types.length && !(resource?.property_type && s.property_types.map(lower).includes(lower(resource.property_type)))) return false
  if (Array.isArray(s.resource_types) && s.resource_types.length && !(resource?.resource_type && s.resource_types.includes(resource.resource_type))) return false
  return true
}
/** The most specific covering policy: employee over role, then the newest. */
export function coveringPolicy(policies = [], args) {
  const c = (Array.isArray(policies) ? policies : []).filter((p) => policyCovers(p, args))
  c.sort((a, b) => (b.employee_id ? 1 : 0) - (a.employee_id ? 1 : 0) || (Number(b.version) || 0) - (Number(a.version) || 0))
  return c[0] || null
}

/**
 * @param {{ employee: object, capability: string, resource?: object|null, context?: object }} o
 *   resource: { property_id?, opportunity_id?, conversation_id?, thread_key?, market?, price_usd?, property_type?, resource_type? }
 *   context:  { env, runtime: { emergency_stop }, hold: { held, fail_closed, hold_type } | null, suppressed?: boolean|null,
 *               policies, settings: { exec_review_price_usd }, usage: { today: { [capability]: n } },
 *               valuation_uncertain?, title_ambiguous?, confidence?, cost_usd?, now }
 */
export function authorize({ employee, capability, resource = null, context = {} } = {}) {
  const env = context.env ?? process.env
  const now = context.now ?? Date.now()
  // 1. kill switches
  if (!workforceEnabled(env)) return deny(['WORKFORCE_DISABLED'], { kill_switch: true })
  if (context.runtime?.emergency_stop === true) return deny(['EMERGENCY_STOP'], { kill_switch: true })
  if (!employee || !employee.employee_id) return deny(['EMPLOYEE_UNKNOWN'])
  if (employee.status !== 'active') return deny([employee.status === 'paused' ? 'EMPLOYEE_PAUSED' : `EMPLOYEE_${String(employee.status || 'unknown').toUpperCase()}`], { kill_switch: employee.status === 'paused' })
  if (employee.kind === 'human') return deny(['HUMAN_EMPLOYEE_NOT_EXECUTED_BY_AI'])
  // 2. charter (and the closed catalog)
  const cap = getCapability(capability)
  if (!cap) return deny([isForbiddenAction(capability) ? 'ACTION_FORBIDDEN_IN_PHASE_A' : 'CAPABILITY_NOT_IN_CATALOG'])
  const charter = charterFor(employee.role_key)
  if (!charter) return deny(['ROLE_UNKNOWN'])
  if (!roleHasCapability(employee.role_key, capability)) return deny(['CAPABILITY_NOT_IN_CHARTER'])
  // 3. tier
  const need = capabilityTier(cap)
  const ceiling = effectiveTierCeiling(employee)
  if (!need || !ceiling || tierRank(need) > tierRank(ceiling)) return deny(['TIER_EXCEEDS_CEILING'], { tier: need, ceiling })
  // 4. resource scope (market-scoped roles)
  const market = marketLabel(resource?.market)
  if (charter.market_scoped && resource) {
    const mine = (Array.isArray(employee.markets) ? employee.markets : []).map(marketLabel).filter(Boolean)
    if (!market) return deny(['MARKET_UNKNOWN'])
    if (!mine.some((m) => sameMarket(m, market))) return deny(['MARKET_OUT_OF_SCOPE'], { market })
  }
  // 5. holds, exclusions, suppression
  if (resource) {
    const never = exclusionCode({ property_id: resource.property_id, opportunity_id: resource.opportunity_id, conversation_id: resource.conversation_id, thread_key: resource.thread_key, property_address: resource.property_address })
    if (never) return deny([never === 'CLOSED_LOST_NEVER_REVIVE' ? 'EXCLUDED_CLOSED_LOST_NEVER_REVIVE' : 'EXCLUDED_PERMANENT_EXCLUSION'], { exclusion: never })
    const h = context.hold
    if (h?.held) return deny([h.fail_closed ? 'HOLD_LOOKUP_FAILED' : 'AUTOMATION_HOLD'], { hold_type: h.hold_type || null })
    if (context.suppressed === true) return deny(['SUPPRESSED'])
  }
  // 6. policy (or the charter default)
  const escalations = []
  const policy = coveringPolicy(context.policies, { employee, capability, resource: { ...(resource || {}), market }, now })
  const used = Number(context.usage?.today?.[capability] || 0)
  const price = num(resource?.price_usd)
  if (policy) {
    const lim = policy.limits || {}
    if (num(lim.per_day) != null && used >= num(lim.per_day)) return deny(['POLICY_DAILY_LIMIT'], { policy_id: policy.policy_id })
    if (num(lim.max_usd) != null && num(context.cost_usd) != null && num(context.cost_usd) > num(lim.max_usd)) return deny(['POLICY_SPEND_LIMIT'], { policy_id: policy.policy_id })
    const risk = CAPABILITY_RISK[capability] || 'high'
    if (policy.risk && RISK.indexOf(risk) > RISK.indexOf(policy.risk)) return deny(['RISK_ABOVE_POLICY'], { policy_id: policy.policy_id })
    if (num(lim.max_price) != null && price != null && price > num(lim.max_price)) escalations.push('PRICE_ABOVE_POLICY_MAX')
    if (num(policy.min_confidence) != null && (num(context.confidence) == null || num(context.confidence) < num(policy.min_confidence))) escalations.push('CONFIDENCE_BELOW_POLICY')
    if (policy.review === 'ceo' || policy.review === 'coo') escalations.push(`POLICY_REQUIRES_${policy.review.toUpperCase()}_REVIEW`)
  } else if (cap.class === 'internal') {
    const cap_n = DEFAULT_DAILY_CAPS[capability]
    if (cap_n != null && used >= cap_n) return deny(['CHARTER_DAILY_CAP'], { cap: cap_n })
  }
  // 7. escalation rules (only for the capabilities that bear a decision)
  const on = new Set(cap.escalates_on || [])
  const threshold = num(context.settings?.exec_review_price_usd) ?? DEFAULT_EXEC_REVIEW_PRICE_USD
  if (on.has('price') && price != null && price >= threshold) escalations.push('EXEC_REVIEW_PRICE')
  if (on.has('valuation_uncertain') && context.valuation_uncertain === true) escalations.push('VALUATION_UNCERTAIN')
  if (on.has('title_ambiguous') && context.title_ambiguous === true) escalations.push('TITLE_AMBIGUOUS')
  if (escalations.length) {
    const review = policy?.review === 'coo' && escalations.every((e) => e === 'POLICY_REQUIRES_COO_REVIEW') ? 'coo' : 'ceo'
    return Object.freeze({ version: AUTHORITY_VERSION, decision: 'escalate', reasons: Object.freeze(escalations), review, policy_id: policy?.policy_id ?? null, threshold_usd: threshold })
  }
  return Object.freeze({ version: AUTHORITY_VERSION, decision: 'allow', reasons: Object.freeze([policy ? 'POLICY_ALLOWS' : `CHARTER_DEFAULT_${cap.class.toUpperCase()}`]), policy_id: policy?.policy_id ?? null, tier: need })
}

/**
 * DISPLAY ONLY: the action_gateway.capability_grants rows an owner would mint for this policy's
 * employee (or each employee of its role) — never created here; grants stay owner-created.
 * A Workforce-internal capability (T0/T1) needs no grant: it renders as { grant_needed: false }.
 */
export function proposeGrants(policy, { employees = [] } = {}) {
  if (!policy) return []
  const targets = (policy.employee_id ? employees.filter((e) => e.employee_id === policy.employee_id) : employees.filter((e) => e.role_key === policy.role_key && e.status === 'active'))
  const internal = Boolean(getCapability(policy.action_key))
  return targets.map((e) => Object.freeze({
    display_only: true,
    grant_needed: !internal,
    reason: internal ? 'workforce_internal_capability_no_gateway_grant' : e.action_principal_id ? 'owner_must_mint' : 'employee_has_no_action_principal',
    agent_id: e.action_principal_id || null,
    employee_id: e.employee_id,
    capability: policy.action_key,
    scope: { markets: policy.scope?.markets || [], resource_types: policy.scope?.resource_types || [] },
    max_uses_per_day: num(policy.limits?.per_day),
    max_spend_usd_per_day: num(policy.limits?.max_usd),
    envelope: num(policy.limits?.max_price) != null ? { max: { price: num(policy.limits.max_price) } } : {},
    valid_from: policy.valid_from || null,
    expires_at: policy.valid_until || null,
    source_policy_id: policy.policy_id || null,
  }))
}

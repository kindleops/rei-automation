// Workforce Phase A — the Delegation & Authority Engine (§4.2), in order: kill switches (flag,
// emergency stop, employee status) → charter → tier → market scope → holds / exclusions (Hartford,
// Maxwell) / suppression → policy limits → escalation ($5M exec review, valuation uncertainty, title
// ambiguity). proposeGrants is display only. Plus the charter ↔ catalog consistency.
import test from 'node:test'
import assert from 'node:assert/strict'

import { authorize, proposeGrants, DEFAULT_EXEC_REVIEW_PRICE_USD, DEFAULT_DAILY_CAPS } from '../../src/lib/workforce/authority/engine.js'
import { CAPABILITIES, CAPABILITY_KEYS } from '../../src/lib/workforce/capabilities/catalog.js'
import { ROLE_CHARTERS, ROLES, rolesFor, effectiveTierCeiling } from '../../src/lib/workforce/org/charters.js'
import { SEED_EMPLOYEES, SEED_EMPLOYEE_IDS } from '../../src/lib/workforce/org/seed.js'
import { HARTFORD, MAXWELL, T0 } from '../helpers/workforce-fixtures.mjs'

const ENV = { WORKFORCE_ENABLED: '1' }
const agent = (o = {}) => ({ employee_id: 'emp_acq_dallas_1', role_key: 'acquisition_agent', kind: 'ai', status: 'active', markets: ['Dallas'], tier_ceiling: 'T1', ...o })
const head = (o = {}) => ({ employee_id: 'emp_head_acquisitions', role_key: 'head_acquisitions', kind: 'ai', status: 'active', markets: [], tier_ceiling: 'T1', ...o })
const cfo = { employee_id: 'emp_cfo', role_key: 'cfo', kind: 'ai', status: 'active', markets: [], tier_ceiling: 'T1' }
const res = (o = {}) => ({ property_id: '700000001', market: 'Dallas', ...o })
const ctx = (o = {}) => ({ env: ENV, now: T0, runtime: { emergency_stop: false }, hold: { held: false }, policies: [], settings: { exec_review_price_usd: DEFAULT_EXEC_REVIEW_PRICE_USD }, usage: { today: {} }, ...o })
const az = (employee, capability, resource = res(), c = {}) => authorize({ employee, capability, resource, context: ctx(c) })

test('kill switches come first: the flag, the emergency stop, the employee status', () => {
  assert.deepEqual(authorize({ employee: agent(), capability: 'intel.conversation_state', resource: res(), context: ctx({ env: {} }) }).reasons, ['WORKFORCE_DISABLED'])
  for (const v of ['0', 'true', 'yes', '']) assert.equal(authorize({ employee: agent(), capability: 'intel.conversation_state', resource: res(), context: ctx({ env: { WORKFORCE_ENABLED: v } }) }).decision, 'deny', v)
  const stop = az(agent(), 'intel.conversation_state', res(), { runtime: { emergency_stop: true } })
  assert.equal(stop.decision, 'deny')
  assert.deepEqual(stop.reasons, ['EMERGENCY_STOP'])
  assert.equal(stop.kill_switch, true)
  const paused = az(agent({ status: 'paused' }), 'intel.conversation_state')
  assert.deepEqual(paused.reasons, ['EMPLOYEE_PAUSED'])
  assert.deepEqual(az(agent({ status: 'retired' }), 'intel.conversation_state').reasons, ['EMPLOYEE_RETIRED'])
  // a human is never executed by the AI engine
  assert.deepEqual(az({ employee_id: 'emp_ceo', role_key: 'ceo', kind: 'human', status: 'active' }, 'work.assign').reasons, ['HUMAN_EMPLOYEE_NOT_EXECUTED_BY_AI'])
  // the emergency stop outranks everything else, even a Hartford deny
  assert.deepEqual(az(agent(), 'intel.conversation_state', res({ property_id: HARTFORD.property_id }), { runtime: { emergency_stop: true } }).reasons, ['EMERGENCY_STOP'])
})

test('charter: a capability outside the role charter, or outside the catalog, is denied', () => {
  assert.deepEqual(az(agent(), 'finance.review_opportunity').reasons, ['CAPABILITY_NOT_IN_CHARTER'])
  assert.deepEqual(az(cfo, 'acq.rank_opportunities', null).reasons, ['CAPABILITY_NOT_IN_CHARTER'])
  assert.equal(az(cfo, 'finance.review_opportunity').decision, 'allow')
  for (const k of ['sms.send', 'offer.send', 'stage.write', 'campaign.launch', 'seller.contact', 'suppression.release', 'send_queue.insert']) {
    const r = az(head(), k)
    assert.equal(r.decision, 'deny', k)
    assert.ok(['ACTION_FORBIDDEN_IN_PHASE_A', 'CAPABILITY_NOT_IN_CATALOG'].includes(r.reasons[0]), `${k}: ${r.reasons}`)
  }
  assert.deepEqual(az(head(), 'offer.send').reasons, ['ACTION_FORBIDDEN_IN_PHASE_A'])
})

test('tier: the class must fit under the effective ceiling (role ∧ row ∧ Phase A T2)', () => {
  assert.equal(effectiveTierCeiling(agent({ tier_ceiling: 'T2' })), 'T1', 'the role charter caps an acquisition agent at T1')
  assert.equal(effectiveTierCeiling({ role_key: 'ceo', tier_ceiling: 'T2' }), 'T2')
  // a row ceiling of T0 (read only) refuses an internal capability
  const ro = agent({ tier_ceiling: 'T0' })
  assert.equal(az(ro, 'intel.conversation_state').decision, 'allow', 'read = T0')
  assert.deepEqual(az(ro, 'research.property').reasons, ['TIER_EXCEEDS_CEILING'])
})

test('market scope: market-scoped roles act only inside their markets; heads are not market-scoped', () => {
  assert.equal(az(agent(), 'intel.conversation_state', res({ market: 'Dallas, TX' })).decision, 'allow')
  assert.deepEqual(az(agent(), 'intel.conversation_state', res({ market: 'Houston' })).reasons, ['MARKET_OUT_OF_SCOPE'])
  assert.deepEqual(az(agent(), 'intel.conversation_state', res({ market: null })).reasons, ['MARKET_UNKNOWN'])
  assert.equal(az(head(), 'intel.conversation_state', res({ market: 'Houston' })).decision, 'allow')
})

test('holds and exclusions: Hartford and Maxwell are ALWAYS excluded; a registry hold or a failed lookup denies; suppression denies', () => {
  for (const id of [{ property_id: HARTFORD.property_id }, { opportunity_id: HARTFORD.opportunity_id }, { conversation_id: HARTFORD.conversation_id }]) {
    const r = az(head(), 'intel.conversation_state', res({ property_id: null, ...id }))
    assert.deepEqual(r.reasons, ['EXCLUDED_CLOSED_LOST_NEVER_REVIVE'], JSON.stringify(id))
  }
  for (const id of [{ property_id: MAXWELL.property_id }, { opportunity_id: MAXWELL.opportunity_id }, { conversation_id: MAXWELL.conversation_id }, { property_id: null, property_address: '3746 Baltimore Ave' }]) {
    assert.deepEqual(az(head(), 'intel.acquisition_decision', res({ property_id: null, ...id })).reasons, ['EXCLUDED_PERMANENT_EXCLUSION'], JSON.stringify(id))
  }
  // even a policy that would allow it cannot un-exclude them
  const pol = [{ policy_id: 'p1', status: 'active', role_key: 'head_acquisitions', action_key: 'intel.conversation_state', scope: {}, limits: {} }]
  assert.equal(az(head(), 'intel.conversation_state', res({ property_id: HARTFORD.property_id }), { policies: pol }).decision, 'deny')
  assert.deepEqual(az(head(), 'intel.conversation_state', res(), { hold: { held: true, hold_type: 'operator_hold' } }).reasons, ['AUTOMATION_HOLD'])
  assert.deepEqual(az(head(), 'intel.conversation_state', res(), { hold: { held: true, fail_closed: true, hold_type: 'lookup_error' } }).reasons, ['HOLD_LOOKUP_FAILED'])
  assert.deepEqual(az(head(), 'intel.conversation_state', res(), { suppressed: true }).reasons, ['SUPPRESSED'])
})

test('policy limits: per-day, spend, risk; review and price limits escalate; the charter default caps internal work', () => {
  const p = (o) => [{ policy_id: 'p1', status: 'active', role_key: 'acquisition_agent', action_key: 'acq.next_action', scope: { markets: ['Dallas'] }, limits: {}, risk: 'high', ...o }]
  assert.deepEqual(az(agent(), 'acq.next_action', res(), { policies: p({ limits: { per_day: 5 } }), usage: { today: { 'acq.next_action': 5 } } }).reasons, ['POLICY_DAILY_LIMIT'])
  assert.equal(az(agent(), 'acq.next_action', res(), { policies: p({ limits: { per_day: 5 } }), usage: { today: { 'acq.next_action': 4 } } }).decision, 'allow')
  assert.deepEqual(az(agent(), 'acq.next_action', res(), { policies: p({ risk: 'low' }) }).reasons, ['RISK_ABOVE_POLICY'])
  assert.deepEqual(az(agent(), 'acq.next_action', res({ price_usd: 400_000 }), { policies: p({ limits: { max_price: 300_000 } }) }).reasons, ['PRICE_ABOVE_POLICY_MAX'])
  const rev = az(agent(), 'acq.next_action', res(), { policies: p({ review: 'ceo' }) })
  assert.equal(rev.decision, 'escalate')
  assert.deepEqual(rev.reasons, ['POLICY_REQUIRES_CEO_REVIEW'])
  assert.equal(az(agent(), 'acq.next_action', res(), { policies: p({ review: 'coo' }) }).review, 'coo')
  assert.deepEqual(az(agent(), 'acq.next_action', res(), { policies: p({ min_confidence: 0.8 }), confidence: 0.5 }).reasons, ['CONFIDENCE_BELOW_POLICY'])
  // out of the policy's scope / revoked / expired ⇒ the charter default applies
  assert.equal(az(agent({ markets: ['Dallas', 'Houston'] }), 'acq.next_action', res({ market: 'Houston' }), { policies: p({ limits: { per_day: 0 } }) }).decision, 'allow')
  assert.equal(az(agent(), 'acq.next_action', res(), { policies: p({ status: 'revoked', limits: { per_day: 0 } }) }).decision, 'allow')
  assert.equal(az(agent(), 'acq.next_action', res(), { policies: p({ valid_until: new Date(T0 - 1000).toISOString(), limits: { per_day: 0 } }) }).decision, 'allow')
  // an employee policy beats a role policy
  const both = [...p({ limits: { per_day: 0 } }), { policy_id: 'p2', status: 'active', employee_id: 'emp_acq_dallas_1', action_key: 'acq.next_action', scope: {}, limits: { per_day: 10 }, risk: 'high' }]
  assert.equal(az(agent(), 'acq.next_action', res(), { policies: both, usage: { today: { 'acq.next_action': 3 } } }).policy_id, 'p2')
  // charter default: read = allow; internal = allow up to the daily cap
  assert.equal(az(agent(), 'research.property', res(), { usage: { today: { 'research.property': DEFAULT_DAILY_CAPS['research.property'] - 1 } } }).decision, 'allow')
  assert.deepEqual(az(agent(), 'research.property', res(), { usage: { today: { 'research.property': DEFAULT_DAILY_CAPS['research.property'] } } }).reasons, ['CHARTER_DAILY_CAP'])
})

test('escalation: a price at/above exec_review_price_usd ($5M default), valuation uncertainty, title ambiguity → escalate (CEO)', () => {
  const at = az(cfo, 'finance.review_opportunity', res({ price_usd: 5_000_000 }))
  assert.equal(at.decision, 'escalate')
  assert.deepEqual(at.reasons, ['EXEC_REVIEW_PRICE'])
  assert.equal(at.review, 'ceo')
  assert.equal(at.threshold_usd, 5_000_000)
  assert.equal(az(cfo, 'finance.review_opportunity', res({ price_usd: 4_999_999 })).decision, 'allow')
  // the CEO's setting moves the threshold
  assert.equal(az(cfo, 'finance.review_opportunity', res({ price_usd: 1_500_000 }), { settings: { exec_review_price_usd: 1_000_000 } }).decision, 'escalate')
  assert.equal(az(cfo, 'finance.review_opportunity', res({ price_usd: 9_000_000 }), { settings: { exec_review_price_usd: 10_000_000 } }).decision, 'allow')
  const next = az(agent(), 'acq.next_action', res({ price_usd: 6_000_000 }), { valuation_uncertain: true, title_ambiguous: true })
  assert.deepEqual(next.reasons, ['EXEC_REVIEW_PRICE', 'VALUATION_UNCERTAIN', 'TITLE_AMBIGUOUS'])
  // evidence gathering is never escalated (a read of a $6M property is how the CEO gets the facts)
  assert.equal(az(head(), 'intel.acquisition_decision', res({ price_usd: 6_000_000 }), { valuation_uncertain: true }).decision, 'allow')
  // a deny still wins over an escalation
  assert.equal(az(agent(), 'acq.next_action', res({ price_usd: 6_000_000, market: 'Houston' })).decision, 'deny')
})

test('proposeGrants is display only: renders rows, creates nothing; internal capabilities need no gateway grant', () => {
  const emps = [{ employee_id: 'emp_acq_dallas_1', role_key: 'acquisition_agent', status: 'active', action_principal_id: 'agt_acq_dallas_1' }, { employee_id: 'emp_acq_dallas_2', role_key: 'acquisition_agent', status: 'paused', action_principal_id: null }]
  const g = proposeGrants({ policy_id: 'p1', role_key: 'acquisition_agent', action_key: 'inbox.send_reply', scope: { markets: ['Dallas'] }, limits: { per_day: 20, max_usd: 1, max_price: 250_000 } }, { employees: emps })
  assert.equal(g.length, 1, 'active employees of the role only')
  assert.equal(g[0].display_only, true)
  assert.equal(g[0].grant_needed, true)
  assert.equal(g[0].agent_id, 'agt_acq_dallas_1')
  assert.deepEqual(g[0].envelope, { max: { price: 250_000 } })
  const internal = proposeGrants({ policy_id: 'p2', role_key: 'acquisition_agent', action_key: 'acq.next_action', scope: {}, limits: {} }, { employees: emps })
  assert.equal(internal[0].grant_needed, false)
  assert.ok(Object.isFrozen(g[0]))
})

test('charters ↔ catalog ↔ seed: every capability is staffed by its charter roles; the seed matches the DB ids', () => {
  for (const k of CAPABILITY_KEYS) {
    const roles = rolesFor(k)
    assert.ok(roles.length >= 1, k)
    for (const r of CAPABILITIES[k].roles) assert.ok(roles.includes(r), `${k}: ${r} is listed but its charter lacks the capability`)
    assert.ok(['read', 'internal'].includes(CAPABILITIES[k].class))
  }
  assert.deepEqual(Object.keys(ROLE_CHARTERS).sort(), [...ROLES].sort())
  for (const c of Object.values(ROLE_CHARTERS)) for (const cap of c.capabilities) assert.ok(CAPABILITY_KEYS.includes(cap), `${c.role_key}: ${cap}`)
  assert.deepEqual([...SEED_EMPLOYEE_IDS], ['emp_ceo', 'emp_coo', 'emp_cfo', 'emp_head_acquisitions', 'emp_head_marketing', 'emp_head_dispositions', 'emp_head_data', 'emp_ops_supervisor', 'emp_research_01'])
  assert.equal(SEED_EMPLOYEES.find((e) => e.employee_id === 'emp_coo').display_name, 'Atlas')
  assert.equal(SEED_EMPLOYEES.find((e) => e.employee_id === 'emp_cfo').display_name, 'Ledger')
  assert.equal(SEED_EMPLOYEES.filter((e) => e.role_key === 'acquisition_agent').length, 0, 'no acquisition agents are seeded')
  assert.equal(SEED_EMPLOYEES.find((e) => e.employee_id === 'emp_ceo').kind, 'human')
  for (const e of SEED_EMPLOYEES) assert.ok(['T1', 'T2'].includes(e.tier_ceiling) && e.spend_day_cap_usd <= 5)
})

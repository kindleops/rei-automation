// The Workforce actions on the Action Gateway (docs/WORKFORCE-AGNTEI.md §2): T1, INTERNAL ONLY. An operator-directed
// Agntei agent reads its Workforce identity / assignments / missions and acts on the assignments assigned to it.
// Registered by one line each in catalog.js (WF_ACTIONS / WF_READS) and actions.js (WF_LOGIC). Durable half:
// supabase/migrations/PROPOSED_20261022110000_workforce_agntei.sql — ONE lease-bound writer
// (action_gateway_dw_workforce) and ONE principal-bound read (action_gateway_workforce_read).
//
// IDENTITY: the acting employee is the one bound to the AUTHENTICATED principal (workforce.employee.action_principal_id),
// resolved server-side from the presented credential digest; no tool argument names an employee (an employee_id /
// actor argument is FORGED_CONTEXT, constants.js). The binding is operator-authorized and expiring (BINDING_EXPIRED /
// BINDING_REVOKED refuse every call).
// AUTHORITY: the SAME engine as the in-process Workforce (lib/workforce/authority/assignment-authority.js:
// assignmentResource → the hold authority → authorizeAssignment), over the facts the principal-bound read returns.
// NOTHING here can send, offer, write a stage, launch a campaign or contact anyone (tests/critical/workforce-no-send-imports).
import { UUID, str, int, num, bool, enumOf, list, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { encodePropertyRef, decodeStored } from '../../../../agent/missions/mission-codec.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { gwErr } from '../../errors.js'
import { cleanText } from '../t2/shared.js'
import { WORKFORCE_GATEWAY_TOOLS } from '../../../../workforce/agntei/tools.js'
import { assignmentResource, authorizeAssignment } from '../../../../workforce/authority/assignment-authority.js'
import { workforceEnabled, WORKFORCE_LIMITS } from '../../../../workforce/config.js'
import { interpretDirective } from '../../../../workforce/coo/interpret.js'
import { missionTitle } from '../../../../workforce/missions/directive.js'
import { pickAssignee } from '../../../../workforce/coo/staffing.js'
import { rolesFor } from '../../../../workforce/org/charters.js'

export const WF_LINK = 'PROPOSED_20261022110000_workforce_agntei'
const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
const client = { client_request_id: CLIENT_KEY }
const TEXT = (max, min = 1) => str(max, { minLength: min, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const WFA = str(40, { minLength: 40, pattern: '^wfa_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })
const WFM = str(40, { minLength: 40, pattern: '^wfm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })
const EMP = str(44, { minLength: 7, pattern: '^emp_[a-z0-9_]{3,40}$' })
const PROPERTY_ID = str(64, { minLength: 1, pattern: '^[A-Za-z0-9_-]{1,64}$' })
const CODE_UP = str(60, { minLength: 2, pattern: '^[A-Za-z][A-Za-z0-9_]{1,59}$' })
const PHASE = str(40, { minLength: 2, pattern: '^[a-z][a-z0-9_]{1,39}$' })
const MODEL = str(60, { minLength: 1, pattern: '^[A-Za-z0-9_.:-]{1,60}$' })
const ASSIGNMENT_STATUSES = ['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled']
const EVIDENCE_TYPES = ['job', 'intent', 'thread', 'property', 'opportunity']
const EVIDENCE = list(obj({ type: enumOf(EVIDENCE_TYPES), id: str(80, { minLength: 1, pattern: '^[A-Za-z0-9_.:-]{1,80}$' }), note: TEXT(200) }, ['type', 'id']), 20)
const OUTPUT = obj({ summary: TEXT(2000), findings: list(TEXT(400), 20), next_steps: list(TEXT(300), 10), recommendation: TEXT(600) })
const CLAIM_ATTEMPT = int(0, 10)
const RESEARCH_BUDGET_USD = WORKFORCE_LIMITS.research_budget_cap_usd

const CAP = Object.fromEntries(WORKFORCE_GATEWAY_TOOLS.map((t) => [t.tool, t.capability]))
const exec = { kind: 'domain_write', fn: DOMAIN_WRITES.workforce }
const wraps = (service) => ({ service, module: 'supabase/migrations/PROPOSED_20261022110000_workforce_agntei.sql' })
/** spec.risk: the explicit rating the MCP advertises (Agntei rates tools by it). */
const write = (o) => Object.freeze({ tier: TIERS.T1, resource: 'workforce', executor: exec, recovery: 'reexecute', limits: { per_min: 30 }, touches: ['workforce'], risk: 'internal_write', ...o })

// ── specs ────────────────────────────────────────────────────────────────────
export const WF_READS = Object.freeze([
  Object.freeze({ name: 'workforce_whoami', title: 'Who am I in LeadCommand Workforce', tier: TIERS.T1, scope: null, resource: 'workforce', capability: CAP.workforce_whoami, risk: 'read',
    description: 'Your Workforce employee (bound to THIS agent credential): role, department, manager, markets, employment type, link state, your live Action Gateway grants and tier ceiling, and your open assignments. Read only.',
    input: obj({}), limits: { per_min: 60 }, wraps: wraps('action_gateway_workforce_read(whoami)') }),
  Object.freeze({ name: 'workforce_list_assignments', title: 'List my Workforce assignments', tier: TIERS.T1, scope: null, resource: 'workforce', capability: CAP.workforce_list_assignments, risk: 'read',
    description: 'The assignments assigned to you (newest first; optionally one status or one mission), each with its mission, step, capability, status, execution mode, input, output and evidence; with include_mission_peers, a summary of the other assignments of the missions you work on. Read only.',
    input: obj({ status: enumOf(ASSIGNMENT_STATUSES), mission_id: WFM, include_mission_peers: bool(), limit: int(1, 100) }), limits: { per_min: 60 }, wraps: wraps('action_gateway_workforce_read(assignments)') }),
  Object.freeze({ name: 'workforce_get_mission_intelligence', title: 'Read the acquisition intelligence of a mission you work on', tier: TIERS.T1, scope: null, resource: 'workforce', capability: CAP.workforce_get_mission_intelligence, risk: 'read',
    description: 'The AUTHORITATIVE acquisition intelligence the Workforce engine computed for a mission you participate in: candidate opportunities with the exclusion counts by reason (closed, suppressed / wrong number, held, never-revive, out of scope), conversation state, Decision Engine results (tier, confidence, valuation, freshness), research results, the CFO review and the ranking — each with its step, outcome class and sources. Property refs, codes, numbers and timestamps only: never a name, phone, email, address or message text. Read only.',
    input: obj({ mission_id: WFM }, ['mission_id']), limits: { per_min: 30 }, wraps: wraps('action_gateway_workforce_read(context) → engine-computed assignment outputs, allowlisted') }),
  Object.freeze({ name: 'workforce_get_mission', title: 'Read one Workforce mission', tier: TIERS.T1, scope: null, resource: 'workforce', capability: CAP.workforce_get_mission, risk: 'read',
    description: 'A mission you participate in (or one your sponsor, the CEO, requested): its directive, status, origin, report and assignments (your own in full, the others as a summary). Read only.',
    input: obj({ mission_id: WFM }, ['mission_id']), limits: { per_min: 60 }, wraps: wraps('action_gateway_workforce_read(mission)') }),
])

export const WF_ACTIONS = Object.freeze([
  write({ name: 'workforce_link_self', title: 'Link this Agntei agent to its Workforce employee', capability: CAP.workforce_link_self, limits: { per_min: 6 },
    description: 'Your FIRST call: binds your Agntei identity (install id + agent id) to the Workforce employee the owner bound to this credential, once and only inside the owner\'s link window. The same identity again is a no-op; a different one is refused (IDENTITY_MISMATCH) and suspends your Workforce grants.',
    input: obj({ ...client, external_install_id: str(80, { minLength: 8, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,79}$' }), external_agent_id: str(71, { minLength: 9, pattern: '^agent_[A-Za-z0-9_-]{3,64}$' }) },
      ['client_request_id', 'external_install_id', 'external_agent_id']),
    wraps: wraps('action_gateway_dw_workforce(workforce_link_self) → workforce.employee_link_external') }),
  write({ name: 'workforce_open_mission', title: 'Relay a CEO directive as a Workforce mission', capability: CAP.workforce_open_mission, limits: { per_min: 6 },
    description: 'Relay the CEO\'s directive: opens a Workforce mission (requested by your sponsor, the CEO; owned and planned by the COO; origin agntei) exactly like one typed in Workforce. With assign_to_self the first step goes to you when your role covers it. Missions plan internal work only: nothing contacts a seller or makes an offer.',
    input: obj({ ...client, directive: TEXT(WORKFORCE_LIMITS.directive_max_chars, 3), assign_to_self: bool() }, ['client_request_id', 'directive']),
    wraps: wraps('action_gateway_dw_workforce(workforce_open_mission) → workforce.mission_open + workforce.coo_plan') }),
  write({ name: 'workforce_claim_assignment', title: 'Claim one of my assignments', capability: CAP.workforce_claim_assignment,
    description: 'Lease an assignment assigned to you (execution mode external) and take its resource claim. Refused when another employee holds the resource (CLAIM_HELD), a person owns it (HUMAN_OWNED), it is not due or not yours. Returns claim_attempt: pass it to report / complete / request research (a reaped lease makes later calls LEASE_LOST).',
    input: obj({ ...client, assignment_id: WFA, lease_seconds: int(60, 3600) }, ['client_request_id', 'assignment_id']),
    wraps: wraps('action_gateway_dw_workforce(workforce_claim_assignment) → workforce.assignment_claim_external') }),
  write({ name: 'workforce_report_progress', title: 'Report progress on my assignment', capability: CAP.workforce_report_progress, limits: { per_min: 60 },
    description: 'Heartbeat + progress (percent, phase, note), partial output, evidence refs and your own reported model cost, under your live lease (claim_attempt from the claim). The cost is shown as reported, not verified.',
    input: obj({ ...client, assignment_id: WFA, claim_attempt: CLAIM_ATTEMPT, progress: obj({ percent: int(0, 100), phase: PHASE, note: TEXT(600) }), output: OUTPUT, evidence: EVIDENCE,
      cost: obj({ usd: num(0, 100), model: MODEL }, ['usd']) }, ['client_request_id', 'assignment_id', 'claim_attempt']),
    wraps: wraps('action_gateway_dw_workforce(workforce_report_progress) → workforce.assignment_progress') }),
  write({ name: 'workforce_complete_assignment', title: 'Complete my assignment', capability: CAP.workforce_complete_assignment,
    description: 'Finish your assignment with an output and evidence. outcome_class verified needs at least one evidence ref LeadCommand can resolve (a completed research job of this mission, one of your succeeded gateway intents, or a record you read through a logged LeadCommand tool call); otherwise it is stored as partial / unknown, never verified.',
    input: obj({ ...client, assignment_id: WFA, claim_attempt: CLAIM_ATTEMPT, outcome_class: enumOf(['verified', 'partial', 'unknown']), output: OUTPUT, evidence: EVIDENCE },
      ['client_request_id', 'assignment_id', 'claim_attempt', 'output']),
    wraps: wraps('action_gateway_dw_workforce(workforce_complete_assignment) → evidence resolution + workforce.assignment_finish') }),
  write({ name: 'workforce_request_research', title: 'Request property research for my assignment', capability: CAP.workforce_request_research, limits: { per_min: 12 }, touches: ['workforce', 'agent_runtime_job'],
    description: 'Enqueue the read-only property.research job for the property of your assignment (one job per mission × property: a retry returns the same job) and park the assignment on it; when the job finishes the assignment returns to you (claim it again, then complete with the job id as evidence). Spends at most the research budget cap.',
    input: obj({ ...client, assignment_id: WFA, claim_attempt: CLAIM_ATTEMPT, property_id: PROPERTY_ID }, ['client_request_id', 'assignment_id', 'claim_attempt']),
    wraps: wraps('action_gateway_dw_workforce(workforce_request_research) → agent.runtime_enqueue(property.research) + workforce.assignment_wait_job') }),
  write({ name: 'workforce_handoff', title: 'Hand off my assignment', capability: CAP.workforce_handoff,
    description: 'Transfer your assignment to another active employee, or back to the COO (to_coo: the COO staffs it with an internal employee whose role covers it). Your lease is released, output and evidence are kept, the new assignee\'s mode applies; recorded as an event and a COO message. Never triggers seller-facing work.',
    input: obj({ ...client, assignment_id: WFA, to_employee_id: EMP, to_coo: bool(), claim_attempt: CLAIM_ATTEMPT, note: TEXT(600) }, ['client_request_id', 'assignment_id']),
    wraps: wraps('action_gateway_dw_workforce(workforce_handoff) → workforce.assignment_handoff') }),
  write({ name: 'workforce_escalate', title: 'Escalate my assignment to the CEO', capability: CAP.workforce_escalate,
    description: 'Put an item in the CEO queue for your assignment with reason codes and a note (the same CEO item the Workforce authority engine raises). Nothing else changes.',
    input: obj({ ...client, assignment_id: WFA, reasons: { ...list(CODE_UP, 8), minItems: 1 }, note: TEXT(600) }, ['client_request_id', 'assignment_id', 'reasons']),
    wraps: wraps('action_gateway_dw_workforce(workforce_escalate) → workforce.assignment_create (CEO queue)') }),
])
export const WF_NAMES = Object.freeze([...WF_READS, ...WF_ACTIONS].map((s) => s.name))

// ── shared logic ─────────────────────────────────────────────────────────────
const enabled = (services) => workforceEnabled(services?.env || {})
const off = () => gwErr('unavailable', 'capability_unavailable', 'LeadCommand Workforce is not enabled on this Action MCP host (WORKFORCE_ENABLED)', { reason: 'WORKFORCE_DISABLED' })
const available = async ({ services }) => (enabled(services) ? { available: true } : { available: false, code: 'WORKFORCE_DISABLED' })

/** The principal-bound policy context (one read): the employee, the assignment + its mission, the facts of the authority engine. */
async function wfContext(store, digest, capability, assignment_id = null) {
  const c = await store.workforceRead(digest, 'context', { capability, ...(assignment_id ? { assignment_id } : {}) })
  if (!c?.registered) throw gwErr('forbidden', 'NOT_REGISTERED', 'this agent credential is not bound to a Workforce employee (the owner registers and binds it)')
  if (c.binding_refusal) throw gwErr('forbidden', c.binding_refusal, c.binding_refusal === 'BINDING_REVOKED' ? 'the owner revoked this agent\'s Workforce binding' : c.binding_refusal === 'BINDING_EXPIRED' ? 'this agent\'s Workforce binding expired; the owner re-binds it' : 'not an Agntei employee')
  return c
}
function mineOrThrow(c, assignment_id) {
  if (!c.assignment || c.assignment.assignment_id !== assignment_id) throw gwErr('not_found', 'ASSIGNMENT_NOT_FOUND', 'no Workforce assignment with this id')
  return c.assignment
}
const resourceOf = (id, c) => ({ type: 'system', id: `workforce:${id}`.slice(0, 80), refs: { wf: c } })
const deny = (code, evidence = {}) => ({ decision: 'deny', code, evidence })
const allow = (evidence = {}) => ({ decision: 'allow', evidence })
/** The Workforce kill switches every write honours (the engine's own step 1, then the employee's state). */
function killSwitch(c) {
  if (c.emergency_stop === true) return deny('EMERGENCY_STOP', { authority: 'deny', reasons: ['EMERGENCY_STOP'] }) // the engine's own step 1
  if (c.employee?.status !== 'active') return deny(c.employee?.status === 'pending_link' ? 'NOT_LINKED' : 'EMPLOYEE_NOT_ACTIVE', { status: c.employee?.status ?? null })
  return null
}
function mineCheck(c) {
  if (c.assignment?.assignee_employee_id !== c.employee?.employee_id) return deny('NOT_ASSIGNEE')
  return null
}

/** THE SHARED AUTHORITY PATH (the dispatcher calls the same two functions, in the same order). */
export async function gatewayAuthority({ c, services, now, capability = null, assignment = null }) {
  const a = assignment || c.assignment
  const { resource, decision, cost_usd } = assignmentResource({ assignment: a, missionAssignments: c.mission_assignments || [], capability })
  let hold = null
  if (resource?.property_id) {
    try { hold = await services.holdCheck({ propertyId: resource.property_id, opportunityId: resource.opportunity_id || null, threadId: resource.conversation_id || null, capability: 'ai_action' }) } catch { hold = { held: true, fail_closed: true, hold_type: 'lookup_error' } }
  }
  return authorizeAssignment({
    employee: c.employee, assignment: a, capability, resource, decision, cost_usd, employeeAssignments: c.employee_assignments || [], policies: c.policies || [], settings: c.settings || null,
    env: services?.env || {}, now: typeof now === 'function' ? now() : now, emergencyStop: c.emergency_stop === true, hold, budgets: cost_usd > 0 ? (Array.isArray(c.budgets) ? c.budgets : null) : [],
  })
}
function verdictToPolicy(v, extra = {}) {
  if (v.decision === 'allow') return allow({ authority: 'allow', reasons: [...v.reasons], ...extra })
  if (v.decision === 'escalate') return deny('AUTHORITY_ESCALATE', { authority: 'escalate', reasons: [...v.reasons], review: v.review, hint: 'workforce_escalate puts it in the CEO queue' })
  return deny(String(v.reasons[0] || 'AUTHORITY_DENIED').slice(0, 80), { authority: 'deny', reasons: [...v.reasons] })
}

const normRefs = (xs = []) => (xs || []).slice(0, 20).map((r) => ({
  type: r.type,
  id: r.type === 'property' ? encodePropertyRef(String(r.id)) : ['thread', 'intent', 'opportunity'].includes(r.type) ? String(r.id).toLowerCase() : String(r.id),
  ...(r.note ? { note: cleanText(r.note, 200) } : {}),
  source: 'agntei', state: 'reported',
}))
const normOutput = (o) => (o ? {
  ...(o.summary ? { summary: cleanText(o.summary, 2000) } : {}),
  ...(o.findings?.length ? { findings: o.findings.map((x) => cleanText(x, 400)).filter(Boolean) } : {}),
  ...(o.next_steps?.length ? { next_steps: o.next_steps.map((x) => cleanText(x, 300)).filter(Boolean) } : {}),
  ...(o.recommendation ? { recommendation: cleanText(o.recommendation, 600) } : {}),
} : null)

/** to_coo: the COO staffs it with an INTERNAL (autonomous) employee whose role covers the capability (deterministic: role, then id). */
export function cooHandoffTarget(c, assignment) {
  const roster = (c.roster || []).filter((e) => e.status === 'active' && e.kind === 'ai' && e.employment_type !== 'operator_ai' && e.employee_id !== c.employee?.employee_id)
  // the workers of the capability first, then the department heads that also cover it (deterministic)
  const roles = rolesFor(assignment.capability_key)
  for (const role of [...roles.filter((r) => !/^head_/.test(r)), ...roles.filter((r) => /^head_/.test(r))]) {
    const e = pickAssignee({ role, market: assignment.input?.market ?? null, employees: roster, openCounts: new Map(), fallback: false })
    if (e) return e.employee_id
  }
  return null
}

// ── B2: allowlisted projections of the ENGINE-COMPUTED intelligence outputs (no name / phone / email / address / text) ──
const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const listOf = (v) => (Array.isArray(v) ? v : [])
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
export const INTEL = Object.freeze({
  'intel.active_opportunities': (o) => ({ ...pick(o, ['mode', 'source', 'markets', 'scanned', 'eligible', 'excluded', 'reads_failed']),
    candidates: listOf(o.candidates).slice(0, 60).map((c) => pick(objOf(c), ['property_ref', 'market', 'stage', 'status', 'has_thread', 'seller_spoke_last', 'last_inbound_at', 'last_outbound_at', 'intent', 'temperature', 'has_decision', 'decision_computed_at'])) }),
  'intel.conversation_state': (o) => ({ ...pick(o, ['property_ref', 'has_thread', 'held', 'hold_type', 'suppressed', 'suppression_lookup_error', 'contact_permitted', 'excluded', 'action_state', 'seller_spoke_last', 'last_inbound_at', 'last_outbound_at', 'message_count', 'sources']),
    ...(o.action ? { action: pick(objOf(o.action), ['state', 'next_action', 'due_at', 'verified_stage', 'stage_verified', 'lost', 'reasons', 'pending_approvals']) } : {}) }),
  'intel.acquisition_decision': (o) => ({ ...pick(o, ['property_ref', 'status', 'tier', 'computed_at', 'age_days', 'confidence', 'valuation_confidence', 'valuation_mid', 'recommended_offer', 'expected_assignment_fee', 'mao', 'offer_ready', 'ask', 'ask_source', 'asset_identity_conflict', 'valuation_uncertain', 'min_comp_count', 'sources']),
    ...(o.comps ? { comps: pick(objOf(o.comps), ['selected', 'median_age_months', 'avg_distance_miles', 'dispersion', 'source']) } : {}),
    internal_only: 'Decision Engine economics: never communicated to a seller; offers follow their own human authorization' }),
  'research.property': (o) => pick(o, ['property_ref', 'needed', 'reasons', 'enqueued', 'job_id', 'deduped', 'skipped', 'result_received']),
  'finance.review_opportunity': (o) => pick(o, ['property_ref', 'verdict', 'reasons', 'supports', 'notes', 'figures', 'basis']),
  'acq.rank_opportunities': (o) => ({ ...pick(o, ['method', 'considered', 'n', 'excluded']), ranked: listOf(o.ranked).slice(0, 30).map((x) => pick(objOf(x), ['rank', 'property_ref', 'market', 'components', 'ev', 'cfo_verdict', 'escalated'])) }),
})
const CONTACT_SHAPE = /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
/** Defense in depth: an allowlisted projection that still carries a contact shape in a STRING fails closed. */
export function assertNoContact(v, path = '') {
  if (typeof v === 'string') { if (CONTACT_SHAPE.test(v)) throw gwErr('internal', 'CONTACT_SHAPE_IN_PROJECTION', `refused: a contact-shaped value at ${path || 'result'}`); return }
  if (Array.isArray(v)) { v.forEach((x, i) => assertNoContact(x, `${path}[${i}]`)); return }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertNoContact(x, path ? `${path}.${k}` : k)
}

// ── reads ────────────────────────────────────────────────────────────────────
const present = (v) => decodeStored(v)
const grantsOf = (principal) => (principal?.grants || []).filter((g) => String(g.capability).startsWith('workforce.'))
  .map((g) => ({ capability: g.capability, max_tier: `T${g.max_tier}`, expires_at: g.expires_at, suspended: Boolean(g.suspended_reason), suspended_reason: g.suspended_reason || null }))
async function guardedRead(kind, { input, store, services, principal, digest }) {
  if (!enabled(services)) throw off()
  const r = await store.workforceRead(digest, kind, input)
  if (!r?.registered) return { resource_type: 'workforce', registered: false, agent_id: principal?.agent_id ?? null, next: 'The owner registers this agent as a Workforce employee and binds this credential to it; then call leadcommand_workforce_link_self.' }
  return r
}

export const WF_LOGIC = Object.freeze({
  workforce_whoami: {
    async read(o) {
      const r = await guardedRead('whoami', { ...o, input: {} })
      if (r.registered === false) return r
      return present({ resource_type: 'workforce', registered: true, agent_id: r.agent_id, tier_ceiling: `T${r.tier_ceiling}`, employee: r.employee, manager: r.manager, grants: grantsOf(o.principal),
        open_assignments: r.open_assignments, linked: Boolean(r.employee?.external_agent_id) })
    },
  },
  workforce_list_assignments: {
    async read(o) {
      const r = await guardedRead('assignments', o)
      if (r.registered === false) return r
      return present({ resource_type: 'workforce', employee_id: r.employee_id, assignments: r.assignments, ...(r.mission_peers ? { mission_peers: r.mission_peers } : {}) })
    },
  },
  workforce_get_mission: {
    async read(o) {
      const r = await guardedRead('mission', o)
      if (r.registered === false) return r
      if (!r.found) throw gwErr('not_found', 'MISSION_NOT_FOUND', 'no mission with this id that you participate in or your sponsor requested')
      return present({ resource_type: 'workforce', visible_because: r.visible_because, mission: r.mission, assignments: r.assignments })
    },
  },

  workforce_get_mission_intelligence: {
    async read(o) {
      const r = await guardedRead('mission', o)
      if (r.registered === false) return r
      if (!r.found || r.visible_because !== 'participant') throw gwErr('not_found', 'MISSION_NOT_FOUND', 'no mission with this id that you participate in')
      const first = (r.assignments || [])[0]?.assignment_id
      if (!first) throw gwErr('not_found', 'MISSION_NOT_FOUND', 'the mission has no assignments yet')
      const c = await wfContext(o.store, o.digest, CAP.workforce_get_mission_intelligence, first)
      const all = Array.isArray(c.mission_assignments) ? c.mission_assignments : []
      if (!all.some((x) => x.assignee_employee_id === c.employee?.employee_id)) throw gwErr('not_found', 'MISSION_NOT_FOUND', 'no mission with this id that you participate in')
      const items = []
      const pending = []
      for (const a of all) {
        const project = INTEL[a.capability_key]
        if (!project) continue
        if (a.status !== 'completed') { pending.push({ step_key: a.step_key, capability: a.capability_key, status: a.status }); continue }
        items.push({ assignment_id: a.assignment_id, step_key: a.step_key, capability: a.capability_key, outcome_class: a.outcome_class, data: project(objOf(a.output)) })
      }
      const result = present({ resource_type: 'workforce', mission_id: r.mission?.mission_id, mission_status: r.mission?.status,
        provenance: 'Workforce engine: the authoritative capability outputs (deal-context, hold registry + never-revive, conversation state, Decision Engine, research, CFO review, ranking)',
        items, pending })
      assertNoContact(result)
      return result
    },
  },

  workforce_link_self: {
    available,
    async resolve(_input, { store, digest, spec }) { return resourceOf('link', await wfContextForLink(store, digest, spec.capability)) },
    params: (input) => ({ external_install_id: input.external_install_id, external_agent_id: input.external_agent_id }),
    async policy({ resource }) {
      const c = resource.refs.wf
      if (c.emergency_stop === true) return deny('EMERGENCY_STOP')
      if (c.employee?.origin !== 'agntei') return deny('NOT_AN_AGNTEI_EMPLOYEE')
      return allow({ employee_status: c.employee?.status ?? null })
    },
  },

  workforce_open_mission: {
    available,
    async resolve(_input, { store, digest, spec }) { return resourceOf('missions', await wfContext(store, digest, spec.capability)) },
    params(input) {
      const directive = cleanText(input.directive, WORKFORCE_LIMITS.directive_max_chars)
      return { directive, title: missionTitle(interpretDirective(directive)), assign_to_self: input.assign_to_self === true }
    },
    async policy({ resource, params }) {
      const c = resource.refs.wf
      const k = killSwitch(c)
      if (k) return k
      // the SAME interpreter as the Workforce routes: only an actionable directive opens a mission
      const interp = interpretDirective(params.directive)
      if (interp.refusal) return deny('DIRECTIVE_REFUSED', { intent: interp.intent, codes: interp.refusal.codes || [] })
      if (interp.intent === 'status_review') return deny('STATUS_IS_A_QUESTION', { intent: interp.intent })
      if (!interp.actionable) return deny('DIRECTIVE_UNCLEAR', { intent: interp.intent })
      return allow({ intent: interp.intent, origin: 'agntei' })
    },
  },

  workforce_claim_assignment: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params: (input) => ({ assignment_id: input.assignment_id, lease_seconds: input.lease_seconds ?? 900 }),
    async policy({ resource, services, now }) {
      const c = resource.refs.wf
      const k = killSwitch(c) || mineCheck(c)
      if (k) return k
      if (c.assignment.execution_mode !== 'external') return deny('NOT_EXTERNAL')
      return verdictToPolicy(await gatewayAuthority({ c, services, now }))
    },
  },

  workforce_report_progress: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params(input) {
      const output = { ...(normOutput(input.output) || {}),
        ...(input.progress ? { progress: { ...(input.progress.percent != null ? { percent: input.progress.percent } : {}), ...(input.progress.phase ? { phase: input.progress.phase } : {}), ...(input.progress.note ? { note: cleanText(input.progress.note, 600) } : {}) } } : {}),
        ...(input.cost ? { reported_cost: { usd: Math.round(input.cost.usd * 1e6) / 1e6, ...(input.cost.model ? { model: input.cost.model } : {}), status: 'reported', source: 'agntei' } } : {}) }
      return { assignment_id: input.assignment_id, claim_attempt: input.claim_attempt, ...(Object.keys(output).length ? { output } : {}), evidence: normRefs(input.evidence) }
    },
    async policy({ resource }) { return killSwitch(resource.refs.wf) || mineCheck(resource.refs.wf) || allow({ lease: 'checked_by_the_writer' }) },
  },

  workforce_complete_assignment: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params: (input) => ({ assignment_id: input.assignment_id, claim_attempt: input.claim_attempt, outcome_class: input.outcome_class || 'verified', output: normOutput(input.output) || {}, evidence: normRefs(input.evidence) }),
    async policy({ resource }) { return killSwitch(resource.refs.wf) || mineCheck(resource.refs.wf) || allow({ evidence: 'resolved_by_the_writer' }) },
  },

  workforce_request_research: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params(input, resource) {
      const a = resource.refs.wf.assignment
      const property_ref = a.resource_type === 'property' ? a.resource_key : input.property_id ? encodePropertyRef(String(input.property_id)) : a.input?.property_ref || null
      if (!property_ref) throw gwErr('invalid_input', 'PROPERTY_REQUIRED', 'this assignment names no property: pass property_id')
      return { assignment_id: input.assignment_id, claim_attempt: input.claim_attempt, property_ref, budget_usd: RESEARCH_BUDGET_USD }
    },
    async policy({ resource, services, now, params }) {
      const c = resource.refs.wf
      const k = killSwitch(c) || mineCheck(c)
      if (k) return k
      // research.property authority over the assignment's property (the charter, markets, holds, exclusions, budgets)
      const a = { ...c.assignment, capability_key: 'research.property', input: { ...(c.assignment.input || {}), property_ref: params.property_ref } }
      return verdictToPolicy(await gatewayAuthority({ c, services, now, capability: 'research.property', assignment: a }), { budget_usd: params.budget_usd })
    },
  },

  workforce_handoff: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params(input, resource) {
      if (Boolean(input.to_employee_id) === Boolean(input.to_coo)) throw gwErr('invalid_input', 'HANDOFF_TARGET', 'name exactly one of to_employee_id or to_coo')
      const to = input.to_employee_id || cooHandoffTarget(resource.refs.wf, resource.refs.wf.assignment)
      return { assignment_id: input.assignment_id, to_employee_id: to, to_coo: input.to_coo === true, ...(input.claim_attempt != null ? { claim_attempt: input.claim_attempt } : {}), ...(input.note ? { note: cleanText(input.note, 600) } : {}) }
    },
    async policy({ resource, params }) {
      const c = resource.refs.wf
      const k = killSwitch(c) || mineCheck(c)
      if (k) return k
      if (!params.to_employee_id) return deny('NO_INTERNAL_ASSIGNEE', { capability: c.assignment.capability_key })
      if (params.claim_attempt != null && ['leased', 'running'].includes(c.assignment.status) && params.claim_attempt !== c.assignment.attempt) return deny('LEASE_LOST', { stage: 'lease_generation' })
      return allow({ to_employee_id: params.to_employee_id, seller_facing: false })
    },
  },

  workforce_escalate: {
    available,
    async resolve(input, { store, digest, spec }) { const c = await wfContext(store, digest, spec.capability, input.assignment_id); mineOrThrow(c, input.assignment_id); return resourceOf(input.assignment_id, c) },
    params: (input) => ({ assignment_id: input.assignment_id, reasons: [...new Set(input.reasons.map((r) => String(r).toUpperCase()))].slice(0, 8), ...(input.note ? { note: cleanText(input.note, 600) } : {}) }),
    async policy({ resource }) {
      const c = resource.refs.wf
      if (c.emergency_stop === true) return deny('EMERGENCY_STOP')
      return mineCheck(c) || (['completed', 'failed', 'cancelled'].includes(c.assignment.status) ? deny('ASSIGNMENT_TERMINAL') : allow({ queue: 'ceo' }))
    },
  },
})

/** link_self runs BEFORE the employee is active: the context read without the active-employee rule (binding still enforced). */
async function wfContextForLink(store, digest, capability) {
  return wfContext(store, digest, capability)
}

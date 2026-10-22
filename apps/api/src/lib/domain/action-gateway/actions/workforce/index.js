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
import { MODEL_RESULT_BUDGET, CURSOR_PATTERN, PART_PATTERN, at, decodeCursor, encodeCursor, pageRows, pagePart, condense } from './page.js'

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
// recommendation: 1,500 (was 600 — a live model ranking ten properties exceeded it on every run and, to fit, dropped its findings)
export const RECOMMENDATION_MAX = 1500
const OUTPUT = obj({ summary: TEXT(2000), findings: list(TEXT(400), 20), next_steps: list(TEXT(300), 10), recommendation: TEXT(RECOMMENDATION_MAX) })
const CLAIM_ATTEMPT = int(0, 10)
const CURSOR = str(400, { minLength: 4, pattern: CURSOR_PATTERN })
const PART = str(200, { minLength: 1, pattern: PART_PATTERN })
const PAGING = 'Results are bounded for a model (about 5,600 characters): a list answers page {next_cursor, complete}; pass next_cursor back as cursor for the next page. A row too large for one page shows its largest members as {_paged, read_with}: call read_with to read that member (itself paged). Nothing is ever cut silently.'
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
    description: `The assignments assigned to you (newest first, the newest 100; optionally one status, one mission or one assignment_id), each with its mission, step, capability, status, execution mode, input, output and evidence; with include_mission_peers, a summary of the other assignments of the missions you work on. With assignment_id + part (e.g. input.candidates, output.research, evidence) it reads that one member of that assignment, paged. ${PAGING} Read only.`,
    input: obj({ status: enumOf(ASSIGNMENT_STATUSES), mission_id: WFM, assignment_id: WFA, include_mission_peers: bool(), limit: int(1, 100), part: PART, cursor: CURSOR }), limits: { per_min: 60 }, wraps: wraps('action_gateway_workforce_read(assignments)') }),
  Object.freeze({ name: 'workforce_get_mission', title: 'Read one Workforce mission', tier: TIERS.T1, scope: null, resource: 'workforce', capability: CAP.workforce_get_mission, risk: 'read',
    description: `A mission you participate in (or one your sponsor, the CEO, requested): its directive, status, origin, plan, report and assignments (your own in full, the others as a summary). With part (e.g. mission.report, mission.plan.steps, assignments) it reads that one member, paged. ${PAGING} Read only.`,
    input: obj({ mission_id: WFM, part: PART, cursor: CURSOR }, ['mission_id']), limits: { per_min: 60 }, wraps: wraps('action_gateway_workforce_read(mission)') }),
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
    description: 'Lease an assignment assigned to you (execution mode external) and take its resource claim. Refused when another employee holds the resource (CLAIM_HELD), a person owns it (HUMAN_OWNED), it is not due or not yours. Returns result.claim_attempt (the lease generation; NOT the envelope\'s own `attempt`): pass it as claim_attempt to report / complete / request research (a reaped lease makes later calls LEASE_LOST).',
    input: obj({ ...client, assignment_id: WFA, lease_seconds: int(60, 3600) }, ['client_request_id', 'assignment_id']),
    wraps: wraps('action_gateway_dw_workforce(workforce_claim_assignment) → workforce.assignment_claim_external') }),
  write({ name: 'workforce_report_progress', title: 'Report progress on my assignment', capability: CAP.workforce_report_progress, limits: { per_min: 60 },
    description: 'Heartbeat + progress (percent, phase, note), partial output, evidence refs and your own reported model cost, under your live lease (claim_attempt from the claim). The cost is shown as reported, not verified.',
    input: obj({ ...client, assignment_id: WFA, claim_attempt: CLAIM_ATTEMPT, progress: obj({ percent: int(0, 100), phase: PHASE, note: TEXT(600) }), output: OUTPUT, evidence: EVIDENCE,
      cost: obj({ usd: num(0, 100), model: MODEL }, ['usd']) }, ['client_request_id', 'assignment_id', 'claim_attempt']),
    wraps: wraps('action_gateway_dw_workforce(workforce_report_progress) → workforce.assignment_progress') }),
  write({ name: 'workforce_complete_assignment', title: 'Complete my assignment', capability: CAP.workforce_complete_assignment,
    description: 'Finish your assignment with an output and evidence. outcome_class verified needs at least one evidence ref LeadCommand can resolve: a completed research job of this mission (type job, the job_id request_research returned), one of your succeeded gateway intents, or a record you read through a LOGGED Action Gateway read (type thread: a thread_id you read with read_conversation_context). Reads through the separate read-only LeadCommand MCP are not gateway-logged and never resolve (cite them, they are stored as reported). Otherwise it is stored as partial / unknown, never verified. Field limits: summary 2000, recommendation 1500, up to 20 findings of 400 characters each (put per-property findings in findings, not in the recommendation).',
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
  ...(o.recommendation ? { recommendation: cleanText(o.recommendation, RECOMMENDATION_MAX) } : {}),
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

// ── reads ────────────────────────────────────────────────────────────────────
// What an AGENT reads: stored text decoded (~e~ markers), but a property ref stays its opaque pid_ ref. Decoded to digits it
// was masked by the MCP's second net (a 10-digit id is phone-shaped), so the agent could neither cite nor research the
// property it had just read; the ref is what request_research (property_id) and evidence (type property) accept.
const present = (v, depth = 0) => {
  if (depth > 12 || v == null) return v
  if (Array.isArray(v)) return v.map((x) => present(x, depth + 1))
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_v1$/, ''), present(x, depth + 1)]))
  if (typeof v === 'string' && !/^pid_[g-p]{1,20}$/.test(v)) return decodeStored(v)
  return v
}
const ASSIGNMENT_ROOTS = ['input', 'output', 'evidence', 'last_error']
const MCP = (name) => `leadcommand_${name}`
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
      const head = present({ resource_type: 'workforce', registered: true, agent_id: r.agent_id, tier_ceiling: `T${r.tier_ceiling}`, employee: r.employee, manager: r.manager, grants: grantsOf(o.principal), linked: Boolean(r.employee?.external_agent_id) })
      // the identity and the grants are never paged; the open assignments share the rest of the budget
      const rows = present(r.open_assignments || [])
      const pg = pageRows(rows, { kind: 'whoami', extra: JSON.stringify(head).length, readWith: (row, p) => ({ tool: MCP('workforce_list_assignments'), arguments: { assignment_id: row.assignment_id, part: p } }), roots: ASSIGNMENT_ROOTS })
      return { ...head, open_assignments: pg.items, open_assignments_page: pg.page.next_cursor ? { ...pg.page, next_cursor: null, more_with: { tool: MCP('workforce_list_assignments'), arguments: {} } } : pg.page }
    },
  },
  workforce_list_assignments: {
    async read(o) {
      const input = o.input || {}
      if (input.part && !input.assignment_id) throw gwErr('invalid_input', 'ASSIGNMENT_REQUIRED', 'part reads one member of ONE assignment: pass assignment_id too')
      const r = await guardedRead('assignments', { ...o, input: { status: input.status, mission_id: input.mission_id, assignment_id: input.assignment_id, include_mission_peers: input.include_mission_peers, limit: input.part ? 1 : Math.min(Number(input.limit) || 100, 100) } })
      if (r.registered === false) return r
      const rows = present(r.assignments || [])
      if (input.part) {
        const row = rows.find((x) => x.assignment_id === input.assignment_id)
        if (!row) throw gwErr('not_found', 'ASSIGNMENT_NOT_FOUND', 'no assignment with this id is assigned to you')
        const kind = `part:${input.assignment_id}:${input.part}`
        const c = decodeCursor(input.cursor, kind)
        return { resource_type: 'workforce', employee_id: r.employee_id, assignment_id: row.assignment_id,
          ...pagePart(at(row, input.part), { part: input.part, offset: c?.o ?? 0, kind, extra: 200, readWith: (p) => ({ tool: MCP('workforce_list_assignments'), arguments: { assignment_id: row.assignment_id, part: p } }) }) }
      }
      const kind = `assignments:${input.status || ''}:${input.mission_id || ''}:${input.assignment_id || ''}:${input.include_mission_peers ? 1 : 0}`
      const c = decodeCursor(input.cursor, kind)
      const readWith = (row, p) => ({ tool: MCP('workforce_list_assignments'), arguments: { assignment_id: row.assignment_id, part: p } })
      const peers = r.mission_peers ? present(r.mission_peers) : null
      // own rows first; the peers' summaries continue the same list (one cursor)
      const all = [...rows.map((x) => ({ own: true, row: x })), ...(peers || []).map((x) => ({ own: false, row: x }))]
      const off = c?.o ?? 0
      const pg = pageRows(all.map((x) => x.row), { offset: off, kind, readWith, roots: ASSIGNMENT_ROOTS, extra: 120 })
      const ownItems = pg.items.filter((_, j) => all[off + j]?.own)
      const peerItems = pg.items.filter((_, j) => !all[off + j]?.own)
      return { resource_type: 'workforce', employee_id: r.employee_id, assignments: ownItems, ...(peers ? { mission_peers: peerItems } : {}), page: { ...pg.page, own_total: rows.length, ...(peers ? { peers_total: peers.length } : {}) } }
    },
  },
  workforce_get_mission: {
    async read(o) {
      const input = o.input || {}
      const r = await guardedRead('mission', { ...o, input: { mission_id: input.mission_id } })
      if (r.registered === false) return r
      if (!r.found) throw gwErr('not_found', 'MISSION_NOT_FOUND', 'no mission with this id that you participate in or your sponsor requested')
      const whole = present({ mission: r.mission, assignments: r.assignments || [] })
      const readWith = (p) => ({ tool: MCP('workforce_get_mission'), arguments: { mission_id: input.mission_id, part: p } })
      if (input.part) {
        const kind = `mpart:${input.mission_id}:${input.part}`
        const c = decodeCursor(input.cursor, kind)
        return { resource_type: 'workforce', visible_because: r.visible_because, mission_id: input.mission_id, ...pagePart(at(whole, input.part), { part: input.part, offset: c?.o ?? 0, kind, extra: 200, readWith }) }
      }
      // the mission row (its plan and report behind stubs when large), then its assignments paged in the rest of the budget
      const kind = `mission:${input.mission_id}`
      const c = decodeCursor(input.cursor, kind)
      const m = condense(whole.mission, { budget: Math.floor(MODEL_RESULT_BUDGET * 0.45), roots: ['plan', 'report', 'objective', 'directive'], readWith: (p) => readWith(`mission.${p}`) })
      const pg = pageRows(whole.assignments, { offset: c?.o ?? 0, kind, extra: JSON.stringify(m.row).length + 200, roots: ASSIGNMENT_ROOTS, readWith: (row, p) => readWith(`assignments.${whole.assignments.indexOf(row)}.${p}`) })
      return { resource_type: 'workforce', visible_because: r.visible_because, mission: m.row, assignments: pg.items, page: { ...pg.page, complete: pg.page.complete && !m.stubbed.length, ...(m.stubbed.length ? { mission_condensed: m.stubbed } : {}) } }
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

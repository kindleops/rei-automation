// Workforce store — memory twin (docs/WORKFORCE.md §11). The engine's unit-test store.
//
// Every method mirrors the workforce.* SQL function of the same name in
// PROPOSED_20261022100000_workforce_foundation.sql: the same idempotency, state graphs
// (transitions.js), lease-token checks, supersede rules, exclusive resource claims, payload
// refusals (payload-guard.js = the S3 CHECKs), owner checks and emitted events. A method either
// commits completely or not at all (the state is restored on any throw, as a rolled-back
// transaction). tests/critical/workforce-store-conformance.test.mjs runs the SAME cases against
// this twin and Postgres, so the two cannot diverge silently.
//
//   createWorkforceMemoryStore({ now, orgs?, members? })
//     now      () => ms | Date | ISO   the clock (clock_timestamp())
//     orgs     org ids that exist (agent.org); default: the single LeadCommand org
//     members  [{ org_id, user_id, role: 'owner' | 'operator' }] (agent.operator_membership)
import crypto from 'node:crypto'
import { WorkforceStoreError } from './errors.js'
import {
  ASSIGNMENT_STATES, MISSION_STATES, ROLE_DEPARTMENTS, ROLE_KEYS, DEPARTMENT_KEYS, EMPLOYEE_STATUSES, OUTCOME_CLASSES, RESOURCE_TYPES,
  MEMORY_SCOPES, EPISTEMIC_CLASSES, canAssignmentTransition, canMissionTransition, backoffSeconds,
} from './transitions.js'
import { isClean, textClean, stringViolation, jsonBytes, asJsonb } from './payload-guard.js'
import {
  shapeEmployee, shapeMission, shapeAssignment, shapeClaim, shapeEvent, shapeExecMessage, shapeFact, shapePolicy, shapeSettings, shapeKpi,
} from './shape.js'

export const LEADCOMMAND_ORG_ID = '00000000-0000-4000-8000-00000000a001'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL = ['completed', 'failed', 'cancelled']
const ID_SHAPE = { mission: /^wfm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, job: /^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }
const STEP_RE = /^[a-z][a-z0-9_.:-]{0,79}$/
const RESOURCE_KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const OWNER_RE = /^[A-Za-z0-9_.:-]{1,80}$/

const fail = (code, message) => { throw new WorkforceStoreError(code, `WF_${code}: ${message}`) }
const refuse = (message) => fail('PAYLOAD_REFUSED', message)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v == null ? v : structuredClone(v))
const clamp = (v, d, lo, hi) => Math.min(Math.max(Number.isFinite(Number(v)) && v != null ? Math.trunc(Number(v)) : d, lo), hi)
const asList = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)])
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** a uuid parameter: NULL stays NULL; anything else must parse (22P02 → PAYLOAD_REFUSED) */
function uuidParam(v, name) {
  if (v == null) return null
  if (typeof v !== 'string' || !UUID_RE.test(v)) refuse(`${name} is not a uuid`)
  return v.toLowerCase()
}
function intParam(v, name) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isInteger(n)) refuse(`${name} is not an integer`)
  return n
}
function numParam(v, name) {
  if (v == null) return null
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) refuse(`${name} is not a number`)
  return n
}
function tsParam(v, name) {
  if (v == null) return null
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v))
  if (!Number.isFinite(ms)) refuse(`${name} is not a timestamp`)
  return new Date(ms).toISOString()
}
const textArray = (v, name) => {
  if (v == null) return []
  if (!Array.isArray(v)) refuse(`${name} must be an array`)
  return v.map((x) => (x == null ? null : String(x)))
}
const listOk = (arr, re) => Array.isArray(arr) && arr.length <= 50 && arr.every((x) => typeof x === 'string' && re.test(x)) && new Set(arr).size === arr.length
const cleanObj = (v, max) => isObj(v) && jsonBytes(v) <= max && isClean(v)
const round = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)

export function createWorkforceMemoryStore({ now = () => Date.now(), orgs = [LEADCOMMAND_ORG_ID], members = [] } = {}) {
  const clockMs = () => {
    const v = typeof now === 'function' ? now() : now
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v))
    return Number.isFinite(ms) ? ms : Date.now()
  }
  const clock = () => new Date(clockMs()).toISOString()
  const addSec = (isoTs, s) => new Date(Date.parse(isoTs) + s * 1000).toISOString()

  let S = {
    orgs: new Set(orgs.map((o) => String(o).toLowerCase())),
    members: members.map((m) => ({ org_id: String(m.org_id).toLowerCase(), user_id: String(m.user_id).toLowerCase(), role: m.role || 'operator' })),
    employees: new Map(), missions: new Map(), assignments: new Map(), claims: new Map(), events: [], messages: [], facts: new Map(),
    policies: new Map(), settings: new Map(), kpis: new Map(), seq: 0, eventId: 0,
  }
  for (const o of S.orgs) if (o === LEADCOMMAND_ORG_ID) S.settings.set(o, { org_id: o, exec_review_price_usd: 5000000, escalation: {}, updated_at: clock(), updated_by: 'migration' })

  /** one transaction: the whole state is restored on any throw */
  async function atomic(fn) {
    const snap = structuredClone(S)
    try {
      return await fn()
    } catch (e) {
      S = snap
      throw e
    }
  }
  const nextSeq = () => { S.seq += 1; return S.seq }
  const orgExists = (org) => S.orgs.has(org)
  const isOwner = (org, user) => user != null && S.members.some((m) => m.org_id === org && m.user_id === user && m.role === 'owner')
  const actorOk = (org, actor) => (typeof actor === 'string' && UUID_RE.test(actor)) || (actor != null && S.employees.get(actor)?.org_id === org)
  const orgParam = (org) => {
    const o = uuidParam(org, 'org_id')
    if (o == null) refuse('org_id required')
    return o
  }

  // ── row checks (the table CHECK / NOT NULL / UNIQUE / FK constraints, in that order) ──
  function checkEmployee(e) {
    if (typeof e.employee_id !== 'string' || !/^emp_[a-z0-9_]{3,40}$/.test(e.employee_id)) refuse('employee_id shape')
    if (!['ai', 'human'].includes(e.kind)) refuse('kind')
    if (!ROLE_KEYS.includes(e.role_key)) refuse('role_key')
    if (!DEPARTMENT_KEYS.includes(e.department_key)) refuse('department_key')
    if (typeof e.display_name !== 'string' || e.display_name.length < 1 || e.display_name.length > 80 || !textClean(e.display_name)) refuse('display_name')
    if (e.employee_code != null && !/^[A-Z]{2,6}-[0-9]{2,3}$/.test(e.employee_code)) refuse('employee_code')
    if (e.action_principal_id != null && !/^agt_[a-z0-9][a-z0-9_]{2,40}$/.test(e.action_principal_id)) refuse('action_principal_id')
    if (!EMPLOYEE_STATUSES.includes(e.status)) refuse('status')
    if (!listOk(e.markets, /^[a-z0-9][a-z0-9_.:-]{0,79}$/)) refuse('markets')
    if (!cleanObj(e.segments, 4096)) refuse('segments')
    if (!['T1', 'T2'].includes(e.tier_ceiling)) refuse('tier_ceiling')
    if (!(e.spend_day_cap_usd >= 0 && e.spend_day_cap_usd <= 5)) refuse('spend_day_cap_usd')
    if (!(ROLE_DEPARTMENTS[e.role_key] || []).includes(e.department_key)) refuse('role / department')
    if (e.role_key === 'ceo' && !(e.kind === 'human' && e.user_id != null)) refuse('the CEO is a human with a user id')
    if (e.kind !== 'human' && e.user_id != null) refuse('an AI employee has no user id')
    if (e.manager_employee_id != null && e.manager_employee_id === e.employee_id) refuse('self manager')
    for (const o of S.employees.values()) {
      if (o.employee_id === e.employee_id) continue
      if (e.role_key === 'ceo' && o.role_key === 'ceo' && o.org_id === e.org_id) fail('CONFLICT', 'one ceo per org')
      if (e.employee_code != null && o.employee_code === e.employee_code && o.org_id === e.org_id) fail('CONFLICT', 'employee_code taken')
    }
    if (!orgExists(e.org_id)) fail('NOT_FOUND', 'org')
    if (e.manager_employee_id != null && !S.employees.has(e.manager_employee_id) && e.manager_employee_id !== e.employee_id) fail('NOT_FOUND', `manager ${e.manager_employee_id}`)
  }
  function checkMission(m) {
    if (!ID_SHAPE.mission.test(m.mission_id)) refuse('mission_id')
    if (typeof m.title !== 'string' || m.title.length < 1 || m.title.length > 200 || !textClean(m.title)) refuse('title')
    if (typeof m.directive !== 'string' || m.directive.length < 1 || m.directive.length > 8000 || !textClean(m.directive)) refuse('directive')
    if (!cleanObj(m.objective, 8192)) refuse('objective')
    if (m.playbook_key != null && !/^[a-z][a-z0-9_]{1,60}$/.test(m.playbook_key)) refuse('playbook_key')
    if (!MISSION_STATES.includes(m.status)) refuse('status')
    if (!Number.isInteger(m.priority) || m.priority < 0 || m.priority > 100) refuse('priority')
    if (!cleanObj(m.plan, 65536)) refuse('plan')
    if (m.report != null && !cleanObj(m.report, 65536)) refuse('report')
    if (TERMINAL.includes(m.status) !== (m.completed_at != null)) refuse('terminal stamp')
    if (!orgExists(m.org_id)) fail('NOT_FOUND', 'org')
  }
  function checkAssignment(a) {
    if (!/^wfa_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.assignment_id)) refuse('assignment_id')
    if (typeof a.step_key !== 'string' || !STEP_RE.test(a.step_key)) refuse('step_key')
    if (typeof a.capability_key !== 'string' || !/^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,60}$/.test(a.capability_key)) refuse('capability_key')
    if (!ASSIGNMENT_STATES.includes(a.status)) refuse('status')
    if (!listOk(a.depends_on, STEP_RE)) refuse('depends_on')
    if (a.outcome_class != null && !OUTCOME_CLASSES.includes(a.outcome_class)) refuse('outcome_class')
    if (a.runtime_job_id != null && !ID_SHAPE.job.test(a.runtime_job_id)) refuse('runtime_job_id')
    if (a.resource_type != null && !RESOURCE_TYPES.includes(a.resource_type)) refuse('resource_type')
    if (a.resource_key != null && (typeof a.resource_key !== 'string' || !RESOURCE_KEY_RE.test(a.resource_key))) refuse('resource_key')
    if (!Number.isInteger(a.max_attempts) || a.max_attempts < 1 || a.max_attempts > 5) refuse('max_attempts')
    if (a.lease_owner != null && !OWNER_RE.test(a.lease_owner)) refuse('lease_owner')
    if (a.lease_seconds != null && !(a.lease_seconds >= 15 && a.lease_seconds <= 3600)) refuse('lease_seconds')
    if (!(a.attempt >= 0 && a.attempt <= a.max_attempts)) refuse('attempts')
    const leaseNull = a.lease_token == null
    if (leaseNull !== (a.lease_until == null) || leaseNull !== (a.lease_owner == null) || leaseNull !== (a.lease_seconds == null)) refuse('lease shape')
    if (['leased', 'running'].includes(a.status) === leaseNull) refuse('lease iff active')
    if (a.status === 'waiting_job' && a.runtime_job_id == null) refuse('waiting_job has a job')
    if (a.status === 'completed' && a.outcome_class == null) refuse('completed has an outcome')
    if (TERMINAL.includes(a.status) !== (a.finished_at != null)) refuse('terminal stamp')
    if ((a.resource_type == null) !== (a.resource_key == null)) refuse('resource pair')
    if (a.depends_on.includes(a.step_key)) refuse('self dependency')
    if (a.parent_assignment_id != null && a.parent_assignment_id === a.assignment_id) refuse('self parent')
    if (a.resource_key != null && stringViolation(a.resource_key, 'resource_key', 0) != null) refuse('resource_key not clean')
    if (!cleanObj(a.input, 16384)) refuse('input')
    if (a.output != null && !cleanObj(a.output, 32768)) refuse('output')
    if (!Array.isArray(a.evidence) || a.evidence.length > 100 || jsonBytes(a.evidence) > 16384 || !isClean({ evidence_refs: a.evidence })) refuse('evidence')
    if (a.last_error != null && !cleanObj(a.last_error, 4096)) refuse('last_error')
  }
  /** workforce.assignment_guard (UPDATE) */
  function guardAssignment(old, next) {
    for (const k of ['assignment_id', 'org_id', 'mission_id', 'step_key', 'capability_key', 'parent_assignment_id', 'max_attempts', 'created_at']) {
      if (old[k] !== next[k]) fail('CONFLICT', `WF_IMMUTABLE: ${k}`)
    }
    if (JSON.stringify(old.depends_on) !== JSON.stringify(next.depends_on) || JSON.stringify(old.input) !== JSON.stringify(next.input)) fail('CONFLICT', 'WF_IMMUTABLE: depends_on / input')
    if (TERMINAL.includes(old.status)) fail('ILLEGAL_TRANSITION', `a ${old.status} assignment is terminal`)
    if (next.status !== old.status && !canAssignmentTransition(old.status, next.status)) fail('ILLEGAL_TRANSITION', `assignment ${old.status} → ${next.status}`)
    if (next.attempt < old.attempt) fail('CONFLICT', 'WF_IMMUTABLE: attempt never decreases')
  }
  function writeAssignment(old, patch) {
    const next = { ...old, ...patch, updated_at: clock() }
    guardAssignment(old, next)
    checkAssignment(next)
    S.assignments.set(next.assignment_id, next)
    return next
  }
  function writeMission(old, patch) {
    const next = { ...old, ...patch, updated_at: clock() }
    if (TERMINAL.includes(old.status)) fail('ILLEGAL_TRANSITION', `a ${old.status} mission is terminal`)
    if (next.status !== old.status && !canMissionTransition(old.status, next.status)) fail('ILLEGAL_TRANSITION', `mission ${old.status} → ${next.status}`)
    checkMission(next)
    S.missions.set(next.mission_id, next)
    return next
  }

  // ── events ──
  function emit(org, type, mission_id, assignment_id, employee_id, payload = {}) {
    const p = asJsonb(payload ?? {})
    if (typeof type !== 'string' || !/^wf\.[a-z_.]+$/.test(type) || type.length > 80) refuse('event type')
    if (!cleanObj(p, 8192)) refuse('event payload')
    S.eventId += 1
    const e = { event_id: S.eventId, org_id: org, at: clock(), mission_id: mission_id ?? null, assignment_id: assignment_id ?? null, employee_id: employee_id ?? null, type, payload: p }
    S.events.push(e)
    return e
  }
  const emitAssignment = (a, from, reason = null) => emit(a.org_id, 'wf.assignment.transitioned', a.mission_id, a.assignment_id, a.assignee_employee_id,
    { from, to: a.status, attempt: a.attempt, step: a.step_key, ...(reason != null ? { reason } : {}) })
  function releaseClaimsOf(assignment_id, reason) {
    let n = 0
    for (const c of [...S.claims.values()].sort((x, y) => (x.claim_id < y.claim_id ? -1 : 1))) {
      if (c.assignment_id !== assignment_id || c.released_at != null) continue
      const released = new Date(Math.max(clockMs(), Date.parse(c.claimed_at) + 1)).toISOString()
      S.claims.set(c.claim_id, { ...c, released_at: released, release_reason: reason })
      emit(c.org_id, 'wf.resource.released', null, assignment_id, c.employee_id, { resource_type: c.resource_type, resource: c.resource_key, reason })
      n += 1
    }
    return n
  }
  const touchEmployee = (id) => { const e = S.employees.get(id); if (e) S.employees.set(id, { ...e, last_activity_at: clock() }) }
  const sortSeq = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a._seq - b._seq)
  const leased = (org, id, token) => {
    const a = S.assignments.get(id)
    if (!a || a.org_id !== org) fail('NOT_FOUND', `assignment ${id}`)
    if (token == null || a.lease_token !== token || !['leased', 'running'].includes(a.status)) fail('LEASE_LOST', `assignment ${id} is ${a.status} (lease not held)`)
    return a
  }
  const out = (shape, row) => shape(clone(row))

  const store = {
    kind: 'memory',
    /** test hooks (never part of the engine contract) */
    _state: () => S,
    _addMember({ org_id, user_id, role = 'owner' }) { S.members.push({ org_id: String(org_id).toLowerCase(), user_id: String(user_id).toLowerCase(), role }) },

    // ── org / employees ──
    async listEmployees({ org_id, status = null } = {}) {
      const st = asList(status)
      return [...S.employees.values()].filter((e) => e.org_id === org_id && (!st || st.includes(e.status)))
        .sort((a, b) => a.department_key.localeCompare(b.department_key) || a.role_key.localeCompare(b.role_key) || a.employee_id.localeCompare(b.employee_id))
        .map((e) => out(shapeEmployee, e))
    },
    async getEmployee({ org_id, employee_id }) {
      const e = S.employees.get(employee_id)
      return e && e.org_id === org_id ? out(shapeEmployee, e) : null
    },
    upsertEmployee: ({ org_id, employee, actor_user_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const actor = uuidParam(actor_user_id, 'actor_user_id')
      if (!isOwner(org, actor)) fail('FORBIDDEN', 'employees are CEO-authored (actor is not an owner of the org)')
      const p = asJsonb(employee)
      if (!isObj(p)) refuse('employee must be an object')
      const allowed = ['employee_id', 'kind', 'role_key', 'department_key', 'display_name', 'employee_code', 'manager_employee_id', 'user_id', 'action_principal_id',
        'status', 'markets', 'segments', 'tier_ceiling', 'spend_day_cap_usd']
      if (Object.keys(p).some((k) => !allowed.includes(k))) refuse('unknown employee field')
      const id = p.employee_id == null ? null : String(p.employee_id)
      if (id == null) refuse('employee_id required')
      let markets
      if (own(p, 'markets')) {
        if (!Array.isArray(p.markets)) refuse('markets must be an array')
        markets = p.markets.map((x) => (x == null ? null : typeof x === 'string' ? x : JSON.stringify(x)))
      }
      const s = (k) => (p[k] == null ? null : String(p[k]))
      const existing = S.employees.get(id)
      let e
      let created = false
      if (existing) {
        if (existing.org_id !== org) fail('NOT_FOUND', `employee ${id}`)
        if (own(p, 'kind') && s('kind') !== existing.kind) fail('CONFLICT', "an employee's kind never changes")
        e = { ...existing }
        for (const k of ['role_key', 'department_key', 'display_name', 'employee_code', 'manager_employee_id', 'action_principal_id', 'status', 'tier_ceiling']) if (own(p, k)) e[k] = s(k)
        if (own(p, 'user_id')) e.user_id = uuidParam(p.user_id, 'user_id')
        if (own(p, 'markets')) e.markets = markets
        if (own(p, 'segments')) e.segments = p.segments === undefined ? {} : p.segments
        if (own(p, 'spend_day_cap_usd')) e.spend_day_cap_usd = round(numParam(p.spend_day_cap_usd, 'spend_day_cap_usd'), 2)
        e.updated_at = clock()
        if (e.role_key == null || e.department_key == null || e.display_name == null || e.status == null || e.tier_ceiling == null || e.spend_day_cap_usd == null) refuse('not null')
      } else {
        const t = clock()
        e = {
          employee_id: id, org_id: org, kind: s('kind'), role_key: s('role_key'), department_key: s('department_key'), display_name: s('display_name'),
          employee_code: s('employee_code'), manager_employee_id: s('manager_employee_id'), user_id: uuidParam(p.user_id, 'user_id'),
          action_principal_id: s('action_principal_id'), status: s('status') ?? 'active', markets: markets ?? [],
          segments: own(p, 'segments') ? p.segments : {}, tier_ceiling: s('tier_ceiling') ?? 'T1',
          spend_day_cap_usd: round(numParam(p.spend_day_cap_usd, 'spend_day_cap_usd') ?? 0, 2),
          heartbeat_at: null, last_activity_at: null, created_by: actor, created_at: t, updated_at: t,
        }
        if (e.kind == null || e.role_key == null || e.department_key == null || e.display_name == null) refuse('not null')
        created = true
      }
      checkEmployee(e)
      S.employees.set(id, e)
      if (e.manager_employee_id != null) {
        const m = S.employees.get(e.manager_employee_id)
        if (!m || m.org_id !== org) fail('NOT_FOUND', `manager ${e.manager_employee_id}`)
        let cur = e.manager_employee_id
        for (let depth = 1; cur != null && depth <= 64; depth += 1) {
          if (cur === e.employee_id) fail('CONFLICT', `the manager chain of ${e.employee_id} would be a cycle`)
          cur = S.employees.get(cur)?.manager_employee_id ?? null
        }
      }
      emit(org, 'wf.employee.upserted', null, null, e.employee_id, { created, role: e.role_key, status: e.status })
      return out(shapeEmployee, e)
    }),
    heartbeatEmployee: ({ org_id, employee_id, at = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const t = tsParam(at, 'at')
      const e = S.employees.get(employee_id)
      if (!e || e.org_id !== org) fail('NOT_FOUND', `employee ${employee_id}`)
      S.employees.set(employee_id, { ...e, heartbeat_at: t ?? clock() })
    }),

    // ── missions ──
    openMission: ({ org_id, title, directive, requested_by, owner_employee_id, priority = null, due_at = null, idempotency_key }) => atomic(async () => {
      const org = orgParam(org_id)
      const by = uuidParam(requested_by, 'requested_by')
      const prio = intParam(priority, 'priority')
      const due = tsParam(due_at, 'due_at')
      if (by == null) fail('FORBIDDEN', 'requested_by must be the named operator')
      if (idempotency_key == null || String(idempotency_key).length < 1 || String(idempotency_key).length > 200) refuse('idempotency_key required (1..200 chars)')
      const key = crypto.createHash('sha256').update(`workforce.mission\u001f${org}\u001f${idempotency_key}`, 'utf8').digest('hex')
      const existing = [...S.missions.values()].find((m) => m.org_id === org && m.idempotency_key === key)
      if (existing) return { mission: out(shapeMission, existing), created: false }
      const owner = S.employees.get(owner_employee_id)
      if (!owner || owner.org_id !== org) fail('NOT_FOUND', `owner employee ${owner_employee_id}`)
      const t = clock()
      const m = {
        mission_id: `wfm_${crypto.randomUUID()}`, org_id: org, title: title == null ? null : String(title), directive: directive == null ? null : String(directive),
        objective: {}, playbook_key: null, owner_employee_id, requested_by: by, status: 'planning', priority: prio ?? 50, due_at: due, plan: {}, plan_version: 0,
        report: null, idempotency_key: key, created_at: t, updated_at: t, completed_at: null, _seq: nextSeq(),
      }
      if (m.title == null || m.directive == null) refuse('not null')
      checkMission(m)
      S.missions.set(m.mission_id, m)
      emit(org, 'wf.mission.opened', m.mission_id, null, m.owner_employee_id, { status: m.status, priority: m.priority })
      return { mission: out(shapeMission, m), created: true }
    }),
    async getMission({ org_id, mission_id }) {
      const m = S.missions.get(mission_id)
      return m && m.org_id === org_id ? out(shapeMission, m) : null
    },
    async listMissions({ org_id, status = null, limit = 50, before = null } = {}) {
      const st = asList(status)
      const b = before == null ? null : new Date(before).toISOString()
      return [...S.missions.values()].filter((m) => m.org_id === org_id && (!st || st.includes(m.status)) && (b == null || m.created_at < b))
        .sort((x, y) => -sortSeq(x, y)).slice(0, clamp(limit, 50, 1, 200)).map((m) => out(shapeMission, m))
    },
    setMissionPlan: ({ org_id, mission_id, objective = null, playbook_key = null, plan, expected_version }) => atomic(async () => {
      const org = orgParam(org_id)
      const ev = intParam(expected_version, 'expected_version')
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      if (TERMINAL.includes(m.status)) fail('ILLEGAL_TRANSITION', `a ${m.status} mission cannot be re-planned`)
      if (ev == null || m.plan_version !== ev) fail('VERSION_MISMATCH', `plan_version is ${m.plan_version}, expected ${ev}`)
      const next = writeMission(m, {
        objective: objective == null ? m.objective : asJsonb(objective), playbook_key: playbook_key ?? m.playbook_key,
        plan: plan == null ? {} : asJsonb(plan), plan_version: m.plan_version + 1,
      })
      emit(org, 'wf.mission.plan_set', next.mission_id, null, next.owner_employee_id, { plan_version: next.plan_version, playbook: next.playbook_key })
      return out(shapeMission, next)
    }),
    transitionMission: ({ org_id, mission_id, to, report = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      if (m.status === to) return out(shapeMission, m)
      if (!canMissionTransition(m.status, to)) fail('ILLEGAL_TRANSITION', `mission ${m.status} → ${to}`)
      const next = writeMission(m, { status: to, report: report == null ? m.report : asJsonb(report), completed_at: TERMINAL.includes(to) ? clock() : null })
      emit(org, 'wf.mission.transitioned', next.mission_id, null, next.owner_employee_id, { from: m.status, to: next.status })
      return out(shapeMission, next)
    }),

    // ── assignments ──
    createAssignment: ({ org_id, mission_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id = null, depends_on = [], input = {},
      resource_type = null, resource_key = null, max_attempts = null, parent_assignment_id = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const deps = textArray(depends_on, 'depends_on')
      const maxA = intParam(max_attempts, 'max_attempts')
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      const existing = [...S.assignments.values()].find((a) => a.mission_id === mission_id && a.step_key === step_key)
      if (existing) return { assignment: out(shapeAssignment, existing), created: false }
      if (TERMINAL.includes(m.status)) fail('ILLEGAL_TRANSITION', `a ${m.status} mission takes no new assignment`)
      const assignee = S.employees.get(assignee_employee_id)
      if (!assignee || assignee.org_id !== org) fail('NOT_FOUND', `assignee ${assignee_employee_id}`)
      if (assignee.status === 'retired') fail('CONFLICT', `assignee ${assignee_employee_id} is retired`)
      if (delegated_by_employee_id != null && S.employees.get(delegated_by_employee_id)?.org_id !== org) fail('NOT_FOUND', `delegating employee ${delegated_by_employee_id}`)
      if (parent_assignment_id != null && S.assignments.get(parent_assignment_id)?.mission_id !== mission_id) fail('NOT_FOUND', `parent assignment ${parent_assignment_id} (same mission)`)
      const t = clock()
      const a = {
        assignment_id: `wfa_${crypto.randomUUID()}`, org_id: org, mission_id, parent_assignment_id, step_key: step_key == null ? null : String(step_key),
        capability_key: capability_key == null ? null : String(capability_key), assignee_employee_id, delegated_by_employee_id, status: 'pending', depends_on: deps,
        input: input == null ? {} : asJsonb(input), output: null, outcome_class: null, evidence: [], runtime_job_id: null, resource_type, resource_key,
        attempt: 0, max_attempts: maxA ?? 3, next_attempt_at: null, lease_token: null, lease_owner: null, lease_until: null, lease_seconds: null, claimed_at: null,
        finished_token: null, last_error: null, created_at: t, updated_at: t, finished_at: null, _seq: nextSeq(),
      }
      checkAssignment(a)
      S.assignments.set(a.assignment_id, a)
      emit(org, 'wf.assignment.created', a.mission_id, a.assignment_id, a.assignee_employee_id, { step: a.step_key, capability: a.capability_key, depends_on: a.depends_on })
      return { assignment: out(shapeAssignment, a), created: true }
    }),
    async getAssignment({ org_id, assignment_id }) {
      const a = S.assignments.get(assignment_id)
      return a && a.org_id === org_id ? out(shapeAssignment, a) : null
    },
    async listAssignments({ org_id, mission_id = null, status = null, assignee_employee_id = null, limit = 200 } = {}) {
      const st = asList(status)
      return [...S.assignments.values()].filter((a) => a.org_id === org_id && (mission_id == null || a.mission_id === mission_id) && (!st || st.includes(a.status))
          && (assignee_employee_id == null || a.assignee_employee_id === assignee_employee_id))
        .sort(sortSeq).slice(0, clamp(limit, 200, 1, 1000)).map((a) => out(shapeAssignment, a))
    },
    claimAssignments: ({ org_id, owner, limit = 1, lease_seconds = 60, now: at = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const vNow = tsParam(at, 'now') ?? clock()
      const lim = intParam(limit, 'limit')
      const ls = intParam(lease_seconds, 'lease_seconds')
      if (owner == null || !OWNER_RE.test(String(owner))) refuse('lease owner must match ^[A-Za-z0-9_.:-]{1,80}$')
      if (ls == null || ls < 15 || ls > 3600) refuse('lease_seconds must be 15..3600')
      if (lim == null || lim < 1 || lim > 50) refuse('limit must be 1..50')
      const live = (a) => ['active', 'waiting'].includes(S.missions.get(a.mission_id)?.status)
      const stepsOf = (missionId) => [...S.assignments.values()].filter((d) => d.mission_id === missionId)
      // 1. dependency resolution
      const pending = [...S.assignments.values()].filter((a) => a.org_id === org && a.status === 'pending' && live(a)).sort(sortSeq).slice(0, 500)
      for (const a0 of pending) {
        const deps = stepsOf(a0.mission_id).filter((d) => a0.depends_on.includes(d.step_key))
        const dead = deps.filter((d) => ['failed', 'cancelled'].includes(d.status)).map((d) => d.step_key).sort()[0]
        if (dead != null) {
          emitAssignment(writeAssignment(a0, { status: 'cancelled', finished_at: vNow, last_error: { code: 'DEPENDENCY_FAILED', step: dead } }), 'pending', 'dependency_failed')
        } else if (deps.filter((d) => d.status === 'completed').length === a0.depends_on.length) {
          emitAssignment(writeAssignment(a0, { status: 'ready' }), 'pending', 'dependencies_completed')
        }
      }
      // 2. lease the due ready rows
      const ready = [...S.assignments.values()].filter((a) => a.org_id === org && a.status === 'ready' && (a.next_attempt_at == null || a.next_attempt_at <= vNow)
          && live(a) && S.employees.get(a.assignee_employee_id)?.status === 'active'
          && !stepsOf(a.mission_id).some((d) => a.depends_on.includes(d.step_key) && d.status !== 'completed'))
        .sort((x, y) => (S.missions.get(y.mission_id).priority - S.missions.get(x.mission_id).priority)
          || (x.next_attempt_at == null ? (y.next_attempt_at == null ? 0 : -1) : y.next_attempt_at == null ? 1 : x.next_attempt_at < y.next_attempt_at ? -1 : x.next_attempt_at > y.next_attempt_at ? 1 : 0)
          || sortSeq(x, y))
        .slice(0, lim)
      const claimed = []
      for (const a0 of ready) {
        const a = writeAssignment(a0, { status: 'leased', lease_token: crypto.randomUUID(), lease_owner: String(owner), lease_until: addSec(vNow, ls), lease_seconds: ls, claimed_at: vNow, finished_token: null })
        emitAssignment(a, 'ready')
        claimed.push(out(shapeAssignment, a))
      }
      return claimed
    }),
    progressAssignment: ({ org_id, assignment_id, lease_token, patch = {} }) => atomic(async () => {
      const org = orgParam(org_id)
      const token = uuidParam(lease_token, 'lease_token')
      const p = patch == null ? {} : asJsonb(patch)
      if (!isObj(p) || Object.keys(p).some((k) => !['status', 'output', 'evidence'].includes(k))) refuse('patch keys are status, output, evidence')
      if (own(p, 'status') && p.status !== 'running') fail('ILLEGAL_TRANSITION', 'progress moves only to running')
      if (own(p, 'output') && !isObj(p.output)) refuse('output must be an object')
      if (own(p, 'evidence') && !Array.isArray(p.evidence)) refuse('evidence must be an array')
      const a0 = leased(org, assignment_id, token)
      const ext = addSec(clock(), a0.lease_seconds)
      const a = writeAssignment(a0, {
        status: own(p, 'status') ? 'running' : a0.status,
        output: own(p, 'output') ? { ...(a0.output || {}), ...p.output } : a0.output,
        evidence: own(p, 'evidence') ? [...a0.evidence, ...p.evidence] : a0.evidence,
        lease_until: a0.lease_until > ext ? a0.lease_until : ext,
      })
      if (a.status !== a0.status) emitAssignment(a, a0.status)
      touchEmployee(a.assignee_employee_id)
      return out(shapeAssignment, S.assignments.get(a.assignment_id))
    }),
    waitAssignmentOnJob: ({ org_id, assignment_id, lease_token, runtime_job_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const token = uuidParam(lease_token, 'lease_token')
      const cur = S.assignments.get(assignment_id)
      if (!cur || cur.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      if (cur.status === 'waiting_job' && cur.finished_token === token && cur.runtime_job_id === (runtime_job_id ?? null)) return out(shapeAssignment, cur)
      if (runtime_job_id == null || !ID_SHAPE.job.test(String(runtime_job_id))) refuse('runtime_job_id must be an R2 job id (mjob_<uuid>)')
      const a0 = leased(org, assignment_id, token)
      const a = writeAssignment(a0, { status: 'waiting_job', runtime_job_id: String(runtime_job_id), lease_token: null, lease_owner: null, lease_until: null, lease_seconds: null, finished_token: token })
      emitAssignment(a, a0.status)
      return out(shapeAssignment, a)
    }),
    async resumeWaitingAssignments({ org_id, resolver, limit = 200 }) {
      if (typeof resolver !== 'function') throw new WorkforceStoreError('PAYLOAD_REFUSED', 'resolver(runtime_job_id) is required')
      const waiting = [...S.assignments.values()].filter((a) => a.org_id === org_id && a.status === 'waiting_job')
        .sort((x, y) => (x.updated_at < y.updated_at ? -1 : x.updated_at > y.updated_at ? 1 : x.assignment_id < y.assignment_id ? -1 : 1))
        .slice(0, clamp(limit, 200, 1, 1000)).map((a) => ({ assignment_id: a.assignment_id, runtime_job_id: a.runtime_job_id }))
      let n = 0
      for (const w of waiting) {
        const job = await resolver(w.runtime_job_id)
        if (!job || !['completed', 'failed', 'dead_letter', 'cancelled'].includes(job.state)) continue
        const changed = await atomic(async () => {
          const a0 = S.assignments.get(w.assignment_id)
          if (!a0 || a0.status !== 'waiting_job' || a0.runtime_job_id !== w.runtime_job_id) return false
          if (job.state === 'completed') {
            const a = writeAssignment(a0, { status: 'completed', outcome_class: 'verified', output: job.result == null ? {} : asJsonb(job.result),
              evidence: [...a0.evidence, { source: 'agent.research_job', job_id: w.runtime_job_id }], finished_at: clock() })
            releaseClaimsOf(a.assignment_id, 'finished')
            emitAssignment(a, 'waiting_job', 'job_completed')
          } else {
            const attempt = a0.attempt + 1
            const exhausted = attempt >= a0.max_attempts
            const a = writeAssignment(a0, {
              status: exhausted ? 'failed' : 'ready', attempt,
              next_attempt_at: exhausted ? a0.next_attempt_at : addSec(clock(), backoffSeconds(attempt)),
              runtime_job_id: exhausted ? a0.runtime_job_id : null,
              last_error: { ...(job.error == null ? {} : asJsonb(job.error)), code: `RUNTIME_JOB_${String(job.state).toUpperCase()}`, job_id: w.runtime_job_id },
              finished_at: exhausted ? clock() : null,
            })
            if (a.status === 'failed') releaseClaimsOf(a.assignment_id, 'finished')
            emitAssignment(a, 'waiting_job', `job_${job.state}`)
          }
          return true
        })
        if (changed) n += 1
      }
      return n
    },
    finishAssignment: ({ org_id, assignment_id, lease_token, status, output = null, outcome_class = null, evidence = null, error = null, retry_after_seconds = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const token = uuidParam(lease_token, 'lease_token')
      const retryAfter = intParam(retry_after_seconds, 'retry_after_seconds')
      const cur = S.assignments.get(assignment_id)
      if (!cur || cur.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      if (token != null && cur.finished_token === token && cur.lease_token == null) return out(shapeAssignment, cur)
      let to = status === 'retry' ? 'ready' : status
      if (!['completed', 'failed', 'ready', 'waiting_approval', 'blocked', 'cancelled'].includes(to)) refuse('finish status must be completed, failed, ready (retry), waiting_approval, blocked or cancelled')
      if (to === 'completed' && outcome_class == null) refuse('a completed assignment names its outcome_class')
      const o = output == null ? null : asJsonb(output)
      const ev = evidence == null ? null : asJsonb(evidence)
      const er = error == null ? null : asJsonb(error)
      if (o != null && !isObj(o)) refuse('output must be an object')
      if (ev != null && !Array.isArray(ev)) refuse('evidence must be an array')
      if (retryAfter != null && (retryAfter < 0 || retryAfter > 86400)) refuse('retry_after_seconds must be 0..86400')
      const a0 = leased(org, assignment_id, token)
      let attempt = a0.attempt
      let next = null
      if (to === 'ready') {
        attempt = a0.attempt + 1
        if (attempt >= a0.max_attempts) to = 'failed'
        else next = addSec(clock(), retryAfter ?? backoffSeconds(attempt))
      }
      const a = writeAssignment(a0, {
        status: to, attempt, next_attempt_at: to === 'ready' ? next : a0.next_attempt_at,
        output: o != null ? { ...(a0.output || {}), ...o } : a0.output,
        outcome_class: outcome_class ?? a0.outcome_class,
        evidence: ev != null ? [...a0.evidence, ...ev] : a0.evidence,
        last_error: er ?? a0.last_error,
        lease_token: null, lease_owner: null, lease_until: null, lease_seconds: null, finished_token: token,
        finished_at: TERMINAL.includes(to) ? clock() : null,
      })
      if (TERMINAL.includes(to)) releaseClaimsOf(a.assignment_id, to === 'cancelled' ? 'cancelled' : 'finished')
      emitAssignment(a, a0.status, status === 'retry' || status === 'ready' ? 'retry' : null)
      touchEmployee(a.assignee_employee_id)
      return out(shapeAssignment, S.assignments.get(a.assignment_id))
    }),
    resolveHeldAssignment: ({ org_id, assignment_id, to, actor }) => atomic(async () => {
      const org = orgParam(org_id)
      if (!actorOk(org, actor)) fail('FORBIDDEN', 'actor must be an employee of the org or a named operator')
      const a0 = S.assignments.get(assignment_id)
      if (!a0 || a0.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      if (!['waiting_approval', 'blocked'].includes(a0.status) || !canAssignmentTransition(a0.status, to)) fail('ILLEGAL_TRANSITION', `assignment ${a0.status} → ${to}`)
      const a = writeAssignment(a0, { status: to, next_attempt_at: to === 'ready' ? clock() : a0.next_attempt_at, finished_at: ['failed', 'cancelled'].includes(to) ? clock() : null })
      if (['failed', 'cancelled'].includes(to)) releaseClaimsOf(a.assignment_id, to === 'cancelled' ? 'cancelled' : 'finished')
      emit(org, 'wf.assignment.transitioned', a.mission_id, a.assignment_id, a.assignee_employee_id,
        { from: a0.status, to: a.status, attempt: a.attempt, step: a.step_key, reason: 'hold_resolved', actor_id: actor })
      return out(shapeAssignment, a)
    }),
    transferAssignment: ({ org_id, assignment_id, to_employee_id, actor }) => atomic(async () => {
      const org = orgParam(org_id)
      if (!actorOk(org, actor)) fail('FORBIDDEN', 'actor must be an employee of the org or a named operator')
      const a0 = S.assignments.get(assignment_id)
      if (!a0 || a0.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      if (TERMINAL.includes(a0.status)) fail('ILLEGAL_TRANSITION', `a ${a0.status} assignment cannot be transferred`)
      if (['leased', 'running', 'waiting_job'].includes(a0.status)) fail('CONFLICT', `a ${a0.status} assignment cannot be transferred (release it first)`)
      const to = S.employees.get(to_employee_id)
      if (!to || to.org_id !== org) fail('NOT_FOUND', `employee ${to_employee_id}`)
      if (to.status === 'retired') fail('CONFLICT', `employee ${to_employee_id} is retired`)
      if (a0.assignee_employee_id === to_employee_id) return out(shapeAssignment, a0)
      const a = writeAssignment(a0, { assignee_employee_id: to_employee_id })
      emit(org, 'wf.assignment.transferred', a.mission_id, a.assignment_id, a.assignee_employee_id, { from_employee_id: a0.assignee_employee_id, to_employee_id, actor_id: actor })
      return out(shapeAssignment, a)
    }),
    cancelMissionAssignments: ({ org_id, mission_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      let n = 0
      for (const a0 of [...S.assignments.values()].filter((a) => a.mission_id === mission_id && !TERMINAL.includes(a.status)).sort(sortSeq)) {
        const a = writeAssignment(a0, { status: 'cancelled', lease_token: null, lease_owner: null, lease_until: null, lease_seconds: null, finished_at: clock() })
        releaseClaimsOf(a.assignment_id, 'cancelled')
        emitAssignment(a, a0.status, 'mission_cancelled')
        n += 1
      }
      return n
    }),
    reapAssignments: ({ org_id, now: at = null } = {}) => atomic(async () => {
      const org = orgParam(org_id)
      const vNow = tsParam(at, 'now') ?? clock()
      let requeued = 0
      let failed = 0
      const due = [...S.assignments.values()].filter((a) => a.org_id === org && ['leased', 'running'].includes(a.status) && a.lease_until < vNow)
        .sort((x, y) => (x.lease_until < y.lease_until ? -1 : x.lease_until > y.lease_until ? 1 : x.assignment_id < y.assignment_id ? -1 : 1)).slice(0, 200)
      for (const r of due) {
        const attempt = r.attempt + 1
        const exhausted = attempt >= r.max_attempts
        const a = writeAssignment(r, {
          status: exhausted ? 'failed' : 'ready', attempt, next_attempt_at: exhausted ? r.next_attempt_at : addSec(vNow, backoffSeconds(attempt)),
          lease_token: null, lease_owner: null, lease_until: null, lease_seconds: null,
          last_error: { code: 'LEASE_EXPIRED', attempt, max_attempts: r.max_attempts }, finished_at: exhausted ? vNow : null,
        })
        if (exhausted) { releaseClaimsOf(a.assignment_id, 'finished'); failed += 1 } else requeued += 1
        emitAssignment(a, r.status, 'lease_expired')
      }
      return { requeued, failed }
    }),

    // ── resource ownership ──
    acquireResourceClaim: ({ org_id, resource_type, resource_key, employee_id, assignment_id = null, ttl_seconds }) => atomic(async () => {
      const org = orgParam(org_id)
      const ttl = intParam(ttl_seconds, 'ttl_seconds')
      if (ttl == null || ttl < 1 || ttl > 86400) refuse('ttl_seconds must be 1..86400')
      if (S.employees.get(employee_id)?.org_id !== org) fail('NOT_FOUND', `employee ${employee_id}`)
      if (assignment_id != null && S.assignments.get(assignment_id)?.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      const t = clock()
      const live = [...S.claims.values()].find((c) => c.org_id === org && c.resource_type === resource_type && c.resource_key === resource_key && c.released_at == null)
      if (live) {
        if (live.expires_at <= t) {
          S.claims.set(live.claim_id, { ...live, released_at: new Date(Math.max(Date.parse(t), Date.parse(live.claimed_at) + 1)).toISOString(), release_reason: 'expired' })
          emit(org, 'wf.resource.released', null, live.assignment_id, live.employee_id, { resource_type: live.resource_type, resource: live.resource_key, reason: 'expired' })
        } else if (live.employee_id === employee_id && live.assignment_id === (assignment_id ?? null)) {
          const ext = addSec(t, ttl)
          const c = { ...live, expires_at: live.expires_at > ext ? live.expires_at : ext }
          S.claims.set(c.claim_id, c)
          return out(shapeClaim, c)
        } else {
          fail('CLAIM_HELD', `${resource_type} ${resource_key} is held by ${live.employee_id} until ${live.expires_at}`)
        }
      }
      const c = { claim_id: crypto.randomUUID(), org_id: org, resource_type, resource_key, employee_id, assignment_id: assignment_id ?? null, claimed_at: t, expires_at: addSec(t, ttl), released_at: null, release_reason: null }
      if (!RESOURCE_TYPES.includes(c.resource_type)) refuse('resource_type')
      if (typeof c.resource_key !== 'string' || !RESOURCE_KEY_RE.test(c.resource_key) || stringViolation(c.resource_key, 'resource_key', 0) != null) refuse('resource_key')
      S.claims.set(c.claim_id, c)
      emit(org, 'wf.resource.claimed', null, c.assignment_id, employee_id, { resource_type, resource: resource_key, expires_at: c.expires_at })
      return out(shapeClaim, c)
    }),
    releaseResourceClaim: ({ org_id, resource_type, resource_key, assignment_id = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const c = [...S.claims.values()].find((x) => x.org_id === org && x.resource_type === resource_type && x.resource_key === resource_key && x.released_at == null
        && x.assignment_id === (assignment_id ?? null))
      if (!c) return
      S.claims.set(c.claim_id, { ...c, released_at: new Date(Math.max(clockMs(), Date.parse(c.claimed_at) + 1)).toISOString(), release_reason: 'released' })
      emit(org, 'wf.resource.released', null, c.assignment_id, c.employee_id, { resource_type: c.resource_type, resource: c.resource_key, reason: 'released' })
    }),
    reapResourceClaims: ({ org_id, now: at = null } = {}) => atomic(async () => {
      const org = orgParam(org_id)
      const vNow = tsParam(at, 'now') ?? clock()
      let n = 0
      for (const c of [...S.claims.values()].filter((x) => x.org_id === org && x.released_at == null && x.expires_at <= vNow)
        .sort((x, y) => (x.expires_at < y.expires_at ? -1 : x.expires_at > y.expires_at ? 1 : x.claim_id < y.claim_id ? -1 : 1)).slice(0, 500)) {
        S.claims.set(c.claim_id, { ...c, released_at: new Date(Math.max(Date.parse(vNow), Date.parse(c.claimed_at) + 1)).toISOString(), release_reason: 'expired' })
        emit(org, 'wf.resource.released', null, c.assignment_id, c.employee_id, { resource_type: c.resource_type, resource: c.resource_key, reason: 'expired' })
        n += 1
      }
      return n
    }),
    async listResourceClaims({ org_id, active = true } = {}) {
      return [...S.claims.values()].filter((c) => c.org_id === org_id && (active === false || c.released_at == null))
        .sort((x, y) => (x.claimed_at > y.claimed_at ? -1 : x.claimed_at < y.claimed_at ? 1 : x.claim_id < y.claim_id ? -1 : 1)).slice(0, 500).map((c) => out(shapeClaim, c))
    },

    // ── events / conversation / memory ──
    appendEvent: ({ org_id, type, mission_id = null, assignment_id = null, employee_id = null, payload = {} }) => atomic(async () => {
      const org = orgParam(org_id)
      if (mission_id != null && S.missions.get(mission_id)?.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      if (assignment_id != null && S.assignments.get(assignment_id)?.org_id !== org) fail('NOT_FOUND', `assignment ${assignment_id}`)
      if (employee_id != null && S.employees.get(employee_id)?.org_id !== org) fail('NOT_FOUND', `employee ${employee_id}`)
      if (!orgExists(org)) fail('NOT_FOUND', 'org')
      return out(shapeEvent, emit(org, type, mission_id, assignment_id, employee_id, payload ?? {}))
    }),
    async listEvents({ org_id, after_event_id = null, mission_id = null, limit = 100 } = {}) {
      return S.events.filter((e) => e.org_id === org_id && (after_event_id == null || e.event_id > Number(after_event_id)) && (mission_id == null || e.mission_id === mission_id))
        .slice(0, clamp(limit, 100, 1, 500)).map((e) => out(shapeEvent, e))
    },
    appendExecMessage: ({ org_id, author, author_user_id = null, author_employee_id = null, content, refs = [], mission_id = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const user = uuidParam(author_user_id, 'author_user_id')
      if (author === 'ceo') {
        if (author_employee_id != null || !isOwner(org, user)) fail('FORBIDDEN', 'a CEO message is authored by an owner of the org')
      } else if (author === 'coo') {
        const e = S.employees.get(author_employee_id)
        if (user != null || !e || e.org_id !== org || e.role_key !== 'coo') fail('FORBIDDEN', 'a COO message is authored by the COO employee')
      } else {
        refuse('author must be ceo or coo')
      }
      if (mission_id != null && S.missions.get(mission_id)?.org_id !== org) fail('NOT_FOUND', `mission ${mission_id}`)
      const r = refs == null ? [] : asJsonb(refs)
      if (typeof content !== 'string' || content.length < 1 || content.length > 8000 || !textClean(content)) refuse('content')
      if (!Array.isArray(r) || r.length > 50 || jsonBytes(r) > 8192 || !isClean({ record_refs: r })) refuse('refs')
      const x = { message_id: crypto.randomUUID(), org_id: org, mission_id: mission_id ?? null, author, author_user_id: user, author_employee_id: author_employee_id ?? null,
        content, refs: r, created_at: clock(), _seq: nextSeq() }
      S.messages.push(x)
      return out(shapeExecMessage, x)
    }),
    async listExecMessages({ org_id, mission_id = null, limit = 50, before = null } = {}) {
      const b = before == null ? null : new Date(before).toISOString()
      return S.messages.filter((m) => m.org_id === org_id && (mission_id == null || m.mission_id === mission_id) && (b == null || m.created_at < b))
        .sort((x, y) => -sortSeq(x, y)).slice(0, clamp(limit, 50, 1, 200)).map((m) => out(shapeExecMessage, m))
    },
    assertMemoryFact: ({ org_id, scope, scope_key, fact_key, value, epistemic, confidence = null, source_refs = [], author_employee_id = null, author_user_id = null }) => atomic(async () => {
      const org = orgParam(org_id)
      const user = uuidParam(author_user_id, 'author_user_id')
      const conf = numParam(confidence, 'confidence')
      if (epistemic === 'ceo_policy' && !isOwner(org, user)) fail('FORBIDDEN', 'a ceo_policy fact is authored only by an owner of the org')
      const refs = source_refs == null ? [] : asJsonb(source_refs)
      if (!Array.isArray(refs)) refuse('source_refs must be an array')
      if (epistemic === 'verified' && refs.length < 1) refuse('a verified fact needs at least one source ref')
      if (value === undefined) refuse('value required')
      if (author_employee_id == null && user == null) refuse('a fact names its author')
      if (author_employee_id != null && S.employees.get(author_employee_id)?.org_id !== org) fail('NOT_FOUND', `author employee ${author_employee_id}`)
      const v = asJsonb(value)
      const c3 = conf == null ? null : round(conf, 3)
      const live = [...S.facts.values()].find((f) => f.org_id === org && f.scope === scope && f.scope_key === scope_key && f.fact_key === fact_key && f.epistemic === epistemic && f.superseded_at == null)
      if (live && JSON.stringify(live.value) === JSON.stringify(v) && JSON.stringify(live.source_refs) === JSON.stringify(refs) && live.confidence === c3
          && live.author_employee_id === (author_employee_id ?? null) && live.author_user_id === user) {
        return out(shapeFact, live)
      }
      const id = crypto.randomUUID()
      const t = clock()
      const f = { fact_id: id, org_id: org, scope, scope_key, fact_key, value: v, epistemic, confidence: c3, source_refs: refs, author_employee_id: author_employee_id ?? null,
        author_user_id: user, valid_from: t, superseded_by: null, superseded_at: null, _seq: nextSeq() }
      if (!MEMORY_SCOPES.includes(f.scope)) refuse('scope')
      if (typeof f.scope_key !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(f.scope_key) || stringViolation(f.scope_key, 'scope_key', 0) != null) refuse('scope_key')
      if (typeof f.fact_key !== 'string' || !/^[a-z][a-z0-9_.:-]{1,80}$/.test(f.fact_key)) refuse('fact_key')
      if (!EPISTEMIC_CLASSES.includes(f.epistemic)) refuse('epistemic')
      if (f.confidence != null && !(f.confidence >= 0 && f.confidence <= 1)) refuse('confidence')
      if (jsonBytes(v) > 8192 || !isClean({ value: v })) refuse('value')
      if (refs.length > 50 || jsonBytes(refs) > 8192 || !isClean({ source_refs: refs })) refuse('source_refs')
      if (live) S.facts.set(live.fact_id, { ...live, superseded_by: id, superseded_at: t })
      S.facts.set(id, f)
      emit(org, 'wf.memory.asserted', null, null, author_employee_id ?? null, { fact_id: id, scope: f.scope, fact: f.fact_key, epistemic: f.epistemic, superseded_fact_id: live?.fact_id ?? null })
      return out(shapeFact, f)
    }),
    async listMemoryFacts({ org_id, scope = null, scope_key = null, include_superseded = false } = {}) {
      return [...S.facts.values()].filter((f) => f.org_id === org_id && (scope == null || f.scope === scope) && (scope_key == null || f.scope_key === scope_key)
          && (include_superseded === true || f.superseded_at == null))
        .sort((x, y) => (x.valid_from > y.valid_from ? -1 : x.valid_from < y.valid_from ? 1 : y._seq - x._seq)).slice(0, 500).map((f) => out(shapeFact, f))
    },

    // ── authority / settings / KPIs ──
    async listPolicies({ org_id, status = null } = {}) {
      const st = asList(status)
      return [...S.policies.values()].filter((p) => p.org_id === org_id && (!st || st.includes(p.status)))
        .sort((x, y) => -sortSeq(x, y)).slice(0, 500).map((p) => out(shapePolicy, p))
    },
    putPolicy: ({ org_id, policy, actor_user_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const actor = uuidParam(actor_user_id, 'actor_user_id')
      if (!isOwner(org, actor)) fail('FORBIDDEN', 'authority policies are CEO-authored')
      const p = asJsonb(policy)
      if (!isObj(p)) refuse('policy must be an object')
      if (Object.keys(p).some((k) => !['policy_id', 'role_key', 'employee_id', 'action_key', 'scope', 'limits', 'risk', 'min_confidence', 'review', 'valid_from', 'valid_until'].includes(k))) refuse('unknown policy field')
      if (p.employee_id != null && S.employees.get(String(p.employee_id))?.org_id !== org) fail('NOT_FOUND', `employee ${p.employee_id}`)
      let old = null
      const t = clock()
      if (p.policy_id != null) {
        const pid = uuidParam(p.policy_id, 'policy_id')
        old = S.policies.get(pid)
        if (!old || old.org_id !== org) fail('NOT_FOUND', `policy ${p.policy_id}`)
        if (old.status !== 'active') fail('CONFLICT', `policy ${old.policy_id} is revoked (put a new one)`)
        S.policies.set(old.policy_id, { ...old, status: 'revoked', revoked_at: t, revoked_by: actor })
      }
      const n = {
        policy_id: crypto.randomUUID(), org_id: org, role_key: p.role_key ?? null, employee_id: p.employee_id ?? null, action_key: p.action_key ?? null,
        scope: own(p, 'scope') && p.scope !== null ? p.scope : own(p, 'scope') ? null : {}, limits: own(p, 'limits') && p.limits !== null ? p.limits : own(p, 'limits') ? null : {},
        risk: p.risk ?? 'low', min_confidence: round(numParam(p.min_confidence, 'min_confidence'), 3), review: p.review ?? 'ceo',
        valid_from: tsParam(p.valid_from, 'valid_from') ?? t, valid_until: tsParam(p.valid_until, 'valid_until'), status: 'active', created_by: actor, created_at: t,
        revoked_at: null, revoked_by: null, version: (old?.version ?? 0) + 1, supersedes: old?.policy_id ?? null, _seq: nextSeq(),
      }
      if (n.action_key == null) refuse('action_key required')
      if (n.role_key != null && !ROLE_KEYS.includes(n.role_key)) refuse('role_key')
      if (!/^[a-z][a-z0-9_]{1,30}(\.[a-z][a-z0-9_]{1,60}){1,3}$/.test(String(n.action_key))) refuse('action_key')
      if (!['low', 'medium', 'high'].includes(n.risk)) refuse('risk')
      if (n.min_confidence != null && !(n.min_confidence >= 0 && n.min_confidence <= 1)) refuse('min_confidence')
      if (!['ceo', 'coo', 'none'].includes(n.review)) refuse('review')
      if ((n.role_key == null) === (n.employee_id == null)) refuse('exactly one of role_key / employee_id')
      if (n.valid_until != null && !(n.valid_until > n.valid_from)) refuse('valid_until after valid_from')
      if (!cleanObj(n.scope, 4096)) refuse('scope')
      if (!cleanObj(n.limits, 4096)) refuse('limits')
      S.policies.set(n.policy_id, n)
      emit(org, 'wf.policy.put', null, null, n.employee_id, { policy_id: n.policy_id, action: n.action_key, version: n.version, supersedes_id: old?.policy_id ?? null })
      return out(shapePolicy, n)
    }),
    revokePolicy: ({ org_id, policy_id, actor_user_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const actor = uuidParam(actor_user_id, 'actor_user_id')
      const pid = uuidParam(policy_id, 'policy_id')
      if (!isOwner(org, actor)) fail('FORBIDDEN', 'authority policies are CEO-authored')
      const p = S.policies.get(pid)
      if (!p || p.org_id !== org) fail('NOT_FOUND', `policy ${policy_id}`)
      if (p.status === 'revoked') return out(shapePolicy, p)
      const n = { ...p, status: 'revoked', revoked_at: clock(), revoked_by: actor }
      S.policies.set(pid, n)
      emit(org, 'wf.policy.revoked', null, null, n.employee_id, { policy_id: n.policy_id, action: n.action_key })
      return out(shapePolicy, n)
    }),
    async getSettings({ org_id }) {
      const s = S.settings.get(org_id)
      return s ? out(shapeSettings, s) : null
    },
    putSettings: ({ org_id, patch, actor_user_id }) => atomic(async () => {
      const org = orgParam(org_id)
      const actor = uuidParam(actor_user_id, 'actor_user_id')
      if (!isOwner(org, actor)) fail('FORBIDDEN', 'settings are CEO-authored')
      const p = asJsonb(patch)
      if (!isObj(p) || Object.keys(p).some((k) => !['exec_review_price_usd', 'escalation'].includes(k))) refuse('settings patch keys are exec_review_price_usd, escalation')
      const cur = S.settings.get(org) || { org_id: org, exec_review_price_usd: 5000000, escalation: {}, updated_at: clock(), updated_by: 'migration' }
      const n = {
        ...cur,
        exec_review_price_usd: own(p, 'exec_review_price_usd') ? round(numParam(p.exec_review_price_usd, 'exec_review_price_usd'), 2) : cur.exec_review_price_usd,
        escalation: own(p, 'escalation') ? (p.escalation === null ? null : p.escalation) : cur.escalation, updated_by: actor, updated_at: clock(),
      }
      if (n.exec_review_price_usd == null || !(n.exec_review_price_usd > 0 && n.exec_review_price_usd <= 1e9)) refuse('exec_review_price_usd')
      if (!cleanObj(n.escalation, 4096)) refuse('escalation')
      if (!orgExists(org)) fail('NOT_FOUND', 'org')
      S.settings.set(org, n)
      emit(org, 'wf.settings.updated', null, null, null, { keys: Object.keys(p).sort() })
      return out(shapeSettings, n)
    }),
    putKpi: ({ org_id, subject_type, subject_key, kpi_key, window, value = null, status, source = {} }) => atomic(async () => {
      const org = orgParam(org_id)
      const v = numParam(value, 'value')
      const src = source == null ? {} : asJsonb(source)
      if (!['employee', 'department', 'org'].includes(subject_type)) refuse('subject_type')
      if (typeof subject_key !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(subject_key)) refuse('subject_key')
      if (typeof kpi_key !== 'string' || !/^[a-z][a-z0-9_.]{1,80}$/.test(kpi_key)) refuse('kpi_key')
      if (typeof window !== 'string' || !/^[a-z0-9_]{1,20}$/.test(window)) refuse('window')
      if (!['known', 'unknown'].includes(status)) refuse('status')
      if ((status === 'unknown') !== (v == null)) refuse('unknown ⇔ value NULL')
      if (!cleanObj(src, 4096)) refuse('source')
      if (!orgExists(org)) fail('NOT_FOUND', 'org')
      S.kpis.set(JSON.stringify([org, subject_type, subject_key, kpi_key, window]), { org_id: org, subject_type, subject_key, kpi_key, window, value: v, status, source: src, computed_at: clock() })
    }),
    async listKpis({ org_id, subject_type = null, subject_key = null } = {}) {
      return [...S.kpis.values()].filter((k) => k.org_id === org_id && (subject_type == null || k.subject_type === subject_type) && (subject_key == null || k.subject_key === subject_key))
        .sort((a, b) => a.subject_type.localeCompare(b.subject_type) || a.subject_key.localeCompare(b.subject_key) || a.kpi_key.localeCompare(b.kpi_key) || a.window.localeCompare(b.window))
        .map((k) => out(shapeKpi, k))
    },
  }
  return store
}

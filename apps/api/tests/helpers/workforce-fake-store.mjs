// A MINIMAL in-test fake of the Workforce store interface (docs/WORKFORCE.md §11) — only what the
// engine, COO and API tests need. It is NOT the memory twin (lib/workforce/store/, built separately):
// it follows §11 literally (names, args, error codes, the assignment / mission transition tables,
// idempotency, lease checks, supersede, unique resource claims) so the engine runs unchanged against
// the real twin at integration.
//
// It also refuses what the DB's payload_is_clean CHECKs refuse in every jsonb field (phone / email values,
// *_key / message-body / contact keys), mirrors the owner checks (employees, policies, settings, CEO
// messages need an owner member; COO messages the COO employee), claims only live missions' rows of
// ACTIVE assignees, cancels a pending row whose dependency failed, merges finish outputs, and releases
// an assignment's resource claims when it turns terminal — the store layer's documented semantics.
import crypto from 'node:crypto'

export class WorkforceStoreError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'WorkforceStoreError'
    this.code = code
  }
}
const E = (code, msg) => new WorkforceStoreError(code, msg)

export const ASSIGNMENT_TRANSITIONS = Object.freeze({
  pending: ['ready', 'cancelled'],
  ready: ['leased', 'cancelled'],
  leased: ['running', 'ready', 'completed', 'failed', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled'],
  running: ['completed', 'failed', 'ready', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled'],
  waiting_job: ['ready', 'completed', 'failed', 'cancelled'],
  waiting_approval: ['ready', 'cancelled', 'failed'],
  blocked: ['ready', 'cancelled'],
  completed: [], failed: [], cancelled: [],
})
export const MISSION_TRANSITIONS = Object.freeze({
  planning: ['active', 'failed', 'cancelled'],
  active: ['waiting', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting: ['active', 'completed', 'failed', 'cancelled'],
  blocked: ['active', 'cancelled', 'failed'],
  completed: [], failed: [], cancelled: [],
})
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

// key rules of agent.payload_is_clean (the S3 CHECK): no credential-like *_key keys (allowlist), no message-body
// keys, no contact keys — plus the phone / email value rules below
const KEY_ALLOW = new Set(['key', 'idempotency_key', 'scope_key', 'dedupe_key', 'section_key', 'sort_key', 'lock_key', 'name_key', 'finding_key', 'cache_key'])
const BODY_KEY = /^(body|text|content|contents|message|messages|msg|message_body|message_text|sms|preview|snippet|transcript|raw|raw_text|html|reply|reply_text)$/
const CONTACT_KEY = /^(phone|phone_number|phones|email|email_address|emails|canonical_e164|e164|seller_phone|best_phone|best_email|mobile|cell)$/
const normKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
const PHONE = [/\+1[0-9]{10}\b/, /\(?\b[2-9][0-9]{2}\)?[\s.-][0-9]{3}[\s.-][0-9]{4}\b/, /(?<![0-9A-Za-z_-])[0-9]{10,11}(?![0-9A-Za-z_-])/]
const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i
export function contactViolation(v, path = '$', depth = 0) {
  if (depth > 12 || v == null) return null
  if (typeof v === 'string') return PHONE.some((re) => re.test(v)) ? `${path}:phone` : EMAIL.test(v) ? `${path}:email` : null
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i += 1) { const x = contactViolation(v[i], `${path}[${i}]`, depth + 1); if (x) return x } return null }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const nk = normKey(k)
      if (/_key$/.test(nk) && !KEY_ALLOW.has(nk)) return `${path}.${k}:key_credential`
      if (BODY_KEY.test(nk)) return `${path}.${k}:key_message_body`
      if (CONTACT_KEY.test(nk) && x != null && typeof x !== 'boolean' && typeof x !== 'number') return `${path}.${k}:key_contact_value`
      const r = contactViolation(x, `${path}.${k}`, depth + 1); if (r) return r
    }
    return null
  }
  return null
}
const textViolation = (v) => (typeof v === 'string' ? contactViolation(v) : null)
const clean = (v, what) => { const x = contactViolation(v); if (x) throw E('PAYLOAD_REFUSED', `${what} ${x}`); return v }
const clone = (v) => (v == null ? v : structuredClone(v))

export function createWorkforceFakeStore({ now = () => Date.now(), calls = null, members = [] } = {}) {
  const isOwner = (org, user) => user != null && members.some((m) => m.org_id === org && m.user_id === user && m.role === 'owner')
  const iso = (t = now()) => new Date(t).toISOString()
  const S = { employees: new Map(), missions: new Map(), assignments: new Map(), claims: [], events: [], messages: [], facts: [], policies: [], settings: new Map(), kpis: [] }
  let seq = 0
  let eventSeq = 0
  const track = (name) => { if (calls) calls[name] = (calls[name] || 0) + 1 }
  const asgTransition = (a, to) => {
    if (!ASSIGNMENT_TRANSITIONS[a.status]?.includes(to)) throw E('ILLEGAL_TRANSITION', `assignment ${a.status} → ${to}`)
    a.status = to
    a.updated_at = iso()
  }
  const leased = (org_id, assignment_id, lease_token) => {
    const a = S.assignments.get(assignment_id)
    if (!a || a.org_id !== org_id) throw E('NOT_FOUND', 'assignment')
    if (!['leased', 'running'].includes(a.status) || a.lease_token !== lease_token || Date.parse(a.lease_until) <= now()) throw E('LEASE_LOST', 'lease')
    return a
  }
  const clearLease = (a) => Object.assign(a, { lease_token: null, lease_until: null, lease_owner: null })
  const releaseClaimsOf = (a) => { if (TERMINAL.has(a.status)) for (const c of S.claims) if (c.assignment_id === a.assignment_id && !c.released_at) c.released_at = iso() }

  const store = {
    kind: 'fake',
    _state: S,
    // ── org / employees
    async listEmployees({ org_id, status } = {}) { track('listEmployees'); return [...S.employees.values()].filter((e) => e.org_id === org_id && (!status || e.status === status)).map(clone) },
    async getEmployee({ org_id, employee_id }) { track('getEmployee'); const e = S.employees.get(employee_id); return e && e.org_id === org_id ? clone(e) : null },
    async upsertEmployee({ org_id, employee, actor_user_id }) {
      track('upsertEmployee')
      if (!isOwner(org_id, actor_user_id)) throw E('FORBIDDEN', 'employees are CEO-authored')
      const ALLOWED = ['employee_id', 'kind', 'role_key', 'department_key', 'display_name', 'employee_code', 'manager_employee_id', 'user_id', 'action_principal_id', 'status', 'markets', 'segments', 'tier_ceiling', 'spend_day_cap_usd']
      if (Object.keys(employee || {}).some((k) => !ALLOWED.includes(k))) throw E('PAYLOAD_REFUSED', 'unknown employee field')
      if (!/^emp_[a-z0-9_]{3,40}$/.test(String(employee?.employee_id || ''))) throw E('PAYLOAD_REFUSED', 'employee_id')
      if (employee.role_key === 'ceo' && [...S.employees.values()].some((e) => e.role_key === 'ceo' && e.employee_id !== employee.employee_id)) throw E('CONFLICT', 'one ceo')
      const prev = S.employees.get(employee.employee_id)
      if (prev && employee.kind && employee.kind !== prev.kind) throw E('CONFLICT', "an employee's kind never changes")
      const row = { markets: [], segments: {}, status: 'active', tier_ceiling: 'T1', spend_day_cap_usd: 0, heartbeat_at: null, last_activity_at: null, ...(prev || {}), ...clone(employee), org_id, created_by: prev?.created_by ?? actor_user_id ?? null }
      if (!['T1', 'T2'].includes(row.tier_ceiling)) throw E('PAYLOAD_REFUSED', 'tier_ceiling')
      if (!Array.isArray(row.markets) || row.markets.some((m) => !/^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(String(m)))) throw E('PAYLOAD_REFUSED', 'markets are lower-case slugs')
      if (row.employee_code != null && !/^[A-Z]{2,6}-[0-9]{2,3}$/.test(row.employee_code)) throw E('PAYLOAD_REFUSED', 'employee_code')
      if (!row.display_name || textViolation(row.display_name)) throw E('PAYLOAD_REFUSED', 'display_name')
      if (row.kind !== 'human' && row.user_id != null) throw E('PAYLOAD_REFUSED', 'an AI employee has no user id')
      if (row.role_key === 'ceo' && !(row.kind === 'human' && row.user_id)) throw E('PAYLOAD_REFUSED', 'the CEO is a human with a user id')
      clean(row.segments, 'segments')
      S.employees.set(row.employee_id, row)
      return clone(row)
    },
    async heartbeatEmployee({ org_id, employee_id, at }) { track('heartbeatEmployee'); const e = S.employees.get(employee_id); if (!e || e.org_id !== org_id) throw E('NOT_FOUND', 'employee'); e.heartbeat_at = at || iso(); e.last_activity_at = e.heartbeat_at },

    // ── missions
    async openMission({ org_id, title, directive, requested_by, owner_employee_id, priority = 50, due_at = null, idempotency_key }) {
      track('openMission')
      for (const m of S.missions.values()) if (m.org_id === org_id && m.idempotency_key === idempotency_key) return { mission: clone(m), created: false }
      if (!/^[0-9a-f-]{36}$/.test(String(requested_by || ''))) throw E('FORBIDDEN', 'requested_by must be the named operator')
      if (textViolation(directive) || textViolation(title)) throw E('PAYLOAD_REFUSED', 'directive')
      const t = iso()
      const m = { mission_id: `wfm_${crypto.randomUUID()}`, org_id, title, directive, objective: null, playbook_key: null, owner_employee_id, requested_by, status: 'planning', priority, due_at, plan: null, plan_version: 0, report: null, idempotency_key, created_at: t, updated_at: t, completed_at: null, _seq: ++seq }
      S.missions.set(m.mission_id, m)
      return { mission: clone(m), created: true }
    },
    async getMission({ org_id, mission_id }) { track('getMission'); const m = S.missions.get(mission_id); return m && m.org_id === org_id ? clone(m) : null },
    async listMissions({ org_id, status, limit = 50, before } = {}) {
      track('listMissions')
      return [...S.missions.values()].filter((m) => m.org_id === org_id && (!status || m.status === status)).sort((a, b) => b._seq - a._seq).slice(0, limit).map(clone)
    },
    async setMissionPlan({ org_id, mission_id, objective, playbook_key, plan, expected_version }) {
      track('setMissionPlan')
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org_id) throw E('NOT_FOUND', 'mission')
      if (m.plan_version !== expected_version) throw E('VERSION_MISMATCH', `plan_version ${m.plan_version} ≠ ${expected_version}`)
      clean(plan, 'plan'); clean(objective, 'objective')
      Object.assign(m, { objective: clone(objective), playbook_key, plan: clone(plan), plan_version: m.plan_version + 1, updated_at: iso() })
      return clone(m)
    },
    async transitionMission({ org_id, mission_id, to, report }) {
      track('transitionMission')
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org_id) throw E('NOT_FOUND', 'mission')
      if (m.status === to) return clone(m)
      if (!MISSION_TRANSITIONS[m.status]?.includes(to)) throw E('ILLEGAL_TRANSITION', `mission ${m.status} → ${to}`)
      if (report !== undefined) m.report = clone(clean(report, 'report'))
      m.status = to
      m.updated_at = iso()
      if (TERMINAL.has(to)) m.completed_at = iso()
      return clone(m)
    },

    // ── assignments
    async createAssignment({ org_id, mission_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id, depends_on = [], input = {}, resource_type = null, resource_key = null, max_attempts = 3, parent_assignment_id = null }) {
      track('createAssignment')
      const m = S.missions.get(mission_id)
      if (!m || m.org_id !== org_id) throw E('NOT_FOUND', 'mission')
      for (const a of S.assignments.values()) if (a.mission_id === mission_id && a.step_key === step_key) return { assignment: clone(a), created: false }
      if (TERMINAL.has(m.status)) throw E('ILLEGAL_TRANSITION', `a ${m.status} mission takes no new assignment`)
      if (!S.employees.has(assignee_employee_id)) throw E('NOT_FOUND', 'assignee')
      if (S.employees.get(assignee_employee_id).status === 'retired') throw E('CONFLICT', 'assignee retired')
      clean(input, 'input')
      const t = iso()
      const a = {
        assignment_id: `wfa_${crypto.randomUUID()}`, org_id, mission_id, parent_assignment_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id,
        status: 'pending', depends_on: [...depends_on], input: clone(input), output: null, outcome_class: null, evidence: [], runtime_job_id: null, resource_type, resource_key,
        attempt: 0, max_attempts: Math.min(Math.max(Number(max_attempts) || 3, 1), 5), next_attempt_at: null, lease_token: null, lease_until: null, lease_owner: null, last_error: null,
        created_at: t, updated_at: t, _seq: ++seq,
      }
      S.assignments.set(a.assignment_id, a)
      return { assignment: clone(a), created: true }
    },
    async getAssignment({ org_id, assignment_id }) { track('getAssignment'); const a = S.assignments.get(assignment_id); return a && a.org_id === org_id ? clone(a) : null },
    async listAssignments({ org_id, mission_id, status, assignee_employee_id, limit = 1000 } = {}) {
      track('listAssignments')
      return [...S.assignments.values()].filter((a) => a.org_id === org_id && (!mission_id || a.mission_id === mission_id) && (!status || a.status === status) && (!assignee_employee_id || a.assignee_employee_id === assignee_employee_id)).sort((a, b) => a._seq - b._seq).slice(0, limit).map(clone)
    },
    async claimAssignments({ org_id, owner, limit = 1, lease_seconds = 120, now: at }) {
      track('claimAssignments')
      const t = at ? Date.parse(at) : now()
      const depsDone = (a) => a.depends_on.every((k) => [...S.assignments.values()].some((x) => x.mission_id === a.mission_id && x.step_key === k && x.status === 'completed'))
      const live = (a) => ['active', 'waiting'].includes(S.missions.get(a.mission_id)?.status)
      const deadDep = (a) => a.depends_on.some((k) => [...S.assignments.values()].some((x) => x.mission_id === a.mission_id && x.step_key === k && ['failed', 'cancelled'].includes(x.status)))
      const out = []
      for (const a of [...S.assignments.values()].filter((x) => x.org_id === org_id && live(x)).sort((x, y) => x._seq - y._seq)) {
        if (a.status === 'pending' && deadDep(a)) { asgTransition(a, 'cancelled'); a.last_error = { code: 'DEPENDENCY_FAILED' }; continue }
        if (out.length >= limit) continue
        if (a.status === 'pending' && depsDone(a)) asgTransition(a, 'ready')
        if (S.employees.get(a.assignee_employee_id)?.status !== 'active') continue // a paused employee is a store-level kill switch
        if (a.status !== 'ready' || (a.next_attempt_at && Date.parse(a.next_attempt_at) > t) || !depsDone(a)) continue
        asgTransition(a, 'leased')
        Object.assign(a, { lease_token: crypto.randomUUID(), lease_until: new Date(t + lease_seconds * 1000).toISOString(), lease_owner: owner })
        out.push(clone(a))
      }
      return out
    },
    async progressAssignment({ org_id, assignment_id, lease_token, patch = {} }) {
      track('progressAssignment')
      const a = leased(org_id, assignment_id, lease_token)
      if (patch.status && patch.status !== a.status) { if (patch.status !== 'running') throw E('ILLEGAL_TRANSITION', 'progress may only set running'); asgTransition(a, 'running') }
      if (patch.output) a.output = { ...(a.output || {}), ...clone(clean(patch.output, 'output')) }
      if (patch.evidence) a.evidence = clone(clean(patch.evidence, 'evidence'))
      return clone(a)
    },
    async waitAssignmentOnJob({ org_id, assignment_id, lease_token, runtime_job_id }) {
      track('waitAssignmentOnJob')
      const a = leased(org_id, assignment_id, lease_token)
      if (!/^mjob_/.test(String(runtime_job_id))) throw E('PAYLOAD_REFUSED', 'runtime_job_id')
      asgTransition(a, 'waiting_job')
      a.runtime_job_id = runtime_job_id
      clearLease(a)
      return clone(a)
    },
    async resumeWaitingAssignments({ org_id, resolver }) {
      track('resumeWaitingAssignments')
      let n = 0
      for (const a of [...S.assignments.values()].filter((x) => x.org_id === org_id && x.status === 'waiting_job')) {
        const r = await resolver(a.runtime_job_id)
        if (r?.state === 'completed') { asgTransition(a, 'completed'); a.output = clone(clean(r.result ?? {}, 'result')); a.outcome_class = 'verified'; releaseClaimsOf(a); n += 1 }
        else if (r?.state === 'failed') {
          a.attempt += 1
          a.last_error = clone(r.error || { code: 'JOB_FAILED' })
          if (a.attempt >= a.max_attempts) { asgTransition(a, 'failed'); releaseClaimsOf(a) } else { asgTransition(a, 'ready'); a.next_attempt_at = iso(); a.runtime_job_id = null }
          n += 1
        }
      }
      return n
    },
    async finishAssignment({ org_id, assignment_id, lease_token, status, output, outcome_class, evidence, error, retry_after_seconds }) {
      track('finishAssignment')
      const a = leased(org_id, assignment_id, lease_token)
      if (!['verified', 'partial', 'unknown', 'refused'].includes(outcome_class)) throw E('PAYLOAD_REFUSED', 'outcome_class')
      if (output !== undefined) clean(output, 'output')
      if (evidence !== undefined) clean(evidence, 'evidence')
      if (status === 'retry') status = 'ready'
      if (status === 'ready') {
        a.attempt += 1
        if (a.attempt >= a.max_attempts) { asgTransition(a, 'failed'); a.outcome_class = outcome_class }
        else { asgTransition(a, 'ready'); a.next_attempt_at = new Date(now() + Math.max(0, Number(retry_after_seconds) || 0) * 1000).toISOString() }
      } else {
        asgTransition(a, status)
        a.outcome_class = outcome_class
      }
      if (output != null) a.output = { ...(a.output || {}), ...clone(output) } // the output MERGES (the store's semantics)
      if (evidence != null) a.evidence = [...(a.evidence || []), ...clone(evidence)]
      if (error != null) a.last_error = clone(error)
      clearLease(a)
      releaseClaimsOf(a)
      return clone(a)
    },
    async transferAssignment({ org_id, assignment_id, to_employee_id }) {
      track('transferAssignment')
      const a = S.assignments.get(assignment_id)
      if (!a || a.org_id !== org_id) throw E('NOT_FOUND', 'assignment')
      if (TERMINAL.has(a.status)) throw E('ILLEGAL_TRANSITION', 'terminal')
      if (!S.employees.has(to_employee_id)) throw E('NOT_FOUND', 'employee')
      a.assignee_employee_id = to_employee_id
      return clone(a)
    },
    async cancelMissionAssignments({ org_id, mission_id }) {
      track('cancelMissionAssignments')
      let n = 0
      for (const a of S.assignments.values()) if (a.org_id === org_id && a.mission_id === mission_id && !TERMINAL.has(a.status)) { asgTransition(a, 'cancelled'); clearLease(a); n += 1 }
      return n
    },
    async reapAssignments({ org_id, now: at } = {}) {
      track('reapAssignments')
      const t = at ? Date.parse(at) : now()
      const out = { requeued: 0, failed: 0 }
      for (const a of S.assignments.values()) {
        if (a.org_id !== org_id || !['leased', 'running'].includes(a.status) || Date.parse(a.lease_until) > t) continue
        a.attempt += 1
        clearLease(a)
        if (a.attempt >= a.max_attempts) { asgTransition(a, 'failed'); a.last_error = { code: 'LEASE_EXPIRED' }; out.failed += 1 } else { asgTransition(a, 'ready'); a.next_attempt_at = null; out.requeued += 1 }
      }
      return out
    },

    // ── resource ownership
    async acquireResourceClaim({ org_id, resource_type, resource_key, employee_id, assignment_id, ttl_seconds = 3600 }) {
      track('acquireResourceClaim')
      const t = now()
      const live = S.claims.find((c) => c.org_id === org_id && c.resource_type === resource_type && c.resource_key === resource_key && !c.released_at)
      if (!(ttl_seconds >= 1 && ttl_seconds <= 86400)) throw E('PAYLOAD_REFUSED', 'ttl_seconds 1..86400')
      if (live && Date.parse(live.expires_at) <= t) live.released_at = iso(t)
      else if (live && live.employee_id === employee_id && live.assignment_id === assignment_id) { live.expires_at = new Date(t + ttl_seconds * 1000).toISOString(); return clone(live) }
      else if (live) throw E('CLAIM_HELD', `held by ${live.employee_id}`)
      const c = { org_id, resource_type, resource_key, employee_id, assignment_id, claimed_at: iso(t), expires_at: new Date(t + ttl_seconds * 1000).toISOString(), released_at: null }
      S.claims.push(c)
      return clone(c)
    },
    async releaseResourceClaim({ org_id, resource_type, resource_key, assignment_id }) {
      track('releaseResourceClaim')
      for (const c of S.claims) if (c.org_id === org_id && c.resource_type === resource_type && c.resource_key === resource_key && c.assignment_id === assignment_id && !c.released_at) c.released_at = iso()
    },
    async listResourceClaims({ org_id, active = true } = {}) { track('listResourceClaims'); return S.claims.filter((c) => c.org_id === org_id && (active === false || !c.released_at)).map(clone) },
    async reapResourceClaims({ org_id, now: at } = {}) {
      track('reapResourceClaims')
      const t = at ? Date.parse(at) : now()
      let n = 0
      for (const c of S.claims) if (c.org_id === org_id && !c.released_at && Date.parse(c.expires_at) <= t) { c.released_at = iso(t); n += 1 }
      return n
    },

    // ── events / conversation / memory
    async appendEvent({ org_id, type, mission_id = null, assignment_id = null, employee_id = null, payload = {} }) {
      track('appendEvent')
      if (!/^wf\.[a-z_.]+$/.test(String(type))) throw E('PAYLOAD_REFUSED', `event type ${type}`)
      if (mission_id != null && !S.missions.has(mission_id)) throw E('NOT_FOUND', 'mission')
      if (assignment_id != null && !S.assignments.has(assignment_id)) throw E('NOT_FOUND', 'assignment')
      if (employee_id != null && !S.employees.has(employee_id)) throw E('NOT_FOUND', 'employee')
      clean(payload, 'event payload')
      if (Buffer.byteLength(JSON.stringify(payload)) > 8192) throw E('PAYLOAD_REFUSED', 'event payload > 8KB')
      const ev = { event_id: ++eventSeq, org_id, at: iso(), mission_id, assignment_id, employee_id, type, payload: clone(payload) }
      S.events.push(ev)
      return clone(ev)
    },
    async listEvents({ org_id, after_event_id, mission_id, limit = 100 } = {}) {
      track('listEvents')
      return S.events.filter((e) => e.org_id === org_id && (after_event_id == null || e.event_id > after_event_id) && (!mission_id || e.mission_id === mission_id)).slice(0, limit).map(clone)
    },
    async appendExecMessage({ org_id, author, author_user_id = null, author_employee_id = null, content, refs = [], mission_id = null }) {
      track('appendExecMessage')
      if (!['ceo', 'coo'].includes(author)) throw E('PAYLOAD_REFUSED', 'author')
      if (author === 'ceo' && (author_employee_id != null || !isOwner(org_id, author_user_id))) throw E('FORBIDDEN', 'a CEO message is authored by an owner')
      if (author === 'coo' && (author_user_id != null || S.employees.get(author_employee_id)?.role_key !== 'coo')) throw E('FORBIDDEN', 'a COO message is authored by the COO employee')
      if (!String(content || '').trim() || String(content).length > 8000 || textViolation(content)) throw E('PAYLOAD_REFUSED', 'content')
      clean(refs, 'refs')
      const m = { message_id: crypto.randomUUID(), org_id, mission_id, author, author_user_id, author_employee_id, content: String(content), refs: clone(refs), created_at: iso(), _seq: ++seq }
      S.messages.push(m)
      return clone(m)
    },
    async listExecMessages({ org_id, mission_id, limit = 50 } = {}) {
      track('listExecMessages')
      const xs = S.messages.filter((m) => m.org_id === org_id && (!mission_id || m.mission_id === mission_id))
      return xs.slice(-limit).reverse().map(clone) // newest first (the store's order)
    },
    async assertMemoryFact({ org_id, scope, scope_key, fact_key, value, epistemic, confidence = null, source_refs, author_employee_id = null, author_user_id = null }) {
      track('assertMemoryFact')
      if (!['verified', 'interpretation', 'ceo_policy'].includes(epistemic)) throw E('PAYLOAD_REFUSED', 'epistemic')
      if (!Array.isArray(source_refs)) throw E('PAYLOAD_REFUSED', 'source_refs')
      if (epistemic === 'verified' && !source_refs.length) throw E('PAYLOAD_REFUSED', 'verified needs a source ref')
      if (epistemic === 'ceo_policy' && !isOwner(org_id, author_user_id)) throw E('FORBIDDEN', 'ceo_policy is the CEO user only')
      clean(value, 'value'); clean(source_refs, 'source_refs')
      const live = S.facts.find((f) => f.org_id === org_id && f.scope === scope && f.scope_key === scope_key && f.fact_key === fact_key && f.epistemic === epistemic && !f.superseded_at)
      const fact = { fact_id: crypto.randomUUID(), org_id, scope, scope_key, fact_key, value: clone(value), epistemic, confidence, source_refs: clone(source_refs), author_employee_id, author_user_id, valid_from: iso(), superseded_by: null, superseded_at: null }
      if (live) Object.assign(live, { superseded_by: fact.fact_id, superseded_at: iso() })
      S.facts.push(fact)
      return clone(fact)
    },
    async listMemoryFacts({ org_id, scope, scope_key, include_superseded = false } = {}) {
      track('listMemoryFacts')
      return S.facts.filter((f) => f.org_id === org_id && (!scope || f.scope === scope) && (!scope_key || f.scope_key === scope_key) && (include_superseded || !f.superseded_at)).map(clone)
    },

    // ── authority / settings / KPIs
    async listPolicies({ org_id, status } = {}) { track('listPolicies'); return S.policies.filter((p) => p.org_id === org_id && (!status || p.status === status)).map(clone) },
    async putPolicy({ org_id, policy, actor_user_id }) {
      track('putPolicy')
      if (!isOwner(org_id, actor_user_id)) throw E('FORBIDDEN', 'policies are CEO-authored')
      if (Object.keys(policy || {}).some((k) => !['policy_id', 'role_key', 'employee_id', 'action_key', 'scope', 'limits', 'risk', 'min_confidence', 'review', 'valid_from', 'valid_until'].includes(k))) throw E('PAYLOAD_REFUSED', 'unknown policy field')
      if ((policy.role_key == null) === (policy.employee_id == null)) throw E('PAYLOAD_REFUSED', 'exactly one of role_key / employee_id')
      clean(policy.scope || {}, 'scope'); clean(policy.limits || {}, 'limits')
      const prev = policy.policy_id ? S.policies.find((p) => p.policy_id === policy.policy_id) : null
      if (policy.policy_id && !prev) throw E('NOT_FOUND', 'policy')
      if (prev) prev.status = 'revoked'
      const { policy_id: _old, ...fields } = clone(policy)
      const p = { review: 'ceo', risk: 'low', scope: {}, limits: {}, ...fields, policy_id: crypto.randomUUID(), org_id, status: 'active', version: prev ? (prev.version || 1) + 1 : 1, supersedes: prev?.policy_id ?? null, created_by: actor_user_id }
      S.policies.push(p)
      return clone(p)
    },
    async revokePolicy({ org_id, policy_id, actor_user_id }) {
      track('revokePolicy')
      const p = S.policies.find((x) => x.org_id === org_id && x.policy_id === policy_id)
      if (!p) throw E('NOT_FOUND', 'policy')
      if (!isOwner(org_id, actor_user_id)) throw E('FORBIDDEN', 'policies are CEO-authored')
      p.status = 'revoked'
      return clone(p)
    },
    async getSettings({ org_id }) { track('getSettings'); return clone(S.settings.get(org_id) || { org_id, exec_review_price_usd: 5_000_000, escalation: {} }) },
    async putSettings({ org_id, patch, actor_user_id }) {
      track('putSettings')
      if (!isOwner(org_id, actor_user_id)) throw E('FORBIDDEN', 'settings are CEO-authored')
      const cur = S.settings.get(org_id) || { org_id, exec_review_price_usd: 5_000_000, escalation: {} }
      const next = { ...cur, ...clone(patch) }
      S.settings.set(org_id, next)
      return clone(next)
    },
    async putKpi({ org_id, subject_type, subject_key, kpi_key, window, value, status, source }) {
      track('putKpi')
      S.kpis = S.kpis.filter((k) => !(k.org_id === org_id && k.subject_type === subject_type && k.subject_key === subject_key && k.kpi_key === kpi_key && k.window === window))
      S.kpis.push({ org_id, subject_type, subject_key, kpi_key, window, value: status === 'unknown' ? null : value, status, source: clone(source), computed_at: iso() })
    },
    async listKpis({ org_id, subject_type, subject_key } = {}) { track('listKpis'); return S.kpis.filter((k) => k.org_id === org_id && (!subject_type || k.subject_type === subject_type) && (!subject_key || k.subject_key === subject_key)).map(clone) },
  }
  return store
}

/** Seed the executive staff (and optional extra rows) into a fake store. */
export async function seedFakeOrg(store, { org_id, seed, owner_user_id = null, extra = [] }) {
  for (const e of seed) await store.upsertEmployee({ org_id, employee: { ...e, ...(e.employee_id === 'emp_ceo' ? { user_id: owner_user_id } : {}) }, actor_user_id: owner_user_id })
  for (const e of extra) await store.upsertEmployee({ org_id, employee: e, actor_user_id: owner_user_id })
}

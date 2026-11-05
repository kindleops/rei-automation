// Workforce API (docs/WORKFORCE.md §7) — the thin Next routes under app/api/cockpit/workforce call these.
//
// Order on every request (the same as the Missions / Operations APIs, Gate B):
//   (1) gate → 404 with an EMPTY body unless AGENT_ENABLED and WORKFORCE_ENABLED=1
//   (2) ops-dashboard auth (ensureMutationAuth)   (3) NAMED-USER authentication + the agent allowlist
//   (4) per-user rate limit → 429                 (5) agent.operator_membership → 403
// Mutations act as the NAMED OPERATOR FROM THE SESSION: any actor / user / requested_by in the body is
// ignored. CEO-only mutations (employees, policies, settings) need the owner membership role.
// Envelope: { ok: true, data } / { ok: false, error, message }. Responses use the dashboard's shapes (present.js:
// step_key / capability_key in the response even though stored jsonb says step / capability); property refs
// are decoded for linking. Error codes: 404 (off), 401/403 (session, NOT_A_MEMBER, CEO_ONLY, FORBIDDEN),
// 409 (ILLEGAL_TRANSITION, CONFLICT), 422 (PAYLOAD_REFUSED, invalid input), 423 (EMERGENCY_STOP), 503.
// Nothing here can send, offer, write a stage or launch anything: a directive opens a mission whose
// plan is built only from the closed capability catalog.
import { createAgentIdentityProvider } from '../agent/security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../agent/security/rate-limit.js'
import { isAgentEnabled } from '../agent/config/agent-config.js'
import { runtimeIdempotencyKey } from '../agent/runtime/job-runtime.js'
import { decodeStored } from '../agent/missions/mission-codec.js'
import { COO_PLAN_KIND, WORKFORCE_KINDS, WORKFORCE_LIMITS, WORKFORCE_ORG_ID, modelInterpretEnabled, workforceEnabled } from './config.js'
import { ROLES, ROLE_CHARTERS, charterFor, effectiveTierCeiling } from './org/charters.js'
import { CEO_EMPLOYEE_ID, COO_EMPLOYEE_ID } from './org/seed.js'
import { interpretDirective, label } from './coo/interpret.js'
import { statusAnswer } from './coo/respond.js'
import { DECISIONS, decisionAck, decisionOutcome } from './coo/decisions.js'
import { OPEN_ASSIGNMENT_STATES, openCountsOf } from './coo/staffing.js'
import { proposeGrants } from './authority/engine.js'
import { enqueueWorkforceJob } from './engine/dispatch.js'
import { marketSlug, safeText } from './capabilities/shared.js'
import { NEVER_REVIVE } from '../domain/action-gateway/actions/t2/shared.js'
import { decodeText, presentAssignment, presentCharter, presentCharters, presentDepartments, presentGrant, presentMission, presentRefs, presentReport, presentRuntime } from './present.js'
import { missionTitle, DIRECTIVE_MISSION_PRIORITY } from './missions/directive.js'
import { agnteiLinkSteps } from './agntei/link-steps.js'
import { employeeActivity } from './agntei/activity.js'

const DEFAULTS = Symbol.for('lc.workforce.routes')
function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}
export const isWorkforceRouteEnabled = (env = process.env) => isAgentEnabled(env) && workforceEnabled(env)

const MISSION_STATUSES = ['planning', 'active', 'waiting', 'blocked', 'completed', 'failed', 'cancelled']
const ASSIGNMENT_STATUSES = ['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled']
const EMP_ID = /^emp_[a-z0-9_]{3,40}$/
const WFM_ID = /^wfm_[0-9a-f-]{36}$/
const WFA_ID = /^wfa_[0-9a-f-]{36}$/
const CLIENT_REQ = /^[A-Za-z0-9_-]{8,80}$/
const STORE_STATUS = { NOT_FOUND: 404, CONFLICT: 409, LEASE_LOST: 409, ILLEGAL_TRANSITION: 409, PAYLOAD_REFUSED: 422, CLAIM_HELD: 409, VERSION_MISMATCH: 409, FORBIDDEN: 403, UNAVAILABLE: 503 }

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}
const ok = (data, headers, status = 200) => json({ ok: true, data: decodeStored(data) }, status, headers)
const fail = (error, message, status, headers, detail = null) => json({ ok: false, error, message, ...(detail ? { detail } : {}) }, status, headers)
const storeFail = (e, headers) => (STORE_STATUS[e?.code]
  ? fail(e.code, e.message || e.code, STORE_STATUS[e.code], headers)
  : fail(e?.code || 'WORKFORCE_DB_UNAVAILABLE', 'The workforce store is unavailable.', 503, headers))
async function body(request) {
  try { const b = await request.json(); return b && typeof b === 'object' ? b : {} } catch { return {} }
}
const qp = (request) => new URL(request.url).searchParams

/**
 * @param {Request} request
 * @param {{ env?, auth: Function, headers?, identity?, limiter?, getServices: Function, bucket?: 'read'|'mutation' }} o
 *   getServices → { store, runtimeStore?, reads?, membership(org_id, user_id) → { role } | null, knownMarkets?, latestBrief? }
 */
async function prologue(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, getServices, bucket = 'read' } = {}) {
  if (!isWorkforceRouteEnabled(env) || typeof auth !== 'function') return { response: new Response(null, { status: 404 }) }
  const a = auth(request)
  if (!a?.ok) return { response: a?.response || json({ ok: false, error: 'unauthorized', message: 'Not authorized.' }, 401, headers) }
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) return { response: fail(who?.code || 'SESSION_REQUIRED', who?.status === 403 ? 'This account is not authorized to use the workforce.' : 'Sign in again: a verified operator session is required.', who?.status || 401, headers) }
  const rl = (limiter || d.limiter).check(who.identity.user_id, bucket)
  if (!rl.ok) return { response: fail(rl.code, 'Too many requests.', 429, { ...headers, 'retry-after': String(rl.retry_after_s) }) }
  let svc
  try { svc = await getServices({ env }) } catch (e) { return { response: fail(e?.code || 'WORKFORCE_DB_UNAVAILABLE', 'The workforce store is unavailable.', 503, headers) } }
  if (!svc?.store) return { response: fail('WORKFORCE_UNCONFIGURED', 'The workforce store is not configured.', 503, headers) }
  let member
  try { member = await svc.membership(WORKFORCE_ORG_ID, who.identity.user_id) } catch (e) { return { response: fail(e?.code || 'WORKFORCE_DB_UNAVAILABLE', 'Membership could not be read.', 503, headers) } }
  if (!member) return { response: fail('NOT_A_MEMBER', 'This account is not a member of the organization.', 403, headers) }
  return { svc, identity: who.identity, member, env, org_id: WORKFORCE_ORG_ID }
}
const isOwner = (p) => p.member?.role === 'owner'

// ── missions / directives ────────────────────────────────────────────────────
// (missionTitle: missions/directive.js — shared with the Action Gateway's workforce_open_mission)

async function runtimeStatus(p) {
  const rs = p.svc.runtimeStore
  try { if (typeof rs?.status === 'function') return await rs.status() } catch { /* fall through */ }
  try { if (typeof rs?.limits === 'function') return { limits: await rs.limits(), heartbeats: [], schedules: [] } } catch { /* unknown */ }
  return null
}

/** Open (or return the replayed) mission for an actionable directive and enqueue its coo_plan. */
async function openDirective(p, { directive, client_request_id, interp }) {
  const user = p.identity.user_id
  const st = await runtimeStatus(p)
  if (st?.limits?.emergency_stop === true) return { stopped: true }
  const idempotency_key = runtimeIdempotencyKey('workforce.mission', user, client_request_id)
  const { mission, created } = await p.svc.store.openMission({ org_id: p.org_id, title: missionTitle(interp), directive, requested_by: user, owner_employee_id: COO_EMPLOYEE_ID, priority: DIRECTIVE_MISSION_PRIORITY, idempotency_key })
  let enqueue = null
  if (mission.status === 'planning') {
    const r = await enqueueWorkforceJob(p.svc.runtimeStore, { kind: COO_PLAN_KIND, key: [mission.mission_id], input: { mission_id: mission.mission_id }, requested_by: user, priority: 90, budget_cap_usd: modelInterpretEnabled(p.env) ? 0.05 : 0 }).catch((e) => ({ ok: false, reason: e?.code || 'runtime_unavailable' }))
    enqueue = r?.ok ? { ok: true, job_id: r.job_id, deduped: Boolean(r.deduped) } : { ok: false, reason: String(r?.reason || 'runtime_unavailable') }
    // (the store writes the mechanical wf.mission.opened event itself)
    if (!enqueue.ok) await p.svc.store.appendEvent({ org_id: p.org_id, type: 'wf.mission.plan_enqueue_failed', mission_id: mission.mission_id, payload: { reason: enqueue.reason.slice(0, 60) } })
  }
  return { mission, created, enqueue }
}
const emergencyFail = (headers) => fail('EMERGENCY_STOP', 'The runtime emergency stop is on: no new mission is opened until it is lifted.', 423, headers)

function directiveInput(b) {
  const directive = String(b?.directive ?? b?.content ?? '').trim()
  const client_request_id = String(b?.client_request_id ?? '').trim()
  if (!directive) return { error: 'DIRECTIVE_REQUIRED' }
  if (directive.length > WORKFORCE_LIMITS.directive_max_chars) return { error: 'DIRECTIVE_TOO_LONG' }
  if (!CLIENT_REQ.test(client_request_id)) return { error: 'CLIENT_REQUEST_ID_INVALID' }
  return { directive, client_request_id }
}
const inactiveOf = (employees = []) => new Map(employees.filter((e) => e.status !== 'active').map((e) => [e.employee_id, e.status]))
const presentMessage = (m) => ({ ...m, content: decodeText(m.content), refs: presentRefs(m.refs) })

export async function handleMissionsList(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  const status = MISSION_STATUSES.includes(q.get('status')) ? q.get('status') : undefined
  try {
    const [missions, assignments] = await Promise.all([
      p.svc.store.listMissions({ org_id: p.org_id, status, limit: Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200), before: q.get('before') || undefined }),
      p.svc.store.listAssignments({ org_id: p.org_id, limit: 1000 }),
    ])
    const by = new Map()
    for (const a of assignments) { if (!by.has(a.mission_id)) by.set(a.mission_id, []); by.get(a.mission_id).push(a) }
    return ok({ missions: missions.map((m) => presentMission(m, { assignments: by.get(m.mission_id) || [] })) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleMissionCreate(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const b = await body(request) // any actor / requested_by / user in the body is ignored: the session decides
  const v = directiveInput(b)
  if (v.error) return fail(v.error, 'A directive and a client_request_id are required.', 422, opts.headers)
  const interp = interpretDirective(v.directive, p.svc.knownMarkets ? { markets: p.svc.knownMarkets } : {})
  try {
    if (!interp.actionable) {
      const content = interp.refusal ? interp.refusal.message : interp.intent === 'status_review' ? 'That is a status question: ask it in the Executive Command conversation and I will answer from live data.' : interp.clarifying_question
      // the Executive Command conversation is the CEO's (an owner): an operator's refused directive is answered, not recorded as a CEO line
      if (isOwner(p)) {
        await p.svc.store.appendExecMessage({ org_id: p.org_id, author: 'ceo', author_user_id: p.identity.user_id, content: v.directive, refs: [{ type: 'client_request', id: v.client_request_id }] })
        await p.svc.store.appendExecMessage({ org_id: p.org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, content, refs: [{ type: 'client_request', id: v.client_request_id }] })
      }
      return fail(interp.refusal ? 'DIRECTIVE_REFUSED' : interp.intent === 'status_review' ? 'STATUS_IS_A_QUESTION' : 'DIRECTIVE_UNCLEAR', content, 422, opts.headers, { intent: interp.intent, codes: interp.refusal?.codes || [] })
    }
    const out = await openDirective(p, { ...v, interp })
    if (out.stopped) return emergencyFail(opts.headers)
    return ok({ mission: presentMission(out.mission), created: out.created, enqueue: out.enqueue, interpretation: { intent: interp.intent, markets: interp.markets, count: interp.count } }, opts.headers, out.created ? 201 : 200)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleMissionGet(request, mission_id, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  if (!WFM_ID.test(String(mission_id || ''))) return fail('MISSION_ID_INVALID', 'Unknown mission id.', 422, opts.headers)
  try {
    const mission = await p.svc.store.getMission({ org_id: p.org_id, mission_id })
    if (!mission) return fail('NOT_FOUND', 'Mission not found.', 404, opts.headers)
    const [assignments, events, messages, employees] = await Promise.all([
      p.svc.store.listAssignments({ org_id: p.org_id, mission_id, limit: 1000 }),
      p.svc.store.listEvents({ org_id: p.org_id, mission_id, limit: 500 }),
      p.svc.store.listExecMessages({ org_id: p.org_id, mission_id, limit: 50 }),
      p.svc.store.listEmployees({ org_id: p.org_id }),
    ])
    const m = presentMission(mission, { assignments })
    const inactive = inactiveOf(employees)
    const byId = new Map(employees.map((e) => [e.employee_id, e]))
    return ok({ mission: m, plan: m.plan, report: m.report, assignments: assignments.map((a) => presentAssignment(a, { inactive, employees: byId })), events, messages: messages.map(presentMessage) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleMissionCancel(request, mission_id, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  if (!WFM_ID.test(String(mission_id || ''))) return fail('MISSION_ID_INVALID', 'Unknown mission id.', 422, opts.headers)
  try {
    const mission = await p.svc.store.getMission({ org_id: p.org_id, mission_id })
    if (!mission) return fail('NOT_FOUND', 'Mission not found.', 404, opts.headers)
    if (mission.requested_by !== p.identity.user_id && !isOwner(p)) return fail('FORBIDDEN', 'Only the requester or the owner can cancel a mission.', 403, opts.headers)
    const cancelled = await p.svc.store.cancelMissionAssignments({ org_id: p.org_id, mission_id })
    const m = await p.svc.store.transitionMission({ org_id: p.org_id, mission_id, to: 'cancelled' })
    await p.svc.store.appendEvent({ org_id: p.org_id, type: 'wf.mission.cancelled', mission_id, payload: { by_user: p.identity.user_id, assignments_cancelled: cancelled } })
    return ok({ mission: presentMission(m), assignments_cancelled: cancelled }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

// ── the executive conversation ───────────────────────────────────────────────
export async function handleCommandList(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  try {
    const messages = await p.svc.store.listExecMessages({ org_id: p.org_id, mission_id: WFM_ID.test(q.get('mission') || '') ? q.get('mission') : undefined, limit: Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200), before: q.get('before') || undefined })
    return ok({ messages: messages.map(presentMessage) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleCommandPost(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  // the executive conversation is the CEO's: a CEO line is authored by an owner of the org (the store re-checks)
  if (!isOwner(p)) return fail('CEO_ONLY', 'The executive conversation is the CEO\'s. Submit a directive through Missions instead.', 403, opts.headers)
  const b = await body(request)
  const v = directiveInput({ directive: b?.content, client_request_id: b?.client_request_id })
  if (v.error) return fail(v.error === 'DIRECTIVE_REQUIRED' ? 'CONTENT_REQUIRED' : v.error, 'Content and a client_request_id are required.', 422, opts.headers)
  const s = p.svc.store
  try {
    // a replayed submission returns what the first one produced
    const recent = await s.listExecMessages({ org_id: p.org_id, limit: 100 })
    const prior = recent.filter((m) => (m.refs || []).some((r) => r?.type === 'client_request' && r.id === v.client_request_id))
    if (prior.some((m) => m.author === 'ceo' && m.author_user_id === p.identity.user_id)) {
      const mref = prior.flatMap((m) => m.refs || []).find((r) => r?.type === 'mission')
      const mission = mref ? await s.getMission({ org_id: p.org_id, mission_id: mref.id }) : null
      return ok({ messages: prior.map(presentMessage), mission: presentMission(mission), replayed: true }, opts.headers)
    }
    const interp = interpretDirective(v.directive, p.svc.knownMarkets ? { markets: p.svc.knownMarkets } : {})
    let opened = null
    if (!interp.refusal && interp.actionable) {
      opened = await openDirective(p, { ...v, interp })
      if (opened.stopped) return emergencyFail(opts.headers)
    }
    const reqRef = { type: 'client_request', id: v.client_request_id }
    const ceoMsg = await s.appendExecMessage({ org_id: p.org_id, author: 'ceo', author_user_id: p.identity.user_id, content: v.directive, refs: [reqRef] })
    let content
    const mission = opened?.mission || null
    if (interp.refusal) content = interp.refusal.message
    else if (interp.intent === 'status_review') {
      const [missions, assignments, employees] = await Promise.all([s.listMissions({ org_id: p.org_id, limit: 50 }), s.listAssignments({ org_id: p.org_id, limit: 1000 }), s.listEmployees({ org_id: p.org_id })])
      content = statusAnswer({ missions, assignments, employees }).content
    } else if (!interp.actionable) content = interp.clarifying_question
    else {
      content = opened.enqueue?.ok === false
        ? `I opened the mission "${mission.title}", but I could not queue its planning job (${opened.enqueue.reason}). It will not start until the runtime accepts it.`
        : `On it. I opened the mission "${mission.title}" and I am planning it now. Nothing in it contacts a seller or makes an offer.`
    }
    const cooMsg = await s.appendExecMessage({ org_id: p.org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, mission_id: mission?.mission_id ?? undefined, content, refs: [reqRef, ...(mission ? [{ type: 'mission', id: mission.mission_id }] : [])] })
    return ok({ messages: [ceoMsg, cooMsg].map(presentMessage), mission: presentMission(mission), interpretation: { intent: interp.intent, refused: Boolean(interp.refusal), codes: interp.refusal?.codes || [] } }, opts.headers, mission ? 201 : 200)
  } catch (e) { return storeFail(e, opts.headers) }
}

// ── organization ─────────────────────────────────────────────────────────────
export async function handleOverview(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const s = p.svc.store
  try {
    const [employees, missions, assignments, events, status] = await Promise.all([
      s.listEmployees({ org_id: p.org_id }),
      s.listMissions({ org_id: p.org_id, limit: 200 }),
      s.listAssignments({ org_id: p.org_id, limit: 1000 }),
      s.listEvents({ org_id: p.org_id, limit: 500 }), // §11 lists ascending from a cursor: the newest 20 of a bounded window
      runtimeStatus(p),
    ])
    const open = openCountsOf(assignments)
    return ok({
      departments: presentDepartments(employees, assignments),
      employees: employees.map((e) => ({ ...e, open_assignments: open.get(e.employee_id) || 0, activity: employeeActivity(e, assignments, { now: Date.now() }) })),
      missions_by_status: Object.fromEntries(MISSION_STATUSES.map((st) => [st, missions.filter((m) => m.status === st).length])),
      assignments_by_status: Object.fromEntries(ASSIGNMENT_STATUSES.map((st) => [st, assignments.filter((a) => a.status === st).length])),
      last_events: events.slice(-20),
      runtime: presentRuntime(status, WORKFORCE_KINDS),
      flags: { workforce_enabled: true, model_interpret: modelInterpretEnabled(p.env) },
    }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleEmployeesList(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  try {
    const [employees, assignments] = await Promise.all([
      p.svc.store.listEmployees({ org_id: p.org_id, status: ['active', 'paused', 'retired', 'pending_link'].includes(q.get('status')) ? q.get('status') : undefined }),
      p.svc.store.listAssignments({ org_id: p.org_id, limit: 1000 }),
    ])
    const open = openCountsOf(assignments)
    return ok({ employees: employees.map((e) => ({ ...e, open_assignments: open.get(e.employee_id) || 0, charter: presentCharter(e.role_key), activity: employeeActivity(e, assignments, { now: Date.now() }) })) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

/** CEO-authored employee rows: the body's employee fields are validated; kind and department come from the charter. */
export function validateEmployeeInput(raw = {}) {
  const e = raw && typeof raw === 'object' ? raw : {}
  const employee_id = String(e.employee_id || '').trim()
  if (!EMP_ID.test(employee_id)) return { error: 'EMPLOYEE_ID_INVALID' }
  if (!ROLES.includes(e.role_key)) return { error: 'ROLE_INVALID' }
  const charter = ROLE_CHARTERS[e.role_key]
  const display_name = String(e.display_name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60)
  if (!display_name || /[0-9]{4,}|@/.test(display_name)) return { error: 'DISPLAY_NAME_INVALID' }
  // markets are lower-case slugs (workforce.employee.markets): 'Dallas, TX' → 'dallas_tx'
  const markets = Array.isArray(e.markets) ? [...new Set(e.markets.map(marketSlug).filter(Boolean))].slice(0, 20) : []
  if (charter.market_scoped && !markets.length) return { error: 'MARKETS_REQUIRED_FOR_ROLE' }
  const status = ['active', 'paused', 'retired'].includes(e.status) ? e.status : 'active'
  const tier_ceiling = ['T1', 'T2'].includes(e.tier_ceiling) ? e.tier_ceiling : 'T1'
  const manager_employee_id = e.manager_employee_id == null ? null : EMP_ID.test(String(e.manager_employee_id)) ? String(e.manager_employee_id) : undefined
  if (manager_employee_id === undefined) return { error: 'MANAGER_ID_INVALID' }
  const employee_code = e.employee_code == null ? null : String(e.employee_code).replace(/[^A-Z0-9-]/gi, '').toUpperCase().slice(0, 12) || null
  const spend = Number(e.spend_day_cap_usd ?? 0)
  // docs/WORKFORCE-AGNTEI.md §1: skills / property specializations are lower-case slugs; availability a closed set
  const tags = (v) => (Array.isArray(v) ? [...new Set(v.map(marketSlug).filter(Boolean))].slice(0, 20) : undefined)
  const skills = tags(e.skills)
  const property_specializations = tags(e.property_specializations)
  const availability = ['available', 'busy', 'off', 'unknown'].includes(e.availability) ? e.availability : undefined
  return { employee: { employee_id, role_key: e.role_key, kind: charter.kind, department_key: charter.department_key, display_name, employee_code, manager_employee_id, status, markets, segments: e.segments && typeof e.segments === 'object' && !Array.isArray(e.segments) ? e.segments : {}, tier_ceiling, spend_day_cap_usd: Number.isFinite(spend) ? Math.min(Math.max(spend, 0), 5) : 0,
    ...(skills ? { skills } : {}), ...(property_specializations ? { property_specializations } : {}), ...(availability ? { availability } : {}) } }
}

/**
 * "Register an Agntei agent" (CEO only, docs/WORKFORCE-AGNTEI.md §1 step 1): a pending_link, unbound operator_ai employee.
 * It grants nothing and executes nothing; the response carries the exact owner steps (mint → principal → grants → bind →
 * connect → link) as copyable commands.
 */
export function validateAgnteiRegistration(raw = {}) {
  const v = validateEmployeeInput({ ...(raw || {}), status: 'active' })
  if (v.error) return v
  const charter = ROLE_CHARTERS[v.employee.role_key]
  if (charter.kind !== 'ai' || ['ceo', 'coo'].includes(v.employee.role_key)) return { error: 'ROLE_NOT_FOR_AN_AGNTEI_AGENT' }
  const { status, ...employee } = v.employee
  return { employee: { ...employee, kind: 'ai', origin: 'agntei', employment_type: 'operator_ai' } }
}

export async function handleEmployeeUpsert(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  if (!isOwner(p)) return fail('CEO_ONLY', 'Only the CEO can create or change employees.', 403, opts.headers)
  const b = await body(request)
  if (b.op === 'register_agntei') return registerAgntei(p, b, opts)
  const v = validateEmployeeInput(b.employee || b)
  if (v.error) return fail(v.error, 'The employee is not valid.', 422, opts.headers)
  if (v.employee.role_key === 'ceo' && v.employee.employee_id !== CEO_EMPLOYEE_ID) return fail('CEO_ROW_FIXED', 'There is exactly one CEO row.', 422, opts.headers)
  try {
    // (the store writes the mechanical wf.employee.upserted event itself)
    const employee = await p.svc.store.upsertEmployee({ org_id: p.org_id, employee: v.employee, actor_user_id: p.identity.user_id })
    return ok({ employee }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

async function registerAgntei(p, b, opts) {
  const v = validateAgnteiRegistration(b.employee || {})
  if (v.error) return fail(v.error, 'The Agntei employee is not valid.', 422, opts.headers)
  try {
    if (await p.svc.store.getEmployee({ org_id: p.org_id, employee_id: v.employee.employee_id })) return fail('CONFLICT', 'An employee with this id already exists.', 409, opts.headers)
    const employee = await p.svc.store.upsertEmployee({ org_id: p.org_id, employee: v.employee, actor_user_id: p.identity.user_id })
    const ceo = await p.svc.store.getEmployee({ org_id: p.org_id, employee_id: CEO_EMPLOYEE_ID })
    return ok({ employee, link: agnteiLinkSteps({ employee, org_id: p.org_id, ceo_user_id: ceo?.user_id ?? p.identity.user_id }), executed: false }, opts.headers, 201)
  } catch (e) { return storeFail(e, opts.headers) }
}

/** The external identity / binding of an employee as the dashboard shows it (ids and times only). */
function presentLink(e) {
  if (e?.origin !== 'agntei') return null
  return {
    system: 'agntei', principal_id: e.action_principal_id ?? null, bound_at: e.bound_at ?? null, link_expires_at: e.link_expires_at ?? null,
    binding_valid_until: e.binding_valid_until ?? null, binding_revoked_at: e.binding_revoked_at ?? null,
    linked: Boolean(e.external_agent_id), external_agent_id: e.external_agent_id ?? null, external_install_id: e.external_install_id ?? null, linked_at: e.external_linked_at ?? null,
  }
}

export async function handleEmployeeGet(request, employee_id, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  if (!EMP_ID.test(String(employee_id || ''))) return fail('EMPLOYEE_ID_INVALID', 'Unknown employee id.', 422, opts.headers)
  const s = p.svc.store
  try {
    const employee = await s.getEmployee({ org_id: p.org_id, employee_id })
    if (!employee) return fail('NOT_FOUND', 'Employee not found.', 404, opts.headers)
    const [assignments, memory, kpis, policies, events, gateway] = await Promise.all([
      s.listAssignments({ org_id: p.org_id, assignee_employee_id: employee_id, limit: 200 }),
      s.listMemoryFacts({ org_id: p.org_id, scope: 'employee', scope_key: employee_id }),
      s.listKpis({ org_id: p.org_id, subject_type: 'employee', subject_key: employee_id }),
      s.listPolicies({ org_id: p.org_id, status: 'active' }),
      s.listEvents({ org_id: p.org_id, employee_id, limit: 200 }).then((xs) => xs.slice(-100).reverse()).catch(() => null),
      typeof s.listEmployeeGatewayAudit === 'function' && employee.action_principal_id ? s.listEmployeeGatewayAudit({ org_id: p.org_id, employee_id, limit: 100 }).catch(() => ({ available: false, events: [], reason: 'gateway_audit_unreadable' }))
        : Promise.resolve({ available: employee.action_principal_id ? false : true, events: [], reason: employee.action_principal_id ? 'gateway_audit_unavailable' : 'no_principal' }),
    ])
    const jobs = [...new Set(assignments.map((a) => a.runtime_job_id).filter(Boolean))].slice(0, 25)
    // spend is per runtime job (agent.spend_ledger); a per-day split per employee is not recorded in Phase A
    let window_usd = jobs.length ? null : 0
    let status = jobs.length ? 'unknown' : 'known'
    let reason = jobs.length ? 'job spend unreadable' : 'no paid work (inline reads cost nothing)'
    if (jobs.length && p.svc.reads?.jobSpend) {
      let total = 0; let unknown = 0
      for (const id of jobs) { try { total += Number((await p.svc.reads.jobSpend(id)).committed_usd || 0) } catch { unknown += 1 } }
      if (!unknown) { window_usd = Math.round(total * 1e6) / 1e6; status = 'known'; reason = null } else reason = `${unknown} of ${jobs.length} job costs unreadable`
    }
    const charter = charterFor(employee.role_key)
    const inactive = inactiveOf([employee])
    return ok({
      employee: { ...employee, open_assignments: assignments.filter((a) => OPEN_ASSIGNMENT_STATES.includes(a.status)).length },
      activity: employeeActivity(employee, assignments, { now: Date.now() }),
      link: presentLink(employee),
      // the exact owner steps while the agent is not (or no longer) linked through a live binding (CEO only)
      link_steps: isOwner(p) && employee.origin === 'agntei' && (employee.status === 'pending_link' || employee.binding_revoked_at || (employee.binding_valid_until && Date.parse(employee.binding_valid_until) <= Date.now()))
        ? agnteiLinkSteps({ employee, org_id: p.org_id, ceo_user_id: (await s.getEmployee({ org_id: p.org_id, employee_id: CEO_EMPLOYEE_ID }))?.user_id ?? p.identity.user_id }) : null,
      // per-employee action history = the Workforce events + the Action Gateway audit of its principal (codes / ids only)
      history: { events: events ?? [], events_available: events !== null, gateway: gateway.events || [], gateway_available: gateway.available === true, gateway_reason: gateway.reason ?? null },
      charter: presentCharter(employee.role_key),
      authority: { effective_tier_ceiling: effectiveTierCeiling(employee), policies: policies.filter((x) => x.employee_id === employee_id || (!x.employee_id && x.role_key === employee.role_key)) },
      memory: memory.map((f) => ({ ...f, source_refs: presentRefs(f.source_refs) })),
      assignments: assignments.map((a) => presentAssignment(a, { inactive, employees: new Map([[employee.employee_id, employee]]) })),
      open_assignments: assignments.filter((a) => OPEN_ASSIGNMENT_STATES.includes(a.status)).length,
      kpis: (charter?.kpis || []).map((k) => kpis.find((x) => x.kpi_key === k) || { subject_type: 'employee', subject_key: employee_id, kpi_key: k, value: null, status: 'unknown', source: { reason: 'not computed in Phase A' } }),
      cost: { today_usd: jobs.length ? null : 0, window_usd, window: `last_${jobs.length}_jobs`, cap_usd: employee.spend_day_cap_usd ?? null, status: jobs.length ? 'unknown' : status, reason: jobs.length ? (status === 'known' ? 'per-day spend is not attributed per employee; window_usd is the recent jobs total' : reason) : reason },
    }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

// ── work queue, operations feed ──────────────────────────────────────────────
export async function handleAssignments(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  try {
    const [assignments, employees] = await Promise.all([p.svc.store.listAssignments({
      org_id: p.org_id,
      status: ASSIGNMENT_STATUSES.includes(q.get('status')) ? q.get('status') : undefined,
      assignee_employee_id: EMP_ID.test(q.get('employee') || '') ? q.get('employee') : undefined,
      mission_id: WFM_ID.test(q.get('mission') || '') ? q.get('mission') : undefined,
      limit: Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500),
    }), p.svc.store.listEmployees({ org_id: p.org_id })])
    const inactive = inactiveOf(employees)
    const byId = new Map(employees.map((e) => [e.employee_id, e]))
    return ok({ assignments: assignments.map((a) => presentAssignment(a, { inactive, employees: byId })) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

/**
 * POST /assignments/[id]/resolve { decision: 'approve'|'decline'|'done', note? } — the CEO decides an item in
 * their queue (an escalation, a review). CEO only (owner membership), as the SESSION user. The decision is
 * RECORDED inside Workforce (store.decideHeldAssignment: waiting_approval → completed, owner-checked again in
 * SQL) plus a semantic event and a COO acknowledgement. Nothing else happens: no send, no offer, no stage
 * write, no runtime job, no new assignment. A replay of the same decision writes nothing and answers the same.
 */
export async function handleAssignmentResolve(request, assignment_id, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  if (!isOwner(p)) return fail('CEO_ONLY', 'Only the CEO decides items in the CEO queue.', 403, opts.headers)
  if (!WFA_ID.test(String(assignment_id || ''))) return fail('ASSIGNMENT_ID_INVALID', 'Unknown assignment id.', 422, opts.headers)
  const b = await body(request) // any actor / user in the body is ignored: the session decides
  const decision = String(b?.decision || '')
  if (!DECISIONS.includes(decision)) return fail('DECISION_INVALID', 'The decision is approve, decline or done.', 422, opts.headers, { allowed: DECISIONS })
  const note = b?.note == null || String(b.note).trim() === '' ? null : String(b.note).replace(/[\u0000-\u001f]/g, ' ').trim()
  if (note && note.length > 500) return fail('NOTE_TOO_LONG', 'A note is at most 500 characters.', 422, opts.headers)
  const s = p.svc.store
  try {
    const current = await s.getAssignment({ org_id: p.org_id, assignment_id })
    if (!current) return fail('NOT_FOUND', 'Assignment not found.', 404, opts.headers)
    if (typeof s.decideHeldAssignment !== 'function') return fail('WORKFORCE_UNCONFIGURED', 'This store cannot record a decision.', 503, opts.headers)
    const { changed, assignment } = await s.decideHeldAssignment({ org_id: p.org_id, assignment_id, decision, note, actor_user_id: p.identity.user_id })
    const task = assignment.output?.task ?? assignment.input?.task ?? null
    const property_ref = assignment.input?.property_ref ?? null
    const raw = decisionOutcome({ decision, task, property_ref })
    const outcome = { ...raw, headline: decodeText(raw.headline), message: decodeText(raw.message) }
    let messages = []
    if (changed) {
      await s.appendEvent({ org_id: p.org_id, type: 'wf.ceo.decision_recorded', mission_id: assignment.mission_id, assignment_id, employee_id: assignment.assignee_employee_id,
        payload: { decision, task, property_ref, by_user: p.identity.user_id, effects: raw.effects } })
      const refs = [{ type: 'assignment', id: assignment_id }, { type: 'mission', id: assignment.mission_id }, ...(property_ref ? [{ type: 'property', id: property_ref }] : [])]
      messages = [await s.appendExecMessage({ org_id: p.org_id, author: 'coo', author_employee_id: COO_EMPLOYEE_ID, mission_id: assignment.mission_id, content: decisionAck({ decision, task, property_ref, note }), refs })]
    }
    const employees = await s.listEmployees({ org_id: p.org_id })
    return ok({ assignment: presentAssignment(assignment, { inactive: inactiveOf(employees) }), decision, outcome, messages: messages.map(presentMessage), replayed: !changed }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleEvents(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  const idq = (k) => (/^[0-9]{1,18}$/.test(q.get(k) || '') ? Number(q.get(k)) : undefined)
  const after = idq('after')
  const before = idq('before')
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500)
  const mission_id = WFM_ID.test(q.get('mission') || '') ? q.get('mission') : undefined
  try {
    let events
    if (before != null && after == null) {
      // §11 pages forward from a cursor: an older page is the tail of a bounded window before `before`
      const win = await p.svc.store.listEvents({ org_id: p.org_id, after_event_id: Math.max(0, before - 1 - 5 * limit), mission_id, limit: 500 })
      events = win.filter((e) => e.event_id < before).slice(-limit)
    } else {
      events = await p.svc.store.listEvents({ org_id: p.org_id, after_event_id: after, mission_id, limit })
      if (before != null) events = events.filter((e) => e.event_id < before)
    }
    const next_after = events.length ? Math.max(...events.map((e) => e.event_id)) : after ?? null
    return ok({ events, next_after, next_cursor: next_after }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

// ── authority ────────────────────────────────────────────────────────────────
function staticRestrictions() {
  return NEVER_REVIVE.map((x) => ({
    kind: 'exclusion',
    label: x.code === 'CLOSED_LOST_NEVER_REVIVE' ? 'Closed lost: never revive' : 'Owner handled: permanent exclusion',
    reason: x.code,
    refs: [{ type: 'property', id: x.property_id, label: `Property ${x.property_id}`, property_id: x.property_id }, { type: 'opportunity', id: x.opportunity_id, label: 'Opportunity', property_id: x.property_id }, { type: 'thread', id: x.thread_id, label: 'Conversation', property_id: x.property_id }],
    since: null,
  }))
}
async function holdRestrictions(p) {
  if (typeof p.svc.listActiveHolds !== 'function') return { items: [], available: false }
  try {
    const r = await p.svc.listActiveHolds()
    if (!r?.ok) return { items: [], available: false }
    const items = (r.holds || []).slice(0, 100).map((h) => ({
      kind: 'hold',
      label: `${String(h.hold_type || 'hold').replace(/_/g, ' ')}${h.hold_key ? ` · ${String(h.hold_key).replace(/[^a-z0-9_:.-]/gi, '').slice(0, 60)}` : ''}`,
      reason: safeText(h.reason, 160),
      refs: [h.property_id ? { type: 'property', id: String(h.property_id), label: `Property ${h.property_id}`, property_id: String(h.property_id) } : null, h.opportunity_id ? { type: 'opportunity', id: String(h.opportunity_id), label: 'Opportunity' } : null, h.inbox_thread_id ? { type: 'thread', id: String(h.inbox_thread_id), label: 'Conversation' } : null].filter(Boolean),
      since: h.created_at ?? null,
    }))
    return { items, available: true }
  } catch { return { items: [], available: false } }
}

export async function handleAuthorityGet(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const s = p.svc.store
  try {
    const [policies, settings, employees, status, holds] = await Promise.all([s.listPolicies({ org_id: p.org_id }), s.getSettings({ org_id: p.org_id }), s.listEmployees({ org_id: p.org_id }), runtimeStatus(p), holdRestrictions(p)])
    const proposed = policies.filter((x) => x.status === 'active').flatMap((x) => proposeGrants(x, { employees })).map(presentGrant)
    const lim = status?.limits || null
    return ok({
      policies,
      // no settings row yet ⇒ the DB default threshold (§2: 5,000,000)
      settings: settings || { exec_review_price_usd: 5_000_000, escalation: {}, default: true },
      proposed_grants: proposed,
      restrictions: [...staticRestrictions(), ...holds.items],
      restrictions_complete: holds.available, // suppression lists are never enumerated here (contact values)
      emergency: lim ? { stop: lim.emergency_stop === true, reason: lim.emergency_stop_reason ?? null, since: lim.emergency_stop_at ?? null } : { stop: null, reason: 'runtime status unavailable', since: null },
      flags: { workforce_enabled: true, model_interpret: modelInterpretEnabled(p.env) },
      charters: presentCharters(),
    }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleAuthorityPost(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  if (!isOwner(p)) return fail('CEO_ONLY', 'Only the CEO can change authority.', 403, opts.headers)
  const b = await body(request)
  const s = p.svc.store
  const actor_user_id = p.identity.user_id
  const op = b.op || ({ put_policy: 'put', revoke_policy: 'revoke', put_settings: 'settings' })[b.action] || null
  try {
    if (op === 'put') {
      const x = b.policy && typeof b.policy === 'object' ? b.policy : {}
      if (!x.action_key || (!x.role_key && !x.employee_id)) return fail('POLICY_INVALID', 'A policy needs an action and a role or an employee.', 422, opts.headers)
      if (x.role_key && !ROLES.includes(x.role_key)) return fail('ROLE_INVALID', 'Unknown role.', 422, opts.headers)
      if (x.employee_id && !EMP_ID.test(String(x.employee_id))) return fail('EMPLOYEE_ID_INVALID', 'Unknown employee.', 422, opts.headers)
      // only the store's policy fields; a new version of an existing policy names it as policy_id (the store revokes
      // the old row and links the new one); review defaults to the store's (ceo) unless the CEO says otherwise
      const policy = {
        ...(x.role_key ? { role_key: x.role_key } : { employee_id: String(x.employee_id) }),
        action_key: String(x.action_key).slice(0, 80),
        scope: x.scope && typeof x.scope === 'object' && !Array.isArray(x.scope) ? x.scope : {},
        limits: x.limits && typeof x.limits === 'object' && !Array.isArray(x.limits) ? x.limits : {},
        risk: ['low', 'medium', 'high'].includes(x.risk) ? x.risk : 'low',
        ...(x.min_confidence != null ? { min_confidence: Number(x.min_confidence) } : {}),
        ...(['ceo', 'coo', 'none'].includes(x.review) ? { review: x.review } : {}),
        ...(x.valid_from ? { valid_from: String(x.valid_from) } : {}),
        ...(x.valid_until ? { valid_until: String(x.valid_until) } : {}),
        ...(x.supersedes || x.policy_id ? { policy_id: String(x.supersedes || x.policy_id) } : {}),
      }
      return ok({ policy: await s.putPolicy({ org_id: p.org_id, policy, actor_user_id }) }, opts.headers)
    }
    if (op === 'revoke') {
      if (!b.policy_id) return fail('POLICY_ID_REQUIRED', 'Which policy?', 422, opts.headers)
      return ok({ policy: await s.revokePolicy({ org_id: p.org_id, policy_id: String(b.policy_id), actor_user_id }) }, opts.headers)
    }
    if (op === 'settings') {
      const patch = {}
      const price = Number(b.patch?.exec_review_price_usd)
      if (b.patch?.exec_review_price_usd !== undefined) {
        if (!Number.isFinite(price) || price <= 0) return fail('SETTINGS_INVALID', 'exec_review_price_usd must be a positive number.', 422, opts.headers)
        patch.exec_review_price_usd = price
      }
      if (b.patch?.escalation && typeof b.patch.escalation === 'object') patch.escalation = b.patch.escalation
      if (!Object.keys(patch).length) return fail('SETTINGS_INVALID', 'Nothing to change.', 422, opts.headers)
      return ok({ settings: await s.putSettings({ org_id: p.org_id, patch, actor_user_id }) }, opts.headers)
    }
    return fail('ACTION_INVALID', 'Unknown authority operation.', 422, opts.headers, { allowed: ['put', 'revoke', 'settings'] })
  } catch (e) { return storeFail(e, opts.headers) }
}

// ── KPIs and reports ─────────────────────────────────────────────────────────
export async function handleKpis(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const q = qp(request)
  try {
    const kpis = await p.svc.store.listKpis({ org_id: p.org_id, subject_type: ['employee', 'department', 'org'].includes(q.get('subject_type')) ? q.get('subject_type') : undefined, subject_key: q.get('subject_key') || undefined })
    // unknown is a first-class value: a KPI never computed is { value: null, status: 'unknown' }, never 0
    return ok({ kpis: kpis.map((k) => (k.status === 'known' ? k : { ...k, value: null, status: 'unknown', source: { ...(k.source || {}), reason: k.source?.reason ?? 'unknown' } })) }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

export async function handleReports(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  try {
    const missions = (await p.svc.store.listMissions({ org_id: p.org_id, limit: 100 })).filter((m) => m.report)
    let daily_brief = { available: false, generated_at: null, summary: null, items: [], code: 'BRIEF_SOURCE_UNAVAILABLE' }
    if (typeof p.svc.latestBrief === 'function') {
      try {
        const f = await p.svc.latestBrief()
        const br = f?.value?.brief
        daily_brief = !f ? { available: false, generated_at: null, summary: null, items: [], code: 'BRIEF_NOT_GENERATED' }
          : !br ? { available: false, generated_at: f.retrieved_at ?? null, summary: null, items: [], code: 'BRIEF_PREDATES_OPERATIONS' }
            : { available: true, generated_at: f.retrieved_at ?? null, summary: typeof br.headline === 'string' ? br.headline : typeof br.summary === 'string' ? br.summary : null, items: Array.isArray(br.items) ? br.items.filter((x) => typeof x === 'string').slice(0, 20) : [], code: null, job_id: f.job_id ?? null, brief: br }
      } catch { daily_brief = { available: false, generated_at: null, summary: null, items: [], code: 'BRIEF_READ_FAILED' } }
    }
    return ok({ reports: missions.map((m) => ({ mission_id: m.mission_id, title: m.title, status: m.status, completed_at: m.completed_at ?? null, report: presentReport(m.report, { mission: m }) })), daily_brief }, opts.headers)
  } catch (e) { return storeFail(e, opts.headers) }
}

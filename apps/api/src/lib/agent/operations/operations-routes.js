// Operations API (8.5.20 part C) — READ the Inbound Action Center, the work items, the
// latest supervisor run and the daily operating brief; one mutation: a named operator
// acknowledges / resolves / dismisses / reopens a work item.
//
//   GET  /api/cockpit/agent/operations/action-center   ?state=&lost=1&limit=&before=
//   GET  /api/cockpit/agent/operations/work-items      ?state=open|acknowledged|resolved|dismissed&scope=&limit=
//   POST /api/cockpit/agent/operations/work-items/:id/decide   { action: acknowledge|resolve|dismiss|reopen }
//   GET  /api/cockpit/agent/operations/supervisor
//   GET  /api/cockpit/agent/operations/brief
//
// Order on every request (same as the Missions API, Gate B):
//   (1) gate → 404 with an EMPTY body unless AGENT_ENABLED and AGENT_OPERATIONS_ENABLED
//   (2) ops-dashboard auth (ensureMutationAuth)   (3) NAMED-USER authentication + allowlist
//   (4) per-user rate limit → 429                 (5) agent.operator_membership → 403
// Ids only: conversations are inbox_thread_state ids; nothing returns a phone, a name or a message body.
// A read model that is not applied answers 200 { available: false, code } — never an empty "all clear".
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../security/rate-limit.js'
import { isAgentEnabled } from '../config/agent-config.js'
import { DEFAULT_ORG_ID } from '../runtime/pg-store.js' // Package A: the same constant, without the capability plane import
import { operationsEnabled } from './operations-kinds.js'
import { ACTION_STATES, ACTION_STATE_LABELS, ACTIVE_QUEUE_STATES } from './action-center.js'

const DEFAULTS = Symbol.for('lc.agent.operations.routes')
function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORK_STATES = ['open', 'acknowledged', 'resolved', 'dismissed']
const SCOPES = ['recovery', 'action_center', 'pipeline', 'supervisor', 'conversation']
const DECISIONS = ['acknowledge', 'resolve', 'dismiss', 'reopen']

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}
export const isOperationsRouteEnabled = (env = process.env) => isAgentEnabled(env) && operationsEnabled(env)

/**
 * @param {Request} request
 * @param {{ env?: object, auth: Function, headers?: object, identity?: object, limiter?: object, getServices: () => (object|null|Promise<object|null>), bucket?: string }} o
 *   getServices → { store, membership(org_id, user_id) → { role } | null }
 */
async function prologue(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, getServices, bucket = 'read' } = {}) {
  if (!isOperationsRouteEnabled(env) || typeof auth !== 'function') return { response: new Response(null, { status: 404 }) }
  const a = auth(request)
  if (!a?.ok) return { response: a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers) }
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) return { response: json({ ok: false, error: who?.code || 'SESSION_REQUIRED' }, who?.status || 401, headers) }
  const rl = (limiter || d.limiter).check(who.identity.user_id, bucket)
  if (!rl.ok) return { response: json({ ok: false, error: rl.code }, 429, { ...headers, 'retry-after': String(rl.retry_after_s) }) }
  let svc
  try { svc = await getServices({ env }) } catch (e) { return { response: json({ ok: false, error: e?.code || 'OPERATIONS_DB_UNAVAILABLE' }, 503, headers) } }
  if (!svc?.store) return { response: json({ ok: false, error: 'OPERATIONS_UNCONFIGURED' }, 503, headers) }
  try {
    const m = await svc.membership(DEFAULT_ORG_ID, who.identity.user_id)
    if (!m) return { response: json({ ok: false, error: 'NOT_A_MEMBER' }, 403, headers) }
  } catch (e) {
    return { response: json({ ok: false, error: e?.code || 'OPERATIONS_DB_UNAVAILABLE' }, 503, headers) }
  }
  return { svc, identity: who.identity }
}
const notApplied = (e) => ['OPERATIONS_NOT_APPLIED'].includes(e?.code)
const readFail = (e, headers) => (notApplied(e) ? json({ ok: true, available: false, code: 'OPERATIONS_NOT_APPLIED' }, 200, headers) : json({ ok: false, error: e?.code || 'OPERATIONS_DB_UNAVAILABLE' }, 503, headers))

export async function handleActionCenter(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const u = new URL(request.url)
  const state = ACTION_STATES.includes(u.searchParams.get('state')) ? u.searchParams.get('state') : null
  const lost = u.searchParams.get('lost') === '1' ? true : null
  const before = UUID.test(u.searchParams.get('before') || '') ? u.searchParams.get('before') : null
  const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 50, 1), 200)
  try {
    const [summary, items] = await Promise.all([p.svc.store.actionCenterSummary(), p.svc.store.listActionStates({ state, lost, limit, before })])
    if (!summary.total) return json({ ok: true, available: false, code: 'ACTION_CENTER_NOT_RUN', states: ACTION_STATES.map((s) => ({ id: s, label: ACTION_STATE_LABELS[s] })) }, 200, opts.headers)
    return json({ ok: true, available: true, source: 'agent.conversation_action_state', states: ACTION_STATES.map((s) => ({ id: s, label: ACTION_STATE_LABELS[s], active: ACTIVE_QUEUE_STATES.includes(s) })), summary, items, next_cursor: items.length === limit ? items[items.length - 1].conversation_id : null }, 200, opts.headers)
  } catch (e) {
    return readFail(e, opts.headers)
  }
}

export async function handleWorkItems(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const u = new URL(request.url)
  const states = u.searchParams.getAll('state').filter((s) => WORK_STATES.includes(s))
  const scope = SCOPES.includes(u.searchParams.get('scope')) ? u.searchParams.get('scope') : null
  try {
    const items = await p.svc.store.listWorkItems({ states: states.length ? states : ['open', 'acknowledged'], scope, limit: Number(u.searchParams.get('limit')) || 50 })
    return json({ ok: true, available: true, source: 'agent.ops_work_item', items }, 200, opts.headers)
  } catch (e) {
    return readFail(e, opts.headers)
  }
}

export async function handleWorkItemDecide(request, work_item_id, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  let b = {}
  try { b = await request.json() } catch { b = {} }
  if (!UUID.test(String(work_item_id || ''))) return json({ ok: false, error: 'WORK_ITEM_ID_INVALID' }, 422, opts.headers)
  if (!DECISIONS.includes(String(b?.action || ''))) return json({ ok: false, error: 'ACTION_INVALID', detail: { allowed: DECISIONS } }, 422, opts.headers)
  try {
    const r = await p.svc.store.decideWorkItem({ work_item_id, by: p.identity.user_id, action: b.action })
    if (!r?.ok) return json({ ok: false, error: String(r?.reason || 'REFUSED').toUpperCase(), ...(r?.state ? { detail: { state: r.state } } : {}) }, r?.reason === 'not_found' ? 404 : 409, opts.headers)
    return json({ ok: true, ...r }, 200, opts.headers)
  } catch (e) {
    return readFail(e, opts.headers)
  }
}

export async function handleSupervisor(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  try {
    const f = await p.svc.store.latestFinding({ finding_type: 'supervisor.summary' })
    if (!f) return json({ ok: true, available: false, code: 'SUPERVISOR_NOT_RUN' }, 200, opts.headers)
    const items = await p.svc.store.listWorkItems({ scope: 'supervisor', limit: 50 })
    return json({ ok: true, available: true, job_id: f.job_id, at: f.retrieved_at, summary: f.value, items }, 200, opts.headers)
  } catch (e) {
    return readFail(e, opts.headers)
  }
}

export async function handleBrief(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  try {
    const f = await p.svc.store.latestFinding({ finding_type: 'digest.morning' })
    if (!f) return json({ ok: true, available: false, code: 'BRIEF_NOT_GENERATED' }, 200, opts.headers)
    if (!f.value?.brief) return json({ ok: true, available: false, code: 'BRIEF_PREDATES_OPERATIONS', job_id: f.job_id, at: f.retrieved_at }, 200, opts.headers)
    return json({ ok: true, available: true, job_id: f.job_id, at: f.retrieved_at, window: f.value.window || null, brief: f.value.brief }, 200, opts.headers)
  } catch (e) {
    return readFail(e, opts.headers)
  }
}

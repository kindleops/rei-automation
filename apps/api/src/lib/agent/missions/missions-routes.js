// Missions API HTTP handlers (contract: docs/agent-missions-api.md).
//
//   GET  /api/cockpit/agent/missions                ?scope=mine|all&kind=&state=&limit=&before=
//   GET  /api/cockpit/agent/missions/:id            ?events_after=
//   POST /api/cockpit/agent/missions                { kind, question, context?, sub_questions?, budget_usd?, per_mission_budget_usd?, max_model_calls?, priority? }
//   POST /api/cockpit/agent/missions/:id/cancel
//
// Order on every request (same as the agent actions / live routes, Gate B):
//   (1) gate → 404 with an EMPTY body unless AGENT_ENABLED and AGENT_MISSIONS_ENABLED
//   (2) ops-dashboard auth (ensureMutationAuth — the Worker-attached shared secret)
//   (3) NAMED-USER authentication (security/agent-auth.js: Supabase JWT verified
//       server-side + the operator allowlist)
//   (4) per-user rate limit → 429
//   (5) agent.operator_membership (service) → 403; create additionally runs the
//       missions.create capability (plane gates, write ceiling, daily cap, audit)
// A mission is visible to the operator who requested it, and to an org owner.
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../security/rate-limit.js'
import { isAgentEnabled } from '../config/agent-config.js'
import { missionsEnabled, OPERATOR_MISSION_KINDS, MISSION_HANDLER_KINDS, OPS_HEALTH_KIND } from './mission-kinds.js'
import { LISTABLE_STATES } from './missions-service.js'

const DEFAULTS = Symbol.for('lc.agent.missions.routes')
function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}

const STATUS = {
  NOT_A_MEMBER: 403, ROLE_NOT_ALLOWED: 403, IDENTITY_REQUIRED: 401, MISSION_NOT_FOUND: 404, JOB_NOT_FOUND: 404, CURSOR_INVALID: 422,
  INPUT_INVALID: 422, QUESTION_REQUIRED: 422, INPUT_NOT_FOR_KIND: 422, KIND_NOT_CREATABLE: 422, RATE_LIMITED: 429, DAILY_CAP: 429,
  AGENT_READ_ONLY: 423, AGENT_MODE_CEILING: 423, CAPABILITY_WRITES_DISABLED: 423, AGENT_DISABLED: 404, CAPABILITIES_UNCONFIGURED: 503,
  AGENT_RUNTIME_DB_UNAVAILABLE: 503, AGENT_RUNTIME_DB_TIMEOUT: 503, BY_NOT_NAMED_OPERATOR: 403,
}
const statusFor = (code, fallback = 422) => STATUS[code] || fallback

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}
async function body(request) {
  try { return await request.json() } catch { return {} }
}

export function isMissionsRouteEnabled(env = process.env) {
  return isAgentEnabled(env) && missionsEnabled(env)
}

async function prologue(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, service = null, getService = null, bucket = 'read' } = {}) {
  if (!isMissionsRouteEnabled(env)) return { response: new Response(null, { status: 404 }) }
  if (typeof auth !== 'function') return { response: new Response(null, { status: 404 }) }
  const a = auth(request)
  if (!a?.ok) return { response: a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers) }
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) {
    const status = who?.status || 401
    return { response: json({ ok: false, error: who?.code || 'SESSION_REQUIRED', message: status === 403 ? 'This account is not authorized to use the agent.' : 'Sign in again: a verified operator session is required.' }, status, headers) }
  }
  const rl = (limiter || d.limiter).check(who.identity.user_id, bucket)
  if (!rl.ok) return { response: json({ ok: false, error: rl.code }, 429, { ...headers, 'retry-after': String(rl.retry_after_s) }) }
  let svc = service
  if (!svc && typeof getService === 'function') {
    try { svc = await getService({ env }) } catch (err) { return { response: json({ ok: false, error: err?.code || 'AGENT_RUNTIME_DB_UNAVAILABLE' }, 503, headers) } }
  }
  if (!svc) return { response: json({ ok: false, error: 'MISSIONS_UNCONFIGURED' }, 503, headers) }
  return { svc, identity: who.identity }
}

const fail = (out, headers, fallback) => json({ ok: false, error: out.code, ...(out.detail ? { detail: out.detail } : {}) }, statusFor(out.code, fallback), headers)

export async function handleMissionsList(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const u = new URL(request.url)
  const scope = u.searchParams.get('scope') === 'all' ? 'all' : 'mine'
  const kinds = u.searchParams.getAll('kind').filter((k) => [...MISSION_HANDLER_KINDS, OPS_HEALTH_KIND].includes(k))
  const states = u.searchParams.getAll('state').filter((s) => LISTABLE_STATES.includes(s))
  try {
    const out = await p.svc.list({ identity: p.identity, scope, kinds: kinds.length ? kinds : null, states: states.length ? states : null, limit: Number(u.searchParams.get('limit')) || 50, before: u.searchParams.get('before') || null })
    return out.ok ? json(out, 200, opts.headers) : fail(out, opts.headers)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_RUNTIME_DB_UNAVAILABLE' }, 503, opts.headers)
  }
}

export async function handleMissionGet(request, mission_id, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const u = new URL(request.url)
  try {
    const out = await p.svc.get({ identity: p.identity, mission_id: String(mission_id || ''), events_after: Math.max(0, Number(u.searchParams.get('events_after')) || 0) })
    return out.ok ? json(out, 200, opts.headers) : fail(out, opts.headers, 404)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_RUNTIME_DB_UNAVAILABLE' }, 503, opts.headers)
  }
}

export async function handleMissionCreate(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const b = await body(request)
  if (!OPERATOR_MISSION_KINDS.includes(String(b?.kind || ''))) return json({ ok: false, error: 'KIND_NOT_CREATABLE', detail: { allowed: OPERATOR_MISSION_KINDS } }, 422, opts.headers)
  try {
    const out = await p.svc.create({ identity: p.identity, body: b })
    if (!out.ok) return fail(out, opts.headers, out.status === 'failed' ? 502 : 422)
    return json(out, out.deduped ? 200 : 201, opts.headers)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_RUNTIME_DB_UNAVAILABLE' }, 503, opts.headers)
  }
}

export async function handleMissionCancel(request, mission_id, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  try {
    const out = await p.svc.cancel({ identity: p.identity, mission_id: String(mission_id || '') })
    return out.ok ? json(out, out.pending ? 202 : 200, opts.headers) : fail(out, opts.headers, 409)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_RUNTIME_DB_UNAVAILABLE' }, 503, opts.headers)
  }
}

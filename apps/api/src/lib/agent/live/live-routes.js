// Live Quick Scan cockpit route handlers (S3, LOCAL DEV ONLY).
//
//   GET  /api/cockpit/agent/live[/status]                  capability probe: gate, mode, tools, sources, route map
//   POST /api/cockpit/agent/live/quick-scan/preflight      { property_ids[] } → scope + scope_hash
//   POST /api/cockpit/agent/live/quick-scan/confirm        { job_id, scope_hash } → run starts
//   GET  /api/cockpit/agent/live/runs                      history (live runs only)
//   GET  /api/cockpit/agent/live/runs/:run_id              snapshot (reduced from events) + last_event_id
//   GET  /api/cockpit/agent/live/runs/:run_id/events       ?after=<event_id> | Last-Event-ID, ?timeout_ms (long-poll ≤ 25 s), ?format=sse
//   POST /api/cockpit/agent/live/runs/:run_id/cancel
//
// Order on every request (Gate B):
//   (1) gate → 404 with an empty body when the AGENT_ENABLED kill switch is off,
//       or AGENT_LIVE_ROUTES≠1, or production without the pilot flags (nothing else runs)
//   (2) ops-dashboard auth (ensureMutationAuth: the Worker-attached shared secret)
//   (3) NAMED-USER authentication (security/agent-auth.js): the Supabase JWT is
//       verified server-side, the user must be on the operator allowlist, and a
//       present x-ops-user-id must equal the verified user. No session → 401,
//       not allowlisted / header mismatch → 403. The worker-asserted header alone
//       is never an identity; there is no shared or service fallback.
//   (4) per-user rate limit (security/rate-limit.js) → 429
// The verified user id is the run operator and is stamped on every run, event
// and finding. Every body is labelled live:true, fixture:false.
import { getLiveAgent, isLiveAgentEnabled } from './live-agent.js'
import { toSse } from '../runtime/event-log.js'
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits, runsStartedToday } from '../security/rate-limit.js'
import { checkSpend, resolveSpendCaps, spendUsage } from '../budget/spend-guard.js'
import { isAgentReadOnly } from '../config/agent-config.js'
import { listQuickScanSources } from '../quick-scan/sources.js'

const DEFAULTS = Symbol.for('lc.agent.live.gate_b')

/** Process-wide identity provider + limiter for the real routes (tests inject their own). */
function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}

/** Route map advertised by the capability probe (GET /api/cockpit/agent/live). */
export const LIVE_ROUTE_MAP = Object.freeze({
  status: '/api/cockpit/agent/live/status',
  preflight: 'POST /api/cockpit/agent/live/quick-scan/preflight',
  confirm: 'POST /api/cockpit/agent/live/quick-scan/confirm',
  runs: '/api/cockpit/agent/live/runs',
  run: '/api/cockpit/agent/live/runs/:run_id',
  events: '/api/cockpit/agent/live/runs/:run_id/events?after=<event_id>&timeout_ms=<≤25000>',
  cancel: 'POST /api/cockpit/agent/live/runs/:run_id/cancel',
})

const STATUS_FOR = {
  SESSION_REQUIRED: 401,
  IDENTITY_REQUIRED: 401,
  OPERATOR_MISMATCH: 403,
  OPERATOR_NOT_NAMED: 403,
  OPERATOR_IDENTITY_MISMATCH: 403,
  AGENT_DISABLED: 503,
  SPEND_ACTOR_REQUIRED: 423,
  SPEND_CAP_USER_DAY: 423,
  SPEND_CAP_GLOBAL_DAY: 423,
  TOKEN_CAP_USER_DAY: 423,
  TOKEN_CAP_GLOBAL_DAY: 423,
  JOB_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  JOB_SCOPE_CHANGED: 409,
  ILLEGAL_JOB_TRANSITION: 409,
  JOB_DRAFT_EXPIRED: 410,
  AGENT_MODE_CEILING: 423,
  TEST_BATCH_LIMIT: 422,
  RESEARCH_EMPTY_SCOPE: 422,
  PROPERTY_ID_INVALID: 422,
  NOT_A_QUICK_SCAN: 422,
  READ_CLIENT_UNCONFIGURED: 503,
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify({ live: true, fixture: false, ...payload }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-agent-live': 'true', ...headers } })
}

function errorResponse(error, headers) {
  const code = error?.code || 'AGENT_LIVE_ERROR'
  const status = STATUS_FOR[code] || (/_INVALID$|_REQUIRED$/.test(code) ? 422 : 500)
  return json({ ok: false, error: code, message: status >= 500 ? 'internal error' : String(error?.message || code).slice(0, 300) }, status, headers)
}

async function body(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

/**
 * Shared prologue: gate → ops auth → named user → rate limit. Returns { response } to short-circuit, or { agent, operator_id, identity }.
 * @param {Request} request
 * @param {{ env?: object, auth?: (req: Request) => { ok: boolean, response?: Response }, headers?: object,
 *   identity?: { authenticate: (req: Request) => Promise<object> }, limiter?: { check: Function }, bucket?: 'read'|'mutation' }} opts
 */
async function prologue(request, { env = process.env, auth, headers = {}, agent: injected = null, identity = null, limiter = null, bucket = 'read' }) {
  if (!isLiveAgentEnabled(env)) return { response: new Response(null, { status: 404 }) }
  if (typeof auth !== 'function') return { response: new Response(null, { status: 404 }) }
  const a = auth(request)
  if (!a?.ok) return { response: a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers) }
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) {
    const status = who?.status || 401
    return { response: json({ ok: false, error: who?.code || 'SESSION_REQUIRED', message: status === 403 ? 'This account is not authorized to use the agent.' : status === 503 ? 'Identity verification is not available.' : 'Sign in again: a verified operator session is required.' }, status, headers) }
  }
  const user_id = who.identity.user_id
  const rl = (limiter || d.limiter).check(user_id, bucket)
  if (!rl.ok) return { response: json({ ok: false, error: rl.code, message: `Too many agent requests; retry in ${rl.retry_after_s}s.` }, 429, { ...headers, 'retry-after': String(rl.retry_after_s) }) }
  const agent = injected || getLiveAgent({ env }) // `agent` injection is for tests only
  if (!agent) return { response: new Response(null, { status: 404 }) }
  if (agent.recovered) await agent.recovered
  if (agent.unavailable) return { response: json({ ok: false, error: 'AGENT_STORE_UNAVAILABLE' }, 503, headers) }
  // durable store: see other instances' commits before serving any read
  if (typeof agent.store.refresh === 'function') await agent.store.refresh()
  return { agent, operator_id: user_id, identity: who.identity, limits: (limiter || d.limiter).limits }
}

/** A run is visible only to the operator who started it (same store/org binding). 404, never 403. */
function ownsRun(agent, run_id, operator_id) {
  const run = agent.runService.getRun(run_id)
  return Boolean(run && operator_id && run.operator_id === operator_id)
}

function needOperator(operator_id, headers) {
  return operator_id ? null : json({ ok: false, error: 'SESSION_REQUIRED', message: 'a verified operator session is required' }, 401, headers)
}

export async function handleLiveStatus(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  return json({ ok: true, enabled: true, quick_scan: true, routes: LIVE_ROUTE_MAP, mode: p.agent.quickScan.mode(), ai_enabled: false, read_only: isAgentReadOnly(opts.env || process.env) || p.agent.registry.readOnly === true, identity: { method: p.identity.method, verified: true }, store: { kind: p.agent.store.kind, namespace: p.agent.store.namespace }, tools: p.agent.quickScan.describeTools(), sources: listQuickScanSources() }, 200, opts.headers)
}

export async function handleQuickScanPreflight(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const denied = needOperator(p.operator_id, opts.headers)
  if (denied) return denied
  // durable per-user daily run cap (counted from the shared store, every instance agrees)
  if (runsStartedToday(p.agent.store.read(), p.operator_id) >= p.limits.daily_runs) {
    return json({ ok: false, error: 'DAILY_RUN_CAP', message: `Daily agent run limit (${p.limits.daily_runs}) reached for this operator.` }, 429, opts.headers)
  }
  try {
    const b = await body(request)
    const out = await p.agent.quickScan.preflight({ operator_id: p.operator_id, property_ids: b.property_ids, identity: p.identity })
    const caps = resolveSpendCaps(opts.env || process.env)
    return json({ ...out, spend_guard: { this_job_usd: out.max_budget_usd, structural_zero: out.max_budget_usd === 0, user_day_usd: caps.user_day_usd, global_day_usd: caps.global_day_usd } }, 200, opts.headers)
  } catch (error) {
    return errorResponse(error, opts.headers)
  }
}

export async function handleQuickScanConfirm(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const denied = needOperator(p.operator_id, opts.headers)
  if (denied) return denied
  try {
    const b = await body(request)
    if (!b.job_id || !b.scope_hash) return json({ ok: false, error: 'SCOPE_HASH_REQUIRED', message: 'job_id and scope_hash from the preflight are required' }, 422, opts.headers)
    // spend guard: the job's cap must fit the user's and the org's daily caps ($0 Quick Scan always fits)
    const job = p.agent.store.read().researchJobs.get(String(b.job_id))
    if (job) {
      const spend = checkSpend({ caps: resolveSpendCaps(opts.env || process.env), actor: p.identity, worst_usd: Number(job.budget_cap_usd || 0), usage: spendUsage(p.agent.store.read().ledger || [], { user_id: p.operator_id, day: new Date().toISOString().slice(0, 10) }) })
      if (!spend.ok) return json({ ok: false, error: spend.code, message: `Refused by the spend guard (${spend.binding_cap}).` }, 423, opts.headers)
    }
    const { done, ...out } = await p.agent.quickScan.confirm({ job_id: String(b.job_id), scope_hash: String(b.scope_hash), operator_id: p.operator_id })
    void done // runs in the background; progress is the event stream
    return json(out, 202, opts.headers)
  } catch (error) {
    return errorResponse(error, opts.headers)
  }
}

export async function handleLiveRuns(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const url = new URL(request.url)
  const denied = needOperator(p.operator_id, opts.headers)
  if (denied) return denied
  return json({ ok: true, runs: p.agent.quickScan.history({ limit: Number(url.searchParams.get('limit') || 50), operator_id: p.operator_id }) }, 200, opts.headers)
}

export async function handleLiveRunSnapshot(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  if (!ownsRun(p.agent, String(params.run_id || ''), p.operator_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  if (typeof p.agent.store.hydrateRun === 'function') await p.agent.store.hydrateRun(String(params.run_id || ''))
  const snap = p.agent.quickScan.snapshot(String(params.run_id || ''))
  if (!snap) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  return json({ ok: true, ...snap }, 200, opts.headers)
}

export async function handleLiveRunEvents(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const run_id = String(params.run_id || '')
  if (!ownsRun(p.agent, run_id, p.operator_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  if (typeof p.agent.store.hydrateRun === 'function') await p.agent.store.hydrateRun(run_id)
  const run = p.agent.runService.getRun(run_id)
  if (!run) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  const expired = p.agent.quickScan.evidenceExpiry(run)
  if (expired) return json({ ok: true, run_id, events: [], cursor: 0, done: true, evidence_complete: false, evidence_expired: expired }, 200, opts.headers)
  const url = new URL(request.url)
  const after = Number(url.searchParams.get('after') ?? request.headers?.get?.('last-event-id') ?? 0) || 0
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 500) || 500, 2000))
  const timeout_ms = Math.max(0, Math.min(Number(url.searchParams.get('timeout_ms') || 0) || 0, 25_000))
  let page = await p.agent.eventLog.poll({ run_id, after, limit, timeout_ms })
  // another instance may have written while we waited (local wakeups only see local commits)
  if (!page.events.length && typeof p.agent.store.refresh === 'function') {
    await p.agent.store.refresh()
    page = p.agent.eventLog.replay({ run_id, after, limit })
  }
  const latest = p.agent.runService.getRun(run_id)
  const tail = p.agent.eventLog.replay({ run_id, after: page.cursor, limit: 1 })
  const done = Boolean(latest.ended_at) && tail.events.length === 0 && !p.agent.quickScan.snapshot(run_id)?.dispatcher_active
  if (url.searchParams.get('format') === 'sse') {
    return new Response(toSse(page.events), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-agent-live': 'true', ...(opts.headers || {}) } })
  }
  return json({ ok: true, run_id, events: page.events, cursor: page.cursor, done }, 200, opts.headers)
}

export async function handleLiveRunCancel(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const denied = needOperator(p.operator_id, opts.headers)
  if (denied) return denied
  if (!ownsRun(p.agent, String(params.run_id || ''), p.operator_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  try {
    return json(await p.agent.quickScan.cancel({ run_id: String(params.run_id || ''), requested_by: p.operator_id }), 202, opts.headers)
  } catch (error) {
    return errorResponse(error, opts.headers)
  }
}

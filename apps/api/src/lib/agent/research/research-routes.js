// Read-only research agent routes.
//
//   GET  /api/cockpit/agent/live/ask              status: switches, resolved models (from GET /v1/models), caps, spend today / this cycle
//   POST /api/cockpit/agent/live/ask              { question, context?: { campaign_id?, property_ids?[] | property_ids?, property_id? }, wait_ms? ≤ 25000 } → 202 { run_id }
//                                                 (property_id is an alias of property_ids — ask-service.contextPropertyIds)
//   GET  /api/cockpit/agent/live/ask/:run_id      the run: state, answer, latency, cost per call, audit trail, and for a
//                                                 refused / failed run its persisted refusal detail (codes only)
//   GET  /api/cockpit/agent/live/ask/:run_id/events   text/event-stream of the run's REAL backend events (run-events.js):
//                                                 replay from ?after= / Last-Event-ID, then live; ends after the terminal
//                                                 event. A run this process does not hold ⇒ one `snapshot` (the durable
//                                                 status) and, when terminal, its terminal event — then the stream closes.
//   POST /api/cockpit/agent/live/ask/:run_id/cancel   stop a running run: no further model / tool call; an in-flight
//                                                 model call is aborted and its reserve stays counted (unknown)
//
// Order on every request (same as Gate B):
//   (1) gate → 404 with an EMPTY body unless the live route gate AND
//       AGENT_RESEARCH_ENABLED=1 (and AGENT_ENABLED) hold
//   (2) ensureMutationAuth (the Worker-attached shared secret)
//   (3) NAMED USER: Supabase JWT verified server-side, user on the allowlist
//       (OPS_ALLOWED_USER_IDS ∩ AGENT_ALLOWED_USER_IDS), header must match
//   (4) per-user rate limit; durable per-user daily run cap
// A run is visible only to the operator who started it (404 otherwise).
import { isLiveAgentEnabled } from '../live/live-agent.js'
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../security/rate-limit.js'
import { isResearchEnabled, researchModeOk, resolveResearchCaps, effectiveCaps, RESEARCH_LIMITS } from './research-config.js'

const DEFAULTS = Symbol.for('lc.agent.research.routes')

function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}

const STATUS_FOR = {
  AGENT_DISABLED: 503,
  RESEARCH_DISABLED: 503,
  MODE_NOT_READ: 423,
  IDENTITY_REQUIRED: 401,
  QUESTION_INVALID: 422,
  AGENT_STORE_UNAVAILABLE: 503,
  AGENT_STORE_ROLE_PRIVILEGED: 503,
  RESEARCH_STORE_REQUIRED: 503,
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify({ live: true, fixture: false, read_only: true, ...payload }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-agent-live': 'true', ...headers } })
}

export function isResearchRouteEnabled(env = process.env) {
  return isLiveAgentEnabled(env) && isResearchEnabled(env)
}

async function prologue(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, bucket = 'read', research = null, getResearch = null }) {
  if (!isResearchRouteEnabled(env)) return { response: new Response(null, { status: 404 }) }
  if (typeof auth !== 'function') return { response: new Response(null, { status: 404 }) }
  const a = auth(request)
  if (!a?.ok) return { response: a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers) }
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) {
    const status = who?.status || 401
    return { response: json({ ok: false, error: who?.code || 'SESSION_REQUIRED', message: status === 403 ? 'This account is not authorized to use the agent.' : status === 503 ? 'Identity verification is not available.' : 'Sign in again: a verified operator session is required.' }, status, headers) }
  }
  const lim = limiter || d.limiter
  const rl = lim.check(who.identity.user_id, bucket)
  if (!rl.ok) return { response: json({ ok: false, error: rl.code, message: `Too many agent requests; retry in ${rl.retry_after_s}s.` }, 429, { ...headers, 'retry-after': String(rl.retry_after_s) }) }
  let agent = research
  if (!agent && typeof getResearch === 'function') {
    try {
      agent = await getResearch({ env })
    } catch (err) {
      return { response: json({ ok: false, error: err?.code || 'AGENT_STORE_UNAVAILABLE', message: 'The research agent is not available.' }, 503, headers) }
    }
  }
  if (!agent) return { response: new Response(null, { status: 404 }) }
  return { agent, operator_id: who.identity.user_id, identity: who.identity, limits: lim.limits }
}

export async function handleResearchStatus(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const env = opts.env || process.env
  try {
    const [models, dbLimits, totals, today] = await Promise.all([p.agent.resolver.resolve(), p.agent.store.limits(), p.agent.store.totals({}), p.agent.store.runsToday(p.operator_id)])
    const caps = effectiveCaps(resolveResearchCaps(env), dbLimits)
    return json({
      ok: true,
      enabled: true,
      mode_ok: researchModeOk(env),
      identity: { method: p.identity.method, verified: true },
      models: {
        ok: models.ok === true,
        code: models.code || null,
        default: models.default ? { id: models.default.id, display_name: models.default.display_name, from: models.default.from, skipped: models.default.skipped } : null,
        escalation: models.escalation ? { id: models.escalation.id, display_name: models.escalation.display_name, from: models.escalation.from, skipped: models.escalation.skipped } : null,
        candidates: models.candidates,
        listed_ids: models.listed_ids,
        resolved_at: models.resolved_at,
      },
      caps,
      spend: { day_usd: totals.day_usd, cycle_usd: totals.cycle_usd, day_remaining_usd: Math.max(0, +(caps.day_usd - totals.day_usd).toFixed(6)), cycle_remaining_usd: Math.max(0, +(caps.cycle_usd - totals.cycle_usd).toFixed(6)) },
      runs_today: today,
      daily_run_cap: p.limits.daily_runs,
      limits: { question_max_chars: RESEARCH_LIMITS.question_max_chars, max_model_calls: RESEARCH_LIMITS.max_model_calls, max_tool_calls: RESEARCH_LIMITS.max_tool_calls },
      tools: p.agent.registry.list().map((t) => ({ name: t.name, label: t.label, tier: t.tier, side_effect: t.side_effect, rows_to_model: t.limits.rows_to_model })),
    }, 200, opts.headers)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_STORE_UNAVAILABLE' }, 503, opts.headers)
  }
}

async function body(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

export async function handleResearchAsk(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  try {
    if ((await p.agent.store.runsToday(p.operator_id)) >= p.limits.daily_runs) return json({ ok: false, error: 'DAILY_RUN_CAP', message: `Daily agent run limit (${p.limits.daily_runs}) reached for this operator.` }, 429, opts.headers)
    const b = await body(request)
    const { run_id, done } = await p.agent.ask.ask({ operator_id: p.operator_id, identity: p.identity, question: b.question, context: b.context || {} })
    const wait = Math.max(0, Math.min(Number(b.wait_ms) || 0, 25_000))
    if (wait > 0) {
      const finished = await Promise.race([done.then(() => true), new Promise((r) => { const t = setTimeout(() => r(false), wait); if (typeof t.unref === 'function') t.unref() })])
      if (finished) return json({ ok: true, ...(await p.agent.ask.status(run_id, p.operator_id)) }, 200, opts.headers)
    }
    return json({ ok: true, run_id, state: 'running', poll: `/api/cockpit/agent/live/ask/${run_id}` }, 202, opts.headers)
  } catch (err) {
    const code = err?.code || 'AGENT_LIVE_ERROR'
    const status = STATUS_FOR[code] || (err?.refusal ? 423 : 500)
    return json({ ok: false, error: code, message: status >= 500 ? 'internal error' : String(err?.message || code).slice(0, 200) }, status, opts.headers)
  }
}

export async function handleResearchRun(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const run_id = String(params.run_id || '')
  if (!/^ask_[A-Za-z0-9_-]{8,80}$/.test(run_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  try {
    const s = await p.agent.ask.status(run_id, p.operator_id)
    if (!s) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
    return json({ ok: true, ...s }, 200, opts.headers)
  } catch (err) {
    return json({ ok: false, error: err?.code || 'AGENT_STORE_UNAVAILABLE' }, 503, opts.headers)
  }
}

const RUN_ID_RE = /^ask_[A-Za-z0-9_-]{8,80}$/
const SSE_HEARTBEAT_MS = 15_000

function sseFrame(ev) {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/** Terminal event derived from a durable status (a run this process no longer holds). */
function terminalFromStatus(s) {
  if (!s || s.state === 'running') return null
  const type = s.state === 'completed' ? 'completed' : s.state === 'cancelled' ? 'cancelled' : 'failed'
  return { seq: 1_000_000, type, at: s.ended_at, state: s.state, outcome: s.outcome, cost_usd: s.cost_usd, latency_ms: s.latency_ms, model_calls: s.counters?.model_calls ?? null, tool_calls: s.counters?.tool_calls ?? null, answer_md: s.answer?.answer_md ?? null, result: s.result ?? null, refusal_class: s.refusal_class ?? null, refusal: s.refusal ?? null, from: 'durable_status' }
}

export async function handleResearchEvents(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const run_id = String(params.run_id || '')
  if (!RUN_ID_RE.test(run_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  const url = new URL(request.url)
  const after = Math.max(0, Number(url.searchParams.get('after') || request.headers.get('last-event-id') || 0) || 0)
  const enc = new TextEncoder()
  const headers = { ...(opts.headers || {}), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-agent-live': 'true' }
  let unsubscribe = null
  let heartbeat = null
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        try { unsubscribe?.() } catch { /* ignore */ }
        try { controller.close() } catch { /* already closed */ }
      }
      const send = (ev) => { if (!closed) { try { controller.enqueue(enc.encode(sseFrame(ev))) } catch { close() } } }
      request.signal?.addEventListener?.('abort', close, { once: true })
      controller.enqueue(enc.encode(': lc-ask events\n\n'))
      heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(enc.encode(': hb\n\n')) } catch { close() } } }, SSE_HEARTBEAT_MS)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      let live = null
      try {
        live = p.agent.ask.subscribe ? p.agent.ask.subscribe(run_id, p.operator_id, { after }, (ev) => { if (ev) send(ev); else close() }) : null
      } catch { live = null }
      if (live) { unsubscribe = live; return }
      // not held by this process: the durable status, then (if terminal) its terminal event
      try {
        const s = await p.agent.ask.status(run_id, p.operator_id)
        if (!s) { send({ seq: 0, type: 'error', code: 'RUN_NOT_FOUND' }); return close() }
        send({ seq: 0, type: 'snapshot', state: s.state, outcome: s.outcome, counters: s.counters, from: 'durable_status' })
        const t = terminalFromStatus(s)
        if (t) send(t)
      } catch {
        send({ seq: 0, type: 'error', code: 'AGENT_STORE_UNAVAILABLE' })
      }
      close()
    },
    cancel() {
      clearInterval(heartbeat)
      try { unsubscribe?.() } catch { /* ignore */ }
    },
  })
  return new Response(stream, { status: 200, headers })
}

export async function handleResearchCancel(request, { params = {}, ...opts } = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const run_id = String(params.run_id || '')
  if (!RUN_ID_RE.test(run_id)) return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
  const r = p.agent.ask.cancel ? p.agent.ask.cancel(run_id, p.operator_id) : { ok: false, code: 'RUN_NOT_FOUND' }
  if (r.ok) return json({ ok: true, run_id, state: r.state }, 202, opts.headers)
  if (r.code === 'RUN_NOT_ACTIVE') return json({ ok: false, error: 'RUN_NOT_ACTIVE', message: 'The run has already ended.' }, 409, opts.headers)
  return json({ ok: false, error: 'RUN_NOT_FOUND' }, 404, opts.headers)
}

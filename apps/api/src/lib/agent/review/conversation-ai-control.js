// Conversation Engine 2.0 — operator control plane for the SHADOW runtime (review panel).
//
//   GET  /api/cockpit/agent/conversation-ai/control   shadow on/off (every gate), runtime
//        limits + heartbeat, conversation.decide kind state, budget caps + spend, the last
//        50 conversation.decide jobs (state, attempts, timings, result codes).
//        Auth: ops-dashboard auth (same as the shadow-records route). Read-only: one
//        READ ONLY transaction on the agent_api pool (statement_timeout 3 s) + agent.runtime_status().
//
//   POST /api/cockpit/agent/conversation-ai/control   { action: 'emergency_stop'|'pause_kind', confirm: true, reason? }
//        Auth, in order: ops-dashboard auth (Worker shared secret) → NAMED operator (Supabase JWT
//        verified server-side + OPS_ALLOWED_USER_IDS allowlist, security/agent-auth.js) → per-user
//        mutation rate limit. Writes ONLY through agent.runtime_emergency_stop(by, reason) or
//        agent.runtime_pause_kind('conversation.decide', by) — the existing SECURITY DEFINER runtime
//        functions; `by` is the verified user id. Never a direct table write. Neither control can
//        turn anything ON (clearing an emergency stop / re-arming a kind stays the owner's SQL path).
//
// Nothing here can send: there is no send import, and the shadow runtime has no send path.
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../security/rate-limit.js'
import { isAgentEnabled } from '../config/agent-config.js'
import {
  REVIEW_KIND, SQL_BUDGET, SQL_RECENT_JOBS, buildControlState, jobInboundSids, normalizeJob, parseControlRequest, readShadowFlags, runControlAction,
} from '../../domain/conversation-ai/review-control.js'

const JOB_LIMIT = 50
const DEFAULTS = Symbol.for('lc.agent.convai.control.defaults')
function defaults(env) {
  const make = () => ({ identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) })
  if (env !== process.env) return make()
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = make()
  return globalThis[DEFAULTS]
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

async function defaultRuntime(env) {
  const svc = await import('../runtime/runtime-service.js')
  const live = await import('../live/live-agent.js')
  const store = await svc.getVerifiedRuntimeStore(env)
  return { store, pool: live.getAgentPgPool(env) }
}

/** One READ ONLY transaction, statement_timeout 3 s. */
async function readOnly(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    await client.query('set local statement_timeout = 3000')
    const out = await fn((sql, params) => client.query(sql, params).then((r) => r.rows))
    await client.query('commit')
    return out
  } catch (err) {
    try { await client.query('rollback') } catch { /* broken connection */ }
    throw err
  } finally {
    client.release()
  }
}

/**
 * @param {Request} request
 * @param {{ env?: object, auth: Function, headers?: object, runtime?: () => Promise<{store, pool}>, supabase?: object|null }} opts
 */
export async function handleConversationAiControlGet(request, { env = process.env, auth, headers = {}, runtime = null, supabase = null } = {}) {
  const a = typeof auth === 'function' ? auth(request) : null
  if (!a?.ok) return a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers)
  const flags = readShadowFlags(env, { agentEnabled: isAgentEnabled(env) })
  const errors = []
  let status = null, budget = null, rows = []
  let rt = null
  try {
    rt = await (runtime || (() => defaultRuntime(env)))()
  } catch (err) {
    errors.push(String(err?.code || err?.message || 'RUNTIME_UNAVAILABLE').slice(0, 80).replace(/[^A-Za-z0-9_.:-]/g, '_'))
  }
  if (rt) {
    try { status = await rt.store.status() } catch (err) { errors.push(err?.code || 'RUNTIME_STATUS_FAILED') }
    try {
      await readOnly(rt.pool, async (q) => {
        budget = (await q(SQL_BUDGET, [REVIEW_KIND]))[0] || null
        rows = await q(SQL_RECENT_JOBS, [REVIEW_KIND, JOB_LIMIT])
      })
    } catch (err) {
      errors.push(err?.code === '42P01' || err?.code === '42703' ? 'RUNTIME_SCHEMA_NOT_APPLIED' : 'RUNTIME_READ_FAILED')
    }
  }
  // job → inbound message id (bounded IN over ≤ 50 provider sids; the shadow record is keyed by message_events.id)
  const idBySid = new Map()
  const sids = jobInboundSids(rows)
  if (sids.length && supabase?.from) {
    try {
      const r = await supabase.from('message_events').select('id,provider_message_sid').in('provider_message_sid', sids).eq('direction', 'inbound').limit(sids.length + 10)
      for (const m of r?.data || []) idBySid.set(String(m.provider_message_sid), String(m.id))
    } catch {
      errors.push('INBOUND_LOOKUP_FAILED')
    }
  }
  const state = buildControlState({ flags, status, budget, jobs: rows.map((row) => normalizeJob(row, idBySid)), errors })
  return json({ ok: true, ...state }, 200, headers)
}

/**
 * @param {Request} request
 * @param {{ env?: object, auth: Function, headers?: object, identity?: object, limiter?: object, runtime?: () => Promise<{store}> }} opts
 */
export async function handleConversationAiControlPost(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, runtime = null } = {}) {
  const a = typeof auth === 'function' ? auth(request) : null
  if (!a?.ok) return a?.response || json({ ok: false, error: 'unauthorized' }, 401, headers)
  const d = identity && limiter ? null : defaults(env)
  const who = await (identity || d.identity).authenticate(request)
  if (!who?.ok) return json({ ok: false, error: who?.code || 'SESSION_REQUIRED' }, who?.status || 401, headers)
  const rl = (limiter || d.limiter).check(who.identity.user_id, 'mutation')
  if (!rl.ok) return json({ ok: false, error: rl.code }, 429, { ...headers, 'retry-after': String(rl.retry_after_s) })
  let body = {}
  try { body = await request.json() } catch { body = {} }
  const parsed = parseControlRequest(body)
  if (!parsed.ok) return json({ ok: false, error: parsed.code }, 422, headers)
  let rt
  try {
    rt = await (runtime || (() => defaultRuntime(env)))()
  } catch {
    return json({ ok: false, error: 'RUNTIME_UNAVAILABLE' }, 503, headers)
  }
  try {
    const out = await runControlAction({ store: rt.store, action: parsed.action, by: who.identity.user_id, reason: parsed.reason })
    return json(out, out.ok ? 200 : 409, headers)
  } catch (err) {
    return json({ ok: false, error: String(err?.code || 'RUNTIME_CONTROL_FAILED') }, 503, headers)
  }
}

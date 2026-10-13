// Agent actions + approvals HTTP handlers (Intelligence Command 2.0, increment B).
//
//   GET  /api/cockpit/agent/actions                         capability matrix + gate state
//   POST /api/cockpit/agent/actions/invoke                  { capability_id, input } (operator-initiated; same enforcement)
//   GET  /api/cockpit/agent/actions/approvals               ?state=pending|all&limit=
//   GET  /api/cockpit/agent/actions/approvals/:id           one approval (+ display preview)
//   POST /api/cockpit/agent/actions/approvals/:id/decide    { decision: approve|deny, payload_hash, note? }
//
// Order on every request (Gate B, same as the live agent routes):
//   (1) gate → 404 with an empty body unless AGENT_ENABLED and AGENT_CAPABILITIES_ENABLED
//   (2) ops-dashboard auth (ensureMutationAuth — the Worker-attached shared secret)
//   (3) NAMED-USER authentication (security/agent-auth.js): Supabase JWT verified
//       server-side + AGENT_ALLOWED_USER_IDS / OPS_ALLOWED_USER_IDS allowlist
//   (4) per-user rate limit → 429
//   (5) agent.operator_membership in the org (inside the plane) → 403
// An approval decision is a human action on this endpoint only; no capability,
// tool, model output or message content can reach it.
import { createAgentIdentityProvider } from '../security/agent-auth.js'
import { createUserRateLimiter, resolveRateLimits } from '../security/rate-limit.js'
import { capabilityGate, createSession } from '../capabilities/registry.js'
import { DEFAULT_ORG_ID, getCapabilityPlane } from '../capabilities/index.js'

const DEFAULTS = Symbol.for('lc.agent.actions.defaults')
function defaults(env) {
  if (env !== process.env) return { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  if (!globalThis[DEFAULTS]) globalThis[DEFAULTS] = { identity: createAgentIdentityProvider({ env }), limiter: createUserRateLimiter({ limits: resolveRateLimits(env) }) }
  return globalThis[DEFAULTS]
}

const STATUS = {
  IDENTITY_REQUIRED: 401, NOT_A_MEMBER: 403, ROLE_NOT_ALLOWED: 403, APPROVAL_NOT_FOUND: 404, CAPABILITY_NOT_REGISTERED: 404,
  HASH_MISMATCH: 409, STATE_DRIFTED: 409, APPROVAL_EXECUTING: 409, CAPABILITY_VERSION_CHANGED: 409, APPROVAL_EXPIRED: 410,
  INPUT_INVALID: 422, DECISION_INVALID: 422, RATE_LIMITED: 429, DAILY_CAP: 429,
  AGENT_READ_ONLY: 423, AGENT_MODE_CEILING: 423, CAPABILITY_WRITES_DISABLED: 423, AGENT_DISABLED: 404, STATE_UNREADABLE: 503,
}
const statusFor = (code, fallback = 422) => STATUS[code] || fallback

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}
async function body(request) {
  try { return await request.json() } catch { return {} }
}

async function prologue(request, { env = process.env, auth, headers = {}, identity = null, limiter = null, plane = null, bucket = 'read' } = {}) {
  if (!capabilityGate(env).enabled) return { response: new Response(null, { status: 404 }) }
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
  const p = plane || (await getCapabilityPlane(env))
  if (!p) return { response: json({ ok: false, error: 'CAPABILITIES_UNCONFIGURED' }, 503, headers) }
  return { plane: p, identity: who.identity, org_id: DEFAULT_ORG_ID }
}

export async function handleActionsCatalog(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  return json({ ok: true, capabilities: p.plane.matrix() }, 200, opts.headers)
}

export async function handleActionsInvoke(request, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const b = await body(request)
  const out = await p.plane.invoker.invoke({ capability_id: String(b?.capability_id || ''), input: b?.input ?? {}, ctx: { org_id: p.org_id, identity: p.identity, source: 'operator', session: createSession() } })
  return json(out, out.ok ? 200 : statusFor(out.code, out.status === 'failed' ? 502 : 422), opts.headers)
}

export async function handleApprovalsList(request, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const u = new URL(request.url)
  const state = u.searchParams.get('state') || 'pending'
  const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 50, 1), 200)
  const out = await p.plane.approvals.list({ org_id: p.org_id, identity: p.identity, states: state === 'all' ? null : [state], limit })
  return json(out, out.ok ? 200 : statusFor(out.code), opts.headers)
}

export async function handleApprovalGet(request, approval_id, opts = {}) {
  const p = await prologue(request, opts)
  if (p.response) return p.response
  const out = await p.plane.approvals.get({ org_id: p.org_id, identity: p.identity, approval_id: String(approval_id || '') })
  if (!out.ok) return json(out, statusFor(out.code), opts.headers)
  // display-only preview (e.g. the exact SMS text): computed now, never stored
  const spec = p.plane.registry.get(out.approval.capability_id)
  if (out.approval.state === 'pending' && typeof spec?.preview === 'function') {
    try {
      out.approval.preview = await spec.preview(out.approval.intended_change, { org_id: p.org_id, actor: p.identity.user_id, services: p.plane.services, now: Date.now }, out.approval.target)
    } catch (e) {
      out.approval.preview = { unavailable: String(e?.code || 'preview_failed') }
    }
  }
  return json(out, 200, opts.headers)
}

export async function handleApprovalDecide(request, approval_id, opts = {}) {
  const p = await prologue(request, { ...opts, bucket: 'mutation' })
  if (p.response) return p.response
  const b = await body(request)
  const out = await p.plane.approvals.decide({ org_id: p.org_id, identity: p.identity, approval_id: String(approval_id || ''), decision: String(b?.decision || ''), payload_hash: String(b?.payload_hash || ''), note: b?.note ?? null })
  const status = out.ok || out.replayed ? 200 : statusFor(out.code, 409)
  return json(out, status, opts.headers)
}

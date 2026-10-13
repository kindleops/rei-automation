// Capability registry + the ONE server-side enforcement path.
//
// invoke({ capability_id, input, ctx }) — every call, model or operator:
//   1  registered?                       → CAPABILITY_NOT_REGISTERED
//   2  input against the closed schema   → INPUT_INVALID   (a model-supplied tier /
//                                           approved / approval_id key is refused here)
//   3  plane gate + mode ceiling         → AGENT_DISABLED / AGENT_READ_ONLY / AGENT_MODE_CEILING
//   4  verified named operator + agent.operator_membership in ctx.org_id (+ role)
//                                         → IDENTITY_REQUIRED / NOT_A_MEMBER / ROLE_NOT_ALLOWED
//   5  effective tier = spec.tier, raised (never lowered) when the session has read
//      untrusted content: an autonomous write is then REFUSED, an approval-tier call
//      still only prepares a pending approval (labelled untrusted_content)
//   6  rate (per minute, in process) + per-day cap (durable audit count)
//   7  idempotency key = sha256(capability, version, org, actor, spec.idempotency(input))
//   8  dispatch by tier:
//        autonomous_internal         execute (writes: replay a recorded success, readback inside)
//        within_approved_policy      server policy allows → execute; else → approval
//        requires_explicit_approval  prepare() → pending approval (nothing else happens)
//   9  audit row for every decision (allowed, refused, prepared, failed)
//  10  model-facing projection: row cap + contact masking; untrusted output taints the session
//
// ctx is assembled by SERVER code only (routes / the ask hook): { org_id, identity,
// source: 'model'|'operator', session, env }. Nothing in `input` reaches ctx.
import { validateSchema } from '../tools/schema.js'
import { canonicalJson, hashCanonical, sha256Hex } from '../runtime/canonical.js'
import { AgentError } from '../runtime/store.js'
import { isConsequentialIdentity } from '../security/identity.js'
import { isAgentEnabled, isAgentReadOnly, resolveAgentMode } from '../config/agent-config.js'
import { maskContacts } from '../research/pii.js'
import { defineCapability, maxTier, TIER_RANK } from './contracts.js'

export const CAPABILITIES_FLAG = 'AGENT_CAPABILITIES_ENABLED'
const ON = new Set(['1', 'true', 'on', 'yes'])
const MODE_RANK = Object.freeze({ off: 0, read: 1, draft: 2, write: 3, full: 4 })
const ROLE_RANK = Object.freeze({ operator: 1, owner: 2 })

/** Plane gate: the Gate B kill switch AND the capability flag (default off everywhere). */
export function capabilityGate(env = process.env) {
  if (!isAgentEnabled(env)) return { enabled: false, reason: 'AGENT_DISABLED' }
  if (!ON.has(String(env?.[CAPABILITIES_FLAG] ?? '').trim().toLowerCase())) return { enabled: false, reason: `${CAPABILITIES_FLAG}_off` }
  return { enabled: true, reason: null }
}

/**
 * Ceilings. Reads: the effective agent mode (AGENT_MAX_MODE ∧ system_control.agent_mode) is not
 * 'off'. Writes (internal writes AND approval preparation) additionally need the capability write
 * flag AGENT_CAPABILITIES_WRITES_ENABLED and the review-only switch lifted (AGENT_READ_ONLY — frozen
 * ON in production builds: lifting it there is a reviewed code change, never an env edit).
 * Independent of the research ask's exact 'read' mode, so the ask hook can prepare approvals.
 */
export const CAPABILITY_WRITES_FLAG = 'AGENT_CAPABILITIES_WRITES_ENABLED'
export function writeCeiling(env = process.env, systemControlMode = null) {
  const mode = resolveAgentMode({ env, systemControlMode })
  const flag = ON.has(String(env?.[CAPABILITY_WRITES_FLAG] ?? '').trim().toLowerCase())
  const read_only = isAgentReadOnly(env)
  return { mode, read_ok: MODE_RANK[mode] >= MODE_RANK.read, write_ok: MODE_RANK[mode] >= MODE_RANK.read && flag && !read_only, read_only, writes_flag: flag }
}

export function createCapabilityRegistry() {
  const caps = new Map()
  let sealed = false
  return {
    register(spec) {
      if (sealed) throw new AgentError('REGISTRY_SEALED', 'capabilities cannot be registered after boot')
      const def = defineCapability(spec)
      if (caps.has(def.id)) throw new AgentError('CAPABILITY_DUPLICATE', def.id)
      caps.set(def.id, def)
      return def
    },
    get: (id) => caps.get(id) || null,
    has: (id) => caps.has(id),
    list: () => [...caps.values()],
    seal() { sealed = true; return this },
    get sealed() { return sealed },
  }
}

/** The public capability matrix (no functions). */
export function describeCapability(c) {
  return { id: c.id, version: c.version, domain: c.domain, title: c.title, side_effect: c.side_effect, tier: c.tier, service: c.wraps.service, min_role: c.min_role, cost_class: c.cost_class, limits: c.limits, compensation: c.compensation || null, approval_class: c.approval_class || null, output_trust: c.output_trust }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AgentError('CAPABILITY_TIMEOUT', `timed out after ${ms} ms`)), ms)
    if (typeof t.unref === 'function') t.unref()
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** A domain refusal thrown by a capability (expected, never an internal error). */
export function refusal(code, message = null, detail = null) {
  return Object.assign(new AgentError(code, message || code), { refusal: true, detail })
}

/** Session = server-side, per conversation. Only the invoker writes `tainted`. */
export function createSession() {
  const s = { tainted: false, tainted_by: null }
  return Object.seal(s)
}

/** Model-facing projection: rows cap + contact masking (phones → last-2 masks, emails withheld). */
export function projectForModel(spec, result) {
  let v = result
  if (typeof spec.project === 'function') v = spec.project(result)
  const cap = spec.limits.rows_to_model
  let truncated = false
  if (v && Array.isArray(v.rows) && v.rows.length > cap) { v = { ...v, rows: v.rows.slice(0, cap) }; truncated = true }
  const masked = maskContacts(v, { knownIds: new Set() })
  return { value: masked.value, truncated }
}

/**
 * @param {{ registry, store, approvals, services, env?, now?: () => number, systemControlMode?: () => Promise<string|null> }} deps
 */
export function createCapabilityInvoker({ registry, store, approvals, services, env = process.env, now = () => Date.now(), systemControlMode = null }) {
  if (!registry?.sealed) throw new AgentError('REGISTRY_NOT_SEALED', 'seal the capability registry before serving')
  const minute = new Map() // `${actor}|${cap}` → timestamps

  function rateOk(actor, spec) {
    const k = `${actor}|${spec.id}`
    const t = now()
    const arr = (minute.get(k) || []).filter((x) => t - x < 60_000)
    if (arr.length >= spec.limits.per_min) { minute.set(k, arr); return false }
    arr.push(t)
    minute.set(k, arr)
    if (minute.size > 5000) minute.delete(minute.keys().next().value)
    return true
  }

  async function audit(row) {
    try { await store.appendAudit(row) } catch (e) { if (row.decision !== 'refused') throw e }
  }

  async function invoke({ capability_id, input = {}, ctx = {} }) {
    const spec = registry.get(String(capability_id || ''))
    const actor = ctx.identity?.user_id || null
    const base = { org_id: ctx.org_id || null, capability_id: spec?.id || String(capability_id || '').slice(0, 80), capability_version: spec?.version ?? null, actor, source: ctx.source === 'operator' ? 'operator' : 'model', tier: spec?.tier ?? null }
    const refuse = async (code, extra = {}) => {
      if (base.org_id && actor) await audit({ ...base, decision: 'refused', code, input_hash: safeHash(input), summary: { code } })
      return { ok: false, status: 'refused', code, ...extra }
    }
    if (!spec) return refuse('CAPABILITY_NOT_REGISTERED')
    const inputObj = input && typeof input === 'object' && !Array.isArray(input) ? input : null
    if (!inputObj) return refuse('INPUT_INVALID', { errors: ['$: expected object'] })
    const errors = validateSchema(spec.input_schema, inputObj)
    if (errors.length) return refuse('INPUT_INVALID', { errors: errors.slice(0, 10) })

    const gate = capabilityGate(env)
    if (!gate.enabled) return refuse(gate.reason)
    const ceiling = writeCeiling(env, typeof systemControlMode === 'function' ? await systemControlMode().catch(() => 'off') : null)
    if (!ceiling.read_ok) return refuse('AGENT_MODE_CEILING')
    if (spec.side_effect !== 'read' && !ceiling.write_ok) return refuse(ceiling.read_only ? 'AGENT_READ_ONLY' : 'CAPABILITY_WRITES_DISABLED')

    if (!isConsequentialIdentity(ctx.identity)) return refuse('IDENTITY_REQUIRED')
    if (!ctx.org_id) return refuse('ORG_REQUIRED')
    const member = await store.membership(ctx.org_id, actor)
    if (!member) return refuse('NOT_A_MEMBER')
    if ((ROLE_RANK[member.role] || 0) < ROLE_RANK[spec.min_role]) return refuse('ROLE_NOT_ALLOWED')

    let tier = spec.tier
    const tainted = Boolean(ctx.session?.tainted) && base.source === 'model'
    if (tainted && spec.side_effect !== 'read') {
      if (tier === 'autonomous_internal') return refuse('UNTRUSTED_CONTEXT_WRITE_REFUSED', { message: 'This conversation read untrusted content (seller messages). Internal writes need a fresh operator request.' })
      tier = maxTier(tier, 'requires_explicit_approval')
    }
    if (TIER_RANK[tier] >= TIER_RANK.never) return refuse('CAPABILITY_NEVER')

    if (!rateOk(actor, spec)) return refuse('RATE_LIMITED')
    const since = new Date(now() - 24 * 3600_000).toISOString()
    if ((await store.countAudit({ org_id: ctx.org_id, actor, capability_id: spec.id, since, decisions: ['executed', 'approval_requested', 'read'] })) >= spec.limits.per_day) return refuse('DAILY_CAP')

    const svcCtx = Object.freeze({ org_id: ctx.org_id, actor, source: base.source, services, now, provenance: tainted ? 'untrusted_content' : base.source })
    const idempotency_key = spec.side_effect === 'read' ? null : sha256Hex(canonicalJson({ c: spec.id, v: spec.version, o: ctx.org_id, a: actor, k: spec.idempotency(inputObj, svcCtx) }))
    const input_hash = safeHash(inputObj)
    const auditBase = { ...base, tier, idempotency_key, input_hash }

    try {
      if (tier === 'autonomous_internal') {
        if (idempotency_key) {
          const prior = await store.findAuditByIdempotency(ctx.org_id, idempotency_key)
          if (prior) return { ok: true, status: 'replayed', capability_id: spec.id, result: prior.summary?.result || null }
        }
        const result = await withTimeout(Promise.resolve().then(() => spec.execute(inputObj, svcCtx)), spec.limits.timeout_ms)
        if (spec.output_trust === 'untrusted' && ctx.session) { ctx.session.tainted = true; ctx.session.tainted_by = spec.id }
        const summary = spec.audit(inputObj, result)
        await audit({ ...auditBase, decision: spec.side_effect === 'read' ? 'read' : 'executed', summary: spec.side_effect === 'read' ? summary : { ...summary, result: summary?.result ?? null } })
        const projected = projectForModel(spec, result)
        return { ok: true, status: spec.side_effect === 'read' ? 'read' : 'executed', capability_id: spec.id, trust: spec.output_trust, result: projected.value, truncated: projected.truncated }
      }
      if (tier === 'within_approved_policy' && !tainted) {
        const p = await spec.policy(inputObj, svcCtx)
        if (p?.allowed === true) {
          const prepared = await spec.prepare(inputObj, svcCtx)
          const result = await withTimeout(Promise.resolve().then(() => spec.executeApproved(prepared.intended_change, { ...svcCtx, approver: `policy:${p.policy_id}`, idempotency_key })), spec.limits.timeout_ms)
          await audit({ ...auditBase, decision: 'executed', code: `policy:${p.policy_id}`, summary: spec.audit(inputObj, result) })
          return { ok: true, status: 'executed', capability_id: spec.id, policy_id: p.policy_id, result: projectForModel(spec, result).value }
        }
      }
      // approval path: prepare → pending approval. Nothing else happens.
      const out = await approvals.request({ spec, input: inputObj, ctx: svcCtx, tier, idempotency_key })
      await audit({ ...auditBase, decision: out.ok ? 'approval_requested' : 'refused', code: out.code || null, approval_id: out.approval_id || null, summary: { prepared: Boolean(out.ok), deduped: Boolean(out.deduped) } })
      if (!out.ok) return { ok: false, status: 'refused', code: out.code, detail: out.detail || null }
      return { ok: true, status: 'approval_pending', capability_id: spec.id, approval_id: out.approval_id, expires_at: out.expires_at, deduped: Boolean(out.deduped), preview: out.preview }
    } catch (e) {
      const code = String(e?.code || 'CAPABILITY_ERROR').slice(0, 80)
      await audit({ ...auditBase, decision: e?.refusal ? 'refused' : 'failed', code, summary: { code } })
      return { ok: false, status: e?.refusal ? 'refused' : 'failed', code, detail: e?.refusal ? e.detail || null : null }
    }
  }

  return { invoke, registry }
}

function safeHash(v) {
  try { return hashCanonical(v ?? null) } catch { return null }
}

// THE ACTION GATEWAY — the ONE execution service every agent mutation flows through.
//
//   1  action registered?                         unknown → invalid_input UNKNOWN_ACTION
//   2  agent credential → principal (server-side)  unauthenticated (unknown / suspended / revoked / expired / sponsor gone)
//   3  tenant: principal org = the served org      forbidden CROSS_TENANT
//   4  global emergency stop / tier kill / capability kill (system_control, absent = OFF)   unavailable
//   5  implemented?                               not_implemented capability_not_implemented
//   6  capability grant + tier ceiling            forbidden
//   7  forged context / escalation keys / closed schema                 invalid_input
//   8  rate (per agent, per action)               rate_limited
//   9  resource: authoritative LeadCommand ids in the tenant            not_found
//  10  durable INTENT, idempotency key = (agent, action, resource, client key); a replay returns the
//      recorded outcome, a reused key with other parameters is a conflict
//  11  policy: the EXISTING domain guards (holds, STOP, suppression, permission state, budget) →
//      allow | deny (recorded refused outcome) | approval (a human decides through the existing path)
//  12  immutable AUTHORIZATION (the database re-verifies credential digest, grant, tier, kills, approval)
//  13  execution lease (one executing intent per resource) → the domain service: a lease-bound database
//      domain write (outcome recorded atomically) or a read-only JS service (outcome recorded on completion)
//  14  recovery: an expired lease is re-claimed for re-executable actions (domain writes are atomic and
//      keyed by the intent: exactly once) or recorded as outcome_unknown (a visible failure)
//  15  append-only audit at every step (the database's own trail + the host audit sink)
import crypto from 'node:crypto'
import { validateSchema } from '../../agent/tools/schema.js'
import { hashCanonical, canonicalJson } from '../../agent/runtime/canonical.js'
import { createActionCatalog } from './catalog.js'
import { ACTION_LOGIC, POLICY_VERSION } from './actions.js'
import { buildApprovalRequest, judgeApproval } from './approvals.js'
import { credentialDigest } from './credentials.js'
import { gwErr, ActionGatewayError, classifyGatewayError } from './errors.js'
import { FORGED_CONTEXT_KEYS, ESCALATION_KEYS, LIMITS, TIER_LABEL, TERMINAL_STATES, ACTION_GATEWAY_VERSION, READ_SCOPES, APPROVAL_GRANT_TTL_MS } from './constants.js'
import { APPROVAL_TTL_MS } from '../../agent/capabilities/contracts.js'
import { readConversationContext } from './context-read.js'
import { encodePropertyRef } from '../../agent/missions/mission-codec.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const low = (v) => String(v ?? '').trim().toLowerCase()

/** Mirror of action_gateway.grant_scope_refusal: an absent axis is unrestricted. */
export function scopeCovers(scope, resource) {
  if (Array.isArray(scope.resource_types) && !scope.resource_types.includes(resource.type)) return false
  if (Array.isArray(scope.campaign_ids) && !(resource.type === 'campaign' && scope.campaign_ids.map(low).includes(low(resource.id)))) return false
  if (Array.isArray(scope.markets) && !(resource.refs?.market && scope.markets.some((m) => low(m) === low(resource.refs.market)))) return false
  return true
}
/** Mirror of action_gateway.grant_envelope_refusal over the stored params: null = inside. */
export function envelopeRefusal(envelope = {}, params = {}) {
  for (const [k, max] of Object.entries(envelope.max || {})) if (k in params && (typeof params[k] !== 'number' || params[k] > Number(max))) return 'ARGUMENT_OUTSIDE_ENVELOPE'
  for (const [k, allowed] of Object.entries(envelope.allow || {})) if (k in params && !(Array.isArray(allowed) && allowed.some((a) => JSON.stringify(a) === JSON.stringify(params[k])))) return 'ARGUMENT_OUTSIDE_ENVELOPE'
  return null
}
const CAP_CODES = new Set(['GRANT_EXHAUSTED_HOURLY', 'GRANT_EXHAUSTED_DAILY', 'GRANT_SPEND_CAP'])

function createRate(now) {
  const hits = new Map()
  return (key, limit) => {
    const t = now()
    const arr = (hits.get(key) || []).filter((x) => t - x < 60_000)
    if (arr.length >= limit) { hits.set(key, arr); throw gwErr('rate_limited', 'RATE_LIMITED', `rate limit reached (${limit} per minute)`, { retry_after_ms: Math.max(60_000 - (t - arr[0]), 0) }) }
    arr.push(t)
    hits.set(key, arr)
    if (hits.size > 10_000) hits.delete(hits.keys().next().value)
  }
}

/** The canonical records a read named (audited, so a Workforce completion can cite them as evidence): ids only, property ids encoded. */
function recordRefsOf(input = {}) {
  const refs = []
  if (typeof input.thread_id === 'string' && UUID_RE.test(input.thread_id)) refs.push({ type: 'thread', id: input.thread_id.toLowerCase() })
  if (typeof input.property_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.property_id)) refs.push({ type: 'property', id: encodePropertyRef(input.property_id) })
  return refs.length ? { record_refs: refs } : {}
}

function deepKeys(v, out = [], depth = 0) {
  if (depth > 6 || v == null || typeof v !== 'object') return out
  for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out, depth + 1) }
  return out
}

/**
 * @param {{ store, reads, services, pepper: string|Buffer, dataOrgId: string, catalog?, logic?, worker?, leaseSeconds?,
 *           now?: () => number, sleep?: (ms) => Promise, onAudit?: (rec) => void, maxBusyRetries?: number }} deps
 */
export function createActionGateway({ store, reads, services, pepper, dataOrgId, catalog = createActionCatalog(), logic = ACTION_LOGIC, worker = `action-gateway:${process.pid}`,
  leaseSeconds = LIMITS.lease_seconds, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onAudit = null, maxBusyRetries = LIMITS.claim_busy_retries,
  approvalDecideTtlMs = APPROVAL_TTL_MS.default, approvalGrantTtlMs = APPROVAL_GRANT_TTL_MS,
  // Owner architecture correction 2026-10-29: Agntei's employees compose EVERY SMS. A spec marked `retired` (an action
  // where LeadCommand would write the words for an agent: queue_agent_message, queue_authorized_reply) is refused
  // AGENT_COMPOSES_TEXT. Its code is kept for the record; only a test that exercises that retained code turns this on.
  legacyComposerActionsForTests = false }) {
  if (!store || !reads || !services) throw new Error('action gateway: store, reads and services are required')
  if (!UUID_RE.test(String(dataOrgId || ''))) throw new Error('action gateway: dataOrgId (the served org) must be a uuid')
  credentialDigest(pepper, `lcag_${'A'.repeat(43)}`) // validates the pepper at construction (throws PEPPER_INVALID)
  const rate = createRate(now)
  // approval windows: bounded (1 s … 24 h, the agent.approval_request CHECK); the grant window never shorter than the decision window
  const decideTtl = Math.min(Math.max(Number(approvalDecideTtlMs) || APPROVAL_TTL_MS.default, 1000), 24 * 3600_000)
  const grantTtl = Math.min(Math.max(Number(approvalGrantTtlMs) || APPROVAL_GRANT_TTL_MS, 1000), 24 * 3600_000)
  let auditFailures = 0

  async function audit(ev) {
    const rec = { ...ev, detail: ev.detail || {} }
    try { onAudit?.({ ts: new Date(now()).toISOString(), ...rec }) } catch { /* host sink failure is counted, never fatal */ auditFailures += 1 }
    if (!(await store.audit(rec).catch(() => false))) auditFailures += 1
  }

  async function authenticate(credential, base) {
    const digest = credentialDigest(pepper, credential)
    if (!digest) throw gwErr('unauthenticated', 'CREDENTIAL_MISSING_OR_MALFORMED', 'an agent credential is required')
    let p
    try { p = await store.principal(digest) } catch (e) { throw classifyGatewayError(e) }
    if (!p) throw gwErr('unauthenticated', 'CREDENTIAL_UNKNOWN', 'unknown agent credential')
    if (p.org_id !== dataOrgId) throw gwErr('forbidden', 'CROSS_TENANT', 'the agent belongs to another tenant')
    if (p.status !== 'active') throw gwErr('unauthenticated', `PRINCIPAL_${String(p.status).toUpperCase()}`, 'the agent is not active')
    if (!(Date.parse(p.credential_expires_at) > now())) throw gwErr('unauthenticated', 'CREDENTIAL_EXPIRED', 'the agent credential expired')
    if (p.sponsor_is_member !== true) throw gwErr('unauthenticated', 'SPONSOR_NOT_MEMBER', 'the agent\'s accountable operator is no longer a member')
    base.agent_id = p.agent_id
    return { principal: p, digest }
  }

  /** The agent's USABLE standing grants for this capability (version-ordered); typed refusals otherwise. */
  function grantsFor(principal, spec) {
    if (spec.tier > Number(principal.tier_ceiling)) throw gwErr('forbidden', 'TIER_ABOVE_CEILING', `${spec.name} is ${TIER_LABEL[spec.tier]}; the agent's ceiling is ${TIER_LABEL[principal.tier_ceiling]}`)
    const all = (principal.grants || []).filter((x) => x.capability === spec.capability && Number(x.max_tier) >= spec.tier && Date.parse(x.expires_at) > now())
    if (!all.length) throw gwErr('forbidden', 'CAPABILITY_NOT_GRANTED', `capability ${spec.capability} is not granted to this agent`, { required_capability: spec.capability, tier: TIER_LABEL[spec.tier] })
    const live = all.filter((x) => !x.suspended_reason)
    if (!live.length) throw gwErr('forbidden', 'GRANT_SUSPENDED', `the standing grant for ${spec.capability} is suspended (${all[0].suspended_reason}); an owner reinstates it`)
    const valid = live.filter((x) => Date.parse(x.valid_from) <= now())
    if (!valid.length) throw gwErr('forbidden', 'GRANT_NOT_YET_VALID', `the standing grant for ${spec.capability} is not valid yet`)
    return valid.sort((a, b) => Number(b.grant_version || 1) - Number(a.grant_version || 1))
  }
  /** The grant whose SCOPE covers the resource (mirror of action_gateway.grant_scope_refusal; the database re-checks). */
  function grantForResource(grants, resource) {
    const g = grants.find((x) => scopeCovers(x.scope || {}, resource))
    if (!g) throw gwErr('forbidden', 'RESOURCE_OUT_OF_GRANT_SCOPE', 'no standing grant of this agent covers this resource (org / market / campaign / resource type)')
    return g
  }

  function validate(spec, rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : null
    if (!args) throw gwErr('invalid_input', 'INPUT_INVALID', 'arguments must be an object')
    // a spec's VERBATIM record (queue_agent_text's attribution: employee, model, provider, route, session id, turn id)
    // is stored as the agent sent it and never interpreted — never identity or authority — so its inner key names are
    // not context keys; its shape is still the closed schema's
    const verbatim = Array.isArray(spec.verbatim_keys) ? spec.verbatim_keys : []
    const keys = deepKeys(verbatim.length ? Object.fromEntries(Object.entries(args).filter(([k]) => !verbatim.includes(k))) : args)
    if (keys.some((k) => FORGED_CONTEXT_KEYS.test(k))) throw gwErr('invalid_input', 'FORGED_CONTEXT', 'identity, tenant, authority and approvals come from the server, never from tool arguments')
    if (keys.some((k) => ESCALATION_KEYS.test(k))) throw gwErr('invalid_input', 'ESCALATION_REFUSED', 'no tool accepts SQL, routes, roles or other execution surfaces')
    const errors = validateSchema(spec.input, args)
    if (errors.length) throw gwErr('invalid_input', 'INPUT_INVALID', 'arguments do not match the input schema', { issues: errors.slice(0, 8) })
    return args
  }

  async function controlsOrStop(spec, base) {
    let c
    try { c = await store.controls() } catch { throw gwErr('unavailable', 'CONTROLS_UNREADABLE', 'the gateway controls could not be read (fail closed)') }
    if (!c.enabled) throw gwErr('unavailable', 'ACTION_GATEWAY_STOPPED', 'the Action Gateway is stopped (system_control action_gateway_enabled is not true)')
    if (!c.tiers.has(TIER_LABEL[spec.tier])) throw gwErr('unavailable', 'TIER_DISABLED', `tier ${TIER_LABEL[spec.tier]} is not enabled`)
    if (c.killed.has(spec.capability)) throw gwErr('unavailable', 'CAPABILITY_KILLED', `capability ${spec.capability} is killed`)
    base.controls_ok = true
  }

  async function availableOrRefuse(spec, base) {
    const fn = logic[spec.name]?.available
    if (typeof fn !== 'function') return
    let v
    try { v = await fn({ spec, reads, services, store, now }) } catch { v = { available: false, code: 'CAPABILITY_STATE_UNREADABLE' } }
    if (v?.available !== true) {
      base.unavailable_reason = v?.code || 'CAPABILITY_OFF'
      // a spec that names its refusals (queue_agent_text) answers the reason itself as the code (EMERGENCY_STOP_ACTIVE,
      // AGENT_TEXT_KILL_SWITCH_OFF …), never a generic one
      throw gwErr('unavailable', spec.unavailable_reason_is_code === true ? base.unavailable_reason : 'capability_unavailable', `${spec.name} is not available: ${spec.unavailable_reason_is_code === true ? 'refused' : 'its production capability is not activated'} (${base.unavailable_reason})`, { reason: base.unavailable_reason })
    }
  }

  const shape = (spec, intent, extra = {}) => ({ ok: intent?.state === 'succeeded', tool: spec.name, intent_id: intent?.intent_id || null, state: intent?.state || null, ...extra })

  /** The recorded outcome of a terminal intent (replay: never a second execution). */
  async function recorded(spec, intentId, base, replayed) {
    const g = await store.getIntent(intentId)
    const o = g?.outcome || null
    const st = g?.intent?.state
    return { ok: st === 'succeeded', status: replayed ? 'replayed' : st, tool: spec.name, intent_id: intentId, state: st, code: o?.code || g?.intent?.result_code || null, result: o?.result || {}, correlation_id: base.correlation_id, replayed: Boolean(replayed) }
  }

  async function execute(spec, intent, ctx, base) {
    // claim the execution lease (one executing intent per resource; a stale holder is recovered first)
    let claim
    for (let attempt = 0; ; attempt += 1) {
      claim = await store.claim(intent.intent_id, worker, leaseSeconds)
      if (claim?.ok) break
      if (claim?.reason === 'resource_busy') {
        if (claim.holder_expired && claim.holder_intent_id) await recoverOne(claim.holder_intent_id).catch(() => {})
        if (attempt < maxBusyRetries) { await sleep(LIMITS.claim_busy_wait_ms); continue }
        await audit({ ...base, event_type: 'resource_busy', intent_id: intent.intent_id, code: 'RESOURCE_BUSY' })
        throw gwErr('busy', 'RESOURCE_BUSY', 'another agent action is executing on this resource; retry with the same client_request_id')
      }
      if (claim?.reason === 'lease_live') return { ok: false, status: 'in_progress', tool: spec.name, intent_id: intent.intent_id, state: 'executing', code: 'IN_PROGRESS', retryable: true, correlation_id: base.correlation_id }
      if (claim?.reason === 'not_claimable') return recorded(spec, intent.intent_id, base, true)
      if (claim?.reason === 'not_reexecutable' || claim?.reason === 'attempts_exhausted') {
        await store.markUnknown(intent.intent_id, claim.reason === 'attempts_exhausted' ? 'ATTEMPTS_EXHAUSTED' : 'LEASE_EXPIRED_OUTCOME_UNKNOWN')
        return recorded(spec, intent.intent_id, base, false)
      }
      throw gwErr('internal', 'CLAIM_FAILED')
    }
    const token = claim.lease_token
    if (spec.executor.kind === 'domain_write') {
      const out = await store.domainWrite(spec.executor.fn, intent.intent_id, token)
      return { ok: out?.status === 'succeeded', status: out?.status, tool: spec.name, intent_id: intent.intent_id, state: out?.status, code: out?.code || null, result: out?.result || {}, attempt: claim.attempt, correlation_id: base.correlation_id }
    }
    // a read-only JS domain service (draft / report): its outcome is recorded on completion
    const fn = logic[spec.name]?.execute
    let r
    try {
      r = await fn({ intent: { ...intent, params: ctx.params }, reads, services, store, now, lease_token: token, org_id: dataOrgId })
    } catch (e) {
      const g = classifyGatewayError(e)
      if (g.errorClass === 'unavailable') throw g // transient: the lease expires and recovery re-executes
      r = { status: 'failed', code: `EXECUTION_${g.code}`.slice(0, 80), result: {} }
    }
    // a JS executor that finished the intent through a lease-bound database writer (T2 human requests): the
    // RECORDED outcome is the answer, never a second completion
    if (r?.recorded) {
      const out = await recorded(spec, intent.intent_id, base, false)
      return { ...out, ...(out.state === 'succeeded' && r.response ? { response: r.response } : {}), attempt: claim.attempt }
    }
    const done = await store.complete(intent.intent_id, token, r.status, r.code, r.result || {})
    if (!done?.ok) {
      if (done?.reason === 'lease_lost') return recorded(spec, intent.intent_id, base, false)
      throw gwErr('internal', 'COMPLETE_FAILED')
    }
    // the RECORDED outcome is the answer (the database may withhold a result: emergency stop / grant revoked mid-run)
    const st = done.status || r.status
    return { ok: st === 'succeeded', status: st, tool: spec.name, intent_id: intent.intent_id, state: st, code: done.code || r.code, result: done.result || {}, ...(st === 'succeeded' && r.response ? { response: r.response } : {}), attempt: claim.attempt, correlation_id: base.correlation_id }
  }

  /** Authorization (immutable record; the database re-verifies everything) then execution. */
  async function authorizeAndRun(spec, intent, ctx, base, { approval_id = null, approval_required = false, decision }) {
    let auth
    try {
      const authz = { grant_id: ctx.grant.grant_id, policy_id: `${spec.name}.policy`, policy_version: POLICY_VERSION,
        approval_required, approval_id, evidence: JSON.parse(canonicalJson(decision?.evidence || {})) }
      // T4: an operator-authorized ENVELOPE REF is the per-use authority (verified again in the database)
      auth = !approval_id && decision?.envelope_ref && spec.envelope_authorized === true && typeof store.authorizeEnvelope === 'function'
        ? await store.authorizeEnvelope(intent.intent_id, ctx.digest, { ...authz, approval_required: false, approval_id: null, envelope_ref: decision.envelope_ref })
        : await store.authorize(intent.intent_id, ctx.digest, authz)
    } catch (e) {
      const g = classifyGatewayError(e)
      // the database refused to authorize: record it (the intent is still received / awaiting)
      await store.refuse(intent.intent_id, `AUTHORIZATION_${g.code}`.slice(0, 80), { stage: 'authorization' }).catch(() => null)
      throw g
    }
    if (auth?.refused) {
      // the STANDING GRANT refused this use (recorded refused outcome; a cap hit counts toward auto-suspension)
      const out = await recorded(spec, intent.intent_id, base, false)
      return { ...out, retryable: CAP_CODES.has(auth.code), ...(CAP_CODES.has(auth.code) ? { hint: 'the grant cap is reached; retry later with a NEW client_request_id' } : {}) }
    }
    return execute(spec, intent, ctx, base)
  }

  async function policyOf(spec, ctx) {
    const p = logic[spec.name]
    let d
    try { d = await p.policy(ctx) } catch (e) { const g = classifyGatewayError(e); d = { decision: 'deny', code: g.errorClass === 'not_found' ? g.code : `POLICY_${g.code}`.slice(0, 80), evidence: {} } }
    if (!['allow', 'deny', 'approval'].includes(d?.decision)) return { decision: 'deny', code: 'POLICY_UNDECIDED', evidence: {} }
    if (d.decision === 'allow') {
      // a standing grant alone authorizes T1, and T2 only for reversible / request-only actions; T3 / T4 never (mirrors the DB)
      // …except an envelope-authorized T4 action whose policy verified an operator-granted envelope ref
      // …and (Agntei 5.4) the certified seller reply — and (link #32) the agent-initiated message — under an owner-minted
      // STANDING seller-facing grant for exactly its capability: no per-use approval; everything else about the path still
      // applies (mirrors action_gateway.grant_refusal; specs flagged standing_reply)
      const standingReply = spec.tier === 3 && spec.standing_reply === true && ctx.grant?.standing_seller_facing === true && ctx.grant?.capability === spec.capability
      if (spec.tier >= 3 && !(spec.envelope_authorized === true && d.envelope_ref) && !standingReply) return { ...d, decision: 'approval', code: 'TIER_REQUIRES_APPROVAL' }
      if (standingReply) return { ...d, evidence: { ...(d.evidence || {}), authority: 'standing_seller_facing' } }
      if (spec.tier >= 3) return d
      // (request_only T2 actions only FILE a human decision: their per-use approval IS that decision)
      if (spec.tier === 2 && !spec.reversible && !spec.request_only) return { ...d, decision: 'approval', code: 'T2_ACTION_NOT_REVERSIBLE' }
      // outside the grant's argument envelope: this one use needs a human approval
      const env = envelopeRefusal(ctx.grant?.envelope || {}, ctx.params || {})
      if (env) return { ...d, decision: 'approval', code: env, evidence: { ...(d.evidence || {}), envelope: 'outside' } }
    }
    return d
  }

  /** awaiting_approval re-entry: verify the HUMAN record, re-run the guards, then authorize with it. */
  async function resumeApproval(spec, intent, ctx, base) {
    const a = await store.approvalGet(intent.approval_id)
    const v = judgeApproval(a, intent, { now: now() })
    if (v.pending) return { ok: false, status: 'approval_pending', tool: spec.name, intent_id: intent.intent_id, state: 'awaiting_approval', code: 'APPROVAL_PENDING', approval: { approval_id: intent.approval_id, expires_at: a?.expires_at || null }, correlation_id: base.correlation_id }
    if (!v.usable) {
      if (v.expired) await store.expire(intent.intent_id, v.code)
      else await store.refuse(intent.intent_id, v.code, { stage: 'approval' })
      await audit({ ...base, event_type: 'approval_refused', intent_id: intent.intent_id, code: v.code })
      return recorded(spec, intent.intent_id, base, false)
    }
    const d = await policyOf(spec, ctx)
    if (d.decision === 'deny') { await store.refuse(intent.intent_id, d.code || 'POLICY_DENIED', d.evidence || {}); return recorded(spec, intent.intent_id, base, false) }
    await audit({ ...base, event_type: 'approval_verified', intent_id: intent.intent_id, detail: { approval_id: intent.approval_id } })
    return authorizeAndRun(spec, intent, ctx, base, { approval_id: intent.approval_id, approval_required: true, decision: d })
  }

  /** Continue an intent from whatever durable state it is in (crash-safe re-entry). */
  async function advance(spec, intent, ctx, base) {
    if (TERMINAL_STATES.includes(intent.state)) return recorded(spec, intent.intent_id, base, true)
    if (intent.state === 'awaiting_approval') return resumeApproval(spec, intent, ctx, base)
    if (intent.state === 'authorized' || intent.state === 'executing') return execute(spec, intent, ctx, base)
    // received
    const d = await policyOf(spec, ctx)
    if (d.decision === 'deny') {
      await store.refuse(intent.intent_id, d.code || 'POLICY_DENIED', JSON.parse(canonicalJson(d.evidence || {})))
      return recorded(spec, intent.intent_id, base, false)
    }
    if (d.decision === 'approval') {
      const row = buildApprovalRequest({ intent, principal: ctx.principal, summary: logic[spec.name]?.summary?.(ctx.params) || [`${spec.title} (${spec.capability}, ${TIER_LABEL[spec.tier]})`, `Reason: ${d.code || 'policy'}`], now: now(), decideTtlMs: decideTtl, grantTtlMs: grantTtl })
      const filed = await store.approvalRequest(row)
      const approval = filed?.row || row
      await store.awaitApproval(intent.intent_id, approval.approval_id)
      return { ok: false, status: 'approval_pending', tool: spec.name, intent_id: intent.intent_id, state: 'awaiting_approval', code: d.code || 'APPROVAL_REQUIRED', approval: { approval_id: approval.approval_id, expires_at: approval.expires_at }, correlation_id: base.correlation_id }
    }
    return authorizeAndRun(spec, intent, ctx, base, { decision: d })
  }

  async function call({ credential, tool, args, transport = 'unknown' } = {}) {
    const started = now()
    const base = { correlation_id: crypto.randomUUID(), action: null, capability: null, tier: null, agent_id: null, transport }
    const spec = catalog.get(tool)
    try {
      if (!spec) throw gwErr('invalid_input', 'UNKNOWN_ACTION', `unknown tool ${String(tool).slice(0, 64)}`)
      Object.assign(base, { action: spec.name, capability: spec.capability, tier: spec.tier })
      const { principal, digest } = await authenticate(credential, base)
      await controlsOrStop(spec, base)
      if (catalog.isRead(spec.name)) return await readTool(spec, principal, args, base, digest)
      if (spec.implemented === false) throw gwErr('not_implemented', 'capability_not_implemented', `${spec.name} is registered but not implemented in this phase`)
      if (spec.retired && legacyComposerActionsForTests !== true) {
        throw gwErr('refused', spec.retired.code || 'AGENT_COMPOSES_TEXT', `${spec.name} is retired: LeadCommand never composes text for an agent. Compose the exact SMS yourself and send it with ${spec.retired.use || 'sms_send_agent_text'}.`, { use: spec.retired.use || 'sms_send_agent_text', gateway_action: spec.retired.action || 'queue_agent_text' })
      }
      // the path's PRODUCTION ACTIVATION (T3 / T4): off or NO-GO ⇒ capability_unavailable, whatever the grants say
      await availableOrRefuse(spec, base)
      const grants = grantsFor(principal, spec)
      const input = validate(spec, args)
      rate(`${principal.agent_id}|*`, LIMITS.per_agent_per_min)
      rate(`${principal.agent_id}|${spec.name}`, spec.limits.per_min)
      const p = logic[spec.name]
      const ctxBase = { spec, input, principal, grant: grants[0], digest, reads, services, store, now }
      const resource = await p.resolve(input, ctxBase)
      ctxBase.grant = grantForResource(grants, resource)
      const params = JSON.parse(canonicalJson(await p.params(input, resource, ctxBase)))
      // (a spec may hash a SUBSET of its params: queue_agent_text's idempotency is over the text and its lead, not the attribution)
      const params_hash = hashCanonical({ action: spec.name, version: spec.version, params: typeof p.hashParams === 'function' ? p.hashParams(params) : params })
      const idempotency_key = hashCanonical({ o: dataOrgId, a: principal.agent_id, x: spec.name, rt: resource.type, rid: String(resource.id), k: input.client_request_id })
      let opened
      try {
        opened = await store.openIntent({ agent_id: principal.agent_id, action: spec.name, capability: spec.capability, tier: spec.tier, resource_type: resource.type, resource_id: String(resource.id),
          client_key: input.client_request_id, idempotency_key, params, params_hash, correlation_id: base.correlation_id, recovery: spec.recovery, max_attempts: 3 })
      } catch (e) {
        if (String(e?.code) === '23514') throw gwErr('invalid_input', 'PARAMS_NOT_STORABLE', 'the arguments carry a value the action record refuses (a phone, email, credential or message body shape)')
        throw classifyGatewayError(e)
      }
      const intent = opened?.intent
      if (!intent?.intent_id) throw gwErr('internal', 'INTENT_OPEN_FAILED')
      if (!opened.inserted && intent.params_hash !== params_hash) {
        await audit({ ...base, event_type: 'idempotency_conflict', intent_id: intent.intent_id, code: 'IDEMPOTENCY_KEY_REUSED' })
        throw gwErr('conflict', spec.idempotency_conflict_code || 'IDEMPOTENCY_KEY_REUSED', 'this client_request_id was already used for this action and resource with different parameters')
      }
      const out = await advance(spec, intent, { ...ctxBase, resource, params }, base)
      return { ...out, latency_ms: now() - started, gateway: ACTION_GATEWAY_VERSION }
    } catch (e) {
      const g = e instanceof ActionGatewayError ? e : classifyGatewayError(e)
      await audit({ ...base, event_type: 'call_refused', code: g.code, detail: { class: g.errorClass, stage: base.controls_ok ? 'post_controls' : 'pre_controls', transport } })
      return { ok: false, status: 'error', tool: spec?.name || String(tool || '').slice(0, 64), correlation_id: base.correlation_id, error: g.toJSON(), unknownTool: g.code === 'UNKNOWN_ACTION', latency_ms: now() - started }
    }
  }

  async function readTool(spec, principal, args, base, digest = null) {
    // a read with a scope needs it in the principal's read scopes; a scope-less read (prepare_acquisition_offer) needs its grant + tier only
    const scope = spec.scope === undefined ? READ_SCOPES.conversation_context : spec.scope
    if (scope && !(principal.read_scopes || []).includes(scope)) throw gwErr('forbidden', 'READ_SCOPE_NOT_GRANTED', `the read scope ${scope} is not granted to this agent`)
    const readGrants = grantsFor(principal, spec)
    const input = validate(spec, args)
    rate(`${principal.agent_id}|*`, LIMITS.per_agent_per_min)
    rate(`${principal.agent_id}|${spec.name}`, spec.limits.per_min)
    const custom = logic[spec.name]?.read
    if (typeof custom === 'function') {
      // principal-bound reads (Workforce) receive the AUTHENTICATED principal + its digest: never an argument
      const result = await custom({ input, reads, services, store, now, principal, digest, coverResource: (res) => grantForResource(readGrants, res) })
      await audit({ ...base, event_type: 'action_read', code: 'READ', detail: { resource_type: result?.resource_type || 'property', ...recordRefsOf(input) } })
      return { ok: true, status: 'read', tool: spec.name, correlation_id: base.correlation_id, result }
    }
    const t = await reads.thread(input.thread_id)
    if (t) grantForResource(readGrants, { type: 'thread', id: t.id, refs: { market: t.market || null } })
    const result = await readConversationContext({ input, reads, services, now })
    await audit({ ...base, event_type: 'context_read', code: 'READ', detail: { resource_type: 'thread', message_count: result.messages.length, ...recordRefsOf(input) } })
    return { ok: true, status: 'read', tool: spec.name, correlation_id: base.correlation_id, result }
  }

  /** Recover ONE intent whose lease expired (re-execute when re-executable, else a visible outcome_unknown). */
  async function recoverOne(intentId) {
    const g = await store.getIntent(intentId)
    const intent = g?.intent
    if (!intent || intent.state !== 'executing') return { recovered: false, state: intent?.state || null }
    const spec = catalog.get(intent.action)
    // the intent's OWN recorded recovery mode decides (never a later catalog change)
    if (!spec || spec.implemented === false || intent.recovery !== 'reexecute' || intent.attempt >= intent.max_attempts) {
      const r = await store.markUnknown(intent.intent_id, !spec || intent.recovery !== 'reexecute' ? 'LEASE_EXPIRED_OUTCOME_UNKNOWN' : 'ATTEMPTS_EXHAUSTED')
      return { recovered: Boolean(r?.ok), state: r?.status || 'outcome_unknown' }
    }
    const base = { correlation_id: intent.correlation_id, action: spec.name, capability: spec.capability, tier: spec.tier, agent_id: intent.agent_id, transport: 'recovery' }
    // the params are the intent's own (stored, hashed, authorized); the read-only executors re-read every fact
    const out = await execute(spec, intent, { params: intent.params || {} }, base)
    await audit({ ...base, event_type: 'recovered', intent_id: intent.intent_id, code: out.code || null, detail: { state: out.state || null } })
    return { recovered: true, state: out.state, code: out.code }
  }

  async function recover({ limit = 20 } = {}) {
    const list = await store.recoverable(limit)
    const results = []
    for (const i of list) results.push({ intent_id: i.intent_id, ...(await recoverOne(i.intent_id).catch((e) => ({ recovered: false, error: classifyGatewayError(e).code }))) })
    return { scanned: list.length, results }
  }

  function listTools() {
    return [...catalog.actions(), ...catalog.reads()].map((s) => ({
      name: s.name, title: s.title, description: s.description, input: s.input, tier: TIER_LABEL[s.tier], capability: s.capability,
      implemented: s.implemented !== false, read: catalog.isRead(s.name), scope: s.scope || null, risk: s.risk || null, ...(s.retired ? { retired: true } : {}),
    }))
  }

  /** Verify a credential (session open): the principal it resolves to, or a typed refusal. Audited when refused. */
  async function whoami(credential) {
    const base = { correlation_id: crypto.randomUUID(), action: null, capability: null, tier: null, agent_id: null, transport: 'session' }
    try {
      const { principal } = await authenticate(credential, base)
      return { ok: true, agent_id: principal.agent_id, tier_ceiling: TIER_LABEL[principal.tier_ceiling], read_scopes: principal.read_scopes || [], capabilities: (principal.grants || []).map((g) => ({ capability: g.capability, max_tier: TIER_LABEL[g.max_tier], expires_at: g.expires_at })) }
    } catch (e) {
      const g = e instanceof ActionGatewayError ? e : classifyGatewayError(e)
      await audit({ ...base, event_type: 'session_refused', code: g.code, detail: { class: g.errorClass } })
      return { ok: false, error: g.toJSON() }
    }
  }

  return Object.freeze({ call, whoami, recover, recoverOne, listTools, get auditFailures() { return auditFailures } })
}

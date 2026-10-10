// Shared tool registry + server-side authorization path + executor
// (architecture §3.3). The model never decides tier, approval or eligibility:
// this code does, on every call.
//
// validate(input_schema) → resolve tier (bulk escalation only upward)
// → mode ceiling (AGENT_MAX_MODE ∧ system_control.agent_mode)
// → capability enabled for the phase
// → T2/T3: verified named-user identity (O5; stub refuses → IDENTITY_REQUIRED)
// → T2: intent binding + bulk caps; fail → approval request
// → T3: approval token (consumed atomically against the recomputed hash)
// → idempotency claim → execute via the wrapped service (timeout)
// → project output (row cap + disclosure deny-list) → tag untrusted → event
import { ROLE_RANK } from '../contracts/approval.js'
import { modeAllowsTier } from '../config/agent-config.js'
import { appendEventTx } from '../runtime/event-log.js'
import { AgentError } from '../runtime/store.js'
import { hashCanonical, newId } from '../runtime/canonical.js'
import { assertToolCallTransition } from '../runtime/run-service.js'
import { checkIntentBinding, wrapToolResult } from '../security/provenance.js'
import { isConsequentialIdentity } from '../security/identity.js'
import { defineTool } from './define-tool.js'
import { validateSchema } from './schema.js'

// ── review-only (AGENT_READ_ONLY, Gate B) ───────────────────────────────────
// A read-only registry accepts ONLY small T0 reads. Enforced here, at
// registration AND at authorization, not in the UI:
//   * tier T0, side_effect 'read', approval 'none'
//   * cost_class free | db_light (no db_heavy, model or paid_external)
//   * small-read rules: rows_to_model ≤ 50, max_rows ≤ 200, timeout ≤ 30 s
//   * no name whose verb segment sends, offers, launches, enqueues, publishes,
//     activates or writes (defense in depth on top of the T4 nets)
//   * no `touches` (written domains) at all
export const READ_ONLY_SMALL_READ = Object.freeze({ rows_to_model: 50, max_rows: 200, timeout_ms: 30_000 })
export const READ_ONLY_COST_CLASSES = Object.freeze(['free', 'db_light'])
export const READ_ONLY_FORBIDDEN_VERB = /(^|[._])(send|sends|submit|offer|offers|quote|launch|enqueue|queue_more|publish|activate|arm|approve|create|insert|update|upsert|delete|write|set|apply|archive|unarchive|suppress|assign|move|mark|schedule|retry|reprocess)($|[._])/i

/** @returns {string|null} refusal reason, or null when the spec is a small T0 read */
export function readOnlyViolation(def) {
  if (!def) return 'missing'
  if (def.tier !== 'T0' || def.side_effect !== 'read') return `tier ${def.tier} (${def.side_effect}) is not a read`
  if (def.approval && def.approval !== 'none') return `approval ${def.approval}`
  if (!READ_ONLY_COST_CLASSES.includes(def.cost_class)) return `cost_class ${def.cost_class}`
  const lim = def.limits || {}
  if (!(lim.rows_to_model <= READ_ONLY_SMALL_READ.rows_to_model)) return `rows_to_model ${lim.rows_to_model} > ${READ_ONLY_SMALL_READ.rows_to_model}`
  if (!(lim.max_rows <= READ_ONLY_SMALL_READ.max_rows)) return `max_rows ${lim.max_rows} > ${READ_ONLY_SMALL_READ.max_rows}`
  if (!(lim.timeout_ms <= READ_ONLY_SMALL_READ.timeout_ms)) return `timeout_ms ${lim.timeout_ms} > ${READ_ONLY_SMALL_READ.timeout_ms}`
  if ((def.touches || []).length) return 'declares written domains'
  if (READ_ONLY_FORBIDDEN_VERB.test(String(def.name || ''))) return 'name is a send/offer/campaign/write verb'
  return null
}

/**
 * @param {{ readOnly?: boolean }} [opts] readOnly: only small T0 reads can be
 *   registered or authorized (AGENT_READ_ONLY). Immutable after creation.
 */
export function createToolRegistry({ readOnly = false } = {}) {
  const tools = new Map()
  let sealed = false
  const ro = readOnly === true
  return {
    register(spec) {
      if (sealed) throw new AgentError('REGISTRY_SEALED', 'tools cannot be registered after boot')
      const def = defineTool(spec)
      if (ro) {
        const why = readOnlyViolation(def)
        if (why) throw new AgentError('READ_ONLY_REGISTRY', `${def.name}: refused by the read-only registry (${why})`)
      }
      if (tools.has(def.name)) throw new AgentError('TOOL_DUPLICATE', def.name)
      tools.set(def.name, def)
      return def
    },
    get readOnly() {
      return ro
    },
    get: (name) => tools.get(name) || null,
    has: (name) => tools.has(name),
    list: () => [...tools.values()],
    seal() {
      sealed = true
      return this
    },
    get sealed() {
      return sealed
    },
  }
}

function targetRefsFor(spec, input) {
  if (typeof spec.target_refs === 'function') return spec.target_refs(input) || []
  return []
}

/**
 * Pure authorization decision (no side effects).
 * @returns {{ decision: 'allow'|'refuse'|'approval_required', code: string|null, tier: string, intent_basis: string, untrusted_span_overlap: boolean, target_refs: string[] }}
 */
export function authorizeToolCall({ registry, tool, input = {}, ctx = {} }) {
  const spec = registry.get(tool)
  const base = { tier: spec?.tier || null, intent_basis: 'none', untrusted_span_overlap: false, target_refs: [] }
  if (!spec) return { ...base, decision: 'refuse', code: 'TOOL_NOT_REGISTERED' }
  const errors = validateSchema(spec.input_schema, input)
  if (errors.length) return { ...base, decision: 'refuse', code: 'INPUT_INVALID', errors }
  const target_refs = targetRefsFor(spec, input)
  let tier = spec.tier
  if (tier === 'T2' && target_refs.length > spec.bulk_n) tier = 'T3' // bulk rule: crossing N escalates
  if (tier === 'T2' && ctx.counters) {
    const fam = ctx.counters[spec.intent_family] || { run: 0, day: 0 }
    if (fam.run + target_refs.length > (ctx.cumulative?.per_run ?? 100) || fam.day + target_refs.length > (ctx.cumulative?.per_day ?? 500)) tier = 'T3'
  }
  const out = { ...base, tier, target_refs }
  // review-only: the registry (or the request) is read-only → nothing but a small T0 read is authorized
  if ((registry.readOnly === true || ctx.read_only === true) && readOnlyViolation({ ...spec, tier })) return { ...out, decision: 'refuse', code: 'AGENT_READ_ONLY' }
  if (!modeAllowsTier(ctx.mode || 'off', tier)) return { ...out, decision: 'refuse', code: 'AGENT_MODE_CEILING' }
  const enabled = ctx.enabled_capabilities
  if (!enabled || !(enabled instanceof Set ? enabled.has(spec.capability) : enabled.includes(spec.capability))) {
    return { ...out, decision: 'refuse', code: 'CAPABILITY_DISABLED' }
  }
  const role = ctx.role || 'operator'
  if (ROLE_RANK[role] < ROLE_RANK[spec.permission.min_role]) return { ...out, decision: 'refuse', code: 'ROLE_NOT_ALLOWED' }
  if ((tier === 'T1' || tier === 'T0') && !ctx.session_user_id) return { ...out, decision: 'refuse', code: 'SESSION_REQUIRED' }
  if (tier === 'T2' || tier === 'T3') {
    if (!isConsequentialIdentity(ctx.identity)) return { ...out, decision: 'refuse', code: 'IDENTITY_REQUIRED' }
  }
  if (tier === 'T2') {
    const b = checkIntentBinding({ spec, input, target_refs, turn: ctx.turn })
    if (!b.bound) return { ...out, decision: 'approval_required', code: b.reason, untrusted_span_overlap: b.untrusted_span_overlap }
    return { ...out, decision: 'allow', code: null, intent_basis: b.basis }
  }
  if (tier === 'T3') {
    if (!ctx.approval_token) return { ...out, decision: 'approval_required', code: 'APPROVAL_TOKEN_REQUIRED' }
    return { ...out, decision: 'allow', code: null, intent_basis: 'approval' }
  }
  return { ...out, decision: 'allow', code: null, intent_basis: ctx.turn ? 'turn' : 'none' }
}

function neverMatches(key, never) {
  const k = String(key).toLowerCase()
  const tokens = k.split(/[^a-z0-9]+/)
  return never.some((n) => k === n || tokens.includes(n) || k.startsWith(`${n}_`) || k.endsWith(`_${n}`))
}

function stripNever(value, never, depth = 0) {
  if (depth > 6 || value == null) return value
  if (Array.isArray(value)) return value.map((v) => stripNever(v, never, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (neverMatches(k, never)) continue
      out[k] = stripNever(v, never, depth + 1)
    }
    return out
  }
  return value
}

/** Project output for the model: deny-list + row cap. */
export function projectOutput(spec, result) {
  let r = stripNever(result, spec.disclosure.never.map((x) => x.toLowerCase()))
  let truncated = false
  const cap = spec.limits.rows_to_model
  if (Array.isArray(r)) {
    truncated = r.length > cap
    r = r.slice(0, cap)
  } else if (r && Array.isArray(r.rows)) {
    truncated = r.rows.length > cap
    r = { ...r, rows: r.rows.slice(0, cap) }
  }
  return { projected: r, truncated }
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AgentError('TOOL_TIMEOUT', `timed out after ${ms} ms`)), ms)
    if (typeof t.unref === 'function') t.unref()
    if (signal) signal.addEventListener?.('abort', () => { clearTimeout(t); reject(new AgentError('RUN_CANCELLED', 'run cancelled')) }, { once: true })
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/**
 * Execute one tool call end-to-end with persistence + events.
 * `approvals` is used by the executor only; it is never exposed to tools.
 */
export function createToolExecutor({ registry, store, approvals = null, services = null, now = () => new Date() }) {
  const evOpts = { now }

  async function execute({ run_id, turn_id = null, tool, input = {}, ctx = {} }) {
    const spec = registry.get(tool)
    const tool_call_id = ctx.tool_call_id || newId('tc')
    const auth = authorizeToolCall({ registry, tool, input, ctx })
    const input_hash = hashCanonical(input)

    // 1) proposed (+ refused) in one transaction
    const proposed = await store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if (run.cancel_requested_at) return { cancelled: true }
      let call = tx.toolCalls.get(tool_call_id)
      if (!call) {
        call = {
          id: tool_call_id, run_id, turn_id, tool, tool_version: spec?.version ?? 0, tier: auth.tier, input, input_hash,
          idempotency_key: null, intent_basis: auth.intent_basis, untrusted_span_overlap: auth.untrusted_span_overlap,
          state: 'proposed', target_refs: auth.target_refs, refusal_code: null, error_code: null, created_at: now().toISOString(),
        }
        tx.toolCalls.set(tool_call_id, call)
        run.tool_call_count = (run.tool_call_count || 0) + 1
        appendEventTx(tx, { run_id, tool_call_id, type: 'tool.proposed', payload: { tool, tool_version: call.tool_version, tier: auth.tier, target_refs: auth.target_refs, intent_basis: auth.intent_basis } }, evOpts)
      }
      if (auth.decision === 'refuse') {
        assertToolCallTransition(call.state, 'refused')
        call.state = 'refused'
        call.refusal_code = auth.code
        appendEventTx(tx, { run_id, tool_call_id, type: 'tool.refused', payload: { tool, refusal_code: auth.code, message: null } }, evOpts)
      }
      return { call: { ...call } }
    })
    if (proposed.cancelled) return { status: 'cancelled', tool_call_id }
    if (auth.decision === 'refuse') return { status: 'refused', code: auth.code, tool_call_id }

    // 2) approval required → request a card (T3, or T2 that lost intent binding)
    if (auth.decision === 'approval_required') {
      if (!approvals) return { status: 'approval_required', code: auth.code, tool_call_id, approval: null }
      const approval = await approvals.requestApproval({
        run_id, tool_call_id, spec, input, tier: auth.tier,
        preconditions: spec.preconditions ? await spec.preconditions(input, ctx) : {},
        resolved_targets: auth.target_refs,
        provenance: auth.untrusted_span_overlap ? { basis: 'untrusted_content', label: 'Proposed from message or document content' } : { basis: ctx.turn ? 'turn' : 'plan', label: 'Proposed from your request' },
        requested_by: ctx.session_user_id || null,
      })
      return { status: 'approval_required', code: auth.code, tool_call_id, approval }
    }

    // 3) T3 with token: consume atomically against the recomputed hash + preconditions
    if (auth.tier === 'T3') {
      if (!approvals) return { status: 'refused', code: 'APPROVAL_SERVICE_UNAVAILABLE', tool_call_id }
      const consumed = await approvals.consume({
        token: ctx.approval_token,
        tool_call_id,
        tool, tool_version: spec.version, input,
        resolved_targets: auth.target_refs,
        preconditions: spec.preconditions ? await spec.preconditions(input, ctx) : {},
      })
      if (!consumed.ok) {
        await store.transaction((tx) => {
          const call = tx.toolCalls.get(tool_call_id)
          if (call && call.state === 'proposed') {
            call.state = 'refused'
            call.refusal_code = consumed.code
            appendEventTx(tx, { run_id, tool_call_id, type: 'tool.refused', payload: { tool, refusal_code: consumed.code, message: null } }, evOpts)
          }
        })
        return { status: 'refused', code: consumed.code, tool_call_id }
      }
    }

    // 4) idempotency claim + authorized → executing + tool.started
    const idem = spec.tier !== 'T0' ? `agent.tool:${spec.idempotency(input, { run_id, ...ctx })}` : null
    const started = await store.transaction((tx) => {
      if (idem && tx.idempotency.has(idem)) return { duplicate: tx.idempotency.get(idem) }
      const call = tx.toolCalls.get(tool_call_id)
      if (call.state === 'proposed') {
        assertToolCallTransition(call.state, 'authorized')
        call.state = 'authorized'
      }
      assertToolCallTransition(call.state, 'executing')
      call.state = 'executing'
      call.idempotency_key = idem
      if (idem) tx.idempotency.set(idem, { tool_call_id, state: 'executing' })
      appendEventTx(tx, {
        run_id, tool_call_id, type: 'tool.started',
        payload: { tool, tool_version: spec.version, tier: auth.tier, operation: 'tool.invoke', target_refs: auth.target_refs },
        label_vars: { tool_label: spec.label },
      }, evOpts)
      return { duplicate: null }
    })
    if (started.duplicate) return { status: 'duplicate', tool_call_id: started.duplicate.tool_call_id }

    // 5) execute through the wrapped service. Tools get attribution + signal + services only.
    const toolCtx = Object.freeze({
      run_id,
      tool_call_id,
      operator: Object.freeze({ user_id: ctx.session_user_id || null, verified: Boolean(ctx.identity?.verified) }),
      signal: ctx.signal || null,
      services,
    })
    const t0 = Date.now()
    let result
    let error = null
    const attempts = spec.failure.retry === 'read_retry_once' ? 2 : 1
    for (let i = 0; i < attempts; i += 1) {
      try {
        result = await withTimeout(Promise.resolve().then(() => spec.execute(input, toolCtx)), spec.limits.timeout_ms, ctx.signal)
        error = null
        break
      } catch (e) {
        error = e
        if (e?.refusal || e?.code === 'RUN_CANCELLED') break
      }
    }
    const duration_ms = Date.now() - t0

    return store.transaction((tx) => {
      const call = tx.toolCalls.get(tool_call_id)
      if (error) {
        if (error.refusal) {
          call.state = 'refused'
          call.refusal_code = error.code || 'DOMAIN_REFUSAL'
          appendEventTx(tx, { run_id, tool_call_id, type: 'tool.refused', payload: { tool, refusal_code: call.refusal_code, message: error.message || null } }, evOpts)
          return { status: 'refused', code: call.refusal_code, tool_call_id }
        }
        if (error.code === 'TOOL_TIMEOUT' && spec.tier !== 'T0') {
          call.state = 'outcome_unknown'
          appendEventTx(tx, { run_id, tool_call_id, type: 'tool.outcome_unknown', payload: { tool, readback_scheduled: true } }, evOpts)
          return { status: 'outcome_unknown', tool_call_id }
        }
        call.state = 'failed'
        call.error_code = error.code || 'TOOL_ERROR'
        if (idem) tx.idempotency.delete(idem)
        appendEventTx(tx, { run_id, tool_call_id, type: 'tool.failed', payload: { tool, error_code: call.error_code, retryable: error.code === 'TOOL_TIMEOUT' } }, evOpts)
        return { status: 'failed', code: call.error_code, tool_call_id }
      }
      const { projected, truncated } = projectOutput(spec, result)
      const wrapped = wrapToolResult({ tool, result: projected, turn: ctx.turn || null })
      call.state = 'succeeded'
      call.duration_ms = duration_ms
      call.rows_returned = Array.isArray(projected) ? projected.length : Array.isArray(projected?.rows) ? projected.rows.length : null
      if (idem) tx.idempotency.set(idem, { tool_call_id, state: 'succeeded' })
      appendEventTx(tx, { run_id, tool_call_id, type: 'tool.completed', payload: { tool, rows: call.rows_returned, duration_ms, cost_usd: 0, result_summary: null, incomplete: truncated } }, evOpts)
      if (spec.tier !== 'T0') {
        tx.counters.audit_id += 1
        tx.audit.push({
          id: tx.counters.audit_id, run_id, tool_call_id, operator_id: ctx.session_user_id || null, actor: `agent:${run_id}`,
          tool, tier: spec.tier, input_hash, approval_id: null, plan_hash: ctx.turn?.approved_plan?.plan_hash || null,
          target_refs: auth.target_refs, result: 'succeeded', summary: spec.audit(input, projected, toolCtx), at: now().toISOString(),
        })
      }
      return { status: 'succeeded', tool_call_id, result: wrapped, truncated }
    })
  }

  return { execute }
}

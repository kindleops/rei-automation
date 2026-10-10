// Tool spec definition + validation (architecture §3.1). Every tool declares
// its full permission contract; an incomplete spec is refused. T4 tools are
// refused here, so they can never be registered.
//
// Required for every tool:
//   name, version, capability (1..12), label (user-facing, rendered into
//   tool.started via the 'tool.invoke' operation), description,
//   input_schema (closed, bounded), output_schema, side_effect (→ tier),
//   permission { min_role, apps }, cost_class, limits, disclosure, wraps
//   (an existing service — never SQL, never a route proxy), execute, audit,
//   failure { retry, surface }
// Additionally:
//   T1+  idempotency(input, ctx) → key
//   T2   undo { kind:'inverse', build, window_h }, readback, intent_family,
//        action_fields, risk_assessment { consumers, undo_restores_all,
//        approved_by, approved_at } — no approved assessment ⇒ not T2 (O5)
//   T3   approval_class ('default'|'sms'|'campaign_launch'), effects(input),
//        preconditions(input, ctx), readback
//   T2/T3  touches: [domains written] (checked against the T4 domain list)
import { ROLES, APPROVAL_TTL_MS } from '../contracts/approval.js'
import { SIDE_EFFECT_CLASSES, SIDE_EFFECT_TIER } from '../contracts/states.js'
import { AgentError } from '../runtime/store.js'
import { classifyProhibited } from './prohibited.js'
import { schemaBoundednessErrors } from './schema.js'

export const COST_CLASSES = Object.freeze(['free', 'db_light', 'db_heavy', 'model', 'paid_external'])
export const FAILURE_RETRY = Object.freeze(['none', 'read_retry_once'])
export const FAILURE_SURFACE = Object.freeze(['tool_error', 'needs_input'])
export const APPROVAL_LEVELS = Object.freeze(['none', 'intent_bound', 'token'])
const APPROVAL_FOR_TIER = Object.freeze({ T0: 'none', T1: 'none', T2: 'intent_bound', T3: 'token' })
const APPROVAL_RANK = Object.freeze({ none: 0, intent_bound: 1, token: 2 })
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

function fail(name, msg) {
  throw new AgentError('TOOL_SPEC_INVALID', `${name || '<unnamed>'}: ${msg}`)
}

/**
 * Validate and freeze a tool spec. Throws TOOL_PROHIBITED for T4 and
 * TOOL_SPEC_INVALID for incomplete contracts.
 */
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object') throw new AgentError('TOOL_SPEC_INVALID', 'spec required')
  const n = spec.name
  const prohibited = classifyProhibited(spec)
  if (prohibited.prohibited) {
    throw new AgentError('TOOL_PROHIBITED', `${n}: T4 prohibited (${prohibited.rule}) — ${prohibited.reason}`, prohibited)
  }
  if (!NAME_RE.test(String(n || ''))) fail(n, 'name must be dotted <capability>.<verb>')
  if (!Number.isInteger(spec.version) || spec.version < 1) fail(n, 'version must be a positive integer')
  if (!Number.isInteger(spec.capability) || spec.capability < 1 || spec.capability > 12) fail(n, 'capability must be 1..12')
  if (typeof spec.label !== 'string' || !spec.label.trim() || spec.label.length > 120) fail(n, 'label (user-facing operation label) required, ≤ 120 chars')
  if (typeof spec.description !== 'string' || !spec.description.trim()) fail(n, 'description required')
  if (!SIDE_EFFECT_CLASSES.includes(spec.side_effect)) fail(n, `side_effect must be one of ${SIDE_EFFECT_CLASSES.join('|')}`)
  const tier = SIDE_EFFECT_TIER[spec.side_effect]
  if (spec.tier && spec.tier !== tier) fail(n, `tier is derived from side_effect (${tier}); declared ${spec.tier}`)

  const boundErr = schemaBoundednessErrors(spec.input_schema)
  if (spec.input_schema?.type !== 'object') fail(n, 'input_schema must be an object schema')
  if (boundErr.length) fail(n, `input_schema not bounded: ${boundErr.join('; ')}`)
  if (!spec.output_schema || typeof spec.output_schema !== 'object') fail(n, 'output_schema required')

  if (!spec.permission || !ROLES.includes(spec.permission.min_role) || !Array.isArray(spec.permission.apps) || !spec.permission.apps.length) {
    fail(n, 'permission { min_role, apps[] } required')
  }
  const derivedApproval = APPROVAL_FOR_TIER[tier]
  const approval = spec.approval ?? derivedApproval
  if (!APPROVAL_LEVELS.includes(approval)) fail(n, 'approval invalid')
  if (APPROVAL_RANK[approval] < APPROVAL_RANK[derivedApproval]) {
    throw new AgentError('TOOL_APPROVAL_DOWNGRADE', `${n}: approval cannot be lowered below ${derivedApproval} for ${tier}`)
  }
  if (!COST_CLASSES.includes(spec.cost_class)) fail(n, `cost_class must be one of ${COST_CLASSES.join('|')}`)
  const lim = spec.limits || {}
  for (const k of ['rows_to_model', 'max_rows', 'timeout_ms', 'per_run']) {
    if (!Number.isInteger(lim[k]) || lim[k] <= 0) fail(n, `limits.${k} must be a positive integer`)
  }
  if (lim.timeout_ms > 30_000 && spec.side_effect === 'read') fail(n, 'read tools run under a 30 s statement timeout')
  if (!spec.disclosure || !Array.isArray(spec.disclosure.to_model) || !Array.isArray(spec.disclosure.never)) fail(n, 'disclosure { to_model[], never[] } required')
  for (const f of ['phone', 'email']) if (!spec.disclosure.never.includes(f)) fail(n, `disclosure.never must include "${f}"`)
  if (!spec.wraps || (!spec.wraps.service && !spec.wraps.module)) fail(n, 'wraps { module, export | service } (an existing service) required')
  if (spec.wraps.module && !spec.wraps.export) fail(n, 'wraps.export required with wraps.module')
  if (typeof spec.execute !== 'function') fail(n, 'execute(input, ctx) required')
  if (typeof spec.audit !== 'function') fail(n, 'audit(input, result, ctx) required')
  if (!spec.failure || !FAILURE_RETRY.includes(spec.failure.retry) || !FAILURE_SURFACE.includes(spec.failure.surface)) fail(n, 'failure { retry, surface } required')
  if (spec.side_effect !== 'read' && spec.failure.retry !== 'none') fail(n, 'only read tools may retry')

  if (tier !== 'T0' && typeof spec.idempotency !== 'function') fail(n, 'idempotency(input, ctx) required for T1+')
  if (tier === 'T2' || tier === 'T3') {
    if (!Array.isArray(spec.touches) || !spec.touches.length) fail(n, 'touches[] (written domains) required for T2/T3')
    if (typeof spec.readback !== 'function') fail(n, 'readback(input, ctx) required for T2/T3')
  }
  if (tier === 'T2') {
    if (!spec.undo || spec.undo.kind !== 'inverse' || typeof spec.undo.build !== 'function' || !(spec.undo.window_h > 0)) fail(n, 'T2 requires undo { kind:"inverse", build, window_h }')
    const ra = spec.risk_assessment
    if (!ra || !Array.isArray(ra.consumers) || !ra.consumers.length || typeof ra.undo_restores_all !== 'boolean' || !ra.approved_by || !ra.approved_at) {
      throw new AgentError('TOOL_RISK_ASSESSMENT_REQUIRED', `${n}: T2 requires an owner-approved risk_assessment (O5); without one it must be T3 or unregistered`)
    }
    if (!spec.intent_family) fail(n, 'T2 requires intent_family')
    if (!Array.isArray(spec.action_fields)) fail(n, 'T2 requires action_fields[] (fields checked for untrusted spans)')
  }
  if (tier === 'T3') {
    if (!Object.prototype.hasOwnProperty.call(APPROVAL_TTL_MS, spec.approval_class || '')) fail(n, 'T3 requires approval_class (default|sms|campaign_launch)')
    if (typeof spec.effects !== 'function') fail(n, 'T3 requires effects(input) → ApprovalEffect[]')
    if (typeof spec.preconditions !== 'function') fail(n, 'T3 requires preconditions(input, ctx)')
  }

  return Object.freeze({
    ...spec,
    tier,
    approval,
    output_trust: spec.output_trust || 'untrusted',
    bulk_n: spec.bulk_n ?? 25,
    owner_only: Boolean(spec.owner_only),
    fresh_auth: Boolean(spec.fresh_auth),
    action_fields: Object.freeze([...(spec.action_fields || [])]),
    touches: Object.freeze([...(spec.touches || [])]),
  })
}

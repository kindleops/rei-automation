// Intelligence Command 2.0 (increment B) — capability contracts.
//
// A CAPABILITY is a typed, versioned, server-side action the agent (or an
// operator) may invoke. It wraps an EXISTING domain service — never SQL, never
// a table mutation, never a second copy of business rules. Every capability
// declares its full contract here and is validated + frozen at registration.
//
// Tier is a property of the SPEC, decided by code review. Nothing a caller
// sends (a model tool input, a prompt, a delegated agent, a header) can raise
// it: inputs are closed schemas, so a model-supplied `tier`, `approved`,
// `approval_id` … is an INPUT_INVALID refusal before anything runs.
//
// side_effect → allowed autonomy tiers (checked at registration):
//   read              autonomous_internal
//   internal_write    autonomous_internal | within_approved_policy | requires_explicit_approval
//   outbound_prepare  requires_explicit_approval            (only ever prepares a pending approval)
// `never` capabilities cannot be registered at all (unreachable, not merely refused).
import { classifyProhibited } from '../tools/prohibited.js'
import { schemaBoundednessErrors } from '../tools/schema.js'
import { AgentError } from '../runtime/store.js'

export const CAPABILITY_DOMAINS = Object.freeze(['entity_graph', 'campaigns', 'inbox', 'pipeline', 'platform_ops', 'missions'])
export const SIDE_EFFECTS = Object.freeze(['read', 'internal_write', 'outbound_prepare'])
export const AUTONOMY_TIERS = Object.freeze(['autonomous_internal', 'within_approved_policy', 'requires_explicit_approval', 'never'])
export const TIER_RANK = Object.freeze({ autonomous_internal: 0, within_approved_policy: 1, requires_explicit_approval: 2, never: 3 })
export const ALLOWED_TIERS = Object.freeze({
  read: Object.freeze(['autonomous_internal']),
  internal_write: Object.freeze(['autonomous_internal', 'within_approved_policy', 'requires_explicit_approval']),
  outbound_prepare: Object.freeze(['requires_explicit_approval']),
})
export const COST_CLASSES = Object.freeze(['free', 'db_light', 'db_heavy'])
export const ROLES = Object.freeze(['operator', 'owner'])
export const APPROVAL_TTL_MS = Object.freeze({ default: 30 * 60 * 1000, sms: 15 * 60 * 1000, campaign_launch: 60 * 60 * 1000, pipeline: 60 * 60 * 1000 })

/**
 * Outbound actions the agent may NEVER perform itself. A capability whose id
 * matches is unregistrable unless it is an outbound_prepare / approval-tier
 * capability whose id says "prepare_" (it only creates a pending approval).
 */
export const OUTBOUND_VERBS = /(^|[._])(send|launch|activate|offer|export|unsuppress|override_stop|override_suppression|resume_campaign|enqueue|dispatch)($|[._])/i

const ID_RE = /^[a-z][a-z_]*\.[a-z][a-z0-9_]*$/

function fail(id, msg) {
  throw new AgentError('CAPABILITY_SPEC_INVALID', `${id || '<unnamed>'}: ${msg}`)
}

/**
 * Validate + freeze a capability spec.
 * Required: id, version, domain, title, description, input_schema (closed, bounded),
 * output_schema, side_effect, tier, min_role, cost_class, limits {per_min, per_day,
 * timeout_ms, rows_to_model}, idempotency(input, ctx) (non-read), audit(input, result),
 * execute(input, ctx) (autonomous) OR prepare(input, ctx) + snapshot(target, ctx) +
 * executeApproved(intent, ctx) (approval tiers), compensation { kind, note } (writes).
 */
export function defineCapability(spec) {
  if (!spec || typeof spec !== 'object') throw new AgentError('CAPABILITY_SPEC_INVALID', 'spec required')
  const id = spec.id
  if (!ID_RE.test(String(id || ''))) fail(id, 'id must be <domain>.<verb>')
  if (spec.tier === 'never') throw new AgentError('CAPABILITY_NEVER_TIER', `${id}: never-tier capabilities are not registrable`)
  const prohibited = classifyProhibited({ name: id, touches: spec.touches || [], wraps: spec.wraps || {}, input_schema: spec.input_schema, side_effect: spec.side_effect })
  if (prohibited.prohibited) throw new AgentError('CAPABILITY_PROHIBITED', `${id}: ${prohibited.reason}`)
  if (!Number.isInteger(spec.version) || spec.version < 1) fail(id, 'version must be a positive integer')
  if (!CAPABILITY_DOMAINS.includes(spec.domain)) fail(id, `domain must be one of ${CAPABILITY_DOMAINS.join('|')}`)
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 120) fail(id, 'title required (≤ 120)')
  if (typeof spec.description !== 'string' || !spec.description.trim()) fail(id, 'description required')
  if (!SIDE_EFFECTS.includes(spec.side_effect)) fail(id, `side_effect must be one of ${SIDE_EFFECTS.join('|')}`)
  if (!AUTONOMY_TIERS.includes(spec.tier)) fail(id, `tier must be one of ${AUTONOMY_TIERS.join('|')}`)
  if (!ALLOWED_TIERS[spec.side_effect].includes(spec.tier)) fail(id, `tier ${spec.tier} is not allowed for side_effect ${spec.side_effect}`)
  if (OUTBOUND_VERBS.test(id) && !(spec.tier === 'requires_explicit_approval' && /\.prepare_/.test(id))) {
    throw new AgentError('CAPABILITY_OUTBOUND_DIRECT', `${id}: outbound actions exist only as prepare_* approval requests`)
  }
  if (spec.input_schema?.type !== 'object') fail(id, 'input_schema must be an object schema')
  const bound = schemaBoundednessErrors(spec.input_schema)
  if (bound.length) fail(id, `input_schema not bounded: ${bound.join('; ')}`)
  if (!spec.output_schema || typeof spec.output_schema !== 'object') fail(id, 'output_schema required')
  if (!ROLES.includes(spec.min_role || 'operator')) fail(id, 'min_role invalid')
  if (!COST_CLASSES.includes(spec.cost_class)) fail(id, `cost_class must be one of ${COST_CLASSES.join('|')}`)
  const lim = spec.limits || {}
  for (const k of ['per_min', 'per_day', 'timeout_ms', 'rows_to_model']) if (!Number.isInteger(lim[k]) || lim[k] <= 0) fail(id, `limits.${k} must be a positive integer`)
  if (lim.timeout_ms > 60_000) fail(id, 'timeout_ms ≤ 60 s')
  if (typeof spec.audit !== 'function') fail(id, 'audit(input, result) required')
  if (!spec.wraps || typeof spec.wraps.service !== 'string' || !spec.wraps.service.trim()) fail(id, 'wraps.service (the existing service it calls) required')
  if (spec.side_effect !== 'read') {
    if (typeof spec.idempotency !== 'function') fail(id, 'idempotency(input, ctx) required for writes')
    if (!spec.compensation || typeof spec.compensation.kind !== 'string') fail(id, 'compensation { kind, note } required for writes (kind "none" must say why)')
  }
  const approvalTier = spec.tier === 'requires_explicit_approval' || spec.tier === 'within_approved_policy'
  if (approvalTier) {
    for (const f of ['prepare', 'snapshot', 'executeApproved']) if (typeof spec[f] !== 'function') fail(id, `${f}() required for ${spec.tier}`)
    if (!Object.prototype.hasOwnProperty.call(APPROVAL_TTL_MS, spec.approval_class || '')) fail(id, `approval_class must be one of ${Object.keys(APPROVAL_TTL_MS).join('|')}`)
  }
  if (spec.tier === 'autonomous_internal' && typeof spec.execute !== 'function') fail(id, 'execute(input, ctx) required')
  if (spec.tier === 'within_approved_policy' && typeof spec.policy !== 'function') fail(id, 'policy(input, ctx) required for within_approved_policy')
  return Object.freeze({
    ...spec,
    min_role: spec.min_role || 'operator',
    output_trust: spec.output_trust || 'system',
    limits: Object.freeze({ ...lim }),
    touches: Object.freeze([...(spec.touches || [])]),
  })
}

/** A tier can only move UP (more restrictive). */
export function maxTier(a, b) {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

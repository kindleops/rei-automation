// Approvals for gateway intents — the EXISTING operator approval path, not a second one.
//
// An agent can never claim approval. When an action's policy needs a human, the gateway files ONE
// agent.approval_request (capability agent_actions.authorize_action v1) bound to the intent: target =
// { intent_id }, intended_change = { intent_id, action, agent_id, capability, tier, resource, params_hash,
// grant_expires_at }, snapshot hash, payload hash (capabilities/approvals.js rules, reused). A HUMAN decides
// it through POST /api/cockpit/agent/actions/approvals/:id/decide (agent/actions/routes.js → approvals.decide:
// verified named operator, org member, echoes the payload hash, drift check, single claim). The decide path
// runs agentActionApprovalCapability.executeApproved, which only re-verifies the intent and records the
// grant; it executes nothing. The gateway then consumes the record ONCE (action_authorizations.approval_id
// is unique, and the authorization trigger re-verifies every binding).
import { canonicalJson, hashCanonical, newId } from '../../agent/runtime/canonical.js'
import { approvalPayloadHash, snapshotHash } from '../../agent/capabilities/approvals.js'
import { APPROVAL_TTL_MS } from '../../agent/capabilities/contracts.js'
import { encodePropertyRef } from '../../agent/missions/mission-codec.js'
import { UUID, obj } from '../../agent/capabilities/defs/_schema.js'
import { APPROVAL_CAPABILITY_ID, APPROVAL_CAPABILITY_VERSION, APPROVAL_GRANT_TTL_MS, TIER_LABEL } from './constants.js'

const OPEN = new Set(['received', 'awaiting_approval'])

/** What the approval binds (the decide path re-reads it; a change is drift). State-independent while open. */
export function approvalSnapshotOf(intent) {
  return { intent_id: intent?.intent_id || null, agent_id: intent?.agent_id || null, action: intent?.action || null, params_hash: intent?.params_hash || null, open: OPEN.has(intent?.state) }
}

const resourceRef = (intent) => (intent.resource_type === 'property' ? encodePropertyRef(String(intent.resource_id)) : String(intent.resource_id))

/** The agent.approval_request row for one intent (same field rules as capabilities/approvals.js#request). */
export function buildApprovalRequest({ intent, principal, summary = [], now = Date.now(), decideTtlMs = APPROVAL_TTL_MS.default, grantTtlMs = APPROVAL_GRANT_TTL_MS }) {
  const snap = snapshotHash(approvalSnapshotOf(intent))
  const target = JSON.parse(canonicalJson({ intent_id: intent.intent_id }))
  const intended_change = JSON.parse(canonicalJson({
    intent_id: intent.intent_id, action: intent.action, agent_id: intent.agent_id, capability: intent.capability, tier: TIER_LABEL[intent.tier],
    // resource_id (an id-named key): agent.payload_is_clean exempts a UUID from its phone-run check ONLY under
    // id keys, and a random UUID can contain a phone-shaped digit run (e.g. …a895-58797158f778)
    resource_type: intent.resource_type, resource_id: resourceRef(intent), params_hash: intent.params_hash,
    grant_expires_at: new Date(now + grantTtlMs).toISOString(),
  }))
  const org_id = principal.org_id
  return {
    approval_id: newId('apr'),
    org_id,
    capability_id: APPROVAL_CAPABILITY_ID,
    capability_version: APPROVAL_CAPABILITY_VERSION,
    tier: 'requires_explicit_approval',
    requested_by: principal.sponsor_user_id,
    provenance: 'model',
    target,
    intended_change,
    summary: summary.slice(0, 12).map((s) => String(s).slice(0, 240)),
    snapshot_hash: snap,
    payload_hash: approvalPayloadHash({ capability_id: APPROVAL_CAPABILITY_ID, capability_version: APPROVAL_CAPABILITY_VERSION, org_id, target, intended_change, snapshot_hash: snap }),
    idempotency_key: hashCanonical({ k: hashCanonical({ gateway_intent: intent.intent_id }), s: snap }),
    expires_at: new Date(now + decideTtlMs).toISOString(),
    created_at: new Date(now).toISOString(),
  }
}

/**
 * Is this approval record a HUMAN approval of exactly this intent, still usable? (The authorization trigger
 * re-checks all of it in the database; this is the gateway's own, earlier answer.)
 * @returns {{ usable: boolean, pending?: boolean, code?: string, approved_by?: string }}
 */
export function judgeApproval(a, intent, { now = Date.now() } = {}) {
  if (!a) return { usable: false, code: 'APPROVAL_NOT_FOUND' }
  if (a.capability_id !== APPROVAL_CAPABILITY_ID || Number(a.capability_version) !== APPROVAL_CAPABILITY_VERSION) return { usable: false, code: 'APPROVAL_WRONG_CAPABILITY' }
  if (a.state === 'pending' || a.state === 'executing') {
    if (Date.parse(a.expires_at) <= now) return { usable: false, code: 'APPROVAL_EXPIRED', expired: true }
    return { usable: false, pending: true, code: 'APPROVAL_PENDING' }
  }
  if (a.state === 'expired') return { usable: false, code: 'APPROVAL_EXPIRED', expired: true }
  if (a.state !== 'executed') return { usable: false, code: `APPROVAL_${String(a.state).toUpperCase()}` }
  if (a.decision !== 'approve' || !a.decided_by) return { usable: false, code: 'APPROVAL_NOT_APPROVED' }
  const c = a.intended_change || {}
  if (a.target?.intent_id !== intent.intent_id || c.intent_id !== intent.intent_id || c.params_hash !== intent.params_hash || c.agent_id !== intent.agent_id || c.action !== intent.action) {
    return { usable: false, code: 'APPROVAL_BINDING_MISMATCH' }
  }
  const recomputed = approvalPayloadHash({ capability_id: a.capability_id, capability_version: Number(a.capability_version), org_id: a.org_id, target: a.target, intended_change: a.intended_change, snapshot_hash: a.snapshot_hash })
  if (recomputed !== a.payload_hash) return { usable: false, code: 'APPROVAL_PAYLOAD_TAMPERED' }
  if (!(Date.parse(c.grant_expires_at) > now)) return { usable: false, code: 'APPROVAL_EXPIRED', expired: true }
  return { usable: true, approved_by: a.decided_by }
}

/**
 * The capability the EXISTING decide path (capabilities/approvals.js#decide) uses for gateway intents.
 * Registered in the capability plane registry (dependency: agent/capabilities/index.js FIRST_CAPABILITIES +
 * services.actionGateway = createIntentApprovalReader). It cannot be invoked to CREATE an approval: only the
 * gateway files these (prepare refuses), and approving it executes nothing beyond recording the grant.
 */
export const agentActionApprovalCapability = Object.freeze({
  id: APPROVAL_CAPABILITY_ID,
  version: APPROVAL_CAPABILITY_VERSION,
  domain: 'platform_ops',
  title: 'Authorize one agent action',
  description: 'A human decision on ONE Action Gateway intent (exact action, resource and parameter hash). Approving records the grant; the gateway consumes it once. Filed only by the gateway.',
  input_schema: obj({ intent_id: UUID }, ['intent_id']),
  output_schema: { type: 'object' },
  side_effect: 'internal_write',
  tier: 'requires_explicit_approval',
  approval_class: 'default',
  cost_class: 'db_light',
  min_role: 'operator',
  limits: { per_min: 10, per_day: 500, timeout_ms: 15_000, rows_to_model: 5 },
  touches: ['action_gateway_intent'],
  wraps: { service: 'action-gateway approvals (agent.approval_request bound to action_gateway.action_intents)', module: 'apps/api/src/lib/domain/action-gateway/approvals.js' },
  compensation: { kind: 'none', note: 'Approving executes nothing; the gateway re-runs every guard when it consumes the grant. Deny or let it expire to withhold.' },
  idempotency: (input) => hashCanonical({ gateway_intent: input.intent_id }),
  async prepare() { return { ok: false, code: 'FILED_BY_ACTION_GATEWAY_ONLY' } },
  async snapshot(target, ctx) {
    return approvalSnapshotOf(await ctx.services.actionGateway.intent(ctx.org_id, target.intent_id))
  },
  async executeApproved(change, ctx) {
    const i = await ctx.services.actionGateway.intent(ctx.org_id, change.intent_id)
    if (!i || i.state !== 'awaiting_approval' || i.params_hash !== change.params_hash || (ctx.approval_id && i.approval_id !== ctx.approval_id)) {
      return { ok: false, code: 'INTENT_NOT_AWAITING_APPROVAL', state: i?.state || null }
    }
    return { ok: true, state: 'granted', status: 'granted', event: 'grant_recorded' }
  },
  audit: (input, r) => ({ intent_id: input?.intent_id || null, ok: r?.ok === true }),
})

/** The decide path's intent read (API process, agent_api pool; RLS policy agent_api_select). */
export function createIntentApprovalReader({ query }) {
  return Object.freeze({
    async intent(org_id, intent_id) {
      const rows = await query(`select intent_id::text, org_id::text, agent_id, action, capability, tier, resource_type, resource_id, params_hash, state, approval_id
                                  from action_gateway.action_intents where org_id = $1::uuid and intent_id = $2::uuid`, [org_id, intent_id])
      return rows[0] || null
    },
  })
}

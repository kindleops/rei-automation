// Human approval contracts (architecture §3.6, O5).
//
//  * payload_hash = sha256(canonical_json({tool, tool_version, input,
//    resolved_targets_hash, preconditions})) — exact, never "similar"
//  * scoped: one tool call, one resolved target set; a batch card is N approvals
//  * expiring: default 10 min, SMS 5 min, campaign launch 30 min
//  * single-use: the token is consumed atomically; a second use is refused
//  * grant requires a VERIFIED NAMED user from the identity provider; the
//    stub provider (S1) never verifies, so every grant is IDENTITY_REQUIRED
//  * fresh auth (≤ 5 min) for owner-designated high-impact tools
//  * drift between request and execution → approval.invalidated (+ diff)
//  * an identical hash denied in a run cannot be re-proposed in that run
//  * the model never sees tokens: grant() returns the token to the human
//    endpoint caller only; tool contexts never receive this service
import {
  APPROVAL_TTL_MS,
  FRESH_AUTH_MAX_AGE_MS,
  PAYLOAD_HASH_PREFIX_LEN,
  ROLE_RANK,
} from '../contracts/approval.js'
import { appendEventTx } from '../runtime/event-log.js'
import { AgentError } from '../runtime/store.js'
import { canonicalJson, hashCanonical, hmacHex, newId, timingSafeEqualHex } from '../runtime/canonical.js'
import { isConsequentialIdentity } from '../security/identity.js'

export function computePayloadHash({ tool, tool_version, input, resolved_targets = [], preconditions = {} }) {
  const resolved_targets_hash = hashCanonical([...resolved_targets].map(String).sort())
  return hashCanonical({ tool, tool_version, input, resolved_targets_hash, preconditions })
}

/**
 * @param {{ store, identityProvider, secret: string, now?: () => Date, roleFor?: (user_id: string) => string }} deps
 */
export function createApprovalService({ store, identityProvider, secret, now = () => new Date(), roleFor = () => 'operator' } = {}) {
  if (!store) throw new Error('store required')
  if (!identityProvider) throw new Error('identityProvider required')
  if (!secret || String(secret).length < 16) throw new Error('approval secret (≥16 chars) required')
  const evOpts = { now }

  async function requestApproval({ run_id, tool_call_id, spec, input, tier = spec?.tier, preconditions = {}, resolved_targets = [], provenance, requested_by = null }) {
    if (!spec) throw new AgentError('TOOL_NOT_REGISTERED', 'approval needs a registered tool')
    if (tier !== 'T3' && tier !== 'T2') throw new AgentError('APPROVAL_TIER_INVALID', `approvals are for T2-escalated or T3 calls, not ${tier}`)
    const payload_hash = computePayloadHash({ tool: spec.name, tool_version: spec.version, input, resolved_targets, preconditions })
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if ((run.denied_hashes || []).includes(payload_hash)) {
        return { ok: false, code: 'IDENTICAL_PROPOSAL_DENIED' }
      }
      const call = tx.toolCalls.get(tool_call_id)
      if (!call) throw new AgentError('TOOL_CALL_NOT_FOUND', tool_call_id)
      if (call.state !== 'proposed') throw new AgentError('ILLEGAL_TOOL_CALL_TRANSITION', `${call.state} → approval_requested`)
      call.state = 'approval_requested'
      const ttl = APPROVAL_TTL_MS[spec.approval_class || 'default'] ?? APPROVAL_TTL_MS.default
      const at = now()
      const effects = typeof spec.effects === 'function' ? spec.effects(input) : [{ summary: spec.label, kind: 'other', reversible: Boolean(spec.undo), undo_note: null }]
      const approval = {
        approval_id: newId('apr'),
        run_id,
        tool_call_id,
        tool: spec.name,
        tool_version: spec.version,
        tier: 'T3',
        payload_hash,
        payload_hash_prefix: payload_hash.slice(0, PAYLOAD_HASH_PREFIX_LEN),
        effects,
        preconditions: JSON.parse(canonicalJson(preconditions)),
        precondition_summary: Object.keys(preconditions),
        target_scope_summary: `${resolved_targets.length} target${resolved_targets.length === 1 ? '' : 's'}`,
        required_role: spec.owner_only ? 'owner' : spec.permission.min_role === 'owner' ? 'owner' : 'lead',
        fresh_auth_required: Boolean(spec.fresh_auth),
        owner_only: Boolean(spec.owner_only),
        requested_at: at.toISOString(),
        expires_at: new Date(at.getTime() + ttl).toISOString(),
        state: 'requested',
        provenance: provenance || { basis: 'turn', label: 'Proposed from your request' },
        batch_id: null,
        identity_available: Boolean(identityProvider.available),
        requested_by,
        decided_by: null,
        decided_at: null,
        consumed_at: null,
        token_digest: null,
      }
      tx.approvals.set(approval.approval_id, approval)
      const card = { ...approval }
      delete card.preconditions
      delete card.requested_by
      delete card.token_digest
      delete card.decided_by
      delete card.decided_at
      delete card.consumed_at
      appendEventTx(tx, { run_id, tool_call_id, type: 'approval.requested', payload: { approval: card } }, evOpts)
      return { ok: true, approval_id: approval.approval_id, payload_hash, expires_at: approval.expires_at, identity_available: approval.identity_available }
    })
  }

  function expireTx(tx, a) {
    a.state = 'expired'
    const call = tx.toolCalls.get(a.tool_call_id)
    if (call && (call.state === 'approval_requested' || call.state === 'approved')) call.state = 'expired'
    appendEventTx(tx, { run_id: a.run_id, tool_call_id: a.tool_call_id, type: 'approval.expired', payload: { approval_id: a.approval_id, payload_hash_prefix: a.payload_hash_prefix } }, evOpts)
  }

  /**
   * Human grant. Returns { ok, token } or { ok:false, code }.
   * @param {{ approval_id: string, payload_hash: string, session: unknown }} input
   */
  async function grant({ approval_id, payload_hash, session }) {
    const identity = await identityProvider.verify(session)
    if (!isConsequentialIdentity(identity)) return { ok: false, code: 'IDENTITY_REQUIRED', reason: identity?.reason || null }
    return store.transaction((tx) => {
      const a = tx.approvals.get(approval_id)
      if (!a) return { ok: false, code: 'APPROVAL_NOT_FOUND' }
      if (a.state === 'consumed') return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED' }
      if (a.state !== 'requested') return { ok: false, code: 'APPROVAL_NOT_PENDING' }
      if (Date.parse(a.expires_at) <= now().getTime()) {
        expireTx(tx, a)
        return { ok: false, code: 'APPROVAL_EXPIRED' }
      }
      if (!timingSafeEqualHex(String(payload_hash || ''), a.payload_hash)) return { ok: false, code: 'HASH_MISMATCH' }
      const role = roleFor(identity.user_id) || 'operator'
      if (ROLE_RANK[role] < ROLE_RANK[a.required_role]) return { ok: false, code: 'ROLE_NOT_ALLOWED' }
      if (a.owner_only && role !== 'owner') return { ok: false, code: 'ROLE_NOT_ALLOWED' }
      if (a.fresh_auth_required) {
        const authAt = Date.parse(identity.authenticated_at || '')
        if (!Number.isFinite(authAt) || now().getTime() - authAt > FRESH_AUTH_MAX_AGE_MS) return { ok: false, code: 'FRESH_AUTH_REQUIRED' }
      }
      const sig = hmacHex(secret, `${a.approval_id}|${a.payload_hash}|${identity.user_id}|${a.expires_at}`)
      a.state = 'granted'
      a.decided_by = identity.user_id
      a.decided_at = now().toISOString()
      a.token_digest = sig
      const call = tx.toolCalls.get(a.tool_call_id)
      if (call && call.state === 'approval_requested') call.state = 'approved'
      appendEventTx(tx, { run_id: a.run_id, tool_call_id: a.tool_call_id, type: 'approval.granted', payload: { approval_id, payload_hash_prefix: a.payload_hash_prefix, approver_display: identity.display_name || 'verified user' } }, evOpts)
      return { ok: true, token: `${a.approval_id}.${sig}`, expires_at: a.expires_at }
    })
  }

  /** Denial is protective and allowed without verified identity; it is recorded. */
  async function deny({ approval_id, reason = 'operator_declined' }) {
    return store.transaction((tx) => {
      const a = tx.approvals.get(approval_id)
      if (!a) return { ok: false, code: 'APPROVAL_NOT_FOUND' }
      if (a.state !== 'requested') return { ok: false, code: 'APPROVAL_NOT_PENDING' }
      a.state = 'denied'
      a.decided_at = now().toISOString()
      const run = tx.runs.get(a.run_id)
      run.denied_hashes = [...(run.denied_hashes || []), a.payload_hash]
      const call = tx.toolCalls.get(a.tool_call_id)
      if (call && call.state === 'approval_requested') call.state = 'denied'
      appendEventTx(tx, { run_id: a.run_id, tool_call_id: a.tool_call_id, type: 'approval.denied', payload: { approval_id, payload_hash_prefix: a.payload_hash_prefix, reason } }, evOpts)
      return { ok: true }
    })
  }

  /**
   * Executor-side consume: verify token, recompute hash from the CURRENT
   * payload + preconditions; any drift invalidates. Single-use.
   */
  async function consume({ token, tool_call_id = null, tool, tool_version, input, resolved_targets = [], preconditions = {} }) {
    const [approval_id, sig] = String(token || '').split('.')
    if (!approval_id || !sig) return { ok: false, code: 'APPROVAL_TOKEN_INVALID' }
    const recomputed = computePayloadHash({ tool, tool_version, input, resolved_targets, preconditions })
    return store.transaction((tx) => {
      const a = tx.approvals.get(approval_id)
      if (!a) return { ok: false, code: 'APPROVAL_NOT_FOUND' }
      if (a.state === 'consumed') return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED' }
      if (a.state !== 'granted') return { ok: false, code: 'APPROVAL_NOT_GRANTED' }
      if (tool_call_id && a.tool_call_id !== tool_call_id) return { ok: false, code: 'APPROVAL_SCOPE_MISMATCH' }
      const expect = hmacHex(secret, `${a.approval_id}|${a.payload_hash}|${a.decided_by}|${a.expires_at}`)
      if (!timingSafeEqualHex(sig, expect) || !timingSafeEqualHex(sig, a.token_digest || '')) return { ok: false, code: 'APPROVAL_TOKEN_INVALID' }
      if (Date.parse(a.expires_at) <= now().getTime()) {
        expireTx(tx, a)
        return { ok: false, code: 'APPROVAL_EXPIRED' }
      }
      if (recomputed !== a.payload_hash) {
        a.state = 'invalidated'
        const drift = { tool_changed: tool !== a.tool, preconditions_changed: canonicalJson(preconditions) !== canonicalJson(a.preconditions) }
        const call = tx.toolCalls.get(a.tool_call_id)
        if (call && call.state === 'approved') call.state = 'invalidated'
        appendEventTx(tx, { run_id: a.run_id, tool_call_id: a.tool_call_id, type: 'approval.invalidated', payload: { approval_id, payload_hash_prefix: a.payload_hash_prefix, drift } }, evOpts)
        return { ok: false, code: drift.preconditions_changed ? 'PRECONDITION_DRIFT' : 'HASH_MISMATCH' }
      }
      a.state = 'consumed'
      a.consumed_at = now().toISOString()
      tx.idempotency.set(`agent.approval:${approval_id}`, { consumed_at: a.consumed_at })
      appendEventTx(tx, { run_id: a.run_id, tool_call_id: a.tool_call_id, type: 'approval.consumed', payload: { approval_id, payload_hash_prefix: a.payload_hash_prefix } }, evOpts)
      return { ok: true, approval_id, decided_by: a.decided_by }
    })
  }

  function expireDue() {
    return store.transaction((tx) => {
      const t = now().getTime()
      const out = []
      for (const a of tx.approvals.values()) {
        if ((a.state === 'requested' || a.state === 'granted') && Date.parse(a.expires_at) <= t) {
          expireTx(tx, a)
          out.push(a.approval_id)
        }
      }
      return out
    })
  }

  function get(approval_id) {
    const a = store.read().approvals.get(approval_id)
    return a ? { ...a } : null
  }

  return { requestApproval, grant, deny, consume, expireDue, get, computePayloadHash }
}

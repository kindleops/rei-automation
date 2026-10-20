// Capability approvals — the ONLY way an approval-tier capability changes state.
//
// The existing agent approvals module (agent/approvals/approval-service.js) is
// bound to an in-memory agent run + tool call and its token flow is not
// persisted (pg-store refuses the `approvals` table). Its payload-hash rule is
// reused here (exact payload, canonical JSON, sha256) and the record is the new
// agent.approval_request (PROPOSED migration 20261013120000).
//
// request():  spec.prepare(input) runs the EXISTING dry-run checks and reads the
//             current state → { target, intended_change, snapshot, summary }.
//             A pending approval is stored: target, exact intended change,
//             current-state snapshot hash, payload hash, expiry, idempotency key.
//             Re-proposing the identical change returns the same approval.
// decide():   a VERIFIED named operator who is a member of the approval's org
//             (a foreign org's approval is "not found"), echoing the payload hash
//             they were shown. Approve:
//               expired?         → expired (refused)
//               re-read state    → spec.snapshot(target); hash differs → refused_drift
//               claim            → pending → executing (compare-and-set: exactly one wins)
//               execute          → spec.executeApproved(intended_change) through the
//                                  existing UI service path (all its gates apply)
//               record           → executed | failed + execution_result (real outcome)
//             Replays of a decided approval return the recorded result and never
//             execute twice.
import { canonicalJson, hashCanonical, newId, timingSafeEqualHex } from '../runtime/canonical.js'
import { isConsequentialIdentity, isAgentIdentity } from '../security/identity.js'
import { APPROVAL_TTL_MS } from './contracts.js'

export const DECISIONS = Object.freeze(['approve', 'deny'])

export function snapshotHash(snapshot) {
  return hashCanonical({ v: 1, snapshot: snapshot ?? null })
}

export function approvalPayloadHash({ capability_id, capability_version, org_id, target, intended_change, snapshot_hash }) {
  return hashCanonical({ capability_id, capability_version, org_id, target, intended_change, snapshot_hash })
}

/** What an approval card shows (no functions, no secrets). */
export function approvalCard(a) {
  if (!a) return null
  return {
    approval_id: a.approval_id, capability_id: a.capability_id, capability_version: a.capability_version, tier: a.tier, state: a.state,
    provenance: a.provenance, target: a.target, intended_change: a.intended_change, summary: a.summary || [],
    snapshot_hash_prefix: String(a.snapshot_hash || '').slice(0, 12), payload_hash: a.payload_hash,
    expires_at: a.expires_at, created_at: a.created_at, decided_at: a.decided_at, decision: a.decision,
    decided_by_self: null, execution_result: a.execution_result || null, executed_at: a.executed_at || null,
  }
}

/**
 * @param {{ store, registry, services, now?: () => number }} deps
 */
export function createCapabilityApprovals({ store, registry, services, now = () => Date.now() }) {
  async function request({ spec, input, ctx, tier, idempotency_key }) {
    const prepared = await spec.prepare(input, ctx)
    if (!prepared || prepared.ok === false) return { ok: false, code: prepared?.code || 'PREPARE_REFUSED', detail: prepared?.detail || null }
    const snap = snapshotHash(prepared.snapshot)
    const target = JSON.parse(canonicalJson(prepared.target))
    const intended_change = JSON.parse(canonicalJson(prepared.intended_change))
    const payload_hash = approvalPayloadHash({ capability_id: spec.id, capability_version: spec.version, org_id: ctx.org_id, target, intended_change, snapshot_hash: snap })
    const at = now()
    const row = {
      approval_id: newId('apr'),
      org_id: ctx.org_id,
      capability_id: spec.id,
      capability_version: spec.version,
      tier,
      requested_by: ctx.actor,
      provenance: ctx.provenance === 'untrusted_content' ? 'untrusted_content' : ctx.source === 'operator' ? 'operator' : 'model',
      target,
      intended_change,
      summary: Array.isArray(prepared.summary) ? prepared.summary.slice(0, 12).map((s) => String(s).slice(0, 240)) : [],
      snapshot_hash: snap,
      payload_hash,
      // the idempotency key also covers the snapshot: the same proposal against changed state is a new approval
      idempotency_key: hashCanonical({ k: idempotency_key, s: snap }),
      expires_at: new Date(at + (APPROVAL_TTL_MS[spec.approval_class] || APPROVAL_TTL_MS.default)).toISOString(),
      created_at: new Date(at).toISOString(),
    }
    const { inserted, row: stored } = await store.insertApproval(row)
    if (!inserted && stored && stored.state !== 'pending') return { ok: false, code: 'IDENTICAL_PROPOSAL_ALREADY_DECIDED', detail: { approval_id: stored.approval_id, state: stored.state } }
    return { ok: true, approval_id: stored.approval_id, expires_at: stored.expires_at, deduped: !inserted, preview: { summary: stored.summary, target: stored.target } }
  }

  async function list({ org_id, identity, states = null, limit = 50 }) {
    if (!isConsequentialIdentity(identity)) return { ok: false, code: 'IDENTITY_REQUIRED' }
    if (!(await store.membership(org_id, identity.user_id))) return { ok: false, code: 'NOT_A_MEMBER' }
    const rows = await store.listApprovals(org_id, { states, limit })
    return { ok: true, approvals: rows.map((r) => ({ ...approvalCard(r), decided_by_self: r.decided_by ? r.decided_by === identity.user_id : null })) }
  }

  async function get({ org_id, identity, approval_id }) {
    if (!isConsequentialIdentity(identity)) return { ok: false, code: 'IDENTITY_REQUIRED' }
    if (!(await store.membership(org_id, identity.user_id))) return { ok: false, code: 'NOT_A_MEMBER' }
    const a = await store.getApproval(org_id, approval_id)
    return a ? { ok: true, approval: approvalCard(a) } : { ok: false, code: 'APPROVAL_NOT_FOUND' }
  }

  const recorded = (a, replayed = true) => ({ ok: a.state === 'executed', replayed, state: a.state, approval_id: a.approval_id, execution_result: a.execution_result || null, code: a.state === 'executed' ? null : `APPROVAL_${String(a.state).toUpperCase()}` })

  async function decide({ org_id, identity, approval_id, decision, payload_hash, note = null }) {
    if (!DECISIONS.includes(decision)) return { ok: false, code: 'DECISION_INVALID' }
    if (!isConsequentialIdentity(identity)) return { ok: false, code: 'IDENTITY_REQUIRED' }
    // D6: a decision is a HUMAN act — an agent / service / model identity never decides (approve or deny)
    if (isAgentIdentity(identity)) return { ok: false, code: 'HUMAN_DECISION_REQUIRED' }
    const member = await store.membership(org_id, identity.user_id)
    if (!member) return { ok: false, code: 'NOT_A_MEMBER' }
    const a = await store.getApproval(org_id, String(approval_id || ''))
    if (!a) return { ok: false, code: 'APPROVAL_NOT_FOUND' }
    if (['executed', 'failed', 'refused_drift', 'denied', 'expired', 'cancelled'].includes(a.state)) return recorded(a)
    if (a.state === 'executing') return { ok: false, code: 'APPROVAL_EXECUTING', state: a.state, approval_id: a.approval_id }
    if (!timingSafeEqualHex(String(payload_hash || ''), a.payload_hash)) return { ok: false, code: 'HASH_MISMATCH' }
    const by = identity.user_id
    const at = new Date(now()).toISOString()
    const decidedNote = note ? String(note).replace(/[^\w .,:;!?'()-]/g, '').slice(0, 200) : null

    if (decision === 'deny') {
      const d = await store.transitionApproval(org_id, a.approval_id, ['pending'], 'denied', { decided_by: by, decided_at: at, decision: 'deny', execution_result: decidedNote ? { note: decidedNote } : null })
      return d ? { ok: true, state: 'denied', approval_id: a.approval_id } : recorded(await store.getApproval(org_id, a.approval_id))
    }

    if (Date.parse(a.expires_at) <= now()) {
      await store.transitionApproval(org_id, a.approval_id, ['pending'], 'expired', { decided_by: by, decided_at: at, decision: 'approve' })
      return { ok: false, code: 'APPROVAL_EXPIRED', state: 'expired', approval_id: a.approval_id }
    }
    const spec = registry.get(a.capability_id)
    if (!spec || spec.version !== a.capability_version) {
      await store.transitionApproval(org_id, a.approval_id, ['pending'], 'refused_drift', { decided_by: by, decided_at: at, decision: 'approve', execution_result: { refused: 'CAPABILITY_VERSION_CHANGED' } })
      return { ok: false, code: 'CAPABILITY_VERSION_CHANGED', state: 'refused_drift', approval_id: a.approval_id }
    }
    const ctx = Object.freeze({ org_id, actor: by, approver: by, source: 'approval', services, now, approval_id: a.approval_id, idempotency_key: a.idempotency_key })

    // re-read the CURRENT state; any drift refuses (the human approved what they saw)
    let current
    try {
      current = await spec.snapshot(a.target, ctx, a.intended_change)
    } catch (e) {
      return { ok: false, code: 'STATE_UNREADABLE', detail: String(e?.code || 'read_failed').slice(0, 60) }
    }
    const nowHash = snapshotHash(current)
    if (nowHash !== a.snapshot_hash) {
      const r = await store.transitionApproval(org_id, a.approval_id, ['pending'], 'refused_drift', { decided_by: by, decided_at: at, decision: 'approve', execution_result: { refused: 'STATE_DRIFTED', drift_hash: nowHash } })
      return r ? { ok: false, code: 'STATE_DRIFTED', state: 'refused_drift', approval_id: a.approval_id } : recorded(await store.getApproval(org_id, a.approval_id))
    }

    // claim: exactly one approver/process moves pending → executing
    const claimed = await store.transitionApproval(org_id, a.approval_id, ['pending'], 'executing', { decided_by: by, decided_at: at, decision: 'approve' })
    if (!claimed) {
      const cur = await store.getApproval(org_id, a.approval_id)
      return cur?.state === 'executing' ? { ok: false, code: 'APPROVAL_EXECUTING', state: 'executing', approval_id: a.approval_id } : recorded(cur)
    }

    let result
    let failed = null
    try {
      result = await spec.executeApproved(a.intended_change, ctx, a.target)
    } catch (e) {
      failed = { error: String(e?.code || 'EXECUTION_ERROR').slice(0, 80) }
    }
    const ok = !failed && result && result.ok !== false
    const execution_result = failed || sanitizeResult(result)
    const final = await store.transitionApproval(org_id, a.approval_id, ['executing'], ok ? 'executed' : 'failed', { execution_result, executed_at: new Date(now()).toISOString() })
    return { ok, replayed: false, state: final?.state || (ok ? 'executed' : 'failed'), approval_id: a.approval_id, execution_result }
  }

  return { request, list, get, decide }
}

/** Execution results are stored and shown: ids, codes, counts, states only (the DB CHECK re-verifies). */
export function sanitizeResult(r) {
  const out = {}
  const allow = /^(ok|status|code|reason|state|campaign_id|opportunity_id|queue_id|queue_row_id|message_event_id|provider_attempted|provider_accepted|provider_status|delivery_status|eligible|inserted|mode|scheduled_for|from_stage|to_stage|readback|stage|event|job_id|exists|active|blocked|hard_block|idempotent|error)$/
  const walk = (v, depth) => {
    if (depth > 3 || v == null) return v ?? null
    if (Array.isArray(v)) return v.slice(0, 10).map((x) => walk(x, depth + 1))
    if (typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) if (allow.test(k)) o[k] = walk(x, depth + 1)
      return o
    }
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v
    if (typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?$/.test(v)) return v
    if (typeof v === 'number' && Math.abs(v) >= 1e9) return `#${String(Math.trunc(Math.abs(v))).length}d`
    if (typeof v === 'string') return v.replace(/[0-9]{7,}/g, (d) => `#${d.length}d`).slice(0, 120)
    return v
  }
  Object.assign(out, walk(r && typeof r === 'object' ? r : { ok: Boolean(r) }, 0))
  return out
}

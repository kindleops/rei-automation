// Capability plane persistence: approval requests, the capability audit, and the
// named-operator membership read. Two adapters with ONE interface:
//
//   membership(org_id, user_id)                      → { role } | null
//   appendAudit(row)                                 → void   (append-only)
//   countAudit({ org_id, actor, capability_id, since, decisions }) → number
//   findAuditByIdempotency(org_id, key)              → row | null (latest succeeded)
//   insertApproval(row)                              → { inserted, row }  (dedupe on org + idempotency_key)
//   getApproval(org_id, approval_id)                 → row | null  (org-scoped: a foreign org's id is "not found")
//   listApprovals(org_id, { states, limit })         → rows
//   transitionApproval(org_id, approval_id, from[], to, patch) → row | null  (compare-and-set)
//
// Postgres schema: supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql
// (PROPOSED — not applied). The pg adapter connects as agent_api; every state
// change goes through agent.capability_approval_transition() (SECURITY DEFINER,
// legal-transition + immutability enforced in the database as well).
import { AgentError } from '../runtime/store.js'

export const APPROVAL_STATES = Object.freeze(['pending', 'executing', 'executed', 'failed', 'denied', 'expired', 'refused_drift', 'cancelled'])
export const APPROVAL_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['executing', 'denied', 'expired', 'refused_drift', 'cancelled']),
  executing: Object.freeze(['executed', 'failed']),
  executed: Object.freeze([]),
  failed: Object.freeze([]),
  denied: Object.freeze([]),
  expired: Object.freeze([]),
  refused_drift: Object.freeze([]),
  cancelled: Object.freeze([]),
})
export const canApprovalTransition = (from, to) => (APPROVAL_TRANSITIONS[from] || []).includes(to)
const IMMUTABLE = ['approval_id', 'org_id', 'capability_id', 'capability_version', 'tier', 'requested_by', 'provenance', 'target', 'intended_change', 'snapshot_hash', 'payload_hash', 'idempotency_key', 'expires_at', 'created_at']

const clone = (v) => (v == null ? v : structuredClone(v))

/** In-memory adapter (tests, local dev). `members`: [{ org_id, user_id, role }]. */
export function createMemoryCapabilityStore({ members = [], now = () => Date.now() } = {}) {
  const approvals = new Map()
  const audit = []
  const memberMap = new Map(members.map((m) => [`${m.org_id}|${String(m.user_id).toLowerCase()}`, { role: m.role || 'operator' }]))
  return {
    kind: 'memory',
    _audit: audit,
    _approvals: approvals,
    async membership(org_id, user_id) {
      return clone(memberMap.get(`${org_id}|${String(user_id || '').toLowerCase()}`) || null)
    },
    async appendAudit(row) {
      audit.push(Object.freeze({ id: audit.length + 1, at: new Date(now()).toISOString(), ...clone(row) }))
    },
    async countAudit({ org_id, actor, capability_id, since, decisions = null }) {
      const t = Date.parse(since)
      return audit.filter((a) => a.org_id === org_id && a.actor === actor && a.capability_id === capability_id && Date.parse(a.at) >= t && (!decisions || decisions.includes(a.decision))).length
    },
    async findAuditByIdempotency(org_id, key) {
      for (let i = audit.length - 1; i >= 0; i -= 1) {
        const a = audit[i]
        if (a.org_id === org_id && a.idempotency_key === key && a.decision === 'executed') return clone(a)
      }
      return null
    },
    async insertApproval(row) {
      for (const a of approvals.values()) if (a.org_id === row.org_id && a.idempotency_key === row.idempotency_key) return { inserted: false, row: clone(a) }
      const r = { ...clone(row), state: 'pending', decided_by: null, decided_at: null, decision: null, execution_result: null, executed_at: null, updated_at: new Date(now()).toISOString() }
      approvals.set(r.approval_id, r)
      return { inserted: true, row: clone(r) }
    },
    async getApproval(org_id, approval_id) {
      const a = approvals.get(approval_id)
      return a && a.org_id === org_id ? clone(a) : null
    },
    async listApprovals(org_id, { states = null, limit = 50 } = {}) {
      return [...approvals.values()]
        .filter((a) => a.org_id === org_id && (!states || states.includes(a.state)))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Math.min(limit, 200))
        .map(clone)
    },
    async transitionApproval(org_id, approval_id, from, to, patch = {}) {
      const a = approvals.get(approval_id)
      if (!a || a.org_id !== org_id || !from.includes(a.state)) return null
      if (!canApprovalTransition(a.state, to)) throw new AgentError('APPROVAL_ILLEGAL_TRANSITION', `${a.state} → ${to}`)
      for (const k of Object.keys(patch)) if (IMMUTABLE.includes(k)) throw new AgentError('APPROVAL_IMMUTABLE_FIELD', k)
      Object.assign(a, clone(patch), { state: to, updated_at: new Date(now()).toISOString() })
      return clone(a)
    },
  }
}

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
function approvalFromRow(r) {
  if (!r) return null
  return {
    approval_id: r.approval_id, org_id: r.org_id, capability_id: r.capability_id, capability_version: Number(r.capability_version), tier: r.tier,
    requested_by: r.requested_by, provenance: r.provenance, target: r.target, intended_change: r.intended_change, summary: r.summary,
    snapshot_hash: r.snapshot_hash, payload_hash: r.payload_hash, idempotency_key: r.idempotency_key, state: r.state,
    expires_at: iso(r.expires_at), decided_by: r.decided_by, decided_at: iso(r.decided_at), decision: r.decision,
    execution_result: r.execution_result, executed_at: iso(r.executed_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  }
}

/** Postgres adapter over the agent_api pool (statement timeout ≤ 5 s per call). */
export function createPgCapabilityStore({ pool, statementTimeoutMs = 5000 } = {}) {
  if (!pool) throw new AgentError('CAPABILITY_STORE_POOL_REQUIRED', 'a pg Pool is required')
  const st = Math.min(Math.max(Math.trunc(statementTimeoutMs), 500), 5000)
  async function q(sql, params = []) {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`set local statement_timeout = ${st}`)
      const res = await c.query(sql, params)
      await c.query('commit')
      return res.rows
    } catch (e) {
      try { await c.query('rollback') } catch { /* broken connection */ }
      throw e
    } finally {
      c.release()
    }
  }
  const j = (v) => (v == null ? null : JSON.stringify(v))
  return {
    kind: 'postgres',
    async assertLeastPrivilege() {
      const rows = await q("select rolsuper, rolbypassrls from pg_roles where rolname = current_user", [])
      if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls) throw new AgentError('CAPABILITY_ROLE_PRIVILEGED', 'the capability store must connect as agent_api (no superuser, no BYPASSRLS)')
      return true
    },
    async membership(org_id, user_id) {
      const rows = await q('select role from agent.operator_membership where org_id = $1::uuid and user_id = $2::uuid', [org_id, user_id])
      return rows[0] ? { role: rows[0].role } : null
    },
    async appendAudit(a) {
      await q(`insert into agent.capability_audit (org_id, capability_id, capability_version, actor, source, tier, decision, code, idempotency_key, input_hash, approval_id, summary)
               values ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [a.org_id, a.capability_id, a.capability_version ?? null, a.actor, a.source, a.tier ?? null, a.decision, a.code ?? null, a.idempotency_key ?? null, a.input_hash ?? null, a.approval_id ?? null, j(a.summary || {})])
    },
    async countAudit({ org_id, actor, capability_id, since, decisions = null }) {
      const rows = await q(`select count(*)::int n from agent.capability_audit where org_id = $1::uuid and actor = $2::uuid and capability_id = $3 and at >= $4::timestamptz and ($5::text[] is null or decision = any($5::text[]))`, [org_id, actor, capability_id, since, decisions])
      return rows[0]?.n || 0
    },
    async findAuditByIdempotency(org_id, key) {
      const rows = await q(`select * from agent.capability_audit where org_id = $1::uuid and idempotency_key = $2 and decision = 'executed' order by id desc limit 1`, [org_id, key])
      return rows[0] || null
    },
    async insertApproval(r) {
      const rows = await q(`select agent.capability_approval_insert($1::jsonb) r`, [j(r)])
      const out = rows[0]?.r || {}
      return { inserted: Boolean(out.inserted), row: approvalFromRow(out.row) }
    },
    async getApproval(org_id, approval_id) {
      const rows = await q('select * from agent.approval_request where org_id = $1::uuid and approval_id = $2', [org_id, approval_id])
      return approvalFromRow(rows[0])
    },
    async listApprovals(org_id, { states = null, limit = 50 } = {}) {
      const rows = await q('select * from agent.approval_request where org_id = $1::uuid and ($2::text[] is null or state = any($2::text[])) order by created_at desc limit $3', [org_id, states, Math.min(Number(limit) || 50, 200)])
      return rows.map(approvalFromRow)
    },
    async transitionApproval(org_id, approval_id, from, to, patch = {}) {
      const rows = await q('select agent.capability_approval_transition($1::uuid, $2, $3::text[], $4, $5::jsonb) r', [org_id, approval_id, from, to, j(patch)])
      return approvalFromRow(rows[0]?.r || null)
    },
  }
}

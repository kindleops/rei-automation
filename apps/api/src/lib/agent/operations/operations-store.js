// Operations store (8.5.20 part C): the durable action states and work items.
//
// WRITES go only through the lease-bound SECURITY DEFINER functions of
// PROPOSED_20261016140000_operations_action_center.sql (the SQL re-checks the running
// job's lease token and kind); operator decisions through agent.ops_work_item_decide.
// READS run inside BEGIN READ ONLY over the agent_api pool and touch schema agent only.
//
//   createOperationsPgStore({ pool })                 production / local PG
//   createOperationsMemoryStore({ runtime, now })     tests (lease checked against the
//                                                     memory runtime store's jobs)
import crypto from 'node:crypto'
import { ACTION_STATES } from './action-center.js'

const SCOPE_OF_KIND = Object.freeze({ 'recovery.sweep': 'recovery', 'inbox.action_center': 'action_center', 'pipeline.reconcile': 'pipeline', 'ops.supervisor': 'supervisor', 'conversation.turn': 'conversation' })
const toIso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
/** the memory twin's work item id: deterministic from the dedupe key (uuid-shaped, never random) */
const memoryItemId = (key) => { const h = crypto.createHash('sha256').update(String(key)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function shapeState(r) {
  return {
    conversation_id: String(r.conversation_id), state: r.state, owner: r.owner, verified_stage: r.verified_stage ?? null, stage_verified: r.stage_verified === true,
    stage_note: r.stage_note ?? null, next_action: r.next_action, due_at: toIso(r.due_at), priority_reason: r.priority_reason, evidence_refs: r.evidence_refs || [],
    pending_approvals: r.pending_approvals || [], reasons: r.reasons || [], lost: r.lost === true, opportunity_id: r.opportunity_id ? String(r.opportunity_id) : null,
    property_ref: r.property_ref ?? null, last_inbound_at: toIso(r.last_inbound_at), last_outbound_at: toIso(r.last_outbound_at), state_since: toIso(r.state_since),
    computed_at: toIso(r.computed_at), job_id: r.job_id, version: r.version,
  }
}
function shapeItem(r) {
  return {
    work_item_id: String(r.work_item_id), scope: r.scope, kind: r.kind, dedupe_key: r.dedupe_key, state: r.state, severity: r.severity, escalated: r.escalated === true,
    title: r.title, subject_type: r.subject_type, subject_id: r.subject_id ?? null, detail: r.detail || {}, priority: Number(r.priority || 0), due_at: toIso(r.due_at),
    first_seen_at: toIso(r.first_seen_at), last_seen_at: toIso(r.last_seen_at), seen_count: Number(r.seen_count || 1), source_job_id: r.source_job_id ?? null,
    acknowledged_by: r.acknowledged_by ? String(r.acknowledged_by) : null, resolved_at: toIso(r.resolved_at), resolved_by: r.resolved_by ?? null,
  }
}

/** @param {{ pool: import('pg').Pool, statementTimeoutMs?: number }} o */
export function createOperationsPgStore({ pool, statementTimeoutMs = 10_000 } = {}) {
  if (!pool) throw new Error('operations store: pool required')
  const st = Math.min(Math.max(Math.trunc(statementTimeoutMs), 500), 30_000)
  async function tx(readOnly, sql, params = []) {
    let client
    try { client = await pool.connect() } catch { throw Object.assign(new Error('operations store unavailable'), { code: 'OPERATIONS_DB_UNAVAILABLE' }) }
    try {
      await client.query(readOnly ? 'begin read only' : 'begin')
      await client.query(`set local statement_timeout = ${st}`)
      const { rows } = await client.query(sql, params)
      await client.query(readOnly ? 'rollback' : 'commit')
      return rows
    } catch (e) {
      try { await client.query('rollback') } catch { /* broken */ }
      const c = String(e?.code || '')
      throw Object.assign(new Error('operations store query failed'), { code: c === '42P01' || c === '42883' ? 'OPERATIONS_NOT_APPLIED' : c === '57014' ? 'OPERATIONS_DB_TIMEOUT' : c === '23514' ? 'OPERATIONS_ROW_REFUSED' : 'OPERATIONS_DB_UNAVAILABLE', pg_code: c || null })
    } finally {
      client.release()
    }
  }
  const call = async (sql, params) => (await tx(false, sql, params))[0]?.r ?? null
  const read = (sql, params) => tx(true, sql, params)
  return Object.freeze({
    kind: 'postgres',
    upsertActionStates: ({ job_id, token, rows }) => call('select agent.ops_action_state_upsert($1, $2::uuid, $3::jsonb) r', [job_id, token, JSON.stringify(rows || [])]),
    syncWorkItems: ({ job_id, token, items, close_missing = false }) => call('select agent.ops_work_item_sync($1, $2::uuid, $3::jsonb, $4) r', [job_id, token, JSON.stringify(items || []), Boolean(close_missing)]),
    decideWorkItem: ({ work_item_id, by, action }) => call('select agent.ops_work_item_decide($1::uuid, $2, $3) r', [work_item_id, by, action]),

    async actionCenterSummary() {
      const rows = await read(`select state, count(*)::int n, count(*) filter (where lost)::int lost, max(computed_at) computed_at from agent.conversation_action_state group by state`)
      const lostIds = await read(`select conversation_id::text id from agent.conversation_action_state where lost order by due_at nulls last limit 10`)
      const counts = Object.fromEntries(ACTION_STATES.map((s) => [s, 0]))
      let lost = 0
      let at = null
      for (const r of rows) { counts[r.state] = Number(r.n); lost += Number(r.lost); const t = toIso(r.computed_at); if (t && (!at || t > at)) at = t }
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      return { counts, lost, active_queue: counts.needs_attention, total, computed_at: at, lost_ids: lostIds.map((r) => r.id) }
    },
    async listActionStates({ state = null, lost = null, limit = 50, before = null } = {}) {
      const rows = await read(`select * from agent.conversation_action_state
         where ($1::text is null or state = $1) and ($2::boolean is null or lost = $2) and ($3::uuid is null or conversation_id > $3::uuid)
         order by conversation_id limit $4`, [state, lost, before, Math.min(Math.max(Number(limit) || 50, 1), 200)])
      return rows.map(shapeState)
    },
    async workItemsFor({ conversation_ids = [] } = {}) {
      if (!conversation_ids.length) return []
      return (await read(`select * from agent.ops_work_item where subject_type = 'conversation' and subject_id = any($1::text[]) and state in ('open', 'acknowledged')`, [conversation_ids.slice(0, 500)])).map(shapeItem)
    },
    async listWorkItems({ states = ['open', 'acknowledged'], scope = null, limit = 50 } = {}) {
      return (await read(`select * from agent.ops_work_item where state = any($1::text[]) and ($2::text is null or scope = $2)
         order by (severity = 'critical') desc, escalated desc, priority desc, last_seen_at desc limit $3`, [states, scope, Math.min(Math.max(Number(limit) || 50, 1), 200)])).map(shapeItem)
    },
    async resolvedWorkItemsSince({ since, limit = 100 } = {}) {
      return (await read(`select * from agent.ops_work_item where resolved_at >= $1 order by resolved_at desc limit $2`, [since, Math.min(Number(limit) || 100, 200)])).map(shapeItem)
    },
    /** pending approvals with the opportunity they target (pipeline.propose_stage_change carries target.opportunity_id) */
    async pendingApprovalTargets({ org_id, limit = 200 } = {}) {
      return (await read(`select approval_id, capability_id, created_at, expires_at, target ->> 'opportunity_id' opportunity_id from agent.approval_request
         where org_id = $1 and state = 'pending' and expires_at > clock_timestamp() order by created_at desc limit $2`, [org_id, Math.min(Number(limit) || 200, 500)]))
        .map((r) => ({ approval_id: r.approval_id, capability_id: r.capability_id, created_at: toIso(r.created_at), expires_at: toIso(r.expires_at), opportunity_id: r.opportunity_id || null }))
    },
    /** newest finding value of a type (the latest supervisor / recovery batch summary) */
    async latestFinding({ finding_type, since = null } = {}) {
      const r = (await read(`select job_id, value, retrieved_at from agent.finding where job_id is not null and finding_type = $1 and ($2::timestamptz is null or retrieved_at >= $2)
         order by retrieved_at desc limit 1`, [finding_type, since]))[0]
      return r ? { job_id: r.job_id, value: r.value || {}, retrieved_at: toIso(r.retrieved_at) } : null
    },
    async recoveryCandidatesSince({ since, limit = 500 } = {}) {
      return (await read(`select distinct on (key) key, value, retrieved_at from agent.finding where job_id is not null and finding_type = 'recovery.candidate' and retrieved_at >= $1
         order by key, retrieved_at desc limit $2`, [since, Math.min(Number(limit) || 500, 2000)]))
        .map((r) => ({ conversation_id: r.value?.conversation_id || null, class: r.value?.class || null, priority: Number(r.value?.priority || 0) }))
        .filter((c) => c.conversation_id)
    },
  })
}

/**
 * Memory twin. `runtime` = createRuntimeMemoryStore(): the lease is checked against its jobs,
 * exactly as agent.runtime_leased does (token match, state running, kind ↔ scope).
 */
export function createOperationsMemoryStore({ runtime = null, now = () => Date.now(), findings = null } = {}) {
  const states = new Map()
  const items = new Map()
  const writes = []
  const leased = (job_id, token) => {
    const j = runtime?._state?.jobs?.get(job_id)
    return j && j.lease_token === token && j.state === 'running' ? j : null
  }
  const iso = () => new Date(now()).toISOString()
  // the memory twin of agent.payload_is_clean's phone-run rule (uuids and ISO timestamps exempt)
  const clean = (o) => {
    const t = JSON.stringify(o ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '').replace(/\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?/g, '')
    if (/\d(?:[\s().,:/_+-]{0,4}\d){9,14}/.test(t)) throw Object.assign(new Error('payload not clean'), { code: 'OPERATIONS_ROW_REFUSED' })
  }
  return {
    kind: 'memory',
    _states: states,
    _items: items,
    writes,
    async upsertActionStates({ job_id, token, rows }) {
      const j = leased(job_id, token)
      if (!j) return { ok: false, reason: 'lease_lost' }
      if (j.kind !== 'inbox.action_center') return { ok: false, reason: 'kind_not_allowed' }
      let changed = 0
      for (const r of rows) {
        if (!ACTION_STATES.includes(r.state)) throw Object.assign(new Error('state refused'), { code: 'OPERATIONS_ROW_REFUSED' })
        clean({ next_action: r.next_action, priority_reason: r.priority_reason, reasons: r.reasons })
        const prev = states.get(r.conversation_id)
        if (prev?.state !== r.state) changed += 1
        states.set(r.conversation_id, { ...r, state_since: prev && prev.state === r.state ? prev.state_since : iso(), computed_at: iso(), job_id })
      }
      writes.push({ fn: 'upsertActionStates', job_id, n: rows.length })
      return { ok: true, upserted: rows.length, changed }
    },
    async syncWorkItems({ job_id, token, items: list, close_missing = false }) {
      const j = leased(job_id, token)
      if (!j) return { ok: false, reason: 'lease_lost' }
      const scope = SCOPE_OF_KIND[j.kind]
      if (!scope) return { ok: false, reason: 'kind_not_allowed' }
      const out = { ok: true, scope, inserted: 0, updated: 0, reopened: 0, resolved: 0 }
      const keys = new Set()
      for (const it of list) {
        if (!String(it.dedupe_key).startsWith(`${scope}:`)) return { ok: false, reason: 'dedupe_key_outside_scope' }
        const cur = items.get(it.dedupe_key)
        if (it.resolve) {
          if (cur && ['open', 'acknowledged'].includes(cur.state)) { Object.assign(cur, { state: 'resolved', resolved_at: iso(), resolved_by: 'auto:condition_cleared' }); out.resolved += 1 }
          continue
        }
        clean({ title: it.title, detail: it.detail })
        keys.add(it.dedupe_key)
        if (!cur) {
          items.set(it.dedupe_key, { work_item_id: memoryItemId(it.dedupe_key), scope, state: 'open', severity: 'info', escalated: false, detail: {}, priority: 0, ...it, first_seen_at: iso(), last_seen_at: iso(), seen_count: 1, source_job_id: job_id, resolved_at: null, resolved_by: null })
          out.inserted += 1
        } else {
          const reopen = cur.state === 'resolved' && String(cur.resolved_by || '').startsWith('auto:')
          Object.assign(cur, { ...it, state: reopen ? 'open' : cur.state, resolved_at: reopen ? null : cur.resolved_at, resolved_by: reopen ? null : cur.resolved_by, last_seen_at: iso(), seen_count: cur.seen_count + 1, source_job_id: job_id })
          if (reopen) out.reopened += 1; else out.updated += 1
        }
      }
      if (close_missing) for (const it of items.values()) if (it.scope === scope && ['open', 'acknowledged'].includes(it.state) && !keys.has(it.dedupe_key)) { Object.assign(it, { state: 'resolved', resolved_at: iso(), resolved_by: 'auto:condition_cleared' }); out.resolved += 1 }
      writes.push({ fn: 'syncWorkItems', job_id, scope, n: list.length })
      return out
    },
    async decideWorkItem({ work_item_id, by, action }) {
      if (!UUID.test(String(by))) return { ok: false, reason: 'by_not_named_operator' }
      const it = [...items.values()].find((x) => x.work_item_id === work_item_id)
      if (!it) return { ok: false, reason: 'not_found' }
      const from = it.state
      if (action === 'acknowledge' && from === 'open') Object.assign(it, { state: 'acknowledged', acknowledged_by: by })
      else if (['resolve', 'dismiss'].includes(action) && ['open', 'acknowledged'].includes(from)) Object.assign(it, { state: action === 'resolve' ? 'resolved' : 'dismissed', resolved_at: iso(), resolved_by: by })
      else if (action === 'reopen' && ['resolved', 'dismissed'].includes(from)) Object.assign(it, { state: 'open', resolved_at: null, resolved_by: null, acknowledged_by: null })
      else return { ok: false, reason: 'transition_invalid', state: from }
      return { ok: true, work_item_id, from, action }
    },
    async actionCenterSummary() {
      const counts = Object.fromEntries(ACTION_STATES.map((s) => [s, 0]))
      let lost = 0
      let at = null
      for (const s of states.values()) { counts[s.state] += 1; if (s.lost) lost += 1; if (!at || s.computed_at > at) at = s.computed_at }
      return { counts, lost, active_queue: counts.needs_attention, total: states.size, computed_at: at, lost_ids: [...states.values()].filter((s) => s.lost).map((s) => s.conversation_id).slice(0, 10) }
    },
    async listActionStates({ state = null, lost = null, limit = 50, before = null } = {}) {
      return [...states.values()].filter((s) => (!state || s.state === state) && (lost == null || s.lost === lost) && (!before || s.conversation_id > before)).sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : 1)).slice(0, limit).map((s) => structuredClone(s))
    },
    async workItemsFor({ conversation_ids = [] } = {}) {
      const ids = new Set(conversation_ids)
      return [...items.values()].filter((w) => w.subject_type === 'conversation' && ids.has(w.subject_id) && ['open', 'acknowledged'].includes(w.state)).map((w) => structuredClone(w))
    },
    async listWorkItems({ states: st = ['open', 'acknowledged'], scope = null, limit = 50 } = {}) {
      return [...items.values()].filter((w) => st.includes(w.state) && (!scope || w.scope === scope)).slice(0, limit).map((w) => structuredClone(w))
    },
    async resolvedWorkItemsSince({ since } = {}) {
      return [...items.values()].filter((w) => w.resolved_at && w.resolved_at >= since).map((w) => structuredClone(w))
    },
    async pendingApprovalTargets() { return [] },
    async latestFinding({ finding_type, since = null } = {}) {
      const all = findings ? findings() : runtime ? [...runtime._state.findings.values()] : []
      const f = all.filter((x) => x.finding_type === finding_type && (!since || x.retrieved_at >= since)).sort((a, b) => (a.retrieved_at < b.retrieved_at ? 1 : -1))[0]
      return f ? { job_id: f.job_id, value: f.value, retrieved_at: f.retrieved_at } : null
    },
    async recoveryCandidatesSince({ since } = {}) {
      const all = findings ? findings() : runtime ? [...runtime._state.findings.values()] : []
      return all.filter((x) => x.finding_type === 'recovery.candidate' && x.retrieved_at >= since).map((x) => ({ conversation_id: x.value?.conversation_id, class: x.value?.class, priority: Number(x.value?.priority || 0) }))
    },
  }
}

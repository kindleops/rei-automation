// Read model for persistent missions (Missions API, supervisor wait, mission spend,
// the morning digest). READ ONLY: every statement runs inside BEGIN READ ONLY with a
// statement_timeout, over the agent_api pool, and reads schema agent only
// (agent_api SELECT grants from the S3 / research / R2 / capabilities migrations).
// Writes never happen here: they go through agent.runtime_* (job-runtime.js).
//
//   createMissionPgReads({ pool })            production / local PG
//   createMissionMemoryReads(memoryStore, o)  over createRuntimeMemoryStore()._state (tests)
import { AgentError } from '../runtime/store.js'

const RUNTIME_COLS = `job_id, kind, state, requested_by, trigger_kind, trigger_ref, priority, attempt, max_attempts, next_attempt_at,
  heartbeat_at, cancel_requested_at, budget_cap_usd, input, progress, checkpoint, result, last_error, schedule_id, schedule_slot,
  created_at, updated_at, ended_at`

const toIso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const num = (v) => (v == null ? 0 : Number(v))

function shapeJob(r) {
  if (!r) return null
  return {
    job_id: r.job_id, kind: r.kind, state: r.state, requested_by: r.requested_by, trigger_kind: r.trigger_kind, trigger_ref: r.trigger_ref,
    priority: Number(r.priority), attempt: Number(r.attempt), max_attempts: Number(r.max_attempts), next_attempt_at: toIso(r.next_attempt_at),
    heartbeat_at: toIso(r.heartbeat_at), cancel_requested_at: toIso(r.cancel_requested_at), budget_cap_usd: num(r.budget_cap_usd),
    input: r.input || {}, progress: r.progress || {}, checkpoint: r.checkpoint || {}, result: r.result ?? null, last_error: r.last_error ?? null,
    schedule_id: r.schedule_id == null ? null : Number(r.schedule_id), schedule_slot: toIso(r.schedule_slot),
    created_at: toIso(r.created_at), updated_at: toIso(r.updated_at), ended_at: toIso(r.ended_at),
  }
}

function shapeSpend(rows) {
  const out = { committed_usd: 0, settled_usd: 0, reserved_open_usd: 0, unknown_usd: 0, released_usd: 0, calls: 0, escalation_usd: 0, escalation_calls: 0 }
  for (const r of rows) {
    const st = r.state
    const committed = st === 'settled' ? num(r.actual_usd) : st === 'released' ? 0 : num(r.reserved_usd)
    out.committed_usd += committed
    if (st === 'settled') out.settled_usd += num(r.actual_usd)
    if (st === 'reserved') out.reserved_open_usd += num(r.reserved_usd)
    if (st === 'unknown') out.unknown_usd += num(r.reserved_usd)
    if (st === 'released') out.released_usd += num(r.reserved_usd)
    if (st !== 'released') out.calls += 1
    if (r.purpose === 'escalation') { out.escalation_usd += committed; if (st !== 'released') out.escalation_calls += 1 }
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1e6) / 1e6
  return out
}

/** @param {{ pool: import('pg').Pool, statementTimeoutMs?: number }} o */
export function createMissionPgReads({ pool, statementTimeoutMs = 5000 } = {}) {
  if (!pool) throw new AgentError('MISSION_READS_POOL_REQUIRED', 'a pg Pool is required')
  const st = Math.min(Math.max(Math.trunc(statementTimeoutMs), 500), 10_000)
  async function q(sql, params = []) {
    let client
    try { client = await pool.connect() } catch { throw new AgentError('AGENT_RUNTIME_DB_UNAVAILABLE', 'mission reads unavailable') }
    try {
      await client.query('begin read only')
      await client.query(`set local statement_timeout = ${st}`)
      const { rows } = await client.query(sql, params)
      await client.query('rollback')
      return rows
    } catch (err) {
      try { await client.query('rollback') } catch { /* broken connection */ }
      if (err instanceof AgentError) throw err
      throw Object.assign(new AgentError(err?.code === '57014' ? 'AGENT_RUNTIME_DB_TIMEOUT' : 'AGENT_RUNTIME_DB_UNAVAILABLE', 'mission read failed'), { pg_code: err?.code || null })
    } finally {
      client.release()
    }
  }
  return Object.freeze({
    kind: 'postgres',
    async getJob(job_id) {
      return shapeJob((await q(`select ${RUNTIME_COLS} from agent.research_job where job_id = $1 and runtime_managed`, [job_id]))[0])
    },
    async getJobs(ids) {
      if (!ids?.length) return []
      return (await q(`select ${RUNTIME_COLS} from agent.research_job where job_id = any($1::text[]) and runtime_managed`, [ids.slice(0, 50)])).map(shapeJob)
    },
    /** newest first; keyset on (created_at, job_id) — research_job_runtime_recent_idx / research_job_requested_recent_idx */
    async listJobs({ requested_by = null, kinds = null, states = null, before = null, limit = 50 } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const rows = await q(`select ${RUNTIME_COLS} from agent.research_job
         where runtime_managed
           and ($1::text is null or requested_by = $1)
           and ($2::text[] is null or kind = any($2))
           and ($3::text[] is null or state = any($3))
           and ($4::timestamptz is null or (created_at, job_id) < ($4::timestamptz, $5::text))
         order by created_at desc, job_id desc limit $6`, [requested_by, kinds, states, before?.created_at || null, before?.job_id || '', lim])
      return rows.map(shapeJob)
    },
    async jobEvents(job_id, { after = 0, limit = 200 } = {}) {
      return (await q(`select id, at, type, state, attempt, actor, payload from agent.job_event where job_id = $1 and id > $2 order by id limit $3`, [job_id, Number(after) || 0, Math.min(Number(limit) || 200, 500)]))
        .map((e) => ({ id: Number(e.id), at: toIso(e.at), type: e.type, state: e.state, attempt: Number(e.attempt), actor: e.actor, payload: e.payload || {} }))
    },
    async jobFindings(job_id, { limit = 200 } = {}) {
      return (await q(`select finding_id, finding_type, key, value, source_id, citation, confidence, evidence_status, retrieved_at from agent.finding where job_id = $1 order by retrieved_at, finding_id limit $2`, [job_id, Math.min(Number(limit) || 200, 500)]))
        .map((f) => ({ ...f, confidence: Number(f.confidence), retrieved_at: toIso(f.retrieved_at) }))
    },
    async jobSpend(job_id) {
      return shapeSpend(await q('select state, reserved_usd, actual_usd, purpose from agent.spend_ledger where job_id = $1', [job_id]))
    },
    async spendTotals() {
      const r = (await q(`select
          coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where day = (clock_timestamp() at time zone 'utc')::date), 0) day_usd,
          coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0) cycle_usd
        from agent.spend_ledger where cycle = to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM')`))[0] || {}
      return { day_usd: num(r.day_usd), cycle_usd: num(r.cycle_usd) }
    },
    async researchLimits() {
      const r = (await q('select enabled, day_usd, cycle_usd, run_usd, escalation_calls_per_run, escalation_usd_per_run from agent.research_limits where id = 1'))[0]
      if (!r) return { enabled: false, day_usd: 0, cycle_usd: 0, run_usd: 0, escalation_calls_per_run: 0, escalation_usd_per_run: 0 }
      return { enabled: r.enabled === true, day_usd: num(r.day_usd), cycle_usd: num(r.cycle_usd), run_usd: num(r.run_usd), escalation_calls_per_run: num(r.escalation_calls_per_run), escalation_usd_per_run: num(r.escalation_usd_per_run) }
    },
    async membership(org_id, user_id) {
      const r = (await q('select role from agent.operator_membership where org_id = $1 and user_id::text = $2', [org_id, user_id]))[0]
      return r ? { role: r.role } : null
    },
    /** keys of findings of this type already recorded by any job since `since` (discovery de-dupe; finding_type_key_job_idx) */
    async recentFindingKeys({ finding_type, keys, since }) {
      if (!keys?.length) return new Set()
      const rows = await q('select distinct key from agent.finding where job_id is not null and finding_type = $1 and key = any($2::text[]) and retrieved_at >= $3', [finding_type, keys.slice(0, 1000), since])
      return new Set(rows.map((r) => r.key))
    },
    async pendingApprovals({ org_id, limit = 20 } = {}) {
      const rows = await q(`select approval_id, capability_id, state, created_at, expires_at from agent.approval_request
         where org_id = $1 and state = 'pending' and expires_at > clock_timestamp() order by created_at desc limit $2`, [org_id, Math.min(Number(limit) || 20, 100)])
      return rows.map((r) => ({ approval_id: r.approval_id, capability_id: r.capability_id, created_at: toIso(r.created_at), expires_at: toIso(r.expires_at) }))
    },
    /** Digest: runtime jobs ended / created since `since` (bounded), cost per job from the ledger. */
    async activitySince({ since, limit = 500 } = {}) {
      const jobs = await q(`select j.job_id, j.kind, j.state, j.created_at, j.ended_at,
           coalesce((select sum(agent.spend_committed(l.state, l.reserved_usd, l.actual_usd)) from agent.spend_ledger l where l.job_id = j.job_id), 0) cost_usd
         from agent.research_job j where j.runtime_managed and (j.created_at >= $1 or j.ended_at >= $1) order by j.created_at desc limit $2`, [since, Math.min(Number(limit) || 500, 1000)])
      const findings = await q(`select finding_type, count(*)::int n from agent.finding where job_id is not null and retrieved_at >= $1 group by 1 order by 2 desc limit 50`, [since])
      return { jobs: jobs.map((j) => ({ job_id: j.job_id, kind: j.kind, state: j.state, created_at: toIso(j.created_at), ended_at: toIso(j.ended_at), cost_usd: num(j.cost_usd) })), findings: findings.map((f) => ({ finding_type: f.finding_type, n: Number(f.n) })) }
    },
  })
}

/**
 * Memory twin over createRuntimeMemoryStore()._state (+ optional research limits / members / approvals).
 * @param {object} memoryStore
 * @param {{ members?: Array<{ org_id: string, user_id: string, role: string }>, approvals?: () => Array<object>, now?: () => number }} [o]
 */
export function createMissionMemoryReads(memoryStore, { members = [], approvals = () => [], now = () => Date.now() } = {}) {
  const S = memoryStore._state
  const all = () => [...S.jobs.values()].sort((a, b) => (a._seq < b._seq ? 1 : -1))
  return Object.freeze({
    kind: 'memory',
    async getJob(job_id) { const j = S.jobs.get(job_id); return j ? shapeJob(structuredClone(j)) : null },
    async getJobs(ids) { return ids.map((id) => S.jobs.get(id)).filter(Boolean).map((j) => shapeJob(structuredClone(j))) },
    async listJobs({ requested_by = null, kinds = null, states = null, before = null, limit = 50 } = {}) {
      let rows = all().filter((j) => (!requested_by || j.requested_by === requested_by) && (!kinds || kinds.includes(j.kind)) && (!states || states.includes(j.state)))
      if (before?.job_id) { const i = rows.findIndex((j) => j.job_id === before.job_id); if (i >= 0) rows = rows.slice(i + 1) }
      return rows.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((j) => shapeJob(structuredClone(j)))
    },
    async jobEvents(job_id, { after = 0 } = {}) { return S.events.filter((e) => e.job_id === job_id && e.id > after).map((e) => structuredClone(e)) },
    async jobFindings(job_id) { return [...S.findings.values()].filter((f) => f.job_id === job_id).map((f) => structuredClone(f)) },
    async jobSpend(job_id) { return shapeSpend(S.ledger.filter((r) => r.job_id === job_id)) },
    async spendTotals() {
      const day = new Date(now()).toISOString().slice(0, 10)
      const c = shapeSpend(S.ledger)
      return { day_usd: shapeSpend(S.ledger.filter((r) => r.day === day)).committed_usd, cycle_usd: c.committed_usd }
    },
    async researchLimits() { return { enabled: S.spend.enabled === true, day_usd: S.spend.day_usd, cycle_usd: S.spend.cycle_usd ?? 150, run_usd: S.spend.run_usd, escalation_calls_per_run: 2, escalation_usd_per_run: 2 } },
    async membership(org_id, user_id) { const m = members.find((x) => x.org_id === org_id && x.user_id === user_id); return m ? { role: m.role } : null },
    async recentFindingKeys({ finding_type, keys, since }) {
      const ks = new Set(keys)
      return new Set([...S.findings.values()].filter((f) => f.finding_type === finding_type && ks.has(f.key) && f.retrieved_at >= since).map((f) => f.key))
    },
    async pendingApprovals() { return approvals().filter((a) => a.state === 'pending') },
    async activitySince({ since }) {
      const jobs = all().filter((j) => j.created_at >= since || (j.ended_at && j.ended_at >= since)).map((j) => ({ job_id: j.job_id, kind: j.kind, state: j.state, created_at: j.created_at, ended_at: j.ended_at, cost_usd: shapeSpend(S.ledger.filter((r) => r.job_id === j.job_id)).committed_usd }))
      const by = {}
      for (const f of S.findings.values()) if (f.retrieved_at >= since) by[f.finding_type] = (by[f.finding_type] || 0) + 1
      return { jobs, findings: Object.entries(by).map(([finding_type, n]) => ({ finding_type, n })) }
    },
  })
}

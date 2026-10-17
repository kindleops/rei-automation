// R2 persistent intelligence runtime — job store (DB authority + memory twin).
//
// Schema: supabase/migrations/PROPOSED_20261012140000_intel_runtime.sql (PROPOSED).
// ONE job system: runtime missions are rows of agent.research_job whose kind is
// not 'research.*'. Every write goes through an agent.runtime_* SECURITY DEFINER
// function; the DB enforces the state graph, leases, concurrency, the emergency
// stop and the budget (agent.spend_ledger_guard). This module only calls them.
//
//   createRuntimePgStore({ pool })   production: one bounded transaction per call
//                                    (statement_timeout ≤ 5 s, lock_timeout 2 s)
//   createRuntimeMemoryStore(opts)   unit-test twin with the SAME rules (refused in
//                                    production by the tick route, which only
//                                    builds the pg store)
//
// Every call is idempotent or safely repeatable: a lost response to claim()
// leaves a lease that expires and is reaped (retry with backoff); finish() with
// the same token returns the recorded state; enqueue dedupes on its key.
import crypto from 'node:crypto'
import { AgentError } from './store.js'

export const RUNTIME_JOB_STATES = Object.freeze(['queued', 'claimed', 'running', 'completed', 'waiting_for_approval', 'paused', 'retrying', 'failed', 'cancelled', 'budget_blocked', 'dead_letter'])
export const RUNTIME_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'dead_letter'])

/** Mirror of agent.runtime_transition_ok (a pg test compares every pair). */
export const RUNTIME_JOB_TRANSITIONS = Object.freeze({
  waiting_for_approval: ['queued', 'cancelled'],
  queued: ['claimed', 'cancelled', 'paused'],
  claimed: ['running', 'retrying', 'dead_letter', 'cancelled', 'budget_blocked'],
  running: ['completed', 'failed', 'retrying', 'dead_letter', 'cancelled', 'budget_blocked', 'waiting_for_approval', 'paused'],
  retrying: ['claimed', 'cancelled', 'paused', 'dead_letter'],
  paused: ['queued', 'cancelled'],
  budget_blocked: ['queued', 'cancelled'],
  failed: ['queued'],
  dead_letter: ['queued'],
  completed: [],
  cancelled: [],
})

export const canRuntimeTransition = (from, to) => Array.isArray(RUNTIME_JOB_TRANSITIONS[from]) && RUNTIME_JOB_TRANSITIONS[from].includes(to)

export const FINISH_OUTCOMES = Object.freeze(['completed', 'failed', 'retry', 'cancelled', 'release', 'waiting_for_approval', 'paused'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KIND_RE = /^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,40}){1,3}$/
export const isNamedOperator = (v) => typeof v === 'string' && UUID_RE.test(v)
export const isRuntimeKind = (k) => typeof k === 'string' && KIND_RE.test(k) && !k.startsWith('research.')

/** Idempotency keys are sha256 hex of a caller string: no raw identifier is ever stored. */
export function runtimeIdempotencyKey(...parts) {
  return crypto.createHash('sha256').update(parts.map((p) => String(p)).join('\u001f')).digest('hex')
}

export function backoffSeconds(attempt, base = 30, max = 3600) {
  return Math.min(max, base * 2 ** (Math.max(Number(attempt) || 1, 1) - 1))
}

// ── Postgres store ──────────────────────────────────────────────────────────
const CODE_RE = /^(AGENT_[A-Z_]+)/

function dbError(err) {
  if (err instanceof AgentError) return err
  const m = CODE_RE.exec(String(err?.message || ''))
  const e = new AgentError(m ? m[1] : err?.code === '57014' ? 'AGENT_RUNTIME_DB_TIMEOUT' : err?.code === '55P03' ? 'AGENT_RUNTIME_DB_LOCK_TIMEOUT' : 'AGENT_RUNTIME_DB_UNAVAILABLE', m ? m[1] : 'runtime store unavailable')
  e.pg_code = err?.code || null
  return e
}

/**
 * @param {{ pool: import('pg').Pool, statementTimeoutMs?: number, lockTimeoutMs?: number }} opts
 */
export function createRuntimePgStore({ pool, statementTimeoutMs = 5000, lockTimeoutMs = 2000 } = {}) {
  if (!pool) throw new AgentError('RUNTIME_STORE_POOL_REQUIRED', 'a pg Pool is required')
  const st = Math.min(Math.max(Math.trunc(statementTimeoutMs), 500), 5000)
  const lt = Math.min(Math.max(Math.trunc(lockTimeoutMs), 100), 5000)

  async function call(sql, params) {
    let client
    try {
      client = await pool.connect()
    } catch (err) {
      throw dbError(err)
    }
    try {
      await client.query('begin isolation level read committed')
      await client.query(`set local statement_timeout = ${st}`)
      await client.query(`set local lock_timeout = ${lt}`)
      const { rows } = await client.query(sql, params)
      await client.query('commit')
      return rows[0]?.r ?? null
    } catch (err) {
      try { await client.query('rollback') } catch { /* connection already broken */ }
      throw dbError(err)
    } finally {
      client.release()
    }
  }
  const j = (v) => (v == null ? null : JSON.stringify(v))

  return Object.freeze({
    kind: 'postgres',
    async assertLeastPrivilege() {
      const r = await call("select jsonb_build_object('super', rolsuper, 'bypassrls', rolbypassrls) r from pg_roles where rolname = current_user")
      if (!r || r.super || r.bypassrls) throw new AgentError('AGENT_RUNTIME_ROLE_PRIVILEGED', 'the runtime store must connect as agent_api (no superuser, no BYPASSRLS)')
      return true
    },
    async limits() {
      const r = await call(`select jsonb_build_object('runtime_enabled', runtime_enabled, 'emergency_stop', emergency_stop, 'tick_max_jobs', tick_max_jobs,
          'tick_budget_ms', tick_budget_ms, 'lease_seconds', lease_seconds, 'max_concurrency_global', max_concurrency_global) r from agent.runtime_limits where id = 1`)
      if (!r) throw new AgentError('AGENT_RUNTIME_LIMITS_MISSING', 'agent.runtime_limits row missing (migration not applied?)')
      return r
    },
    enqueue: (o) => call('select agent.runtime_enqueue($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9) r', [o.kind, o.idempotency_key, j(o.input || {}), o.requested_by, o.priority ?? 100, o.max_attempts ?? 3, o.budget_cap_usd ?? 0, Boolean(o.require_approval), o.not_before ?? null]),
    enqueueEvent: (o) => call('select agent.runtime_enqueue_event($1, $2, $3::jsonb, $4) r', [o.kind, o.event_key, j(o.input || {}), o.priority ?? 100]),
    // rc-8.5.20: an event job that is due no earlier than not_before (PROPOSED_20261016120000_conversation_reply_turns.sql)
    enqueueEventAt: (o) => call('select agent.runtime_enqueue_event_at($1, $2, $3::jsonb, $4, $5::timestamptz) r', [o.kind, o.event_key, j(o.input || {}), o.priority ?? 100, o.not_before ?? null]),
    enqueueDueSchedules: ({ limit = 10 } = {}) => call('select agent.runtime_enqueue_due_schedules($1) r', [limit]),
    claim: ({ worker, limit = 1, kinds = null }) => call('select agent.runtime_claim($1, $2, $3::text[]) r', [worker, limit, kinds]),
    start: ({ job_id, token }) => call('select agent.runtime_start($1, $2::uuid) r', [job_id, token]),
    checkpoint: (o) => call('select agent.runtime_checkpoint($1, $2::uuid, $3::jsonb, $4::jsonb, $5, $6::jsonb) r', [o.job_id, o.token, j(o.progress), j(o.checkpoint), o.event_type ?? null, j(o.event_payload)]),
    finish: (o) => call('select agent.runtime_finish($1, $2::uuid, $3, $4::jsonb, $5::jsonb) r', [o.job_id, o.token, o.outcome, j(o.result), j(o.error)]),
    reap: ({ limit = 20 } = {}) => call('select agent.runtime_reap($1) r', [limit]),
    reserve: (o) => call('select agent.runtime_reserve($1, $2::uuid, $3, $4, $5) r', [o.job_id, o.token, o.model, o.reserved_usd, o.purpose || 'default']),
    settle: (o) => call('select agent.runtime_settle($1, $2::uuid, $3::uuid, $4, $5::jsonb) r', [o.job_id, o.token, o.reserve_id, o.actual_usd ?? null, j(o.usage)]),
    recordFinding: (o) => call('select agent.runtime_record_finding($1, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8) r', [o.job_id, o.token, o.finding_type, o.key, j(o.value), o.source_id, o.confidence ?? 1, o.citation ?? null]),
    scheduleWatermark: (o) => call('select agent.runtime_schedule_watermark($1, $2::uuid, $3::jsonb) r', [o.job_id, o.token, j(o.watermark || {})]),
    cancel: ({ job_id, by }) => call('select agent.runtime_cancel($1, $2) r', [job_id, by]),
    requeue: ({ job_id, by }) => call('select agent.runtime_requeue($1, $2) r', [job_id, by]),
    approve: ({ job_id, by }) => call('select agent.runtime_approve($1, $2) r', [job_id, by]),
    pause: ({ job_id, by }) => call('select agent.runtime_pause($1, $2) r', [job_id, by]),
    emergencyStop: ({ by, reason = null }) => call('select agent.runtime_emergency_stop($1, $2) r', [by, reason]),
    pauseKind: ({ kind, by }) => call('select agent.runtime_pause_kind($1, $2) r', [kind, by]),
    heartbeat: ({ worker, summary = {} }) => call('select agent.runtime_heartbeat($1, $2::jsonb) r', [worker, j(summary)]),
    status: () => call('select agent.runtime_status() r'),
    purge: ({ limit = 200 } = {}) => call('select agent.runtime_purge($1) r', [limit]),
    healthSnapshot: ({ overdue_minutes = 15, processing_stale_minutes = 10 } = {}) => call('select agent.ops_health_snapshot($1, $2) r', [overdue_minutes, processing_stale_minutes]),
    async jobEvents(job_id, { after = 0, limit = 200 } = {}) {
      return call(`select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb) r from (
          select id, job_id, at, type, state, attempt, actor, payload from agent.job_event where job_id = $1 and id > $2 order by id limit $3) e`, [job_id, after, Math.min(Number(limit) || 200, 500)])
    },
  })
}

// ── memory twin (unit tests) ────────────────────────────────────────────────
/**
 * Same rules as the SQL functions: born OFF, named operators, sha256 keys,
 * transition graph, global + per-kind concurrency, leases, reaper backoff,
 * dead-letter, cancel, emergency stop, budget refusal ⇒ budget_blocked,
 * schedule slot at most once, append-only events.
 * @param {{ now?: () => number, limits?: object, research?: { enabled?: boolean, day_usd?: number, run_usd?: number }, health?: () => object }} [opts]
 */
export function createRuntimeMemoryStore({ now = () => Date.now(), limits = {}, research = {}, health = null } = {}) {
  const lim = {
    runtime_enabled: false, emergency_stop: false, emergency_stop_at: null, emergency_stop_by: null, max_concurrency_global: 2,
    kind_limits: {}, lease_seconds: 60, backoff_base_seconds: 30, backoff_max_seconds: 3600, tick_max_jobs: 2, tick_budget_ms: 25_000, ...limits,
  }
  const spend = { enabled: false, day_usd: 10, run_usd: 2.5, ...research }
  const jobs = new Map()
  const events = []
  const ledger = []
  const findings = new Map()
  const schedules = new Map()
  const heartbeats = new Map()
  let seq = 0
  let schedSeq = 0
  let chain = Promise.resolve()
  const iso = (ms) => new Date(ms).toISOString()
  // calls are serialized like the advisory locks / row locks they mirror
  const serial = (fn) => {
    const p = chain.then(fn, fn)
    chain = p.then(() => undefined, () => undefined)
    return p
  }
  const transition = (job, to) => {
    if (job.state !== to && !canRuntimeTransition(job.state, to)) throw new AgentError('AGENT_JOB_ILLEGAL_TRANSITION', `${job.state} → ${to}`)
    if (job.state === to && RUNTIME_TERMINAL_STATES.includes(to)) throw new AgentError('AGENT_JOB_TERMINAL', to)
    job.state = to
    job.updated_at = iso(now())
    job.ended_at = RUNTIME_TERMINAL_STATES.includes(to) ? iso(now()) : null
  }
  const emit = (job, type, actor, payload = {}) => events.push({ id: ++seq, job_id: job.job_id, at: iso(now()), type, state: job.state, attempt: job.attempt, actor, payload: structuredClone(payload) })
  const clearLease = (job) => Object.assign(job, { lease_token: null, lease_owner: null, lease_until: null })
  const stopReason = (kind) => (lim.emergency_stop ? 'emergency_stop' : !lim.runtime_enabled ? 'runtime_disabled' : lim.kind_limits?.[kind]?.enabled !== true ? 'kind_disabled' : null)
  const leased = (job_id, token) => {
    const job = jobs.get(job_id)
    return job && job.lease_token === token && ['claimed', 'running'].includes(job.state) ? job : null
  }
  const unknownOpen = (job_id) => { for (const l of ledger) if (l.job_id === job_id && l.state === 'reserved') l.state = 'unknown' }
  // mirror of runtime_enqueue_event(_at): kind_limits.<kind>.event_budget_cap_usd (absent ⇒ 0) clamped to
  // [0, agent.runtime_event_budget_ceiling(kind)] — 0.05 unless limits.event_budget_ceilings names the kind (hard max 0.30)
  const eventBudgetCap = (kind) => {
    const raw = Number(lim.kind_limits?.[kind]?.event_budget_cap_usd)
    const ceil = Math.min(Math.max(Number(lim.event_budget_ceilings?.[kind] ?? 0.05), 0), 0.30)
    return Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), ceil)
  }

  function enqueueCore({ kind, idempotency_key, input = {}, requested_by, trigger_kind, trigger_ref, priority = 100, max_attempts = 3, budget_cap_usd = 0, require_approval = false, schedule_id = null, schedule_slot = null, not_before = null }) {
    if (!isRuntimeKind(kind)) return { ok: false, reason: 'kind_invalid' }
    if (!isNamedOperator(requested_by)) return { ok: false, reason: 'requested_by_not_named_operator' }
    if (!/^[0-9a-f]{64}$/.test(String(idempotency_key || ''))) return { ok: false, reason: 'idempotency_key_must_be_sha256_hex' }
    for (const j of jobs.values()) {
      if ((j.kind === kind && j.idempotency_key === idempotency_key) || (schedule_id != null && j.schedule_id === schedule_id && j.schedule_slot === schedule_slot)) return { ok: true, deduped: true, job_id: j.job_id, state: j.state }
    }
    const t = now()
    const job = {
      job_id: `mjob_${crypto.randomUUID()}`, kind, state: require_approval ? 'waiting_for_approval' : 'queued', requested_by, trigger_kind, trigger_ref, idempotency_key,
      priority, attempt: 0, max_attempts, next_attempt_at: iso(Math.max(not_before ? Date.parse(not_before) : t, t)), budget_cap_usd: Number(budget_cap_usd), input: structuredClone(input),
      progress: {}, checkpoint: {}, result: null, last_error: null, lease_token: null, lease_owner: null, lease_until: null, finished_token: null,
      cancel_requested_at: null, cancel_requested_by: null, schedule_id, schedule_slot, created_at: iso(t), updated_at: iso(t), ended_at: null, _seq: ++seq,
    }
    jobs.set(job.job_id, job)
    emit(job, 'job.enqueued', `enqueue:${trigger_kind}`, { trigger_kind, trigger_ref, priority, max_attempts, budget_cap_usd: job.budget_cap_usd, requires_approval: Boolean(require_approval) })
    return { ok: true, deduped: false, job_id: job.job_id, state: job.state }
  }

  const store = {
    kind: 'memory',
    _state: { jobs, events, ledger, findings, schedules, heartbeats, lim, spend },
    setLimits: (patch) => Object.assign(lim, patch),
    setResearch: (patch) => Object.assign(spend, patch),
    async limits() { return { runtime_enabled: lim.runtime_enabled, emergency_stop: lim.emergency_stop, tick_max_jobs: lim.tick_max_jobs, tick_budget_ms: lim.tick_budget_ms, lease_seconds: lim.lease_seconds, max_concurrency_global: lim.max_concurrency_global } },
    enqueue: (o) => serial(() => enqueueCore({ ...o, trigger_kind: 'manual', trigger_ref: 'manual' })),
    enqueueEvent: ({ kind, event_key, input = {}, priority = 100 }) => serial(() => {
      if (!event_key || String(event_key).length > 200) return { ok: false, reason: 'event_key_invalid' }
      const armed = lim.kind_limits?.[kind]?.armed_by
      if (!armed) return { ok: false, reason: 'kind_not_armed' }
      return enqueueCore({ kind, idempotency_key: crypto.createHash('sha256').update(`event:${kind}:${event_key}`).digest('hex'), input, requested_by: armed, trigger_kind: 'event', trigger_ref: `event:${kind}`, priority, budget_cap_usd: eventBudgetCap(kind) })
    }),
    enqueueEventAt: ({ kind, event_key, input = {}, priority = 100, not_before = null }) => serial(() => {
      if (!event_key || String(event_key).length > 200) return { ok: false, reason: 'event_key_invalid' }
      if (!not_before || !Number.isFinite(Date.parse(not_before))) return { ok: false, reason: 'not_before_required' }
      if (Date.parse(not_before) > now() + 2 * 864e5) return { ok: false, reason: 'not_before_too_far' }
      const armed = lim.kind_limits?.[kind]?.armed_by
      if (!armed) return { ok: false, reason: 'kind_not_armed' }
      return enqueueCore({ kind, idempotency_key: crypto.createHash('sha256').update(`event:${kind}:${event_key}`).digest('hex'), input, requested_by: armed, trigger_kind: 'event', trigger_ref: `event:${kind}`, priority, not_before, budget_cap_usd: eventBudgetCap(kind) })
    }),
    upsertSchedule: ({ name, kind, interval_seconds, created_by, input = {}, enabled = false, first_run_at = null, budget_cap_usd = 0 }) => serial(() => {
      let s = [...schedules.values()].find((x) => x.name === name)
      if (!s) { s = { schedule_id: ++schedSeq, name, watermark: {}, last_slot: null, last_job_id: null, last_outcome: null, priority: 100, max_attempts: 3 }; schedules.set(s.schedule_id, s) }
      Object.assign(s, { kind, interval_seconds, created_by, input, enabled, budget_cap_usd, next_run_at: s.next_run_at || iso(first_run_at ? Date.parse(first_run_at) : now()) })
      return { ok: true, schedule_id: s.schedule_id }
    }),
    enqueueDueSchedules: ({ limit = 10 } = {}) => serial(() => {
      const t = now()
      const out = { enqueued: 0, deduped: 0, skipped: 0 }
      const due = [...schedules.values()].filter((s) => s.enabled && Date.parse(s.next_run_at) <= t).sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at)).slice(0, Math.min(Math.max(limit, 1), 50))
      for (const s of due) {
        const slot = Date.parse(s.next_run_at)
        const next = slot + s.interval_seconds * 1000 * (Math.floor((t - slot) / 1000 / s.interval_seconds) + 1)
        const stop = stopReason(s.kind)
        let r = null
        if (stop) { s.last_outcome = `skipped_${stop}`; out.skipped += 1 }
        else if ([...jobs.values()].some((j) => j.schedule_id === s.schedule_id && !j.ended_at)) { s.last_outcome = 'skipped_overlap'; out.skipped += 1 }
        else {
          r = enqueueCore({ kind: s.kind, idempotency_key: crypto.createHash('sha256').update(`schedule:${s.schedule_id}:${iso(slot).slice(0, 19)}`).digest('hex'), input: { ...s.input, schedule_watermark: s.watermark }, requested_by: s.created_by, trigger_kind: 'schedule', trigger_ref: `schedule:${s.schedule_id}`, priority: s.priority, max_attempts: s.max_attempts, budget_cap_usd: s.budget_cap_usd, schedule_id: s.schedule_id, schedule_slot: iso(slot) })
          if (r.deduped) { s.last_outcome = 'deduped'; out.deduped += 1 } else { s.last_outcome = 'enqueued'; out.enqueued += 1 }
        }
        Object.assign(s, { last_slot: iso(slot), next_run_at: iso(next), last_job_id: r?.job_id || s.last_job_id })
      }
      return out
    }),
    claim: ({ worker, limit = 1, kinds = null }) => serial(() => {
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(String(worker || ''))) return { ok: false, reason: 'worker_invalid', claimed: [] }
      if (lim.emergency_stop) return { ok: true, blocked: 'emergency_stop', claimed: [] }
      if (!lim.runtime_enabled) return { ok: true, blocked: 'runtime_disabled', claimed: [] }
      const enabled = Object.entries(lim.kind_limits || {}).filter(([k, v]) => v?.enabled === true && (!kinds || kinds.includes(k))).map(([k]) => k)
      if (!enabled.length) return { ok: true, blocked: 'no_kind_enabled', claimed: [] }
      const t = now()
      const active = {}
      let total = 0
      for (const j of jobs.values()) if (['claimed', 'running'].includes(j.state) && Date.parse(j.lease_until) > t) { active[j.kind] = (active[j.kind] || 0) + 1; total += 1 }
      const slots = Math.min(Math.max(limit, 0), lim.tick_max_jobs, lim.max_concurrency_global - total)
      if (slots <= 0) return { ok: true, blocked: 'concurrency', active: total, claimed: [] }
      const due = [...jobs.values()]
        .filter((j) => ['queued', 'retrying'].includes(j.state) && Date.parse(j.next_attempt_at) <= t && enabled.includes(j.kind) && !j.cancel_requested_at && j.attempt < j.max_attempts)
        .sort((a, b) => a.priority - b.priority || Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at) || (a.job_id < b.job_id ? -1 : 1))
      const claimed = []
      for (const j of due) {
        if ((active[j.kind] || 0) >= (lim.kind_limits[j.kind]?.max_concurrency ?? 1)) continue
        transition(j, 'claimed')
        Object.assign(j, { attempt: j.attempt + 1, lease_token: crypto.randomUUID(), lease_owner: worker, lease_until: iso(t + lim.lease_seconds * 1000), claimed_at: iso(t), heartbeat_at: iso(t), finished_token: null })
        emit(j, 'job.claimed', worker, { lease_seconds: lim.lease_seconds })
        active[j.kind] = (active[j.kind] || 0) + 1
        claimed.push({ job_id: j.job_id, kind: j.kind, lease_token: j.lease_token, lease_until: j.lease_until, attempt: j.attempt, max_attempts: j.max_attempts, input: structuredClone(j.input), checkpoint: structuredClone(j.checkpoint), budget_cap_usd: j.budget_cap_usd, requested_by: j.requested_by, schedule_id: j.schedule_id })
        if (claimed.length >= slots) break
      }
      return { ok: true, blocked: null, claimed }
    }),
    start: ({ job_id, token }) => serial(() => {
      const j = leased(job_id, token)
      if (!j) return { ok: false, reason: 'lease_lost' }
      if (j.state === 'claimed') { transition(j, 'running'); emit(j, 'job.started', j.lease_owner) }
      return { ok: true, state: j.state, cancel_requested: Boolean(j.cancel_requested_at), stop: stopReason(j.kind) }
    }),
    checkpoint: ({ job_id, token, progress = null, checkpoint = null, event_type = null, event_payload = null }) => serial(() => {
      const j = leased(job_id, token)
      if (!j || j.state !== 'running') return { ok: false, reason: 'lease_lost' }
      const stop = stopReason(j.kind)
      if (j.cancel_requested_at || stop) return { ok: true, cancel_requested: Boolean(j.cancel_requested_at), stop, lease_until: j.lease_until }
      Object.assign(j, { heartbeat_at: iso(now()), lease_until: iso(now() + lim.lease_seconds * 1000) })
      if (progress) j.progress = structuredClone(progress)
      if (checkpoint) j.checkpoint = structuredClone(checkpoint)
      if (event_type) emit(j, event_type, j.lease_owner, event_payload || {})
      return { ok: true, cancel_requested: false, stop: null, lease_until: j.lease_until }
    }),
    finish: ({ job_id, token, outcome, result = null, error = null }) => serial(() => {
      const j = jobs.get(job_id)
      if (!j) return { ok: false, reason: 'job_not_found' }
      if (j.finished_token === token && !j.lease_token) return { ok: true, idempotent: true, state: j.state }
      if (j.lease_token !== token || !['claimed', 'running'].includes(j.state)) return { ok: false, reason: 'lease_lost', state: j.state }
      const to = { completed: 'completed', failed: 'failed', cancelled: 'cancelled', waiting_for_approval: 'waiting_for_approval', paused: 'paused', retry: j.attempt >= j.max_attempts ? 'dead_letter' : 'retrying', release: 'retrying' }[outcome]
      if (!to) return { ok: false, reason: 'outcome_invalid' }
      let next = null
      if (outcome === 'retry' && to === 'retrying') next = iso(now() + backoffSeconds(j.attempt, lim.backoff_base_seconds, lim.backoff_max_seconds) * 1000)
      if (outcome === 'release') { j.attempt = Math.max(j.attempt - 1, 0); next = iso(now() + lim.backoff_base_seconds * 1000) }
      transition(j, to)
      unknownOpen(job_id)
      clearLease(j)
      Object.assign(j, { finished_token: token, next_attempt_at: next || j.next_attempt_at, result: result ?? j.result, last_error: error ?? j.last_error })
      if (to === 'completed') j.progress = { ...j.progress, pct: 100 }
      emit(j, `job.${to}`, outcome, { outcome, ...(error ? { error } : {}), ...(next ? { next_attempt_at: next } : {}) })
      return { ok: true, idempotent: false, state: j.state, next_attempt_at: next }
    }),
    reap: ({ limit = 20 } = {}) => serial(() => {
      const t = now()
      const out = { retrying: 0, dead_letter: 0, cancelled: 0 }
      const expired = [...jobs.values()].filter((j) => ['claimed', 'running'].includes(j.state) && Date.parse(j.lease_until) < t).sort((a, b) => Date.parse(a.lease_until) - Date.parse(b.lease_until)).slice(0, Math.min(Math.max(limit, 1), 100))
      for (const j of expired) {
        unknownOpen(j.job_id)
        const to = j.cancel_requested_at ? 'cancelled' : j.attempt >= j.max_attempts ? 'dead_letter' : 'retrying'
        const attempt = j.attempt
        transition(j, to)
        clearLease(j)
        if (to === 'retrying') j.next_attempt_at = iso(t + backoffSeconds(attempt, lim.backoff_base_seconds, lim.backoff_max_seconds) * 1000)
        j.last_error = { code: 'LEASE_EXPIRED', attempt }
        emit(j, 'job.lease_expired', 'reaper', { to, attempt, max_attempts: j.max_attempts })
        out[to] += 1
      }
      return out
    }),
    reserve: ({ job_id, token, model, reserved_usd, purpose = 'default' }) => serial(() => {
      const j = leased(job_id, token)
      if (!j) return { ok: false, reason: 'lease_lost' }
      const day = iso(now()).slice(0, 10)
      const committed = (rows) => rows.reduce((a, r) => a + (r.state === 'settled' ? r.actual_usd : r.state === 'released' ? 0 : r.reserved_usd), 0)
      let code = null
      if (!spend.enabled) code = 'AGENT_RESEARCH_DISABLED'
      else if (j.cancel_requested_at) code = 'AGENT_SPEND_JOB_CANCELLED'
      else if (committed(ledger.filter((r) => r.day === day)) + reserved_usd > spend.day_usd) code = 'AGENT_SPEND_CAP_DAY'
      else if (committed(ledger.filter((r) => r.job_id === job_id)) + reserved_usd > Math.min(spend.run_usd, j.budget_cap_usd)) code = 'AGENT_SPEND_CAP_JOB'
      if (code) {
        unknownOpen(job_id)
        transition(j, 'budget_blocked')
        clearLease(j)
        Object.assign(j, { finished_token: token, last_error: { code } })
        emit(j, 'job.budget_blocked', 'spend_ledger_guard', { code, requested_usd: reserved_usd })
        return { ok: false, reason: code, state: 'budget_blocked' }
      }
      const reserve_id = crypto.randomUUID()
      ledger.push({ reserve_id, job_id, operator_id: j.requested_by, model, purpose, day, reserved_usd, actual_usd: null, state: 'reserved' })
      emit(j, 'job.budget_reserved', j.lease_owner, { reserve_id, reserved_usd, model })
      return { ok: true, reserve_id }
    }),
    settle: ({ job_id, token, reserve_id, actual_usd = null }) => serial(() => {
      const j = leased(job_id, token)
      if (!j) return { ok: false, reason: 'lease_lost' }
      const r = ledger.find((x) => x.reserve_id === reserve_id && x.job_id === job_id)
      if (!r || (actual_usd == null ? r.state !== 'reserved' : !['reserved', 'unknown'].includes(r.state))) return { ok: false }
      Object.assign(r, actual_usd == null ? { state: 'released' } : { state: 'settled', actual_usd })
      emit(j, actual_usd == null ? 'job.budget_released' : 'job.budget_settled', j.lease_owner, { reserve_id, actual_usd })
      return { ok: true }
    }),
    recordFinding: ({ job_id, token, finding_type, key, value, source_id, confidence = 1 }) => serial(() => {
      const j = leased(job_id, token)
      if (!j || j.state !== 'running') return { ok: false, reason: 'lease_lost' }
      if (!/^[a-z]{2,20}\.[a-z_]{2,60}$/.test(finding_type) || !/^[a-z][a-z0-9_.:-]{0,79}$/.test(key) || !/^[a-z][a-z0-9_.:-]{0,79}$/.test(source_id)) return { ok: false, reason: 'finding_shape_invalid' }
      const k = `${job_id}|${finding_type}|${key}`
      const prev = findings.get(k)
      const finding_id = prev?.finding_id || `fnd_${crypto.randomUUID()}`
      findings.set(k, { finding_id, job_id, finding_type, key, value: structuredClone(value), source_id, confidence, evidence_status: 'internal_record', source_class: 'internal_record', actor_user_id: j.requested_by, retrieved_at: iso(now()) })
      emit(j, 'job.finding', j.lease_owner, { finding_id, finding_type, key })
      return { ok: true, finding_id }
    }),
    scheduleWatermark: ({ job_id, token, watermark }) => serial(() => {
      const j = leased(job_id, token)
      if (!j || j.schedule_id == null) return { ok: false, reason: 'lease_lost_or_unscheduled' }
      schedules.get(j.schedule_id).watermark = structuredClone(watermark || {})
      return { ok: true }
    }),
    cancel: ({ job_id, by }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      const j = jobs.get(job_id)
      if (!j) return { ok: false, reason: 'job_not_found' }
      if (RUNTIME_TERMINAL_STATES.includes(j.state)) return { ok: true, noop: true, state: j.state }
      j.cancel_requested_at ||= iso(now())
      j.cancel_requested_by ||= by
      if (['claimed', 'running'].includes(j.state)) { emit(j, 'job.cancel_requested', 'operator'); return { ok: true, pending: true, state: j.state } }
      transition(j, 'cancelled')
      emit(j, 'job.cancelled', 'operator')
      return { ok: true, pending: false, state: j.state }
    }),
    requeue: ({ job_id, by }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      const j = jobs.get(job_id)
      if (!j) return { ok: false, reason: 'job_not_found' }
      if (!['dead_letter', 'failed', 'budget_blocked', 'paused'].includes(j.state)) return { ok: false, reason: 'not_requeueable', state: j.state }
      const from = j.state
      transition(j, 'queued')
      Object.assign(j, { attempt: 0, next_attempt_at: iso(now()), cancel_requested_at: null, cancel_requested_by: null, finished_token: null })
      emit(j, 'job.requeued', 'operator', { from })
      return { ok: true, state: j.state, from }
    }),
    approve: ({ job_id, by }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      const j = jobs.get(job_id)
      if (!j || j.state !== 'waiting_for_approval') return { ok: false, reason: 'not_waiting_for_approval', state: j?.state }
      transition(j, 'queued')
      j.next_attempt_at = iso(now())
      emit(j, 'job.approved', 'operator')
      return { ok: true, state: j.state }
    }),
    pause: ({ job_id, by }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      const j = jobs.get(job_id)
      if (!j || !['queued', 'retrying'].includes(j.state)) return { ok: false, reason: 'not_pausable', state: j?.state }
      transition(j, 'paused')
      emit(j, 'job.paused', 'operator')
      return { ok: true, state: j.state }
    }),
    emergencyStop: ({ by, reason = null }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      Object.assign(lim, { emergency_stop: true, emergency_stop_at: lim.emergency_stop_at || iso(now()), emergency_stop_by: lim.emergency_stop_by || by, emergency_stop_reason: reason })
      return { ok: true, emergency_stop: true }
    }),
    pauseKind: ({ kind, by }) => serial(() => {
      if (!isNamedOperator(by)) return { ok: false, reason: 'by_not_named_operator' }
      if (lim.kind_limits[kind]) lim.kind_limits[kind] = { ...lim.kind_limits[kind], enabled: false }
      return { ok: true, kind, enabled: false }
    }),
    heartbeat: ({ worker, summary = {} }) => serial(() => {
      const h = heartbeats.get(worker) || { worker_id: worker, ticks: 0 }
      Object.assign(h, { last_tick_at: iso(now()), ticks: h.ticks + 1, last_summary: structuredClone(summary) })
      heartbeats.set(worker, h)
      return { ok: true }
    }),
    status: () => serial(() => {
      const open = {}
      for (const j of jobs.values()) if (!j.ended_at) open[j.state] = (open[j.state] || 0) + 1
      return { at: iso(now()), limits: { ...lim }, open, heartbeats: [...heartbeats.values()], schedules: [...schedules.values()] }
    }),
    purge: async () => ({ runtime_jobs: 0 }),
    healthSnapshot: async (opts) => {
      if (!health) throw new AgentError('AGENT_RUNTIME_DB_UNAVAILABLE', 'no health fixture')
      return health(opts)
    },
    async jobEvents(job_id) { return events.filter((e) => e.job_id === job_id) },
  }
  return store
}

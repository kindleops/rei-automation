// R2 runtime worker tick — one bounded pass, invoked once a minute by the
// Cloudflare cron lane "*/1 * * * *" (job agent_runtime_tick) through
// POST /api/internal/agent/runtime/tick.
//
// Per tick, in order, each phase isolated (a failing phase never skips the heartbeat):
//   1. limits      runtime_enabled=false ⇒ heartbeat only; emergency_stop ⇒ reap only
//   2. reap        expired leases → retrying (backoff) | dead_letter | cancelled
//   3. schedules   due slots enqueued at most once
//   4. claim       ≤ tick_max_jobs jobs of REGISTERED kinds only
//   5. run         sequentially, each inside the remaining wall-clock budget
//   6. heartbeat   agent.runtime_heartbeat (stale-worker monitoring)
// The wall-clock budget is hard: a handler that overruns is abandoned (its
// AbortSignal fires, its attempt is finished as 'retry'), and the tick returns.
// Status and progress are written only by the store (job rows + job_event); the
// tick fabricates nothing.
import { AgentError } from './store.js'

export const TICK_HARD_MAX_MS = 45_000
export const DEFAULT_TICK_BUDGET_MS = 25_000
const MIN_CLAIM_MS = 3_000
const SAFETY_MS = 1_000

/** Thrown inside a handler (via ctx.step / ctx.reserve) to stop between steps. */
export class RuntimeStop extends Error {
  constructor(reason) {
    super(`runtime stop: ${reason}`)
    this.reason = reason
  }
}

/** A handler throws this for a non-retryable failure (→ failed, not retry). */
export class RuntimePermanentError extends Error {
  constructor(code, message = code) {
    super(message)
    this.code = code
  }
}

const safeCode = (v, fallback = 'HANDLER_ERROR') => {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60)
  return /^[A-Z][A-Z0-9_]{1,59}$/.test(s) ? s : fallback
}

function createJobContext({ store, claim, deadlineAt, now }) {
  const ac = new AbortController()
  const base = { job_id: claim.job_id, token: claim.lease_token }
  let steps = 0
  const guard = (r) => {
    if (!r?.ok) throw new RuntimeStop('lease_lost')
    if (r.cancel_requested) throw new RuntimeStop('cancelled')
    if (r.stop) throw new RuntimeStop(`stop:${r.stop}`)
    if (ac.signal.aborted || now() >= deadlineAt) throw new RuntimeStop('deadline')
    return r
  }
  const ctx = {
    job: Object.freeze({ job_id: claim.job_id, kind: claim.kind, attempt: claim.attempt, max_attempts: claim.max_attempts, input: claim.input || {}, checkpoint: claim.checkpoint || {}, budget_cap_usd: Number(claim.budget_cap_usd || 0), schedule_id: claim.schedule_id ?? null, requested_by: claim.requested_by ?? null }),
    signal: ac.signal,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    /** Between steps: heartbeat + progress + checkpoint; throws RuntimeStop on cancel / stop / lease loss / deadline. */
    async step(name, { progress = null, checkpoint = null, payload = {} } = {}) {
      if (ac.signal.aborted || now() >= deadlineAt) throw new RuntimeStop('deadline')
      steps += 1
      return guard(await store.checkpoint({ ...base, progress: progress || { step: name, steps_done: steps - 1 }, checkpoint, event_type: 'job.step', event_payload: { step: name, ...payload } }))
    },
    /** Mid-step lease extension (no event, no progress change); throws RuntimeStop on cancel / stop / lease loss / deadline. */
    async heartbeat() {
      return guard(await store.checkpoint({ ...base }))
    },
    async reserve(model, reserved_usd, purpose = 'default') {
      const r = await store.reserve({ ...base, model, reserved_usd, purpose })
      if (!r?.ok) throw new RuntimeStop(r?.state === 'budget_blocked' ? 'budget_blocked' : 'lease_lost')
      return r.reserve_id
    },
    settle: (reserve_id, actual_usd, usage = null) => store.settle({ ...base, reserve_id, actual_usd, usage }),
    async recordFinding(f) {
      const r = await store.recordFinding({ ...base, ...f })
      if (!r?.ok) throw new RuntimeStop(r?.reason === 'finding_shape_invalid' ? 'finding_shape_invalid' : 'lease_lost')
      return r.finding_id
    },
    setWatermark: (watermark) => store.scheduleWatermark({ ...base, watermark }),
    /** Hand the job back between steps (release: no attempt burned; re-claimed after backoff_base_seconds). */
    yield(reason = 'yield') { throw new RuntimeStop(`yield:${String(reason).slice(0, 40)}`) },
    read: Object.freeze({ healthSnapshot: (o) => store.healthSnapshot(o) }),
    /** The claim's lease (8.5.20 C): lease-bound SECURITY DEFINER writers (agent.ops_*) re-check it in SQL. */
    lease: Object.freeze({ job_id: claim.job_id, token: claim.lease_token }),
  }
  return { ctx, abort: () => ac.abort() }
}

async function runJob({ store, handler, claim, deadlineAt, now }) {
  const base = { job_id: claim.job_id, token: claim.lease_token }
  const out = { job_id: claim.job_id, kind: claim.kind, attempt: claim.attempt }
  const finish = async (outcome, extra = {}) => {
    try {
      const r = await store.finish({ ...base, outcome, ...extra })
      return { ...out, outcome, state: r?.state ?? null, ok: Boolean(r?.ok) }
    } catch (e) {
      // the lease expires and the reaper retries: never a silent success
      return { ...out, outcome, state: null, ok: false, error: e?.code || 'FINISH_FAILED' }
    }
  }
  let st
  try {
    st = await store.start(base)
  } catch (e) {
    return { ...out, outcome: 'start_failed', ok: false, error: e?.code || 'START_FAILED' }
  }
  if (!st?.ok) return { ...out, outcome: 'lease_lost', ok: false }
  if (st.cancel_requested) return finish('cancelled')
  if (st.stop) return finish('release', { error: { code: safeCode(`STOP_${st.stop}`) } })
  if (!handler) return finish('failed', { error: { code: 'NO_HANDLER' } })

  const { ctx, abort } = createJobContext({ store, claim, deadlineAt, now })
  let timer
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ deadline: true }), Math.max(0, deadlineAt - now())) })
  let res
  try {
    res = await Promise.race([Promise.resolve().then(() => handler.run(ctx)).then((value) => ({ value }), (error) => ({ error })), deadline])
  } finally {
    clearTimeout(timer)
  }
  if (res.deadline) {
    abort()
    return finish('retry', { error: { code: 'TICK_DEADLINE' } })
  }
  if (res.error) {
    const e = res.error
    if (e instanceof RuntimeStop) {
      if (e.reason === 'cancelled') return finish('cancelled')
      if (e.reason === 'lease_lost') return { ...out, outcome: 'lease_lost', ok: false }
      if (e.reason === 'budget_blocked') return { ...out, outcome: 'budget_blocked', state: 'budget_blocked', ok: true }
      if (e.reason === 'deadline') return finish('retry', { error: { code: 'TICK_DEADLINE' } })
      if (e.reason === 'yield' || e.reason.startsWith('yield:')) return { ...(await finish('release')), outcome: 'yield' }
      if (e.reason.startsWith('stop:')) return finish('release', { error: { code: safeCode(`STOP_${e.reason.slice(5)}`) } })
      return finish('failed', { error: { code: safeCode(e.reason) } })
    }
    if (e instanceof RuntimePermanentError || e?.permanent === true) return finish('failed', { error: { code: safeCode(e.code) } })
    // rc-8.5.21: a handler may name its own retry delay (e.g. a turn whose dispatch lease is live:
    // "lease remaining + jitter"); the attempt is still burned, so the budget stays bounded
    const ms = Number(e?.retry_after_ms)
    return finish('retry', { error: { code: safeCode(e?.code, 'HANDLER_ERROR'), ...(e?.outcome ? { outcome: safeCode(e.outcome).toLowerCase() } : {}) }, ...(Number.isFinite(ms) && ms > 0 ? { retry_after_ms: Math.min(ms, 3_600_000) } : {}) })
  }
  return finish('completed', { result: res.value?.result ?? res.value ?? null })
}

/**
 * @param {{ store: object, handlers: Record<string, { run: (ctx: object) => Promise<any> }>, workerId: string,
 *           budgetMs?: number, now?: () => number, maxJobs?: number, minClaimMs?: number, safetyMs?: number, concurrent?: boolean }} o
 *   concurrent: run this tick's claims in parallel (each inside the same wall-clock deadline). The
 *   number in flight is what the DB granted: ≤ tick_max_jobs, ≤ max_concurrency_global live leases,
 *   ≤ the kind's max_concurrency. Default false (sequential, the R2 behaviour).
 */
export async function runRuntimeTick({ store, handlers, workerId, budgetMs = DEFAULT_TICK_BUDGET_MS, now = () => Date.now(), maxJobs = null, minClaimMs = MIN_CLAIM_MS, safetyMs = SAFETY_MS, concurrent = false }) {
  if (!store) throw new AgentError('RUNTIME_STORE_REQUIRED', 'store required')
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(String(workerId || ''))) throw new AgentError('RUNTIME_WORKER_INVALID', 'workerId must match ^[A-Za-z0-9_.:-]{1,80}$')
  const started = now()
  let budget = Math.min(Math.max(Number(budgetMs) || DEFAULT_TICK_BUDGET_MS, 500), TICK_HARD_MAX_MS)
  const summary = { worker_id: workerId, blocked: null, reaped: null, schedules: null, claimed: 0, jobs: [], errors: [] }
  const phase = async (name, fn) => {
    try {
      return await fn()
    } catch (e) {
      summary.errors.push({ phase: name, code: safeCode(e?.code, 'PHASE_FAILED') })
      return null
    }
  }
  try {
    const lim = await phase('limits', () => store.limits())
    if (!lim) { summary.blocked = 'limits_unavailable'; return summary }
    if (Number(lim.tick_budget_ms) > 0) budget = Math.min(budget, Number(lim.tick_budget_ms))
    const deadlineAt = started + budget - safetyMs
    if (!lim.runtime_enabled) { summary.blocked = 'runtime_disabled'; return summary }
    summary.reaped = await phase('reap', () => store.reap({ limit: 20 }))
    if (lim.emergency_stop) { summary.blocked = 'emergency_stop'; return summary }
    summary.schedules = await phase('schedules', () => store.enqueueDueSchedules({ limit: 10 }))
    const kinds = Object.keys(handlers || {})
    if (!kinds.length) { summary.blocked = 'no_handlers'; return summary }
    if (deadlineAt - now() < minClaimMs) { summary.blocked = 'budget_exhausted_before_claim'; return summary }
    const limit = Math.max(1, Math.min(Number(maxJobs) || Number(lim.tick_max_jobs) || 1, 5))
    const c = await phase('claim', () => store.claim({ worker: `${workerId}`.slice(0, 80), limit, kinds }))
    if (!c) return summary
    if (c.blocked) summary.blocked = c.blocked
    const claims = Array.isArray(c.claimed) ? c.claimed : []
    summary.claimed = claims.length
    if (concurrent && claims.length > 1) {
      summary.jobs.push(...(await Promise.all(claims.map((claim) => runJob({ store, handler: handlers[claim.kind], claim, deadlineAt, now })))))
      return summary
    }
    for (const claim of claims) {
      if (deadlineAt - now() <= 0) {
        // never started: hand it back without burning an attempt
        const r = await phase('release', () => store.finish({ job_id: claim.job_id, token: claim.lease_token, outcome: 'release', error: { code: 'TICK_BUDGET' } }))
        summary.jobs.push({ job_id: claim.job_id, kind: claim.kind, outcome: 'release', state: r?.state ?? null, ok: Boolean(r?.ok) })
        continue
      }
      summary.jobs.push(await runJob({ store, handler: handlers[claim.kind], claim, deadlineAt, now }))
    }
    return summary
  } finally {
    summary.elapsed_ms = Math.max(0, now() - started)
    summary.budget_ms = budget
    await phase('heartbeat', () => store.heartbeat({ worker: workerId, summary: heartbeatSummary(summary) }))
  }
}

// heartbeat rows are payload_is_clean jsonb: counts and codes only
function heartbeatSummary(s) {
  return {
    blocked: s.blocked,
    claimed: s.claimed,
    outcomes: s.jobs.reduce((a, j) => ({ ...a, [j.outcome]: (a[j.outcome] || 0) + 1 }), {}),
    reaped: s.reaped,
    schedules: s.schedules,
    errors: s.errors.map((e) => `${e.phase}:${e.code}`).slice(0, 10),
    elapsed_ms: s.elapsed_ms ?? null,
    budget_ms: s.budget_ms ?? null,
  }
}

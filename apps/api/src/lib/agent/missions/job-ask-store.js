// The research ask service's store, bound to ONE runtime job.
//
// The ask service (research/ask-service.js) is reused unchanged in its gates and
// loop; only its persistence is swapped:
//   spend   reserve → ctx.reserve (agent.runtime_reserve: a JOB-owned spend_ledger
//           row; agent.spend_ledger_guard refuses day / cycle / job / escalation
//           overruns and a switched-off research_limits, and a refusal parks the job
//           in budget_blocked). settle / release → ctx.settle. An unknown outcome is
//           left reserved: runtime_finish turns it 'unknown' (still counted).
//   caps    limits() = agent.research_limits; totals() = today / this cycle from the
//           ledger + THIS JOB's committed spend across all of its attempts (a
//           resumed mission never gets a fresh per-run allowance).
//   record  the job itself is the run record: createRun / updateRun / finishRun only
//           capture counters; audit rows are kept in memory and summarized into the
//           job's step events by the handler (codes and counts only).
import { AgentError } from '../runtime/store.js'
import { RuntimeStop } from '../runtime/runtime-tick.js'

/**
 * @param {{ ctx: object, reads: object }} o
 */
export function createJobAskStore({ ctx, reads }) {
  const state = { stopped: null, audit: [], run: null, finished: null, reserves: 0, settled_usd: 0 }
  const counts = {}
  const store = {
    kind: 'runtime_job',
    get stopped() { return state.stopped },
    get auditCounts() { return { ...counts } },
    get finished() { return state.finished },
    async limits() {
      return reads.researchLimits()
    },
    async totals() {
      const [t, job] = await Promise.all([reads.spendTotals(), reads.jobSpend(ctx.job.job_id)])
      return { day_usd: t.day_usd, cycle_usd: t.cycle_usd, run_usd: job.committed_usd, run_escalation_usd: job.escalation_usd, run_escalation_calls: job.escalation_calls }
    },
    async reserve({ model, purpose, reserved_usd }) {
      try {
        const id = await ctx.reserve(model, reserved_usd, purpose || 'default')
        state.reserves += 1
        return id
      } catch (err) {
        if (err instanceof RuntimeStop) {
          state.stopped = err
          throw new AgentError(err.reason === 'budget_blocked' ? 'AGENT_SPEND_JOB_BLOCKED' : 'AGENT_JOB_LEASE_LOST', `job reserve refused (${err.reason})`)
        }
        throw err
      }
    },
    async settle(reserve_id, { actual_usd, usage } = {}) {
      const u = usage ? { input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0), cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0), web_search_requests: Number(usage.web_search_requests || 0) } : null
      const r = await ctx.settle(reserve_id, actual_usd, u)
      if (r?.ok) state.settled_usd = Math.round((state.settled_usd + Number(actual_usd || 0)) * 1e6) / 1e6
      return r
    },
    async release(reserve_id) { return ctx.settle(reserve_id, null, null) },
    // billed unknown: stays reserved now; runtime_finish / the reaper mark it 'unknown' (counted at the reserve)
    async markUnknown() { return { ok: true } },
    async audit(row) {
      const k = String(row?.kind || 'other').slice(0, 40)
      counts[k] = (counts[k] || 0) + 1
      if (state.audit.length < 200) state.audit.push({ kind: k, name: String(row?.name || '').slice(0, 80), outcome: row?.outcome == null ? null : String(row.outcome).slice(0, 60), cost_usd: Number(row?.cost_usd || 0) })
    },
    async createRun(r) { state.run = { run_id: r.run_id } },
    async updateRun() { /* the job's progress is written by the handler's steps */ },
    async finishRun(_id, f) { state.finished = { state: f?.state || null, outcome: f?.outcome || null, cost_usd: Number(f?.cost_usd || 0) } },
    async getRun() { return null },
    async listAudit() { return [] },
    async runsToday() { return 0 },
  }
  return store
}

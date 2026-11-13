// Runtime handler `mission.supervisor` — one request split into ≤ 3 bounded
// `mission.research` sub-missions that run in parallel on the runtime, then one
// consolidated result (8.5.18).
//
//   1 split        operator-supplied sub-questions (≤ 3), or one Haiku split call
//                  (job-owned reserve), or — no model — the question itself.
//   2 enqueue      agent.runtime_enqueue per child: kind mission.research, the same
//                  accountable operator, budget_cap_usd = the per-mission ceiling,
//                  idempotency key sha256(supervisor job, index) ⇒ a resumed
//                  supervisor never enqueues a child twice.
//   3 wait         read the children's job state (agent.research_job) and YIELD
//                  (runtime_finish 'release': no attempt burned, re-claimed after
//                  backoff_base_seconds). No model call while waiting. Concurrency
//                  is the runtime's: the DB claims ≤ kind max_concurrency (≤ 3) and
//                  ≤ max_concurrency_global live leases; the tick runs claims in
//                  parallel (AGENT_RUNTIME_TICK_CONCURRENT=1) or several workers do.
//   4 consolidate  one Haiku call over the children's masked answers (job-owned
//                  reserve), or a deterministic merge when no model is configured.
//   5 findings     mission.consolidated + one mission.sub_mission per child.
// A supervisor cancel (between steps) cancels every open child.
import { RuntimeStop, RuntimePermanentError } from '../runtime/runtime-tick.js'
import { RUNTIME_TERMINAL_STATES, runtimeIdempotencyKey } from '../runtime/job-runtime.js'
import { MISSION_LIMITS, MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, missionIdentity } from './mission-kinds.js'
import { decodeText, encodeText, jsonBytes } from './mission-codec.js'
import { jobModelCall, parseJsonObject } from './mission-model.js'
import { recordFindings } from './research-mission-handler.js'
import { maskString } from '../research/pii.js'

const STALLED = new Set(['budget_blocked', 'paused', 'waiting_for_approval'])
const DEFAULT_WAIT_MAX_S = 1800

const SPLIT_SYSTEM = 'You split one real-estate research request into at most 3 independent sub-questions that can be researched in parallel with read-only tools. Reply with JSON only: {"sub_questions": ["...", "..."]}. Keep each under 300 characters. Never add outreach, messaging or offer tasks.'
const CONSOLIDATE_SYSTEM = 'You consolidate the answers of parallel read-only research sub-missions into one answer for the operator. Use ONLY the facts in the answers; keep sources and gaps; never invent facts; no recommendations to contact, message or make offers to sellers. Markdown: a short summary, then "Evidence" bullets, then "Gaps".'

export function deterministicMerge(question, children) {
  const parts = [`Consolidated from ${children.length} sub-mission(s) for: ${question.slice(0, 200)}`]
  children.forEach((c, i) => parts.push(`\n### Sub-mission ${i + 1} (${c.state}${c.outcome ? `, ${c.outcome}` : ''})\n${c.answer || '_No answer: the sub-mission did not complete._'}`))
  return parts.join('\n')
}

/**
 * @param {{ runtimeStore: object, reads: object, provider?: object|null, resolver?: object|null, env?: object, now?: () => number }} deps
 */
export function createSupervisorHandler({ runtimeStore, reads, provider = null, resolver = null, env = process.env, now = () => Date.now() } = {}) {
  if (!runtimeStore || !reads) throw new Error('mission.supervisor: runtimeStore and reads are required')
  const model = (ctx, o) => jobModelCall({ ctx, provider, resolver, reads, env, identity: missionIdentity(ctx.job.requested_by), ...o })
  const haveModel = () => Boolean(provider && resolver)

  async function cancelChildren(ctx, cp) {
    for (const c of cp.children || []) {
      try { await runtimeStore.cancel({ job_id: c.job_id, by: ctx.job.requested_by }) } catch { /* best effort; the API cascades too */ }
    }
  }
  const step = async (ctx, cp, name, o) => {
    try {
      return await ctx.step(name, { checkpoint: cp, ...o })
    } catch (e) {
      if (e instanceof RuntimeStop && e.reason === 'cancelled') await cancelChildren(ctx, cp)
      throw e
    }
  }

  return Object.freeze({
    kind: MISSION_SUPERVISOR_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const question = decodeText(input.question_v1)
      if (!question.trim()) throw new RuntimePermanentError('MISSION_QUESTION_MISSING')
      if (!missionIdentity(ctx.job.requested_by).verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const maxChildren = Math.min(Math.max(Number(input.max_children) || MISSION_LIMITS.supervisor_max_children, 1), MISSION_LIMITS.supervisor_max_children)
      const perChild = Math.min(Math.max(Number(input.per_mission_budget_usd) || MISSION_LIMITS.child_default_usd, 0), MISSION_LIMITS.child_max_usd)
      const cp = { v: 1, cost_usd: 0, ...(ctx.job.checkpoint || {}) }

      // 1 split
      if (!cp.plan) {
        await step(ctx, cp, 'split', { progress: { step: 'split', steps_done: 0, steps_total: 5, pct: 2 } })
        let subs = Array.isArray(input.sub_questions_v1) ? input.sub_questions_v1.map(decodeText).map((s) => s.trim()).filter(Boolean) : []
        let source = subs.length ? 'operator' : 'single'
        if (!subs.length && haveModel()) {
          const [masked] = maskString(question)
          const r = await model(ctx, { system: SPLIT_SYSTEM, messages: [{ role: 'user', content: masked }], max_tokens: 400, purpose: 'default' })
          cp.cost_usd = Math.round((cp.cost_usd + r.cost_usd) * 1e6) / 1e6
          const parsed = parseJsonObject(r.text)
          subs = Array.isArray(parsed?.sub_questions) ? parsed.sub_questions.map((s) => String(s || '').trim()).filter(Boolean) : []
          source = subs.length ? 'model' : 'single'
        }
        if (!subs.length) subs = [question]
        cp.plan = subs.slice(0, maxChildren).map((s, i) => ({ i, question_v1: encodeText(s, 600) }))
        cp.split_source = source
        await step(ctx, cp, 'split.done', { progress: { step: 'split', steps_done: 1, steps_total: 5, pct: 10 }, payload: { children: cp.plan.length, source } })
      }

      // 2 enqueue (idempotent per index)
      if (!cp.children || cp.children.length < cp.plan.length) {
        cp.children = cp.children || []
        for (const p of cp.plan) {
          if (cp.children.some((c) => c.i === p.i)) continue
          const r = await runtimeStore.enqueue({
            kind: MISSION_RESEARCH_KIND,
            idempotency_key: runtimeIdempotencyKey('mission.supervisor.child', ctx.job.job_id, p.i),
            input: { question_v1: p.question_v1, context: input.context || {}, parent_job_id: ctx.job.job_id, sub_index: p.i, ...(input.max_model_calls ? { max_model_calls: input.max_model_calls } : {}) },
            requested_by: ctx.job.requested_by, priority: Math.max(0, Number(input.priority ?? 100) - 1), max_attempts: 2, budget_cap_usd: perChild, require_approval: false,
          })
          if (!r?.ok) throw new RuntimePermanentError(`CHILD_ENQUEUE_${String(r?.reason || 'REFUSED').toUpperCase()}`.slice(0, 60))
          cp.children.push({ i: p.i, job_id: r.job_id })
          await step(ctx, cp, 'enqueue', { progress: { step: 'enqueue', steps_done: 1, steps_total: 5, pct: 15 }, payload: { child_job_id: r.job_id, index: p.i, deduped: Boolean(r.deduped) } })
        }
        cp.wait_started_at = cp.wait_started_at || new Date(now()).toISOString()
        await step(ctx, cp, 'enqueue.done', { progress: { step: 'wait', steps_done: 2, steps_total: 5, pct: 20 } })
      }

      // 3 wait (job state only; yield between checks)
      if (!cp.waited) {
        const jobs = await reads.getJobs(cp.children.map((c) => c.job_id))
        const byId = new Map(jobs.map((j) => [j.job_id, j]))
        const done = cp.children.filter((c) => RUNTIME_TERMINAL_STATES.includes(byId.get(c.job_id)?.state))
        const stalled = cp.children.filter((c) => STALLED.has(byId.get(c.job_id)?.state))
        const waitMax = Math.min(Math.max(Number(input.wait_max_s) || DEFAULT_WAIT_MAX_S, 60), 6 * 3600)
        const waitedS = (now() - Date.parse(cp.wait_started_at)) / 1000
        const pct = 20 + Math.round((done.length / cp.children.length) * 60)
        if (done.length < cp.children.length && !(done.length + stalled.length === cp.children.length && stalled.length > 0) && waitedS < waitMax) {
          await step(ctx, cp, 'wait', { progress: { step: 'wait', steps_done: 2, steps_total: 5, pct, children_done: done.length, children_total: cp.children.length }, payload: { done: done.length, total: cp.children.length } })
          ctx.yield('waiting_children')
        }
        cp.waited = { done: done.length, stalled: stalled.length, timed_out: waitedS >= waitMax && done.length < cp.children.length }
        await step(ctx, cp, 'wait.done', { progress: { step: 'consolidate', steps_done: 3, steps_total: 5, pct: 80 }, payload: cp.waited })
      }

      // 4 consolidate
      if (!cp.consolidated) {
        const jobs = await reads.getJobs(cp.children.map((c) => c.job_id))
        const byId = new Map(jobs.map((j) => [j.job_id, j]))
        const kids = await Promise.all(cp.children.map(async (c) => {
          const j = byId.get(c.job_id)
          const spend = await reads.jobSpend(c.job_id)
          return { i: c.i, job_id: c.job_id, state: j?.state || 'unknown', outcome: j?.result?.outcome || j?.last_error?.code || null, answer: decodeText(j?.result?.answer_v1), cost_usd: spend.committed_usd, property_refs: j?.result?.property_refs || [], approvals: j?.result?.approvals || [] }
        }))
        const answered = kids.filter((k) => k.answer)
        let answer
        let method = 'deterministic'
        if (answered.length >= 2 && haveModel()) {
          const body = answered.map((k, n) => `## Sub-mission ${n + 1}\n${maskString(k.answer.slice(0, 5000))[0]}`).join('\n\n')
          const r = await model(ctx, { system: CONSOLIDATE_SYSTEM, messages: [{ role: 'user', content: `Request: ${maskString(question)[0]}\n\n${body}` }], max_tokens: 1500, purpose: 'default' })
          cp.cost_usd = Math.round((cp.cost_usd + r.cost_usd) * 1e6) / 1e6
          answer = r.text ? maskString(r.text)[0] : deterministicMerge(question, kids)
          method = r.text ? 'model' : 'deterministic'
        } else {
          answer = deterministicMerge(question, kids)
        }
        cp.consolidated = {
          method, answer_v1: encodeText(answer, MISSION_LIMITS.answer_store_chars),
          children: kids.map((k) => ({ i: k.i, job_id: k.job_id, state: k.state, outcome: k.outcome, cost_usd: k.cost_usd })),
          property_refs: [...new Set(kids.flatMap((k) => k.property_refs))].slice(0, 25),
          approvals: kids.flatMap((k) => k.approvals).slice(0, 10),
          children_cost_usd: Math.round(kids.reduce((a, k) => a + k.cost_usd, 0) * 1e6) / 1e6,
        }
        while (jsonBytes(cp) > 14_000 && decodeText(cp.consolidated.answer_v1).length > 400) cp.consolidated.answer_v1 = encodeText(`${decodeText(cp.consolidated.answer_v1).slice(0, Math.floor(decodeText(cp.consolidated.answer_v1).length * 0.7))}…`)
        await step(ctx, cp, 'consolidate.done', { progress: { step: 'findings', steps_done: 4, steps_total: 5, pct: 90 }, payload: { method, children: kids.length, answered: answered.length } })
      }

      // 5 findings
      if (!cp.findings) {
        const c = cp.consolidated
        const findings = [
          { finding_type: 'mission.consolidated', key: 'answer', source_id: 'agent.mission_supervisor', value: { method: c.method, answer_v1: encodeText(decodeText(c.answer_v1), 3000), children: c.children.length, property_refs: c.property_refs }, confidence: c.method === 'model' ? 0.8 : 0.6 },
          ...c.children.map((k) => ({ finding_type: 'mission.sub_mission', key: `child.${k.i}`, source_id: 'agent.research_job', value: { job_id: k.job_id, state: k.state, outcome: k.outcome, cost_usd: k.cost_usd }, confidence: 1 })),
        ]
        cp.findings = await recordFindings(ctx, findings)
        await step(ctx, cp, 'findings.done', { progress: { step: 'findings', steps_done: 5, steps_total: 5, pct: 99 }, payload: { written: cp.findings.written } })
      }

      const c = cp.consolidated
      const own = (await reads.jobSpend(ctx.job.job_id)).committed_usd // the ledger, not a running sum: a crashed attempt's spend counts too
      cp.cost_usd = own
      return { result: { mission: 'supervisor', outcome: cp.waited?.timed_out ? 'PARTIAL_TIMEOUT' : c.children.every((k) => k.state === 'completed') ? 'COMPLETED' : 'PARTIAL', answer_v1: c.answer_v1, method: c.method, split_source: cp.split_source, children: c.children, property_refs: c.property_refs, approvals: c.approvals, cost_usd: cp.cost_usd, children_cost_usd: c.children_cost_usd, total_cost_usd: Math.round((cp.cost_usd + c.children_cost_usd) * 1e6) / 1e6, findings: cp.findings.written } }
    },
  })
}

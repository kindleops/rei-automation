// Runtime handler `mission.research` — the existing ask service, run headlessly
// for one persistent mission (8.5.18).
//
// Steps (each checkpointed into agent.research_job.checkpoint + a job.step event;
// a resumed attempt skips every step its checkpoint marks done, so a completed
// ask is NEVER re-spent and findings are upserts keyed (job, type, key)):
//   1 ask        the research ask service: research read tools + web (only when
//                AGENT_WEB_RESEARCH_ENABLED) + mission capability tools (autonomous
//                internal + approval-tier, which only prepare pending approvals).
//                Principal = the job's requested_by operator. Spend = job-owned
//                reserves (job-ask-store.js) under the existing day / cycle / run
//                caps and this mission's budget_cap_usd. Bounded to fit the tick.
//   2 findings   mission.answer, mission.property_evidence, mission.web_citation,
//                mission.approval_pending, mission.draft_campaign (agent.finding).
//   3 result     the typed result envelope (encoded) + counters → job result.
// Cancel is honoured between steps (ctx.step) and inside the ask (ctx.heartbeat →
// ask.cancel: no further model / tool call; an in-flight call's reserve stays counted).
import { RuntimeStop, RuntimePermanentError } from '../runtime/runtime-tick.js'
import { createJobAskStore } from './job-ask-store.js'
import { createMissionCapabilityHook } from './mission-capability-hook.js'
import { MISSION_LIMITS, MISSION_RESEARCH_KIND, missionIdentity } from './mission-kinds.js'
import { decodeText, decodeContext, encodeText, encodePropertyRef, jsonBytes, storableUrl } from './mission-codec.js'
import { encodeForStore } from '../research/pii.js'

const HEARTBEAT_MS = 8_000
const CP_MAX_BYTES = 14_000
const PERMANENT = /^(AGENT_DISABLED|RESEARCH_DISABLED|MODE_NOT_READ|IDENTITY_REQUIRED|QUESTION_INVALID|MODEL_UNRESOLVED|MODELS_UNRESOLVED|DEFAULT_MODEL_UNRESOLVED|UNPRICED_MODEL|PROMPT_TOO_LARGE|PII_RESIDUAL|MODEL_REFUSAL|AGENT_RESEARCH_DISABLED|AGENT_SPEND_CAP_[A-Z]+|AGENT_ESCALATION_CAP_[A-Z]+|RUN_TIMEOUT)$/

const safeCode = (v) => String(v || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60)

/** The ask outcome, trimmed until the checkpoint fits its CHECK (≤ 16 KB). */
function askCheckpoint(r, hook, store) {
  const res = r?.result && typeof r.result === 'object' ? r.result : null
  const props = (res?.evidence?.internal?.property_ids || []).slice(0, 25)
  const cites = (res?.evidence?.public_web || []).slice(0, 8).map((c) => ({ url: storableUrl(c.url), title: c.title ? encodeText(c.title, 160) : null, retrieved_at: c.retrieved_at || null })).filter((c) => c.url)
  const base = {
    state: r?.state || 'failed', outcome: safeCode(r?.outcome),
    cost_usd: Number(r?.cost_usd || store.finished?.cost_usd || 0), model_calls: Number(r?.model_calls || 0), tool_calls: Number(r?.tool_calls || 0), web_searches: Number(r?.web_searches || 0),
    tools: (res?.evidence?.internal?.tools || []).slice(0, 20).map((t) => String(t).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60)),
    property_refs: props.map(encodePropertyRef),
    citations: cites,
    approvals: hook ? hook.ledger.approvals.slice(0, 10) : [],
    drafts: hook ? hook.ledger.drafts.slice(0, 5) : [],
    capability_refusals: hook ? hook.ledger.refused : {},
    audit_counts: store.auditCounts,
  }
  let answer = String(r?.answer_md || '')
  let cp = { ...base, answer_v1: encodeText(answer, MISSION_LIMITS.answer_store_chars), result_v1: res ? encodeForStore(JSON.stringify(res)) : null }
  if (jsonBytes(cp) > CP_MAX_BYTES) cp = { ...cp, result_v1: null }
  while (jsonBytes(cp) > CP_MAX_BYTES && answer.length > 400) { answer = answer.slice(0, Math.floor(answer.length * 0.7)); cp = { ...cp, answer_v1: encodeText(`${answer}…`, MISSION_LIMITS.answer_store_chars), answer_truncated: true } }
  return cp
}

/** Findings with traceable evidence (one per (type, key); a retry overwrites, never duplicates). */
export function researchFindings(ask) {
  const out = [{
    finding_type: 'mission.answer', key: 'answer', source_id: 'agent.mission_research',
    value: { outcome: ask.outcome, answer_v1: encodeText(decodeText(ask.answer_v1), 3000), tools: ask.tools, property_refs: ask.property_refs, web_citations: ask.citations.length, cost_usd: ask.cost_usd },
    confidence: ask.state === 'completed' ? 0.8 : 0.3,
  }]
  for (const ref of ask.property_refs.slice(0, 20)) out.push({ finding_type: 'mission.property_evidence', key: `property.${ref}`, source_id: 'agent.research_tools', value: { property_ref: ref, tools_read: ask.tools }, confidence: 1 })
  ask.citations.forEach((c, i) => out.push({ finding_type: 'mission.web_citation', key: `web.${i}`, source_id: 'public_web', value: { url_v1: c.url, title_v1: c.title, retrieved_at: c.retrieved_at }, confidence: 0.6 }))
  for (const a of ask.approvals) out.push({ finding_type: 'mission.approval_pending', key: `approval.${String(a.approval_id).toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 60)}`, source_id: 'agent.approval_request', value: { approval_id: a.approval_id, capability_id: a.capability_id, expires_at: a.expires_at }, confidence: 1 })
  for (const d of ask.drafts) out.push({ finding_type: 'mission.draft_campaign', key: `campaign.${String(d.campaign_id).toLowerCase()}`, source_id: 'public.campaigns', value: { campaign_id: d.campaign_id, status: d.status }, confidence: 1 })
  return out
}

/** Record findings; a finding the DB CHECK refuses is counted, never fatal. RuntimeStop propagates. */
export async function recordFindings(ctx, findings) {
  let written = 0
  const refused = []
  for (const f of findings) {
    try {
      await ctx.recordFinding(f)
      written += 1
    } catch (err) {
      if (err instanceof RuntimeStop && err.reason !== 'finding_shape_invalid') throw err
      refused.push({ finding_type: f.finding_type, code: safeCode(err?.code || err?.reason || 'FINDING_REFUSED') })
    }
  }
  return { written, refused: refused.slice(0, 20) }
}

/**
 * @param {{ buildAsk: (o: { store: object, capabilityHook: object|null }) => { ask: Function, cancel: Function },
 *           reads: object, getPlane?: () => Promise<object|null>, minAskMs?: number, heartbeatMs?: number }} deps
 */
export function createResearchMissionHandler({ buildAsk, reads, getPlane = async () => null, minAskMs = MISSION_LIMITS.min_ask_ms, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (typeof buildAsk !== 'function' || !reads) throw new Error('mission.research: buildAsk and reads are required')
  return Object.freeze({
    kind: MISSION_RESEARCH_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const question = decodeText(input.question_v1)
      if (!question.trim()) throw new RuntimePermanentError('MISSION_QUESTION_MISSING')
      const operator_id = ctx.job.requested_by
      const identity = missionIdentity(operator_id)
      if (!identity.verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const cp = { v: 1, ...(ctx.job.checkpoint || {}) }

      if (!cp.ask) {
        if (ctx.remainingMs() < minAskMs) ctx.yield('tick_budget')
        await ctx.step('ask', { progress: { step: 'ask', steps_done: 0, steps_total: 3, pct: 5 }, checkpoint: cp, payload: { resumed: ctx.job.attempt > 1 } })
        const plane = await getPlane().catch(() => null)
        const hook = plane ? createMissionCapabilityHook({ plane }) : null
        const store = createJobAskStore({ ctx, reads })
        const svc = buildAsk({ store, capabilityHook: hook })
        const room = Math.max(5_000, ctx.remainingMs() - 4_000)
        const calls = Math.min(Number(input.max_model_calls) || MISSION_LIMITS.ask_max_model_calls, MISSION_LIMITS.ask_max_model_calls)
        // a model call may START until 40 % of the room and run for up to 60 % of it: the ask ends inside the tick
        const limits = { run_timeout_ms: Math.floor(room * 0.4), answer_by_ms: Math.floor(room * 0.25), model_timeout_ms: Math.min(90_000, Math.floor(room * 0.6)), max_model_calls: calls, max_default_calls: calls }
        const started = await svc.ask({ operator_id, identity, question, context: decodeContext(input.context), limits })
        // mid-ask: extend the lease, and turn a cancel / stop / deadline into ask.cancel
        let stop = null
        const cancelAsk = (why) => { if (!stop) { stop = why; try { svc.cancel(started.run_id, operator_id) } catch { /* already ended */ } } }
        const onAbort = () => cancelAsk(new RuntimeStop('deadline'))
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        const hb = setInterval(() => { ctx.heartbeat().catch((e) => cancelAsk(e instanceof RuntimeStop ? e : new RuntimeStop('lease_lost'))) }, heartbeatMs)
        if (typeof hb.unref === 'function') hb.unref()
        let r
        try {
          r = await started.done
        } finally {
          clearInterval(hb)
          ctx.signal.removeEventListener('abort', onAbort)
        }
        if (store.stopped) throw store.stopped // budget_blocked (the DB already parked the job) / lease lost
        if (stop) throw stop
        if (r?.state === 'cancelled') throw new RuntimeStop('cancelled')
        if (r?.state !== 'completed') {
          const code = safeCode(r?.outcome)
          if (PERMANENT.test(code)) throw new RuntimePermanentError(`MISSION_${code}`.slice(0, 60))
          throw Object.assign(new Error(code), { code: `MISSION_${code}`.slice(0, 60) }) // transient (provider / store): retry, attempts bounded
        }
        cp.ask = askCheckpoint(r, hook, store)
        await ctx.step('ask.done', { progress: { step: 'ask', steps_done: 1, steps_total: 3, pct: 60 }, checkpoint: cp, payload: { outcome: cp.ask.outcome, cost_usd: cp.ask.cost_usd, model_calls: cp.ask.model_calls, tool_calls: cp.ask.tool_calls, approvals: cp.ask.approvals.length } })
      }

      if (!cp.findings) {
        await ctx.step('findings', { progress: { step: 'findings', steps_done: 1, steps_total: 3, pct: 70 }, checkpoint: cp })
        cp.findings = await recordFindings(ctx, researchFindings(cp.ask))
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 2, steps_total: 3, pct: 90 }, checkpoint: cp, payload: { written: cp.findings.written, refused: cp.findings.refused.length } })
      }

      const a = cp.ask
      const result = { mission: 'research', outcome: a.outcome, state: a.state, answer_v1: a.answer_v1, result_v1: a.result_v1 ?? null, cost_usd: a.cost_usd, model_calls: a.model_calls, tool_calls: a.tool_calls, web_searches: a.web_searches, property_refs: a.property_refs, citations: a.citations.length, approvals: a.approvals, drafts: a.drafts, findings: cp.findings.written, parent_job_id: input.parent_job_id || null }
      return { result: jsonBytes(result) > CP_MAX_BYTES ? { ...result, result_v1: null } : result }
    },
  })
}

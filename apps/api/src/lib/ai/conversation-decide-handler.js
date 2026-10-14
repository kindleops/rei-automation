// R2 runtime handler `conversation.decide` — Conversation Engine 2.0 R1/R2 SHADOW (NO SEND).
//
// Registered with the runtime tick ONLY when AI_CONVERSATION_SHADOW_ENABLED=true
// (conversationRuntimeHandlers() returns {} otherwise), and the DB claims the kind
// only when it is armed + enabled in agent.runtime_limits.kind_limits.
//
// Spend: every model call reserves on THIS job (ctx.reserve → agent.runtime_reserve →
// agent.spend_ledger guard: research spend enabled, day $10 / UTC-month $150 / run
// $2.50 caps, and the job cap = kind_limits.conversation.decide.event_budget_cap_usd,
// armed at $0.01) and settles the provider-reported actual (ctx.settle).
//   - job cap > 0 and the call's worst case does not fit what is LEFT of it (e.g. the
//     Sonnet escalation, worst ≈ $0.07 against $0.01) ⇒ the call is not attempted
//     (no reservation, no spend): JOB_BUDGET_INSUFFICIENT, which the engine records as
//     a NEEDS_REVIEW hold (escalated to a person) — never a reply.
//   - any refusal by the DB guard (spend switch off, day / cycle cap, job cap 0 before
//     the event-budget migration) stops the job as budget_blocked (requeueable) — no
//     partial record is written.
// Time: each model call is bounded by the job's remaining wall-clock budget
// (ctx.remainingMs, ctx.signal); too little time ⇒ JOB_DEADLINE ⇒ the runtime retries.
// Idempotency: one job per inbound message VERSION (event key); the wiring checks the
// version and the existing record before any thread read.
//
// Output: one row in public.conversation_ai_shadow_decisions (PROPOSED table) and a
// job result of codes/counts only (agent.payload_is_clean). Nothing is sent.
import { CONVERSATION_AI_SHADOW_ENV, CONVERSATION_DECIDE_KIND, conversationAiShadowRequested, decodeRef } from './conversation-ai-shadow-hook.js'
import { ModelCallRefused } from '@/lib/domain/conversation-ai/model-client.js'

export { CONVERSATION_DECIDE_KIND }

/** The armed per-job (routine reply) budget, USD (runbook: kind_limits.conversation.decide.event_budget_cap_usd). */
export const ROUTINE_REPLY_RESERVE_USD = 0.01
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6

/** spend_ledger.purpose for a call: the Sonnet escalation route is 'escalation' (its own per-job caps), every other call 'default'. */
export function spendPurposeFor(model) {
  return /sonnet/i.test(String(model || '')) ? 'escalation' : 'default'
}

/**
 * Adapter: the conversation-ai spend tracker interface over the job's reserve/settle.
 * Tracks this attempt's committed + open reservations against ctx.job.budget_cap_usd so
 * a call that cannot fit is refused BEFORE the DB guard would park the whole job.
 */
export function runtimeJobTracker(ctx) {
  const cap = Number(ctx?.job?.budget_cap_usd || 0)
  let committed = 0
  let open = 0
  return {
    async reserve(worst, model) {
      const w = r6(worst)
      if (cap > 0 && committed + open + w > cap + 1e-9) {
        // not attempted: no reservation, no spend; the engine records a NEEDS_REVIEW hold
        throw new ModelCallRefused('JOB_BUDGET_INSUFFICIENT', { worst: w, cap, committed: r6(committed), model, billed: 'no' })
      }
      try {
        // agent.spend_ledger.purpose is CHECK ('default','escalation'): the 8.5.14 handler passed the
        // kind name, so every real reservation raised check_violation (→ retry → dead_letter).
        const reserve_id = await ctx.reserve(model, w, spendPurposeFor(model))
        open += w
        return { reserve_id, worst: w }
      } catch (err) {
        // RuntimeStop (budget_blocked / lease_lost / cancelled / deadline): stop the whole job
        throw Object.assign(new Error('JOB_STOP'), { code: 'JOB_STOP', abortJob: true, cause: err })
      }
    },
    async settle(tok, actual, usage) {
      const usd = actual == null ? tok.worst : actual
      open = Math.max(0, open - tok.worst); committed += Number(usd) || 0
      await ctx.settle(tok.reserve_id, usd, usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 } : null)
    },
    // a call that died after reserve: settle the WORST case (never released on a guess)
    async abandon(tok) { open = Math.max(0, open - tok.worst); committed += tok.worst; await ctx.settle(tok.reserve_id, tok.worst, null) },
    // the provider refused before any work (billed 'no'): release the reservation
    async release(tok) { open = Math.max(0, open - tok.worst); await ctx.settle(tok.reserve_id, null, null) },
    snapshot: () => ({ cap, committed: r6(committed), open: r6(open) }),
  }
}

/**
 * @param {{ run?: Function }} [deps] run = runConversationAiShadowForInbound (injectable for tests)
 */
export function createConversationDecideHandler({ run = null, env = process.env } = {}) {
  return Object.freeze({
    kind: CONVERSATION_DECIDE_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const sid = typeof input.inbound_ref === 'string' && input.inbound_ref.length <= 320 ? decodeRef(input.inbound_ref) : null
      if (!sid) return { result: { code: 'INBOUND_REF_INVALID' } }
      const inboundVersion = typeof input.inbound_version === 'string' && /^[a-p]{16}$/.test(input.inbound_version) ? input.inbound_version : null
      const rev = typeof input.inbound_revision === 'string' ? Number(decodeRef(input.inbound_revision)) : 0
      const inboundRevision = Number.isInteger(rev) && rev > 0 && rev <= 999 ? rev : 0
      await ctx.step('decide', { progress: { step: 'decide', steps_done: 0, steps_total: 1, pct: 0 } })
      const exec = run || (await import('./conversation-ai-shadow-wiring.js')).runConversationAiShadowForInbound
      let r
      try {
        r = await exec({
          providerMessageSid: sid,
          inboundVersion,
          inboundRevision,
          deterministic: input.deterministic_intent ? { intent: input.deterministic_intent, compliance_flag: input.compliance_flag || null } : null,
          env,
          tracker: runtimeJobTracker(ctx),
          remainingMs: ctx.remainingMs,
          signal: ctx.signal,
        })
      } catch (err) {
        if (err?.abortJob === true && err.cause) throw err.cause // the runtime's own stop (budget_blocked, …)
        throw err
      }
      const rec = r?.record || null
      return {
        result: {
          code: r?.code || null,
          outcome: rec?.decision?.outcome || null,
          validation_status: rec?.validation?.status || null,
          path: rec?.model?.path || null,
          cost_usd: rec?.cost?.total_usd ?? 0,
          send_status: rec ? rec.send_status : null,
        },
      }
    },
  })
}

/** {} unless the env gate is on — the tick then never claims this kind. */
export function conversationRuntimeHandlers(env = process.env) {
  if (!conversationAiShadowRequested(env)) return {}
  return { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ env }) }
}

export { CONVERSATION_AI_SHADOW_ENV }

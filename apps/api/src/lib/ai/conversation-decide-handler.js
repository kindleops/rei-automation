// R2 runtime handler `conversation.decide` — Conversation Engine 2.0 R1/R2 SHADOW (NO SEND).
//
// Registered with the runtime tick ONLY when AI_CONVERSATION_SHADOW_ENABLED=true
// (conversationRuntimeHandlers() returns {} otherwise), and the DB claims the kind
// only when it is armed + enabled in agent.runtime_limits.kind_limits.
//
// Spend: every model call reserves on THIS job (ctx.reserve → agent.runtime_reserve →
// agent.spend_ledger guard: research spend enabled, day cap, job cap) and settles the
// provider-reported actual (ctx.settle). A refused reservation stops the job as
// budget_blocked (requeueable once spend is on) — no partial record is written.
//
// Output: one row in public.conversation_ai_shadow_decisions (PROPOSED table) and a
// job result of codes/counts only (agent.payload_is_clean). Nothing is sent.
import { CONVERSATION_AI_SHADOW_ENV, CONVERSATION_DECIDE_KIND, conversationAiShadowRequested, decodeRef } from './conversation-ai-shadow-hook.js'

export { CONVERSATION_DECIDE_KIND }

/** Adapter: the conversation-ai spend tracker interface over the job's reserve/settle. */
export function runtimeJobTracker(ctx) {
  return {
    async reserve(worst, model) {
      try {
        const reserve_id = await ctx.reserve(model, Math.round(Number(worst) * 1e6) / 1e6, CONVERSATION_DECIDE_KIND)
        return { reserve_id, worst }
      } catch (err) {
        // RuntimeStop (budget_blocked / lease_lost / cancelled / deadline): stop the whole job
        throw Object.assign(new Error('JOB_STOP'), { code: 'JOB_STOP', abortJob: true, cause: err })
      }
    },
    async settle(tok, actual, usage) {
      await ctx.settle(tok.reserve_id, actual == null ? tok.worst : actual, usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 } : null)
    },
    // a call that died after reserve: settle the WORST case (never released on a guess)
    async abandon(tok) { await ctx.settle(tok.reserve_id, tok.worst, null) },
    // the provider refused before any work (billed 'no'): release the reservation
    async release(tok) { await ctx.settle(tok.reserve_id, null, null) },
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
      await ctx.step('decide', { progress: { step: 'decide', steps_done: 0, steps_total: 1, pct: 0 } })
      const exec = run || (await import('./conversation-ai-shadow-wiring.js')).runConversationAiShadowForInbound
      let r
      try {
        r = await exec({ providerMessageSid: sid, deterministic: input.deterministic_intent ? { intent: input.deterministic_intent, compliance_flag: input.compliance_flag || null } : null, env, tracker: runtimeJobTracker(ctx) })
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

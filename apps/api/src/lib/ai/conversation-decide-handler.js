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
import { CONVERSATION_AI_SHADOW_ENV, CONVERSATION_DECIDE_KIND, conversationAiShadowRequested, decodeRef, encodeRef } from './conversation-ai-shadow-hook.js'
import { ModelCallRefused } from '@/lib/domain/conversation-ai/model-client.js'
import { agentStandDownForInbound, AGENT_HELD_STAND_DOWN } from './agent-lead-stand-down.js'
import { turnsRequested } from '@/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler, createConversationTurnSweepHandler, CONVERSATION_TURN_KIND, CONVERSATION_TURN_SWEEP_KIND, defaultOperatorItems, precautionaryHoldWorkItem } from './conversation-turn-handler.js'

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
// rc-8.5.20 (Phase 1A): with AI_CONVERSATION_TURNS_ENABLED=true this job no longer decides the
// inbound on the spot. It ROUTES the event deterministically (no model) into the turn engine: a
// stop cancels the open turn immediately, a reply-worthy inbound opens / joins the thread's ONE
// open turn at the planned 3–40 min delay, and the decision runs once, at the due time, in the
// conversation.turn job. Turns OFF (default) ⇒ this handler behaves exactly as in 8.5.15.
// A conversation change on a turn (event_kind state_change / failed_outbound_reply, turn_ref)
// is routed the same way.
// link #32: `standDown(providerMessageSid)` — an agent holds the lead ⇒ no model decision (a stop is still routed, with
// no model, when turns are on: the deterministic stop path cancels the thread's open turn)
async function defaultStandDown(supabase, sid) {
  let sb = supabase
  if (!sb) {
    const { hasSupabaseConfig } = await import('@/lib/supabase/client.js')
    if (!hasSupabaseConfig()) return { stand_down: false }
    sb = (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient()
  }
  return agentStandDownForInbound(sb, sid)
}

export function createConversationDecideHandler({ run = null, env = process.env, route = null, routeChange = null, runtimeStore = null, supabase = null, effectsDeps = {}, operatorItems = null, standDown = null } = {}) {
  return Object.freeze({
    kind: CONVERSATION_DECIDE_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      if (turnsRequested(env) && (input.event_kind === 'state_change' || input.event_kind === 'failed_outbound_reply')) {
        const turnId = typeof input.turn_ref === 'string' && input.turn_ref.length <= 160 ? decodeRef(input.turn_ref) : null
        if (!turnId || !/^[0-9a-f-]{36}$/i.test(turnId)) return { result: { code: 'TURN_REF_INVALID' } }
        await ctx.step('route', { progress: { step: 'route', steps_done: 0, steps_total: 1, pct: 0 } })
        const fn = routeChange || (await import('./conversation-turn-wiring.js')).routeTurnChange
        const rs = runtimeStore || (await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env))
        const safe = (v) => (typeof v === 'string' && /^[a-z_]{1,60}$/.test(v) ? v : null)
        const r = await fn({ turnId, kind: input.event_kind, change: safe(input.change), failureClass: safe(input.failure_class), runtimeStore: rs })
        return { result: turnRouteResult(r) }
      }
      const sid = typeof input.inbound_ref === 'string' && input.inbound_ref.length <= 320 ? decodeRef(input.inbound_ref) : null
      if (!sid) return { result: { code: 'INBOUND_REF_INVALID' } }
      const sd = await (standDown ? standDown(sid) : defaultStandDown(supabase, sid))
      if (sd?.stand_down && !(sd.stop && turnsRequested(env))) return { result: { code: sd.stop ? `${AGENT_HELD_STAND_DOWN}_STOP_HANDLED_DETERMINISTICALLY` : AGENT_HELD_STAND_DOWN } }
      const inboundVersion = typeof input.inbound_version === 'string' && /^[a-p]{16}$/.test(input.inbound_version) ? input.inbound_version : null
      const rev = typeof input.inbound_revision === 'string' ? Number(decodeRef(input.inbound_revision)) : 0
      const inboundRevision = Number.isInteger(rev) && rev > 0 && rev <= 999 ? rev : 0
      if (turnsRequested(env)) {
        await ctx.step('route', { progress: { step: 'route', steps_done: 0, steps_total: 1, pct: 0 } })
        const fn = route || (await import('./conversation-turn-wiring.js')).routeInboundToTurn
        const rs = runtimeStore || (await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env))
        const r = await fn({ providerMessageSid: sid, inboundVersion, inboundRevision, deterministic: input.deterministic_intent ? { intent: input.deterministic_intent, compliance_flag: input.compliance_flag || null } : null, env, runtimeStore: rs })
        // rc-8.5.21 v4 (S2 / S3): a routed stop / possible stop / denial WRITES its protective effects here (the
        // deciding modules write none); a failed write throws, so the job retries — never a silent drop
        if (r?.immediate?.effects_input) {
          await ctx.step('effects', { progress: { step: 'effects', steps_done: 0, steps_total: 1, pct: 0 } })
          const sb = supabase || (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient()
          const { applyCanonicalDecisionEffects } = await import('./conversation-decision-effects.js')
          r.effects = await applyCanonicalDecisionEffects({ supabase: sb, ...r.immediate.effects_input }, effectsDeps)
          if (r.immediate.precautionary) {
            const items = operatorItems || (await defaultOperatorItems(env))
            const res = await items.syncWorkItems({ ...ctx.lease, items: [precautionaryHoldWorkItem({ subject_id: `inbound:${encodeRef(String(r.immediate.inbound_id))}`.slice(0, 120), sources: r.immediate.sources || [] })], close_missing: false })
            if (!res?.ok) throw Object.assign(new Error('OPERATOR_ITEM_REFUSED'), { code: 'OPERATOR_ITEM_REFUSED', reason: res?.reason || null })
          }
        }
        return { result: { ...turnRouteResult(r), immediate: r?.immediate ? { terminal: r.immediate.terminal || null, precautionary: Boolean(r.immediate.precautionary), effects: (r.effects?.effects || []).map((e) => `${e.kind}:${e.ok ? 'ok' : 'failed'}`) } : null } }
      }
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

/** Codes / counts only (agent.payload_is_clean): the turn id is letter-encoded, never raw. */
export function turnRouteResult(r = {}) {
  const id = r?.turn_id ? encodeRef(String(r.turn_id)) : null
  return {
    code: r?.code || null, route: r?.route || null, event_type: r?.event_type || null, turn_ref: id,
    turn_version: Number.isInteger(r?.version) ? r.version : null, delay_minutes: r?.plan?.since_inbound_minutes ?? null,
    plan_reasons: Array.isArray(r?.plan?.reasons) ? r.plan.reasons.slice(0, 6) : [], cancelled: r?.cancelled ?? null,
    job_deduped: r?.job ? Boolean(r.job.deduped) : null,
  }
}

/** {} unless the env gate is on — the tick then never claims this kind. Turn kinds need BOTH flags. */
export function conversationRuntimeHandlers(env = process.env) {
  if (!conversationAiShadowRequested(env)) return {}
  const handlers = { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ env }) }
  if (turnsRequested(env)) {
    handlers[CONVERSATION_TURN_KIND] = createConversationTurnHandler({ env, trackerFor: runtimeJobTracker })
    handlers[CONVERSATION_TURN_SWEEP_KIND] = createConversationTurnSweepHandler({ env })
  }
  return handlers
}

export { CONVERSATION_AI_SHADOW_ENV }

// rc-8.5.21 v4 (rt-cr-01): the stranded-inbound recovery is a RUNTIME TICK maintenance task whenever the
// conversation pipeline is live (the same env gate that registers conversation.decide). v3fix ran it only
// inside the born-disabled conversation-turn-sweep schedule and the born-off ops supervisor, so with the
// pipeline live and those optional schedules off (the shipped posture), an inbound persisted before its
// decide job was enqueued was never recovered. Idempotent (the hook's own event key), throttled per
// process, bounded by the sweep's lookback / grace window; nothing is decided or sent here.
export const INBOUND_RECOVERY_INTERVAL_MS = 60_000
const RECOVERY_LAST = Symbol.for('lc.conversation.inbound_recovery.last_at')

export function conversationRuntimeMaintenance(env = process.env, { supabase = null, recover = null, intervalMs = INBOUND_RECOVERY_INTERVAL_MS } = {}) {
  if (!conversationAiShadowRequested(env)) return []
  return [Object.freeze({
    name: 'conversation_inbound_recovery',
    async run({ store, now = new Date().toISOString() } = {}) {
      const t = Date.parse(now) || Date.now()
      const last = Number(globalThis[RECOVERY_LAST] || 0)
      if (intervalMs > 0 && last && t - last < intervalMs) return { skipped: 'throttled' }
      globalThis[RECOVERY_LAST] = t
      const sb = supabase || (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient()
      const fn = recover || (await import('./conversation-inbound-sweep.js')).recoverStrandedInbounds
      const r = await fn({ supabase: sb, runtimeStore: store, env, now })
      return { examined: r.examined || 0, enqueued: r.enqueued || 0, already_present: r.already_present || 0, failed: (r.failed || []).length, skipped: r.skipped || null }
    },
  })]
}

/** test seam: forget the per-process throttle */
export function __resetConversationMaintenanceThrottleForTests() { delete globalThis[RECOVERY_LAST] }

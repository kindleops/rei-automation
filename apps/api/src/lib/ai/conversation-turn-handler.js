// R2 runtime handlers for the 24/7 conversation turn engine (rc-8.5.20). OFF by default:
// registered only when AI_CONVERSATION_SHADOW_ENABLED=true AND AI_CONVERSATION_TURNS_ENABLED=true
// (conversation-decide-handler.js conversationRuntimeHandlers), and the DB claims a kind only
// when an operator armed + enabled it in agent.runtime_limits.kind_limits.
//
//   conversation.turn        one job per (turn, version), next_attempt_at = the planned due time.
//                            Claims the turn at that exact version, decides ONCE on the
//                            consolidated thread (the shadow decision: spend on THIS job through
//                            the same reserve/settle tracker as conversation.decide), finalizes.
//                            Not due yet (clock skew) ⇒ yield (no attempt burned). A newer
//                            version exists ⇒ TURN_SUPERSEDED (that version's job decides).
//   conversation.turn_sweep  restart recovery: re-enqueue overdue turns / expired claims.
//
// Results are codes / counts only (agent.payload_is_clean). Nothing is sent: R3 stays unwired.
import { encodeRef } from './conversation-ai-shadow-hook.js'
import {
  CONVERSATION_TURN_KIND, CONVERSATION_TURN_SWEEP_KIND, decodeTurnJobInput, recoverDueTurns, runDueTurn,
} from '@/lib/domain/conversation-ai/turns/turn-engine.js'

export { CONVERSATION_TURN_KIND, CONVERSATION_TURN_SWEEP_KIND }

async function defaultSupabase() {
  return (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient()
}
async function defaultTurnStore(supabase) {
  return (await import('@/lib/domain/conversation-ai/turns/turn-store.js')).createSupabaseTurnStore(supabase)
}

/**
 * @param {{ env?: object, store?: object, decide?: Function, trackerFor?: (ctx: object) => object, supabase?: object }} [deps]
 */
export function createConversationTurnHandler({ env = process.env, store = null, decide = null, trackerFor = null, supabase = null } = {}) {
  return Object.freeze({
    kind: CONVERSATION_TURN_KIND,
    async run(ctx) {
      const ref = decodeTurnJobInput(ctx.job.input || {})
      if (!ref) return { result: { code: 'TURN_REF_INVALID' } }
      await ctx.step('turn', { progress: { step: 'turn', steps_done: 0, steps_total: 1, pct: 0 } })
      const sb = supabase || (store && decide ? null : await defaultSupabase())
      const turnStore = store || (await defaultTurnStore(sb))
      const decideTurn = decide || (await import('./conversation-turn-wiring.js')).createShadowTurnDecider({ supabase: sb, env, tracker: trackerFor ? trackerFor(ctx) : null, remainingMs: ctx.remainingMs, signal: ctx.signal })
      let r
      try {
        r = await runDueTurn({ ...ref, store: turnStore, worker: `turn.${ctx.job.job_id}`.slice(0, 80), decideTurn })
      } catch (err) {
        if (err?.code === 'TURN_NOT_DUE') ctx.yield('turn_not_due')
        if (err?.abortJob === true && err.cause) throw err.cause
        throw err
      }
      return { result: { code: r.code, outcome: r.outcome || null, members: r.members ?? null, turn_ref: encodeRef(ref.turn_id), turn_version: ref.version } }
    },
  })
}

/**
 * @param {{ env?: object, store?: object, runtimeStore?: object, supabase?: object, now?: () => string }} [deps]
 */
export function createConversationTurnSweepHandler({ env = process.env, store = null, runtimeStore = null, supabase = null, now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    kind: CONVERSATION_TURN_SWEEP_KIND,
    async run(ctx) {
      await ctx.step('sweep', { progress: { step: 'sweep', steps_done: 0, steps_total: 1, pct: 0 } })
      const turnStore = store || (await defaultTurnStore(supabase || (await defaultSupabase())))
      const rs = runtimeStore || (await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env))
      const r = await recoverDueTurns({ store: turnStore, enqueueAt: (o) => rs.enqueueEventAt(o), now: now() })
      return { result: r }
    },
  })
}

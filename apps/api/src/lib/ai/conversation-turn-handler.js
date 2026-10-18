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
// rc-8.5.21: the decision is the canonical runtime; an authorised reply is dispatched through R3
// (OFF switches). A job that dies after finalize resumes the dispatch on retry (runDueTurn), but ONLY once
// its dispatch lease has expired; a live lease defers the retry (DEFERRED_LIVE_DISPATCH, retry-after).
//
// Results are codes / counts only (agent.payload_is_clean). R3 is wired but OFF (its switches are absent).
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
/** The operator work item for a turn whose AI reply R3 HELD (blind-eval D3). Codes only (payload_is_clean). */
export function heldTurnWorkItem({ turn_id, version, r3_status, reasons = [] }) {
  return {
    dedupe_key: `conversation:turn_held:${turn_id}`, kind: 'escalation', severity: 'warning', escalated: true,
    title: 'AI reply held for operator review', subject_type: 'conversation', subject_id: turn_id,
    detail: { r3_status: String(r3_status || 'unknown').slice(0, 40), reasons: reasons.slice(0, 6), turn_version: version },
  }
}

async function defaultOperatorItems(env) {
  const { getAgentPgPool } = await import('@/lib/agent/live/live-agent.js')
  const { createOperationsPgStore } = await import('@/lib/agent/operations/operations-store.js')
  return createOperationsPgStore({ pool: getAgentPgPool(env) })
}

export function createConversationTurnHandler({ env = process.env, store = null, decide = null, dispatch = undefined, runtimeStore = null, trackerFor = null, supabase = null, operatorItems = null } = {}) {
  return Object.freeze({
    kind: CONVERSATION_TURN_KIND,
    async run(ctx) {
      const ref = decodeTurnJobInput(ctx.job.input || {})
      if (!ref) return { result: { code: 'TURN_REF_INVALID' } }
      await ctx.step('turn', { progress: { step: 'turn', steps_done: 0, steps_total: 1, pct: 0 } })
      const sb = supabase || (store && decide ? null : await defaultSupabase())
      const turnStore = store || (await defaultTurnStore(sb))
      const wiring = decide ? null : await import('./conversation-turn-wiring.js')
      const decideTurn = decide || wiring.createCanonicalTurnDecider({ supabase: sb, env, tracker: trackerFor ? trackerFor(ctx) : null, remainingMs: ctx.remainingMs, signal: ctx.signal })
      // rc-8.5.21: the R3 dispatcher is wired; it only ever receives a reply the decider authorised
      // (kill switch + policy + scope), and R3 re-reads every switch before any enqueue
      const dispatchTurn = dispatch !== undefined ? dispatch : (await import('./conversation-turn-dispatch.js')).createR3TurnDispatcher({ supabase: sb, jobId: ctx.job.job_id })
      let rs = runtimeStore
      const enqueueAt = async (o) => { rs ||= await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env); return rs.enqueueEventAt(o) }
      let r
      try {
        // a held reply raises ONE operator work item per turn through the lease-bound writer (scope
        // 'conversation'); a failed write throws, so the job retries and a hold is never silent
        const raiseOperatorItem = async (h) => {
          const items = operatorItems || (await defaultOperatorItems(env))
          const res = await items.syncWorkItems({ ...ctx.lease, items: [heldTurnWorkItem(h)], close_missing: false })
          if (!res?.ok) throw Object.assign(new Error('OPERATOR_ITEM_REFUSED'), { code: 'OPERATOR_ITEM_REFUSED', reason: res?.reason || null })
          return res
        }
        r = await runDueTurn({ ...ref, store: turnStore, worker: `turn.${ctx.job.job_id}`.slice(0, 80), decideTurn, dispatch: dispatchTurn, enqueueAt, raiseOperatorItem })
      } catch (err) {
        if (err?.code === 'TURN_NOT_DUE') ctx.yield('turn_not_due')
        // a transient dispatch failure: the runtime retries the job (bounded attempts, then dead letter)
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

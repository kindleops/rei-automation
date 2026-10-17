// Composition root for the rc-8.5.21 FOLLOW-UP EXECUTION PIPELINE
// (lib/domain/followups/followup-execution.js): the three runtime kinds
//
//   followup.execution_sweep   due follow_up_at intents → one followup.dispatch job each (or adopt)
//   followup.dispatch          fresh re-check → ONE claimed canonical follow-up write (send_queue)
//   followup.reconcile         dates with no job · jobs with no outcome · duplicates · retries
//
// followupRuntimeHandlers() → {} unless LC_FOLLOWUP_EXECUTION=1 and the runtime gate; the DB then
// still claims a kind only when the owner armed + enabled it in agent.runtime_limits.kind_limits,
// and every handler does nothing while system_control.followup_execution_mode is absent / 'off'.
import { runtimeGate } from '@/lib/agent/runtime/runtime-service.js'
import { getSystemValueFresh } from '@/lib/system-control.js'
import {
  createFollowUpDeps, decodeDispatchInput, followUpExecutionRequested, runFollowUpDispatch, runFollowUpReconcile, runFollowUpSweep,
  FOLLOWUP_DISPATCH_KIND, FOLLOWUP_RECONCILE_KIND, FOLLOWUP_SWEEP_KIND,
} from '@/lib/domain/followups/followup-execution.js'

async function defaultSupabase() {
  return (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient()
}

/**
 * @param {{ env?: object, supabase?: object, runtimeStore?: object, deps?: object }} [o] tests inject deps
 */
export function buildFollowUpHandlers({ env = process.env, supabase = null, runtimeStore = null, deps = null } = {}) {
  const depsFor = async () => {
    if (deps) return deps
    const sb = supabase || (await defaultSupabase())
    let rs = runtimeStore
    const enqueueAt = async (o) => { rs ||= await (await import('@/lib/agent/runtime/runtime-service.js')).getVerifiedRuntimeStore(env); return rs.enqueueEventAt(o) }
    return createFollowUpDeps({ supabase: sb, readSwitch: (key) => getSystemValueFresh(key, { supabase: sb }), enqueueAt })
  }
  return {
    [FOLLOWUP_SWEEP_KIND]: Object.freeze({
      kind: FOLLOWUP_SWEEP_KIND,
      async run(ctx) {
        await ctx.step('sweep', { progress: { step: 'sweep', steps_done: 0, steps_total: 1, pct: 0 } })
        return { result: await runFollowUpSweep(await depsFor()) }
      },
    }),
    [FOLLOWUP_DISPATCH_KIND]: Object.freeze({
      kind: FOLLOWUP_DISPATCH_KIND,
      async run(ctx) {
        const job = decodeDispatchInput(ctx.job.input || {})
        if (!job) return { result: { code: 'FOLLOWUP_INPUT_INVALID' } }
        await ctx.step('dispatch', { progress: { step: 'dispatch', steps_done: 0, steps_total: 1, pct: 0 } })
        // a thrown error (read failure, another worker holding the claim) is retried by the runtime:
        // bounded attempts, then dead letter — the claimed write itself is idempotent
        const r = await runFollowUpDispatch(job, await depsFor())
        return { result: { code: r.code, reason: r.reason || null, followup_kind: job.kind, attempt: job.attempt, send_at: r.send_at || null } }
      },
    }),
    [FOLLOWUP_RECONCILE_KIND]: Object.freeze({
      kind: FOLLOWUP_RECONCILE_KIND,
      async run(ctx) {
        await ctx.step('reconcile', { progress: { step: 'reconcile', steps_done: 0, steps_total: 1, pct: 0 } })
        return { result: await runFollowUpReconcile(await depsFor()) }
      },
    }),
  }
}

export function followupRuntimeHandlers(env = process.env) {
  if (!followUpExecutionRequested(env) || !runtimeGate(env).enabled) return {}
  return buildFollowUpHandlers({ env })
}

// Composition root for the FOLLOW-UP EXECUTION LIFECYCLE on the agent runtime
// (lib/domain/followups/followup-execution.js → followup-lifecycle.js): the three runtime kinds
//
//   followup.execution_sweep   one materialization pass (due − lead intents → ONE nonempty send-ready row each, or a reason)
//   followup.dispatch          materialize one named intent now
//   followup.reconcile         two-way reconciliation; report-only unless the job input says { apply: true }
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
 * @param {{ env?: object, supabase?: object, deps?: object }} [o] tests inject deps
 */
export function buildFollowUpHandlers({ env = process.env, supabase = null, deps = null } = {}) {
  void env
  const depsFor = async () => {
    if (deps) return deps
    const sb = supabase || (await defaultSupabase())
    return createFollowUpDeps({ supabase: sb, readSwitch: (key) => getSystemValueFresh(key, { supabase: sb }) })
  }
  return {
    [FOLLOWUP_SWEEP_KIND]: Object.freeze({
      kind: FOLLOWUP_SWEEP_KIND,
      async run(ctx) {
        await ctx.step('materialize', { progress: { step: 'materialize', steps_done: 0, steps_total: 1, pct: 0 } })
        // a thrown claim / read error is retried by the runtime (bounded, then dead letter); each
        // intent's own lease makes a replayed pass exactly-once
        return { result: await runFollowUpSweep({ ...(await depsFor()), worker: `runtime:${ctx.job?.job_id || 'sweep'}` }) }
      },
    }),
    [FOLLOWUP_DISPATCH_KIND]: Object.freeze({
      kind: FOLLOWUP_DISPATCH_KIND,
      async run(ctx) {
        const job = decodeDispatchInput(ctx.job.input || {})
        if (!job) return { result: { code: 'FOLLOWUP_INPUT_INVALID' } }
        await ctx.step('materialize_one', { progress: { step: 'materialize_one', steps_done: 0, steps_total: 1, pct: 0 } })
        const r = await runFollowUpDispatch(job, { ...(await depsFor()), worker: `runtime:${ctx.job?.job_id || 'dispatch'}` })
        return { result: { code: r.code, reason: r.reason || null } }
      },
    }),
    [FOLLOWUP_RECONCILE_KIND]: Object.freeze({
      kind: FOLLOWUP_RECONCILE_KIND,
      async run(ctx) {
        await ctx.step('reconcile', { progress: { step: 'reconcile', steps_done: 0, steps_total: 1, pct: 0 } })
        return { result: await runFollowUpReconcile(await depsFor(), { apply: ctx.job?.input?.apply === true }) }
      },
    }),
  }
}

export function followupRuntimeHandlers(env = process.env) {
  if (!followUpExecutionRequested(env) || !runtimeGate(env).enabled) return {}
  return buildFollowUpHandlers({ env })
}

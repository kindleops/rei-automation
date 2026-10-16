// 8.5.20 part C — operations runtime kinds, switches and schedules.
//
// Four R2 runtime kinds (agent.research_job rows run by runtime/runtime-tick.js). None of
// them can send, queue, schedule a message or write a stage: they read (agent.ops_*
// SECURITY DEFINER read functions), record findings, sync durable work items and action
// states (lease-bound agent.ops_* writers), and — pipeline.reconcile only — prepare
// PENDING stage-change approvals through pipeline.propose_stage_change.
export const RECOVERY_SWEEP_KIND = 'recovery.sweep'
export const ACTION_CENTER_KIND = 'inbox.action_center'
export const PIPELINE_RECONCILE_KIND = 'pipeline.reconcile'
export const OPS_SUPERVISOR_KIND = 'ops.supervisor'
export const OPERATIONS_KINDS = Object.freeze([RECOVERY_SWEEP_KIND, ACTION_CENTER_KIND, PIPELINE_RECONCILE_KIND, OPS_SUPERVISOR_KIND])

/** Handlers register only when AGENT_OPERATIONS_ENABLED (and the runtime gate); the DB still claims a kind only when armed. */
export const OPERATIONS_FLAG = 'AGENT_OPERATIONS_ENABLED'
const ON = new Set(['1', 'true', 'on', 'yes'])
export function operationsEnabled(env = process.env) {
  return ON.has(String(env?.[OPERATIONS_FLAG] ?? '').trim().toLowerCase())
}

/**
 * Schedule definitions — created ONLY by the owner path and born DISABLED:
 * supabase/migrations/PROPOSED_20261016140100_operations_schedules.sql (kept in step by a test).
 * approved_programs = [] ⇒ the recovery sweep labels nothing "eligible" until the owner names a program.
 */
export const OPERATIONS_SCHEDULE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'recovery-sweep', kind: RECOVERY_SWEEP_KIND, interval_seconds: 6 * 3600, budget_cap_usd: 0, input: Object.freeze({ batch_limit: 300, approved_programs: Object.freeze([]), full_pass_hours: 24 }) }),
  Object.freeze({ name: 'inbox-action-center', kind: ACTION_CENTER_KIND, interval_seconds: 15 * 60, budget_cap_usd: 0, input: Object.freeze({ batch_limit: 500, full_pass_hours: 1 }) }),
  Object.freeze({ name: 'pipeline-reconcile', kind: PIPELINE_RECONCILE_KIND, interval_seconds: 6 * 3600, budget_cap_usd: 0, input: Object.freeze({ batch_limit: 300, propose: true, max_proposals: 5 }) }),
  Object.freeze({ name: 'ops-supervisor', kind: OPS_SUPERVISOR_KIND, interval_seconds: 30 * 60, budget_cap_usd: 0, input: Object.freeze({}) }),
])

export const OPERATIONS_LIMITS = Object.freeze({
  batch_max: 500,
  findings_per_job: 200,
  proposals_max: 10,
})

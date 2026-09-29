/**
 * In-memory Supabase for the workflow orchestrator. Mirrors the rules in
 * supabase/migrations/20260929140000_workflow_orchestrator.sql: unique keys,
 * one live run per workflow × subject, immutable versions, append-only steps,
 * a logical action succeeds once, and the lease-based wf_claim_runs RPC.
 */
import { makeClosingDb } from './closing-db-mock.mjs'

const LIVE = new Set(['running', 'waiting', 'awaiting_approval', 'held'])

export function makeWfDb(seed = {}) {
  return makeClosingDb({ system_control: [], wf_workflows: [], wf_versions: [], wf_runs: [], wf_run_steps: [], wf_waits: [], workflow_events: [], ...seed }, {
    unique: {
      wf_workflows: [['workflow_key']],
      wf_versions: [['workflow_key', 'version']],
      wf_runs: [['start_key']],
      wf_waits: [['run_id', 'node_id']],
      system_control: [['key']],
    },
    check(table, row, old, state) {
      if (table === 'wf_versions' && old) return { code: 'P0001', message: 'WF_VERSION_IMMUTABLE' }
      if (table === 'wf_run_steps' && old) return { code: 'P0001', message: 'WF_RUN_STEPS_APPEND_ONLY' }
      if (table === 'wf_run_steps' && row.status === 'succeeded' && row.idempotency_key && state.wf_run_steps.some((s) => s !== row && s.status === 'succeeded' && s.idempotency_key === row.idempotency_key)) return { code: '23505', message: 'wf_run_steps_action_once' }
      if (table === 'wf_runs') {
        if (LIVE.has(row.state) && state.wf_runs.some((r) => r.id !== row.id && r !== old && LIVE.has(r.state) && r.workflow_key === row.workflow_key && r.subject_kind === row.subject_kind && r.subject_id === row.subject_id)) return { code: '23505', message: 'wf_runs_one_active' }
        if (['completed', 'failed', 'cancelled'].includes(row.state) && !row.finished_at) return { code: '23514', message: 'wf_runs_terminal_finished' }
        if (row.state === 'held' && !row.reason) return { code: '23514', message: 'wf_runs_held_has_reason' }
      }
      if (table === 'wf_workflows' && row.status === 'armed' && !row.live_version) return { code: '23514', message: 'wf_workflows_armed_has_version' }
      return null
    },
    rpc: {
      wf_claim_runs({ p_limit, p_worker, p_now, p_lease_seconds }, state) {
        const due = state.wf_runs
          .filter((r) => (r.state === 'running' || (['waiting', 'awaiting_approval'].includes(r.state) && r.wake_at && r.wake_at <= p_now)) && (!r.lease_until || r.lease_until < p_now))
          .sort((a, b) => String(a.wake_at || a.started_at).localeCompare(String(b.wake_at || b.started_at)))
          .slice(0, p_limit)
        for (const r of due) Object.assign(r, { lease_owner: p_worker, lease_until: new Date(Date.parse(p_now) + p_lease_seconds * 1000).toISOString() })
        return { data: due.map((r) => JSON.parse(JSON.stringify(r))), error: null }
      },
    },
  })
}

export const ENABLED = [{ key: 'workflow_orchestrator_enabled', value: 'true' }]
export const ENV_ON = { WORKFLOW_ORCHESTRATOR_ENABLED: 'true' }

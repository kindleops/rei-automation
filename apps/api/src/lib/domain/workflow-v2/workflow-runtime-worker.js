// Workflow V2 — the runtime worker.
//
// Two jobs, one worker, one cron. Both were fully built and entirely undriven:
//
//  1. THE CANONICAL EVENT BRIDGE. Acquisition emits into `automation_events`;
//     Workflow V2 reads `workflow_events`. Nothing connected them, so no
//     published workflow could ever be entered. This drains the canonical bus
//     into the workflow inbox through the normal ingest path.
//
//  2. DUE SCHEDULED WORK. `scheduled-tasks.js` exports `findDueTasks` and
//     `completeTask`, and measured 2026-09-15 they had ZERO callers anywhere in
//     the codebase — matching `workflow_scheduled_tasks = 0` rows and
//     `/api/workflows/process`'s own comment, "No cron integration yet".
//
// DELIBERATELY NOT A SECOND TIMER SERVICE. This is a plain function driven by
// the same vercel.json cron list every other recurring worker uses. It holds no
// state, keeps no in-process schedule, and does not depend on an open browser.
//
// IDEMPOTENCY comes from the database, not from this file's bookkeeping:
//   - `workflow_events.dedupe_key` UNIQUE, keyed off the CANONICAL event's own
//     dedupe_key, so re-scanning an overlapping window is harmless.
//   - `workflow_enrollments (definition, subject_type, subject_id)` UNIQUE.
//   - `workflow_runs.dedupe_key` UNIQUE (partial).
//   - `workflow_scheduled_tasks.dedupe_key` UNIQUE.
// That is why the bridge can use a simple overlapping time window instead of a
// cursor: a duplicate delivery collides on a unique key and is dropped, rather
// than being prevented by state this worker would have to keep correct.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { getSystemValue } from '@/lib/system-control.js';
import { canonicalEventToWorkflowEvent } from '@/lib/domain/workflow-v2/canonical-event-bridge.js';
import { ingestWorkflowEvent } from '@/lib/domain/workflow-v2/events-service.js';
import { findDueTasks, claimTask, completeTask } from '@/lib/domain/workflow-v2/scheduled-tasks.js';
import { runEnrollment, processReadyEnrollments } from '@/lib/domain/workflow-v2/workflow-runner.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

export const BRIDGE_MODE_OFF = 'off';
export const BRIDGE_MODE_ACTIVE_ONLY = 'active_only';
const DEFAULT_BRIDGE_MODE = BRIDGE_MODE_ACTIVE_ONLY;

/**
 * Operator kill switch.
 *
 * `active_only` (the default) is the honest description of what the bridge can
 * do: it delivers canonical events to the matcher, and the matcher selects only
 * definitions with `status = 'active'`. It is not a second safety mechanism —
 * the status gate in execution-service.js is the real containment — it is the
 * lever an operator needs if the bridge itself misbehaves.
 */
export async function resolveBridgeMode(deps = {}) {
  if (clean(deps.bridgeMode)) return clean(deps.bridgeMode);
  try {
    const value = clean(await getSystemValue('workflow_event_bridge_mode'));
    return value || DEFAULT_BRIDGE_MODE;
  } catch {
    // An unreadable control must not silently open the bridge wider than its
    // default, and must not break the worker either.
    return DEFAULT_BRIDGE_MODE;
  }
}

const DEFAULT_LOOKBACK_MINUTES = 15;
const MAX_EVENTS_PER_TICK = 200;

/**
 * Drain canonical acquisition events into the workflow event inbox.
 *
 * The window overlaps deliberately: re-reading an event that was already
 * bridged costs one insert attempt that collides on `dedupe_key`, which is
 * cheaper and far more robust than a cursor this worker could corrupt.
 */
export async function drainCanonicalEventsToWorkflow(opts = {}, deps = {}) {
  const mode = await resolveBridgeMode(deps);
  if (mode === BRIDGE_MODE_OFF) {
    return { ok: true, mode, skipped: true, scanned: 0, bridged: 0, duplicates: 0, unmapped: 0 };
  }

  const client = db(deps);
  const lookbackMinutes = Math.min(Math.max(Number(opts.lookback_minutes) || DEFAULT_LOOKBACK_MINUTES, 1), 1440);
  const limit = Math.min(Math.max(Number(opts.limit) || MAX_EVENTS_PER_TICK, 1), 1000);
  const since = opts.since ?? new Date(Date.now() - lookbackMinutes * 60_000).toISOString();

  const { data, error } = await client
    .from('automation_events')
    .select('id, event_type, dedupe_key, source, conversation_thread_id, property_id, prospect_id, master_owner_id, payload, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(limit);
  // A failed read must surface. Reporting "0 bridged" for an unreadable bus
  // would look exactly like a quiet acquisition period.
  if (error) throw error;

  const rows = data ?? [];
  const results = { ok: true, mode, since, scanned: rows.length, bridged: 0, duplicates: 0, unmapped: 0, matched: 0, errors: [] };

  for (const row of rows) {
    const mapped = canonicalEventToWorkflowEvent(row);
    if (!mapped.ok) {
      // Most canonical events are not workflow triggers (recovery bookkeeping,
      // shadow telemetry). Not an error — just not a trigger.
      results.unmapped += 1;
      continue;
    }
    try {
      const ingested = await ingestWorkflowEvent(mapped.event, { supabase: client });
      if (ingested?.duplicate) {
        results.duplicates += 1;
        continue;
      }
      if (ingested?.ok) {
        results.bridged += 1;
        results.matched += Number(ingested.execution?.definitions_matched ?? 0);
      } else {
        results.errors.push({ canonical_event_id: row.id, error: ingested?.error ?? 'ingest_failed' });
      }
    } catch (err) {
      // One poisoned event must not stop the drain.
      results.errors.push({ canonical_event_id: row.id, error: err?.message ?? String(err) });
    }
  }

  return results;
}

const MAX_TASKS_PER_TICK = 100;

/**
 * Process workflow scheduled tasks whose time has come.
 *
 * Each task is CLAIMED with a compare-and-swap before any work happens, so two
 * overlapping ticks cannot both advance the same run — `findDueTasks` alone
 * would hand the same pending row to both. A task that loses the race is
 * counted as `already_claimed`, not as an error.
 *
 * The claim also makes a crash mid-tick safe in the right direction: the row is
 * left in `running` rather than silently re-running, which is visible.
 */
export async function processDueWorkflowTasks(opts = {}, deps = {}) {
  const client = db(deps);
  const limit = Math.min(Math.max(Number(opts.limit) || MAX_TASKS_PER_TICK, 1), 500);
  const now = opts.now ?? new Date().toISOString();

  const due = await findDueTasks({ limit, now }, { supabase: client });
  const tasks = due?.tasks ?? due?.data ?? (Array.isArray(due) ? due : []);

  const results = {
    ok: true,
    now,
    due: tasks.length,
    processed: 0,
    advanced: 0,
    skipped: 0,
    already_claimed: 0,
    errors: [],
    live_send_blocked: true,
  };

  for (const task of tasks) {
    try {
      const claim = await claimTask(task.id, { supabase: client });
      if (!claim.claimed) {
        results.already_claimed += 1;
        continue;
      }

      const enrollmentId = clean(task.enrollment_id);
      let advanced = false;
      if (enrollmentId) {
        const run = await runEnrollment(enrollmentId, { supabase: client });
        advanced = run?.ok === true;
      }

      await completeTask(
        task.id,
        {
          status: 'completed',
          payload: {
            ...(task.payload && typeof task.payload === 'object' ? task.payload : {}),
            processed_by: 'workflow_runtime_worker',
            enrollment_advanced: advanced,
          },
        },
        { supabase: client },
      );
      results.processed += 1;
      if (advanced) results.advanced += 1;
      else results.skipped += 1;
    } catch (err) {
      results.errors.push({ task_id: task.id, error: err?.message ?? String(err) });
    }
  }

  return results;
}

/**
 * One tick: bridge canonical events, then run everything that became due.
 *
 * There are TWO scheduling mechanisms and a worker that drove only one of them
 * would look like it worked while half the graph stalled:
 *
 *   - a `timing` node returns `_pause_until`, which parks the ENROLLMENT as
 *     `waiting` with `next_execution_at` — drained by processReadyEnrollments
 *   - `action.schedule_follow_up` writes a `workflow_scheduled_tasks` ROW —
 *     drained by processDueWorkflowTasks
 *
 * Order matters: bridge first so a brand-new event can be enrolled and reach
 * its first wait within the same tick, then drain due work.
 */
export async function runWorkflowRuntimeTick(opts = {}, deps = {}) {
  const bridge = await drainCanonicalEventsToWorkflow(opts, deps);
  const scheduled = await processDueWorkflowTasks(opts, deps);

  let enrollments;
  try {
    enrollments = await processReadyEnrollments(
      { limit: Math.min(Math.max(Number(opts.limit) || 50, 1), 200) },
      { supabase: db(deps) },
    );
  } catch (err) {
    enrollments = { ok: false, error: err?.message ?? String(err) };
  }

  return {
    ok: true,
    bridge,
    scheduled,
    enrollments,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
  };
}

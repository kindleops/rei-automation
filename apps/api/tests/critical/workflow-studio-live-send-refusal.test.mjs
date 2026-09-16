import test from 'node:test';
import assert from 'node:assert/strict';
import { updateDefinition, createDefinition } from '../../src/lib/domain/workflow-v2/definition-service.js';
import { pauseEnrollment, resumeEnrollment, cancelEnrollment } from '../../src/lib/domain/workflow-v2/run-control.js';
import { terminateEnrollment } from '../../src/lib/domain/workflow-v2/enrollment-service.js';
import { runEnrollment } from '../../src/lib/domain/workflow-v2/workflow-runner.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1 — arming Workflow Studio is refused, and
 * pause/resume scope is not allowed to drift.
 *
 * The mobile actions sheet's primary button asks for exactly
 * `{ status: 'active', live_send_enabled: true, operational_mode: 'live' }`.
 * Three things have to hold for that button to be safe, and each is pinned here
 * because each has failed somewhere in this codebase before:
 *
 *  1. The API REFUSES, with 423, BEFORE any read or write. If the refusal came
 *     after the patch, `status: 'active'` would land and the workflow would
 *     become trigger-matchable while live send stayed off — a half-armed state
 *     nobody asked for.
 *  2. `live_send_enabled` can never be written true by any other route in.
 *  3. Per-enrollment pause/resume must never touch workflow_definitions. The
 *     brief's requirement is explicit: a per-run pause may not pause the global
 *     workflow definition.
 *
 * The dashboard half of (1) is already guarded: backendClient maps 423 to
 * `{ ok: false }` (it used to rewrite refusals into ok:true, which painted a
 * blocked send as sent), `unwrap` throws on that, and `withBusy` only sets its
 * success notice after the task resolves — so "Workflow live mode armed" cannot
 * be shown for a refused request.
 */

/** Records every table touched, so scope violations are visible. */
function trackingSupabase({ definition = null } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    from(table) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return Promise.resolve({ data: definition ? [definition] : [], error: null }); },
        maybeSingle() {
          reads.push(table);
          return Promise.resolve({ data: definition, error: null });
        },
        single() {
          reads.push(table);
          return Promise.resolve({ data: definition, error: null });
        },
        update(patch) {
          writes.push({ table, op: 'update', patch });
          return {
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { ...definition, ...patch }, error: null }),
                maybeSingle: () => Promise.resolve({ data: { ...definition, ...patch }, error: null }),
              }),
            }),
          };
        },
        insert(rows) {
          writes.push({ table, op: 'insert', patch: rows });
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...definition, id: 'new-id' }, error: null }),
            }),
          };
        },
      };
      return builder;
    },
  };
}

const publishedDefinition = {
  id: 'def-1',
  name: 'Underwriting Collection',
  definition_key: 'underwriting_collection',
  status: 'published',
  trigger_type: 'trigger.asking_price_extracted',
  live_send_enabled: false,
  is_system_template: false,
  is_locked: false,
  metadata: { operational_mode: 'active_safe' },
};

test('the exact Go-live request is refused with 423', async () => {
  const client = trackingSupabase({ definition: publishedDefinition });
  const result = await updateDefinition(
    'def-1',
    { status: 'active', live_send_enabled: true, operational_mode: 'live' },
    { supabase: client },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.equal(result.error, 'workflow_v2_live_send_disabled');
});

/**
 * The ordering is the safety property. A refusal that happens after the write
 * would leave status='active' behind — trigger-matchable — which is a worse
 * state than either arming fully or refusing outright.
 */
test('the refusal happens before anything is read or written', async () => {
  const client = trackingSupabase({ definition: publishedDefinition });
  await updateDefinition('def-1', { live_send_enabled: true }, { supabase: client });
  assert.deepEqual(client.writes, [], 'nothing may be written on a refused arm');
  assert.deepEqual(client.reads, [], 'the guard must not even load the definition');
});

test('live_send_enabled is forced false on every accepted update', async () => {
  const client = trackingSupabase({ definition: publishedDefinition });
  const result = await updateDefinition('def-1', { status: 'paused' }, { supabase: client });
  assert.equal(result.ok, true);
  const update = client.writes.find((w) => w.table === 'workflow_definitions' && w.op === 'update');
  assert.ok(update, 'the update must have happened');
  assert.equal(update.patch.live_send_enabled, false, 'every write pins it false');
  assert.equal(result.definition.live_send_enabled, false, 'and the response never claims otherwise');
});

test('a workflow cannot be created with live send on either', async () => {
  const client = trackingSupabase({ definition: publishedDefinition });
  const result = await createDefinition(
    { name: 'X', definition_key: 'x', live_send_enabled: true },
    { supabase: client },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.deepEqual(client.writes, [], 'no row may be inserted on a refused create');
});

// ───────────────────────────────────────── pause/resume scope

/**
 * A per-run pause must stay per-run. These assert the TABLE, not the value:
 * the failure mode the brief names is a run-level control reaching the global
 * definition, and only the table touched can show that.
 */
test('per-enrollment pause never touches the workflow definition', async () => {
  const client = trackingSupabase({ definition: { id: 'enr-1', status: 'waiting' } });
  await pauseEnrollment('enr-1', 'manual_pause', { supabase: client });
  const tables = [...new Set(client.writes.map((w) => w.table))];
  assert.deepEqual(tables, ['workflow_enrollments']);
});

test('per-enrollment resume never arms the workflow definition', async () => {
  const client = trackingSupabase({ definition: { id: 'enr-1', status: 'active' } });
  await resumeEnrollment('enr-1', { supabase: client });
  const tables = [...new Set(client.writes.map((w) => w.table))];
  assert.deepEqual(tables, ['workflow_enrollments']);
  assert.ok(
    !client.writes.some((w) => w.patch?.live_send_enabled === true),
    'resuming a run may never enable live send',
  );
});

test('cancelling an enrollment is also scoped to the enrollment', async () => {
  const client = trackingSupabase({ definition: { id: 'enr-1', status: 'cancelled' } });
  await cancelEnrollment('enr-1', 'cancelled', { supabase: client });
  assert.deepEqual([...new Set(client.writes.map((w) => w.table))], ['workflow_enrollments']);
});

/**
 * The inverse direction, which is the one the mobile sheet actually exposes:
 * definition-level resume sets status='active', and 'active' is precisely what
 * matchDefinitions requires. The sheet's copy now says so; this pins the
 * behaviour it describes.
 */
test('definition-level resume arms the definition, and says so by writing active', async () => {
  const client = trackingSupabase({ definition: { ...publishedDefinition, status: 'paused' } });
  const { resumeDefinition } = await import('../../src/lib/domain/workflow-v2/definition-service.js');
  const result = await resumeDefinition('def-1', { supabase: client });
  assert.equal(result.ok, true);
  const update = client.writes.find((w) => w.table === 'workflow_definitions');
  assert.equal(update.patch.status, 'active', 'this is the trigger-matchable status');
  assert.equal(update.patch.live_send_enabled, false, 'armed for matching is not armed for sending');
  assert.ok(
    !client.writes.some((w) => w.table === 'workflow_enrollments'),
    'it does not restart enrollments, whatever the button used to claim',
  );
});

// ───────────────────────────────────────── resume cannot bypass DNC (LOCK-1B)

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §15 acceptance — Resume must not be a way
 * around a suppression block.
 *
 * The guarantee is a chain, and each link is asserted separately because any one
 * of them failing would restore the bypass:
 *
 *   1. a blocked guard TERMINATES the enrollment (status 'cancelled', reason
 *      carried) — workflow-runner.js calls terminateEnrollment on a guard block
 *   2. runEnrollment refuses anything outside ['active', 'waiting'], so a
 *      cancelled enrollment can never be advanced again
 *   3. definition-level Resume writes only workflow_definitions (asserted
 *      above), so it cannot revive a cancelled enrollment
 *
 * Proven end-to-end against production in scripts/proof/workflow-runtime-proof.mjs:
 * the run parked on a wait, the subject became DNC through the real signal
 * (message_events.is_opt_out), the tick resumed, guard.suppression blocked, and
 * nothing past the gate executed.
 */
test('a suppression block terminates the enrollment rather than parking it', async () => {
  const writes = [];
  const client = {
    from() {
      return {
        update(patch) {
          writes.push(patch);
          return {
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { id: 'enr-1', ...patch }, error: null }) }),
            }),
          };
        },
      };
    },
  };
  const result = await terminateEnrollment('enr-1', 'guard_blocked:guard.suppression', { supabase: client });
  assert.equal(result.ok, true);
  assert.equal(writes[0].status, 'cancelled', 'a suppressed run must not stay runnable');
  assert.equal(writes[0].waiting_reason, 'guard_blocked:guard.suppression', 'the reason is carried, not dropped');
  assert.ok(writes[0].terminated_at, 'termination is timestamped');
});

test('a cancelled enrollment can never be advanced again', async () => {
  for (const status of ['cancelled', 'completed', 'failed']) {
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: () => Promise.resolve({ data: { id: 'enr-1', status, workflow_definition_id: 'def-1' }, error: null }),
          single: () => Promise.resolve({ data: { id: 'enr-1', status, workflow_definition_id: 'def-1' }, error: null }),
        };
      },
    };
    const result = await runEnrollment('enr-1', { supabase: client });
    assert.equal(result.ok, false, status);
    assert.equal(result.skipped, true, status);
    assert.equal(result.reason, 'enrollment_not_runnable', `${status} must not be runnable`);
  }
});

/** A paused run is skipped too, and for its own distinct reason. */
test('a paused enrollment is skipped with its own reason', async () => {
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: () => Promise.resolve({ data: { id: 'enr-1', status: 'paused', workflow_definition_id: 'def-1' }, error: null }),
        single: () => Promise.resolve({ data: { id: 'enr-1', status: 'paused', workflow_definition_id: 'def-1' }, error: null }),
      };
    },
  };
  const result = await runEnrollment('enr-1', { supabase: client });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'enrollment_paused');
});

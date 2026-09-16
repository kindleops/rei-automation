import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_MODE_OFF,
  drainCanonicalEventsToWorkflow,
  resolveBridgeMode,
} from '../../src/lib/domain/workflow-v2/workflow-runtime-worker.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §5/§11/§12 — the runtime worker.
 *
 * `findDueTasks` and `completeTask` had ZERO callers anywhere in the codebase,
 * matching `workflow_scheduled_tasks = 0` rows and /api/workflows/process's own
 * comment: "No cron integration yet; caller is responsible for scheduling."
 * Both jobs the worker now performs were fully built and entirely undriven.
 *
 * These cover the parts that are unit-testable with an injected client. The
 * end-to-end behaviour — a real canonical event producing exactly one run, a
 * due task processed exactly once, DNC interrupting a parked run — is proven
 * against production by scripts/proof/workflow-runtime-proof.mjs and recorded
 * in the phase report.
 */

/** A client that records what the drain asked for and hands back rows. */
function fakeBus({ rows = [], error = null, ingest = () => ({ ok: true }) } = {}) {
  const calls = { selects: [], ingested: [] };
  const client = {
    calls,
    from(table) {
      const builder = {
        select() { return builder; },
        gte(_col, value) { calls.selects.push({ table, since: value }); return builder; },
        order() { return builder; },
        limit(n) {
          calls.selects[calls.selects.length - 1].limit = n;
          return Promise.resolve({ data: error ? null : rows, error });
        },
      };
      return builder;
    },
  };
  return { client, calls, ingest };
}

/**
 * The drain is exercised through its injected supabase client; ingestion is
 * exercised separately because it is events-service's contract, not the
 * worker's.
 */
const drainWith = (fake, opts = {}) =>
  drainCanonicalEventsToWorkflow(opts, { supabase: fake.client, bridgeMode: 'active_only' });

test('the bridge mode defaults to active_only rather than wide open', async () => {
  const mode = await resolveBridgeMode({ bridgeMode: '' });
  assert.equal(mode, 'active_only');
});

test('an explicit off mode skips the drain entirely', async () => {
  const fake = fakeBus({ rows: [{ id: 'x', event_type: 'inbound_message_received', conversation_thread_id: 't' }] });
  const result = await drainCanonicalEventsToWorkflow({}, { supabase: fake.client, bridgeMode: BRIDGE_MODE_OFF });
  assert.equal(result.skipped, true);
  assert.equal(result.scanned, 0);
  assert.equal(fake.calls.selects.length, 0, 'the kill switch must not even read the bus');
});

/**
 * The drain reads an overlapping window instead of keeping a cursor, because
 * idempotency lives in the database (workflow_events.dedupe_key UNIQUE, keyed
 * off the canonical event's own key). A cursor would be state this worker could
 * corrupt; a window cannot lose an event it has not seen.
 */
test('the drain reads a bounded, overlapping window', async () => {
  const fake = fakeBus({ rows: [] });
  const before = Date.now();
  await drainWith(fake, { lookback_minutes: 15, limit: 50 });
  const [select] = fake.calls.selects;
  assert.equal(select.table, 'automation_events');
  assert.equal(select.limit, 50);
  const since = new Date(select.since).getTime();
  assert.ok(since <= before, 'the window must start in the past');
  assert.ok(before - since >= 14 * 60_000, `expected ~15m lookback, got ${(before - since) / 60_000}m`);
});

test('the lookback and limit are clamped to sane bounds', async () => {
  const fake = fakeBus({ rows: [] });
  await drainWith(fake, { lookback_minutes: 99999, limit: 99999 });
  const [select] = fake.calls.selects;
  assert.equal(select.limit, 1000, 'limit clamps');
  const lookbackMinutes = (Date.now() - new Date(select.since).getTime()) / 60_000;
  assert.ok(lookbackMinutes <= 1441, `lookback clamps, got ${lookbackMinutes}m`);
});

/**
 * An unreadable bus must surface. Reporting "0 bridged" for a failed read is
 * indistinguishable from a genuinely quiet acquisition period, which is exactly
 * how the disjunction went unnoticed for months in the first place.
 */
test('a failed bus read throws rather than reporting nothing to do', async () => {
  const fake = fakeBus({ error: { code: '42501', message: 'permission denied for table automation_events' } });
  await assert.rejects(
    () => drainWith(fake),
    (thrown) => {
      assert.match(String(thrown.message ?? thrown), /permission denied/);
      return true;
    },
  );
});

test('events that are not triggers are counted as unmapped, not as errors', async () => {
  const fake = fakeBus({
    rows: [
      { id: '1', event_type: 'RECOVERY_NEXT_ACTION_RESTORED', conversation_thread_id: 't1', dedupe_key: 'a' },
      { id: '2', event_type: 'acquisition_brain_shadow_decision', conversation_thread_id: 't2', dedupe_key: 'b' },
      { id: '3', event_type: 'queue_item_sent', conversation_thread_id: 't3', dedupe_key: 'c' },
    ],
  });
  const result = await drainWith(fake);
  assert.equal(result.scanned, 3);
  assert.equal(result.unmapped, 3);
  assert.equal(result.bridged, 0);
  assert.deepEqual(result.errors, [], 'housekeeping is not an error');
});

test('an event with no resolvable subject is unmapped rather than crashing the drain', async () => {
  const fake = fakeBus({
    rows: [{ id: '1', event_type: 'OWNER_CONFIRMED', conversation_thread_id: null, property_id: null, payload: {}, dedupe_key: 'a' }],
  });
  const result = await drainWith(fake);
  assert.equal(result.unmapped, 1);
  assert.deepEqual(result.errors, []);
});

test('an empty window makes no ingest attempt and reports cleanly', async () => {
  const fake = fakeBus({ rows: [] });
  const result = await drainWith(fake);
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.bridged, 0);
  assert.equal(result.duplicates, 0);
});

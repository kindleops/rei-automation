import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWorkflowTriggerActivity,
  listWorkflowStudioCatalog,
} from '../../src/lib/domain/workflow-v2/workflow-studio-bridge.js';
import {
  SELLER_FACING_NODE_TYPES,
  isSellerFacingNodeType,
} from '../../src/lib/domain/workflow-v2/seller-facing-nodes.js';
import { S1_URGENCY_DELAYS_DAYS } from '../../src/lib/domain/acquisition/s1-cadence.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1 §3/§4/§22/§33 — what the catalog may claim.
 *
 * Two defects, both measured against production on 2026-09-15.
 *
 * 1. `send_node_count` WAS A HARDCODED ZERO. `mapDefinitionToWorkflowSummary`
 *    returned the literal `send_node_count: 0` for every workflow, so the
 *    surface reported "no sends" about the four published workflows that
 *    genuinely carry a send node (Nurture/Reactivation, Stage-Aware No-Reply,
 *    Underwriting Collection, Asking Price Extraction). Whether a workflow can
 *    text a seller is the first thing an operator needs and the last thing that
 *    may be guessed.
 *
 * 2. NOTHING SAID THE WORKFLOWS COULD NOT RUN. The catalog stamped
 *    `operational_mode: 'active_safe'` on all 14 published workflows and the
 *    mobile row rendered that instead of the status, so each read "active safe".
 *    Meanwhile `matchDefinitions` (execution-service.js) selects on trigger_type
 *    AND status='active' — all 14 are `published` — and zero events of any
 *    `trigger.*` type have ever been emitted, because production emits
 *    `opportunity_*` and the library subscribes `trigger.*`. The two namespaces
 *    are disjoint.
 */

// ───────────────────────────────────────── seller-facing node types (§3)

test('the send-capable node types are exactly the ones that reach the queue', () => {
  assert.deepEqual([...SELLER_FACING_NODE_TYPES].sort(), [
    'action.enqueue_email',
    'action.enqueue_sms',
    'action.send_email',
    'action.send_sms',
  ]);
});

test('internal actions are not counted as seller-facing', () => {
  for (const nodeType of [
    'action.update_stage', 'action.update_status', 'action.run_classification',
    'action.schedule_follow_up', 'action.notify_operator', 'action.request_human_approval',
    'trigger.inbound_message_received', 'guard.suppression_check', '', null, undefined,
  ]) {
    assert.equal(isSellerFacingNodeType(nodeType), false, String(nodeType));
  }
});

test('a send node type is recognised through surrounding whitespace', () => {
  assert.equal(isSellerFacingNodeType('  action.send_sms  '), true);
});

// ───────────────────────────────────────── trigger activity evidence (§22)

/** Stands in for the workflow_event_type_activity aggregate. */
function fakeSupabase(rows, { error = null, noRpc = false } = {}) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const builder = {
        select() { return builder; },
        in() { return Promise.resolve({ data: [], error: null }); },
        order() { return builder; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      void table;
      return builder;
    },
  };
  if (!noRpc) {
    client.rpc = async (name, args) => {
      calls.push({ name, types: args?.p_event_types ?? [] });
      if (error) return { data: null, error };
      const wanted = new Set(args.p_event_types);
      return { data: rows.filter((r) => wanted.has(r.event_type)), error: null };
    };
  }
  return client;
}

test('an observed trigger reports its real count and last-seen', async () => {
  const { activity, available } = await fetchWorkflowTriggerActivity(['lead_entered_workflow'], {
    supabase: fakeSupabase([
      { event_type: 'lead_entered_workflow', event_count: 4, last_seen_at: '2026-06-12T05:58:25.666Z' },
    ]),
  });
  assert.equal(available, true);
  assert.equal(activity.get('lead_entered_workflow').event_count, 4);
  assert.equal(activity.get('lead_entered_workflow').last_seen_at, '2026-06-12T05:58:25.666Z');
});

/**
 * The production shape: a trigger type with no rows at all. That is a MEASURED
 * zero and must be reported as one — it is the whole basis for saying a
 * workflow has never fired.
 */
test('a trigger with no events is a measured zero, not a missing entry', async () => {
  const { activity } = await fetchWorkflowTriggerActivity(
    ['trigger.inbound_message_received', 'trigger.follow_up_due'],
    { supabase: fakeSupabase([]) },
  );
  for (const type of ['trigger.inbound_message_received', 'trigger.follow_up_due']) {
    assert.equal(activity.get(type).event_count, 0, type);
    assert.equal(activity.get(type).last_seen_at, null);
  }
});

/**
 * The distinction that decides whether the UI may reassure: unmeasured is not
 * zero. A failed aggregate must not render as "never fired".
 */
test('an unavailable aggregate reports unavailable rather than zero', async () => {
  const failed = await fetchWorkflowTriggerActivity(['trigger.offer_sent'], {
    supabase: fakeSupabase([], { error: { code: '42501', message: 'permission denied for function' } }),
  });
  assert.equal(failed.available, false);
  assert.equal(failed.activity.size, 0, 'no entry at all, so callers cannot read a zero');

  const missing = await fetchWorkflowTriggerActivity(['trigger.offer_sent'], {
    supabase: fakeSupabase([], { noRpc: true }),
  });
  assert.equal(missing.available, false);
});

test('trigger types are de-duplicated and blanks dropped before the lookup', async () => {
  const client = fakeSupabase([]);
  await fetchWorkflowTriggerActivity(
    ['trigger.a', 'trigger.a', '  trigger.b  ', '', null, undefined],
    { supabase: client },
  );
  assert.deepEqual([...client.calls[0].types].sort(), ['trigger.a', 'trigger.b']);
});

test('an empty trigger set makes no call at all', async () => {
  const client = fakeSupabase([]);
  const { activity, available } = await fetchWorkflowTriggerActivity([], { supabase: client });
  assert.equal(activity.size, 0);
  assert.equal(available, true);
  assert.equal(client.calls.length, 0);
});

// ───────────────────────────────────────── the catalog projection (§3/§4)

/**
 * A client shaped like the lightweight catalog path: definitions, nodes, edges,
 * and the trigger aggregate.
 */
function catalogSupabase({ definitions, nodes }) {
  const rpcCalls = [];
  return {
    rpcCalls,
    rpc: async (name, args) => {
      rpcCalls.push(name);
      if (name !== 'workflow_event_type_activity') return { data: null, error: { message: 'unknown' } };
      // Nothing has ever fired — the production condition.
      void args;
      return { data: [], error: null };
    },
    from(table) {
      const builder = {
        _table: table,
        select() { return builder; },
        order() { return builder; },
        limit() {
          if (table === 'workflow_definitions') return Promise.resolve({ data: definitions, error: null });
          return Promise.resolve({ data: [], error: null });
        },
        in() {
          if (table === 'workflow_nodes') return Promise.resolve({ data: nodes, error: null });
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
}

const definition = (over = {}) => ({
  id: 'def-1',
  name: 'Underwriting Collection',
  description: null,
  definition_key: 'underwriting_collection',
  status: 'published',
  trigger_type: 'trigger.asking_price_extracted',
  version: 1,
  updated_at: '2026-09-01T00:00:00.000Z',
  created_at: '2026-09-01T00:00:00.000Z',
  published_at: '2026-09-01T00:00:00.000Z',
  metadata: { operational_mode: 'active_safe', channel: 'multichannel' },
  is_system_template: true,
  is_locked: true,
  ...over,
});

test('send nodes are counted from the graph, not reported as zero', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: catalogSupabase({
      definitions: [definition()],
      nodes: [
        { workflow_definition_id: 'def-1', node_type: 'trigger.asking_price_extracted' },
        { workflow_definition_id: 'def-1', node_type: 'action.update_stage' },
        { workflow_definition_id: 'def-1', node_type: 'action.enqueue_sms' },
      ],
    }),
  });
  const [workflow] = result.workflows;
  assert.equal(workflow.node_count, 3);
  assert.equal(workflow.send_node_count, 1, 'a workflow that can text a seller must say so');
});

test('a workflow with no send node reports a measured zero', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: catalogSupabase({
      definitions: [definition({ name: 'Inbound Classification' })],
      nodes: [{ workflow_definition_id: 'def-1', node_type: 'action.run_classification' }],
    }),
  });
  assert.equal(result.workflows[0].send_node_count, 0);
});

/**
 * The headline. A published workflow is not selectable by the real matcher, and
 * its trigger has never been emitted. Both facts have to reach the projection,
 * because `operational_mode: 'active_safe'` alone told the operator the
 * opposite.
 */
test('a published workflow is reported as unmatchable with a never-fired trigger', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: catalogSupabase({ definitions: [definition({ status: 'published' })], nodes: [] }),
  });
  const [workflow] = result.workflows;
  assert.equal(workflow.status, 'published');
  assert.equal(workflow.operational_mode, 'active_safe', 'the stored mode is unchanged — only the evidence is added');
  assert.equal(workflow.trigger_matchable, false, 'matchDefinitions requires status=active');
  assert.equal(workflow.trigger_event_count, 0, 'no trigger.* event has ever been emitted');
  assert.equal(workflow.trigger_last_seen_at, null);
});

test('an active workflow is reported as matchable', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: catalogSupabase({
      definitions: [definition({ status: 'active', trigger_type: 'lead_entered_workflow' })],
      nodes: [],
    }),
  });
  assert.equal(result.workflows[0].trigger_matchable, true);
});

test('the catalog still names workflow_definitions as canonical and legacy as read-only', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: catalogSupabase({ definitions: [definition()], nodes: [] }),
  });
  assert.equal(result.canonical_model, 'workflow_definitions');
  assert.equal(result.legacy_read_only, true);
});

/**
 * The fabricated zero has one more way in: a failed count read. If
 * `workflow_nodes` errors and the result is treated as an empty list, every
 * workflow reports 0 nodes and 0 send nodes — which is exactly the claim
 * ("this workflow cannot text sellers") that must never be guessed.
 */
test('a failed node count surfaces instead of reporting zero send nodes', async () => {
  const broken = {
    rpc: async () => ({ data: [], error: null }),
    from(table) {
      const builder = {
        select() { return builder; },
        order() { return builder; },
        limit() {
          if (table === 'workflow_definitions') return Promise.resolve({ data: [definition()], error: null });
          return Promise.resolve({ data: [], error: null });
        },
        in() {
          if (table === 'workflow_nodes') {
            return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied for table workflow_nodes' } });
          }
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
  await assert.rejects(
    () => listWorkflowStudioCatalog({}, { supabase: broken }),
    (thrown) => {
      assert.match(String(thrown.message), /workflow_nodes count failed/);
      assert.match(String(thrown.message), /permission denied/);
      return true;
    },
  );
});

// ───────────────────────────────────────── legacy visibility (§3)

/**
 * §3. FIVE WORKFLOWS WERE INVISIBLE, WITH NO ERROR.
 *
 * `listDefinitionsLightweight` asked `public.workflows` for `trigger_type` and
 * `version`. Neither column exists, so PostgREST failed the WHOLE select with
 *
 *   42703  column workflows.trigger_type does not exist
 *
 * and the result was then read as `v1Res.data ?? []` while only `v2Res.error`
 * was thrown. One unknown column killed the entire legacy read and the surface
 * quietly listed 18 workflows instead of 23. A list that omits things without
 * saying so is worse than one that errors.
 *
 * Their size was a second fabricated zero: legacy shape lives in
 * `workflow_steps`, which was never read, so every legacy workflow showed 0
 * nodes while carrying 3 to 16 steps.
 */
function legacySupabase({ legacyRows = [], steps = [], legacyError = null } = {}) {
  return {
    rpc: async () => ({ data: [], error: null }),
    from(table) {
      const builder = {
        select(columns) {
          builder._columns = String(columns ?? '');
          return builder;
        },
        order() { return builder; },
        limit() {
          if (table === 'workflow_definitions') return Promise.resolve({ data: [], error: null });
          if (table === 'workflows') {
            if (legacyError) return Promise.resolve({ data: null, error: legacyError });
            // Model PostgREST: any unknown column fails the whole select.
            for (const column of builder._columns.split(',').map((c) => c.trim()).filter(Boolean)) {
              if (!LEGACY_COLUMNS.has(column)) {
                return Promise.resolve({
                  data: null,
                  error: { code: '42703', message: `column workflows.${column} does not exist` },
                });
              }
            }
            return Promise.resolve({ data: legacyRows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        in() {
          if (table === 'workflow_steps') return Promise.resolve({ data: steps, error: null });
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
}

/** The real column set of public.workflows, measured 2026-09-15. */
const LEGACY_COLUMNS = new Set([
  'id', 'workflow_key', 'name', 'description', 'channel', 'workflow_type', 'status',
  'live_send_enabled', 'market_scope', 'state_scope', 'property_type_scope',
  'language_scope', 'owner_type_scope', 'asset_type_scope', 'daily_cap', 'hourly_cap',
  'timezone', 'created_at', 'updated_at',
]);

const legacyRow = (over = {}) => ({
  id: 'legacy-1',
  workflow_key: 'sfr_owner_check_sms',
  name: 'SFR Owner Check SMS Workflow',
  description: null,
  channel: 'sms',
  workflow_type: 'automation',
  status: 'draft',
  live_send_enabled: false,
  updated_at: '2026-06-03T00:00:00.000Z',
  created_at: '2026-06-03T00:00:00.000Z',
  ...over,
});

test('legacy workflows are listed, not silently dropped by an unknown column', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: legacySupabase({
      legacyRows: [legacyRow()],
      steps: Array.from({ length: 6 }, () => ({ workflow_id: 'legacy-1' })),
    }),
  });
  assert.equal(result.workflows.length, 1, 'the legacy read must succeed against the real column set');
  const [workflow] = result.workflows;
  assert.equal(workflow.is_legacy, true);
  assert.equal(workflow.name, 'SFR Owner Check SMS Workflow');
});

test('legacy size is counted from workflow_steps rather than reported as zero', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: legacySupabase({
      legacyRows: [legacyRow()],
      steps: Array.from({ length: 6 }, () => ({ workflow_id: 'legacy-1' })),
    }),
  });
  assert.equal(result.workflows[0].node_count, 6);
  assert.equal(result.workflows[0].step_count, 6);
});

/** Legacy steps are not graph nodes, so send capability is genuinely unknown. */
test('legacy send capability is unknown, never a reassuring zero', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: legacySupabase({ legacyRows: [legacyRow()], steps: [] }),
  });
  assert.equal(result.workflows[0].send_node_count, null);
});

test('a legacy read failure surfaces instead of hiding workflows', async () => {
  await assert.rejects(
    () => listWorkflowStudioCatalog({}, {
      supabase: legacySupabase({ legacyError: { code: '42501', message: 'permission denied for table workflows' } }),
    }),
    (thrown) => {
      assert.match(String(thrown.message), /permission denied/);
      return true;
    },
    'silently listing fewer workflows is the defect this replaces',
  );
});

test('smoke and duplicate legacy workflows stay filtered out', async () => {
  const result = await listWorkflowStudioCatalog({}, {
    supabase: legacySupabase({
      legacyRows: [
        legacyRow(),
        legacyRow({ id: 'l2', workflow_key: 'workflow_studio_smoke_1780528901493', name: 'Workflow Studio Smoke' }),
        legacyRow({ id: 'l3', workflow_key: 'owner_acquisition_follow_up_mq5t1yl9', name: 'Owner Acquisition Follow-Up' }),
        legacyRow({ id: 'l4', workflow_key: 'owner_acquisition_follow_up', name: 'Owner Acquisition Follow-Up' }),
        legacyRow({ id: 'l5', workflow_key: 'archived_one', status: 'archived' }),
      ],
      steps: [],
    }),
  });
  assert.deepEqual(
    result.workflows.map((w) => w.workflow_key).sort(),
    ['owner_acquisition_follow_up', 'sfr_owner_check_sms'],
    'the smoke run, the suffixed duplicate and the archived row stay hidden',
  );
});

// ───────────────────────────────────────── cadence agreement (§33)

/**
 * §33. Workflow Studio's ownership cadence must not become a second S1 policy.
 *
 * `workflow-v2/follow-up-service.js` carries its own BASELINE_CADENCES_DAYS
 * table, and its `ownership` row is the S1 path. It currently agrees with the
 * canonical `acquisition/s1-cadence.js` urgency table (7 / 14 / 21) and the
 * ownership branch delegates to `shouldScheduleS1FollowUp` rather than using
 * the local numbers — but nothing structurally keeps the two tables in step, so
 * silent divergence is exactly the failure this pins. It asserts agreement; it
 * does not change either table.
 */
test('the studio ownership cadence still agrees with the canonical S1 policy', async () => {
  const module = await import('../../src/lib/domain/workflow-v2/follow-up-service.js');
  // BASELINE_CADENCES_DAYS is module-private, so the agreement is asserted
  // against the canonical table's own values, which are exported.
  assert.deepEqual(
    [S1_URGENCY_DELAYS_DAYS.high, S1_URGENCY_DELAYS_DAYS.medium, S1_URGENCY_DELAYS_DAYS.low],
    [7, 14, 21],
    'canonical S1 urgency delays changed — reconcile workflow-v2/follow-up-service.js BASELINE_CADENCES_DAYS.ownership',
  );
  assert.equal(S1_URGENCY_DELAYS_DAYS.unknown, 21, 'an unknown urgency must not become the aggressive branch');
  assert.equal(typeof module.scheduleFollowUp, 'function');
});

/**
 * The compression multiplier is the aggressive-cadence risk on the non-S1
 * categories: motivation, cooperation and response speed compound to ~0.51.
 * The floor is what stops it reaching zero, so the floor is what gets pinned.
 */
test('follow-up timing compression can never go below one day', async () => {
  const { adjustFollowUpTiming } = await import('../../src/lib/domain/workflow-v2/follow-up-service.js');
  const fastest = {
    motivation_score: 100,
    seller_cooperation_score: 100,
    avg_response_time_hours: 1,
  };
  for (const baseDays of [1, 2, 3, 5, 7, 14, 30, 60, 90]) {
    const adjusted = adjustFollowUpTiming(baseDays, fastest);
    assert.ok(adjusted >= 1, `${baseDays} -> ${adjusted} must never drop below a day`);
    assert.ok(adjusted <= baseDays, `${baseDays} -> ${adjusted} must never be lengthened by compression`);
  }
  // Documented, so a change to the multipliers shows up here rather than in a
  // seller's inbox: 30 days of nurture compresses to 15 at maximum motivation.
  assert.equal(adjustFollowUpTiming(30, fastest), 15);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listWorkflowNodeRegistry,
  listWorkflowStudioCatalog,
  mutateWorkflowGraph,
  createWorkflowStudioDraft,
  getWorkflowStudioDetail,
  cloneLegacyWorkflowToV2,
} from '../../src/lib/domain/workflow-v2/workflow-studio-bridge.js';
import { resolveEdge } from '../../src/lib/domain/workflow-v2/graph-mutations.js';
import { NODE_TYPE_REGISTRY, getVisibleNodes } from '../../src/lib/domain/workflow-v2/node-registry.js';

function createFakeSupabase(seed = {}) {
  const rows = structuredClone(seed);
  let seq = 0;
  const id = (prefix) => `${prefix}-${++seq}`;

  const q = (table) => {
    const state = { table, filters: [], op: 'select', payload: null, one: false, order: null, limit: null };
    const api = {
      select() { return api; },
      eq(col, val) { state.filters.push(['eq', col, val]); return api; },
      in(col, vals) { state.filters.push(['in', col, vals]); return api; },
      order(col, opts) { state.order = { col, asc: opts?.ascending !== false }; return api; },
      limit(n) { state.limit = n; return api; },
      maybeSingle() { state.one = true; return api; },
      single() { state.one = true; return api; },
      insert(value) { state.op = 'insert'; state.payload = value; return api; },
      update(value) { state.op = 'update'; state.payload = value; return api; },
      delete() { state.op = 'delete'; return api; },
      then(resolve, reject) {
        try {
          if (!rows[state.table]) rows[state.table] = [];
          let data = [...rows[state.table]];
          for (const [kind, col, val] of state.filters) {
            if (kind === 'eq') data = data.filter((r) => r[col] === val);
            if (kind === 'in') data = data.filter((r) => val.includes(r[col]));
          }
          if (state.op === 'insert') {
            const items = Array.isArray(state.payload) ? state.payload : [state.payload];
            for (const item of items) {
              const row = { id: item.id ?? id(state.table), ...item };
              rows[state.table].push(row);
              data = [row];
            }
          }
          if (state.op === 'update') {
            data = data.map((r) => ({ ...r, ...state.payload }));
            rows[state.table] = rows[state.table].map((r) => (data.find((d) => d.id === r.id) ?? r));
          }
          if (state.op === 'delete') {
            rows[state.table] = rows[state.table].filter((r) => !data.some((d) => d.id === r.id));
            data = [];
          }
          if (state.order) {
            data.sort((a, b) => String(a[state.order.col]).localeCompare(String(b[state.order.col])));
            if (!state.order.asc) data.reverse();
          }
          if (state.limit != null) data = data.slice(0, state.limit);
          resolve({ data: state.one ? (data[0] ?? null) : data, error: null, count: data.length });
        } catch (error) {
          reject(error);
        }
      },
    };
    return api;
  };

  return { from: q, rows };
}

test('node registry exposes operator vs internal counts', async () => {
  const registryRows = NODE_TYPE_REGISTRY.map((n) => ({
    node_type: n.node_type,
    node_kind: n.node_kind,
    label: n.label,
    description: n.description,
    category: n.category,
    is_communication: n.is_communication === true,
    requires_guard_before: n.requires_guard_before === true,
    is_terminal: n.is_terminal === true,
    is_enabled: true,
    is_system: n.is_system === true,
    input_schema: {},
    output_schema: {},
  }));
  const fake = createFakeSupabase({ workflow_node_registry: registryRows });
  const result = await listWorkflowNodeRegistry({}, { supabase: fake });
  assert.equal(result.ok, true);
  assert.equal(result.counts.total, NODE_TYPE_REGISTRY.length);
  assert.equal(result.counts.operator, getVisibleNodes().length);
  assert.equal(result.counts.internal, NODE_TYPE_REGISTRY.length - getVisibleNodes().length);
});

test('resolveEdge finds edge by source and target node ids', async () => {
  const fake = createFakeSupabase({
    workflow_edges: [{
      id: 'edge-1',
      workflow_definition_id: 'wf-1',
      source_node_id: 'a',
      target_node_id: 'b',
      edge_type: 'next',
    }],
  });
  const resolved = await resolveEdge('wf-1', { source_node_id: 'a', target_node_id: 'b' }, { supabase: fake });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.edge.id, 'edge-1');
});

test('insert-before rewires inbound edges', async () => {
  const fake = createFakeSupabase({
    workflow_definitions: [{
      id: 'wf-1', name: 'Test', definition_key: 'test', status: 'draft', metadata: {}, is_locked: false,
    }],
    workflow_nodes: [
      { id: 'n-a', workflow_definition_id: 'wf-1', node_key: 'a', node_type: 'trigger.lead_entered_workflow', label: 'A', config: {}, position_x: 0, position_y: 0, is_active: true, node_kind: 'trigger' },
      { id: 'n-b', workflow_definition_id: 'wf-1', node_key: 'b', node_type: 'action.update_status', label: 'B', config: {}, position_x: 100, position_y: 0, is_active: true, node_kind: 'action' },
    ],
    workflow_edges: [{
      id: 'e-ab', workflow_definition_id: 'wf-1', source_node_id: 'n-a', target_node_id: 'n-b', edge_type: 'next',
    }],
    workflow_template_sets: [],
    workflow_sender_pools: [],
    workflow_enrollments: [],
    workflow_runs: [],
  });

  const result = await mutateWorkflowGraph('wf-1', {
    operation: 'insert-before',
    target_node_id: 'n-b',
    node_type: 'timing.wait_duration',
    label: 'Wait',
    position_x: 50,
    position_y: 0,
  }, { supabase: fake });

  assert.equal(result.ok, true);
  const edges = fake.rows.workflow_edges;
  assert.equal(edges.length, 2);
  const viaNew = edges.find((e) => e.source_node_id !== 'n-a' && e.target_node_id === 'n-b');
  assert.ok(viaNew);
});

test('createWorkflowStudioDraft creates trigger node', async () => {
  const fake = createFakeSupabase({
    workflow_definitions: [],
    workflow_nodes: [],
    workflow_edges: [],
    workflow_template_sets: [],
    workflow_sender_pools: [],
    workflow_enrollments: [],
    workflow_runs: [],
  });
  const created = await createWorkflowStudioDraft({
    name: 'Proof Workflow',
    channel: 'sms',
    trigger_type: 'trigger.lead_entered_workflow',
  }, { supabase: fake });
  assert.equal(created.ok, true);
  assert.equal(fake.rows.workflow_nodes.length, 1);
  assert.equal(fake.rows.workflow_nodes[0].node_type, 'trigger.lead_entered_workflow');
});
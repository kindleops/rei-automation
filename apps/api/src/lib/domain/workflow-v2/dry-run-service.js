import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { getDefinition } from '@/lib/domain/workflow-v2/definition-service.js';
import { validateGraph } from '@/lib/domain/workflow-v2/graph-service.js';
import { getNodeMeta, isCommunicationNode, isTriggerNode } from '@/lib/domain/workflow-v2/node-registry.js';
import { sendSmsPlaceholder } from '@/lib/domain/workflow-v2/sms-adapter.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function defaultContext() {
  return {
    subject_type: 'lead',
    subject_id: 'dry-run-subject',
    first_name: 'Jordan',
    property_address: '123 Main St',
    city: 'Austin',
    state: 'TX',
    market: 'default',
    agent_name: 'Nexus Operator',
  };
}

// Topological sort via Kahn's algorithm.
// Returns ordered node IDs or null if a cycle is detected.
function topoSort(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (!ids.has(e.source_node_id) || !ids.has(e.target_node_id)) continue;
    adj.get(e.source_node_id).push(e.target_node_id);
    inDegree.set(e.target_node_id, (inDegree.get(e.target_node_id) ?? 0) + 1);
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const next of adj.get(id) ?? []) {
      const deg = inDegree.get(next) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  return sorted.length === nodes.length ? sorted : null;
}

// Simulate a single node execution during dry-run.
async function simulateNode(node, context, opts = {}) {
  const meta = getNodeMeta(node.node_type);
  const base = {
    node_id: node.id,
    node_key: node.node_key,
    node_kind: node.node_kind,
    node_type: node.node_type,
    label: node.label,
    status: 'planned',
    dry_run: true,
    live_send_blocked: true,
  };

  if (isTriggerNode(node.node_type)) {
    return { ...base, status: 'triggered', trigger: { event_type: node.node_type, source: 'dry_run' } };
  }

  if (node.node_kind === 'timing') {
    return {
      ...base,
      status: 'planned',
      wait: {
        amount: node.config?.amount ?? null,
        unit: node.config?.unit ?? null,
        business_hours_only: node.config?.business_hours_only === true,
      },
    };
  }

  if (node.node_kind === 'condition') {
    return {
      ...base,
      status: 'planned',
      condition: { node_type: node.node_type, config: node.config },
      branches: ['true_path', 'false_path'],
    };
  }

  if (node.node_kind === 'guard') {
    return {
      ...base,
      status: 'planned',
      guard: { node_type: node.node_type, evaluated: false, result: 'dry_run_skip' },
    };
  }

  if (node.node_type === 'action.send_sms') {
    const adapterResult = await sendSmsPlaceholder({
      to: context.phone ?? null,
      body: node.config?.body ?? node.config?.template ?? null,
      workflow_definition_id: opts.definition_id,
      node_id: node.id,
      enrollment_id: opts.enrollment_id ?? null,
    });
    return {
      ...base,
      status: 'blocked',
      block_reason: 'workflow_v2_live_send_disabled',
      action: { node_type: node.node_type },
      adapter_result: adapterResult,
    };
  }

  if (node.node_type === 'action.update_stage') {
    return {
      ...base,
      status: 'planned',
      action: { node_type: node.node_type, target_stage: node.config?.stage ?? null, applied: false, dry_run: true },
    };
  }

  if (node.node_type === 'action.update_status') {
    return {
      ...base,
      status: 'planned',
      action: { node_type: node.node_type, target_status: node.config?.status ?? null, applied: false, dry_run: true },
    };
  }

  return { ...base, status: 'planned', action: { node_type: node.node_type }, meta };
}

// Persist run + run_steps records for a completed dry-run.
async function persistDryRun({ client, definitionId, context, validation, orderedSteps }) {
  if (!client?.from) return { ok: false, skipped: true, reason: 'supabase_unavailable' };

  const runInsert = await client
    .from('workflow_runs')
    .insert({
      workflow_definition_id: definitionId,
      conversation_thread_id: clean(context.conversation_thread_id ?? '') || null,
      property_id: clean(context.property_id ?? '') || null,
      prospect_id: clean(context.subject_id ?? '') || null,
      status: 'dry_run',
      dry_run: true,
      live_send_enabled: false,
      context: { sample_context: context, validation },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (runInsert.error) throw runInsert.error;
  const run = runInsert.data;

  const stepRows = orderedSteps.map((step) => ({
    workflow_run_id: run.id,
    workflow_definition_id: definitionId,
    node_id: step.node_id ?? null,
    node_key: step.node_key,
    node_kind: step.node_kind,
    node_type: step.node_type,
    status: step.status ?? 'planned',
    dry_run: true,
    live_send_blocked: true,
    block_reason: step.block_reason ?? null,
    execution_result: step,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }));

  if (stepRows.length) {
    const stepsInsert = await client.from('workflow_run_steps').insert(stepRows).select('*');
    if (stepsInsert.error) throw stepsInsert.error;
    return { ok: true, run, run_steps: stepsInsert.data ?? [] };
  }

  return { ok: true, run, run_steps: [] };
}

// ─────────────────────────────────────────────
// dryRunDefinition
// ─────────────────────────────────────────────
export async function dryRunDefinition(input = {}, deps = {}) {
  const client = db(deps);
  const definitionId = clean(input.workflow_definition_id ?? input.definitionId ?? input.id ?? '');

  const detail = await getDefinition(definitionId, { ...deps, supabase: client });
  if (!detail.ok) return detail;

  const { definition, nodes, edges } = detail;
  const context = { ...defaultContext(), ...((input.context && typeof input.context === 'object') ? input.context : {}) };

  const activeNodes = nodes.filter((n) => n.is_active !== false);
  const validation = validateGraph(activeNodes, edges);

  const warnings = [...validation.warnings];
  const errors = [...validation.errors];

  // Topological ordering
  const sortedIds = topoSort(activeNodes, edges);
  if (sortedIds === null) {
    errors.push('graph_has_cycle');
  }

  const nodesById = new Map(activeNodes.map((n) => [n.id, n]));
  const orderedNodes = sortedIds
    ? sortedIds.map((id) => nodesById.get(id)).filter(Boolean)
    : activeNodes;

  const orderedSteps = await Promise.all(
    orderedNodes.map((node) =>
      simulateNode(node, context, { definition_id: definitionId, enrollment_id: null })
    )
  );

  if (definition.live_send_enabled !== true) {
    warnings.push('workflow_v2_live_send_enabled_false');
  }

  const result = {
    ok: true,
    definition: { ...definition, live_send_enabled: false },
    validation,
    context,
    dry_run: true,
    live_send_enabled: false,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
    steps: orderedSteps,
    warnings: Array.from(new Set(warnings)),
    errors,
  };

  if (input.persist === true || input.write_audit === true) {
    const persisted = await persistDryRun({
      client,
      definitionId,
      context,
      validation,
      orderedSteps,
    });
    result.persisted = persisted;
  }

  return result;
}

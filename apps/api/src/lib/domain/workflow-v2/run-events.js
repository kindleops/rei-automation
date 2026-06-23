// Workflow Studio V2 — persisted run event ledger.

import { buildActionDedupeKey, isDuplicateError } from '@/lib/domain/workflow-v2/idempotency.js';

function clean(value) {
  return String(value ?? '').trim();
}

function buildRunEventDedupeKey({ run_id, enrollment_id, node, event_type }) {
  const nodeId = clean(node?.id ?? node?.node_id ?? 'no_node');
  const nodeKey = clean(node?.node_key ?? 'no_key');
  const eventType = clean(event_type ?? 'workflow.step');
  return buildActionDedupeKey(enrollment_id, `${run_id}:${nodeId}:${nodeKey}`, eventType);
}

export async function persistRunEvent(client, input = {}) {
  const runId = clean(input.run_id ?? input.runId ?? '');
  const enrollmentId = clean(input.enrollment_id ?? input.enrollmentId ?? '');
  const definitionId = clean(input.definition_id ?? input.definitionId ?? '');
  const node = input.node && typeof input.node === 'object' ? input.node : {};
  const stepResult = input.stepResult && typeof input.stepResult === 'object' ? input.stepResult : {};
  const eventType = clean(input.event_type ?? input.eventType ?? 'workflow_v2.step.completed');

  if (!runId) return { ok: false, error: 'run_id_required' };
  if (!client?.from) return { ok: false, error: 'supabase_client_required' };

  let workflowId = clean(input.workflow_id ?? input.workflowId ?? '');
  if (!workflowId) {
    const runLookup = await client
      .from('workflow_runs')
      .select('workflow_id, workflow_definition_id')
      .eq('id', runId)
      .maybeSingle();
    if (runLookup.error) throw runLookup.error;
    workflowId = clean(runLookup.data?.workflow_id ?? '');
  }

  const dedupeKey = clean(input.dedupe_key ?? input.dedupeKey ?? '') ||
    buildRunEventDedupeKey({ run_id: runId, enrollment_id: enrollmentId, node, event_type: eventType });

  const row = {
    workflow_run_id: runId,
    workflow_id: workflowId || definitionId || null,
    step_id: clean(node.id ?? node.node_id ?? '') || null,
    event_type: eventType,
    node_type: clean(node.node_type ?? stepResult.node_type ?? null) || null,
    status: clean(stepResult.status ?? 'completed'),
    dedupe_key: dedupeKey,
    payload: {
      enrollment_id: enrollmentId || null,
      definition_id: definitionId || null,
      node: {
        id: node.id ?? null,
        node_key: node.node_key ?? null,
        node_kind: node.node_kind ?? null,
        node_type: node.node_type ?? null,
      },
      step_result: stepResult,
    },
  };

  const insert = await client.from('workflow_run_events').insert(row).select('*').single();
  if (isDuplicateError(insert.error)) {
    const existing = await client
      .from('workflow_run_events')
      .select('*')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    return { ok: true, duplicate: true, event: existing.data ?? null };
  }
  if (insert.error) throw insert.error;

  return { ok: true, duplicate: false, event: insert.data };
}
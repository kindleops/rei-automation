import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { createNode, updateNode, deleteNode } from '@/lib/domain/workflow-v2/graph-service.js';
import {
  createEdge,
  deleteEdge,
  listEdges,
  listNodes,
} from '@/lib/domain/workflow-v2/graph-service.js';
import { getDefinition } from '@/lib/domain/workflow-v2/definition-service.js';
import { protectSystemTemplateEdit } from '@/lib/domain/workflow-v2/system-templates.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

async function reloadDetail(definitionId, deps) {
  return getDefinition(definitionId, deps);
}

async function assertEditable(definitionId, deps) {
  const detail = await getDefinition(definitionId, deps);
  if (!detail.ok) return detail;
  if (detail.is_legacy) {
    return { ok: false, status: 403, error: 'legacy_workflow_readonly' };
  }
  if (detail.definition?.is_locked) {
    const lock = protectSystemTemplateEdit(detail.definition);
    if (!lock.ok) return { ok: false, status: 403, ...lock };
  }
  return { ok: true, detail };
}

export async function resolveEdge(definitionId, hint = {}, deps = {}) {
  const client = db(deps);
  const edgeId = clean(hint.edge_id ?? hint.edgeId ?? '');
  if (edgeId) {
    const { data } = await client.from('workflow_edges').select('*').eq('id', edgeId).maybeSingle();
    if (data) return { ok: true, edge: data };
    return { ok: false, status: 404, error: 'edge_not_found' };
  }

  const sourceId = clean(
    hint.source_node_id ?? hint.sourceNodeId ?? hint.from_step_id ?? hint.fromStepId ?? '',
  );
  const targetId = clean(
    hint.target_node_id ?? hint.targetNodeId ?? hint.to_step_id ?? hint.toStepId ?? '',
  );
  const kind = clean(hint.kind ?? hint.edge_type ?? hint.edgeType ?? 'next').toLowerCase();

  if (!sourceId || !targetId) {
    return { ok: false, status: 400, error: 'edge_resolution_requires_id_or_endpoints' };
  }

  let query = client
    .from('workflow_edges')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .eq('source_node_id', sourceId)
    .eq('target_node_id', targetId);

  if (kind && kind !== 'next') {
    query = query.eq('edge_type', kind);
  }

  const { data: matches } = await query;
  if (!matches?.length) {
    return { ok: false, status: 404, error: 'edge_not_found' };
  }
  return { ok: true, edge: matches[0] };
}

function nodePayloadFromRequest(payload = {}) {
  const node = payload.node ?? payload.step_payload ?? payload;
  return {
    node_type: clean(node.node_type ?? node.nodeType ?? payload.node_type ?? ''),
    label: clean(node.label ?? payload.label ?? ''),
    node_key: clean(node.step_key ?? node.node_key ?? ''),
    config: node.config && typeof node.config === 'object' ? node.config : {},
    position_x: Number(payload.position_x ?? payload.x ?? node.position_x ?? node.x ?? 0),
    position_y: Number(payload.position_y ?? payload.y ?? node.position_y ?? node.y ?? 0),
    is_active: node.is_active !== false,
  };
}

async function incomingEdges(definitionId, nodeId, deps) {
  const { data } = await db(deps)
    .from('workflow_edges')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .eq('target_node_id', nodeId);
  return data ?? [];
}

async function outgoingEdges(definitionId, nodeId, deps) {
  const { data } = await db(deps)
    .from('workflow_edges')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .eq('source_node_id', nodeId);
  return data ?? [];
}

export async function insertNodeOnEdgeResolved(definitionId, payload = {}, deps = {}) {
  const guard = await assertEditable(definitionId, deps);
  if (!guard.ok) return guard;

  const edgeHint = payload.edge ?? payload;
  const resolved = await resolveEdge(definitionId, {
    edge_id: payload.edge_id ?? edgeHint.edge_id,
    source_node_id: edgeHint.from_step_id ?? edgeHint.source_node_id ?? payload.source_node_id,
    target_node_id: edgeHint.to_step_id ?? edgeHint.target_node_id ?? payload.target_node_id,
    kind: edgeHint.kind ?? payload.kind,
  }, deps);
  if (!resolved.ok) return resolved;

  const edge = resolved.edge;
  const nodeInput = nodePayloadFromRequest(payload);
  const created = await createNode(definitionId, nodeInput, deps);
  if (!created.ok) return created;

  await deleteEdge(edge.id, deps);
  await createEdge(definitionId, {
    source_node_id: edge.source_node_id,
    target_node_id: created.node_id,
    edge_type: edge.edge_type,
    condition_key: edge.condition_key,
    label: edge.label,
    config: edge.config,
  }, deps);
  await createEdge(definitionId, {
    source_node_id: created.node_id,
    target_node_id: edge.target_node_id,
    edge_type: 'next',
  }, deps);

  return reloadDetail(definitionId, deps);
}

export async function insertNodeBefore(definitionId, targetNodeId, payload = {}, deps = {}) {
  const guard = await assertEditable(definitionId, deps);
  if (!guard.ok) return guard;

  const targetId = clean(targetNodeId ?? payload.target_node_id ?? '');
  if (!targetId) return { ok: false, status: 400, error: 'target_node_id_required' };

  const inbound = await incomingEdges(definitionId, targetId, deps);
  const nodeInput = nodePayloadFromRequest(payload);
  const created = await createNode(definitionId, nodeInput, deps);
  if (!created.ok) return created;

  if (!inbound.length) {
    await createEdge(definitionId, {
      source_node_id: created.node_id,
      target_node_id: targetId,
      edge_type: 'next',
    }, deps);
    return reloadDetail(definitionId, deps);
  }

  for (const edge of inbound) {
    await deleteEdge(edge.id, deps);
    await createEdge(definitionId, {
      source_node_id: edge.source_node_id,
      target_node_id: created.node_id,
      edge_type: edge.edge_type,
      condition_key: edge.condition_key,
      label: edge.label,
      config: edge.config,
    }, deps);
  }

  await createEdge(definitionId, {
    source_node_id: created.node_id,
    target_node_id: targetId,
    edge_type: 'next',
  }, deps);

  return reloadDetail(definitionId, deps);
}

export async function insertNodeAfter(definitionId, sourceNodeId, payload = {}, deps = {}) {
  const guard = await assertEditable(definitionId, deps);
  if (!guard.ok) return guard;

  const sourceId = clean(sourceNodeId ?? payload.source_node_id ?? '');
  if (!sourceId) return { ok: false, status: 400, error: 'source_node_id_required' };

  const outbound = await outgoingEdges(definitionId, sourceId, deps);
  const nodeInput = nodePayloadFromRequest(payload);
  const created = await createNode(definitionId, nodeInput, deps);
  if (!created.ok) return created;

  const primary = outbound.find((e) => e.edge_type === 'next') ?? outbound[0];

  if (primary) {
    await deleteEdge(primary.id, deps);
    await createEdge(definitionId, {
      source_node_id: sourceId,
      target_node_id: created.node_id,
      edge_type: primary.edge_type,
      condition_key: primary.condition_key,
      label: primary.label,
      config: primary.config,
    }, deps);
    await createEdge(definitionId, {
      source_node_id: created.node_id,
      target_node_id: primary.target_node_id,
      edge_type: 'next',
    }, deps);
  } else {
    await createEdge(definitionId, {
      source_node_id: sourceId,
      target_node_id: created.node_id,
      edge_type: 'next',
    }, deps);
  }

  return reloadDetail(definitionId, deps);
}

export async function addBranch(definitionId, sourceNodeId, payload = {}, deps = {}) {
  const guard = await assertEditable(definitionId, deps);
  if (!guard.ok) return guard;

  const sourceId = clean(sourceNodeId ?? payload.source_node_id ?? '');
  const branchKind = clean(payload.branch_kind ?? payload.branchKind ?? 'true').toLowerCase();
  const edgeType = ['true', 'false'].includes(branchKind) ? branchKind : 'next';

  const nodeInput = nodePayloadFromRequest(payload);
  const created = await createNode(definitionId, nodeInput, deps);
  if (!created.ok) return created;

  await createEdge(definitionId, {
    source_node_id: sourceId,
    target_node_id: created.node_id,
    edge_type: edgeType,
    condition_key: edgeType === 'next' ? null : edgeType,
    label: payload.branch_label ?? payload.label ?? titleCaseBranch(edgeType),
  }, deps);

  return reloadDetail(definitionId, deps);
}

function titleCaseBranch(kind) {
  if (kind === 'true') return 'Yes';
  if (kind === 'false') return 'No';
  return kind;
}

export async function replaceNode(definitionId, nodeId, payload = {}, deps = {}) {
  const guard = await assertEditable(definitionId, deps);
  if (!guard.ok) return guard;

  const replaceId = clean(nodeId ?? payload.node_id ?? '');
  if (!replaceId) return { ok: false, status: 400, error: 'node_id_required' };

  const current = await db(deps).from('workflow_nodes').select('*').eq('id', replaceId).maybeSingle();
  if (!current.data) return { ok: false, status: 404, error: 'workflow_node_not_found' };

  const nodeInput = nodePayloadFromRequest({
    ...payload,
    position_x: payload.position_x ?? current.data.position_x,
    position_y: payload.position_y ?? current.data.position_y,
  });

  const patch = {
    label: nodeInput.label || current.data.label,
    config: { ...current.data.config, ...nodeInput.config },
    position_x: nodeInput.position_x,
    position_y: nodeInput.position_y,
    is_active: nodeInput.is_active,
  };
  if (nodeInput.node_type) patch.node_type = nodeInput.node_type;

  const { data, error } = await db(deps)
    .from('workflow_nodes')
    .update(patch)
    .eq('id', replaceId)
    .select('*')
    .single();
  if (error) throw error;
  const updated = { ok: true, node: data, node_id: data.id };
  if (!updated.ok) return updated;

  return reloadDetail(definitionId, deps);
}

export async function applyGraphMutation(definitionId, payload = {}, deps = {}) {
  const operation = clean(payload.operation ?? payload.op ?? '').toLowerCase();
  const targetNodeId = clean(payload.target_node_id ?? payload.targetNodeId ?? '');
  const sourceNodeId = clean(payload.source_node_id ?? payload.sourceNodeId ?? '');

  switch (operation) {
    case 'insert-before':
      return insertNodeBefore(definitionId, targetNodeId, payload, deps);
    case 'insert-after':
      return insertNodeAfter(definitionId, sourceNodeId || targetNodeId, payload, deps);
    case 'add-branch':
      return addBranch(definitionId, sourceNodeId || targetNodeId, payload, deps);
    case 'replace':
      return replaceNode(definitionId, targetNodeId, payload, deps);
    case 'insert-on-edge':
      return insertNodeOnEdgeResolved(definitionId, payload, deps);
    default:
      return { ok: false, status: 400, error: 'unknown_graph_mutation', operation };
  }
}
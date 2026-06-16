import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  isValidNodeType,
  isValidNodeKind,
  getNodeMeta,
  isCommunicationNode,
  requiresGuardBefore,
  isGuardNode,
  isTriggerNode,
} from '@/lib/domain/workflow-v2/node-registry.js';

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

// ─────────────────────────────────────────────
// Graph validation
// ─────────────────────────────────────────────

export function validateGraph(nodes = [], edges = []) {
  const errors = [];
  const warnings = [];

  const activeNodes = nodes.filter((n) => n.is_active !== false);
  const nodeIds = new Set(activeNodes.map((n) => n.id));

  // One trigger required
  const triggers = activeNodes.filter((n) => isTriggerNode(n.node_type));
  if (triggers.length === 0) errors.push('graph_missing_trigger');
  if (triggers.length > 1) warnings.push('graph_multiple_triggers');

  // All node_types must be valid
  for (const node of activeNodes) {
    if (!isValidNodeType(node.node_type)) {
      errors.push(`invalid_node_type:${clean(node.node_type)}:${clean(node.node_key)}`);
    }
    if (!isValidNodeKind(node.node_kind)) {
      errors.push(`invalid_node_kind:${clean(node.node_kind)}:${clean(node.node_key)}`);
    }
  }

  // Edges must reference existing active nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.source_node_id)) {
      errors.push(`edge_source_not_found:${edge.id ?? 'unknown'}`);
    }
    if (!nodeIds.has(edge.target_node_id)) {
      errors.push(`edge_target_not_found:${edge.id ?? 'unknown'}`);
    }
  }

  // Build adjacency: predecessors per node (who points to me)
  const predecessors = new Map(activeNodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (predecessors.has(edge.target_node_id)) {
      predecessors.get(edge.target_node_id).push(edge.source_node_id);
    }
  }

  // Guard-before-communication check:
  // For every communication node, at least one ancestor must be a guard node.
  for (const node of activeNodes) {
    if (!isCommunicationNode(node.node_type)) continue;
    if (!requiresGuardBefore(node.node_type)) continue;

    const hasGuardAncestor = _hasGuardAncestor(node.id, predecessors, nodes);
    if (!hasGuardAncestor) {
      warnings.push(`communication_node_missing_guard_ancestor:${clean(node.node_key)}`);
    }
  }

  if (activeNodes.length === 0) warnings.push('graph_has_no_nodes');

  return { ok: errors.length === 0, errors, warnings };
}

function _hasGuardAncestor(nodeId, predecessors, nodes) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set();
  const queue = predecessors.get(nodeId) ?? [];

  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const pred = nodesById.get(pid);
    if (!pred) continue;
    if (isGuardNode(pred.node_type)) return true;
    const grandParents = predecessors.get(pid) ?? [];
    queue.push(...grandParents);
  }
  return false;
}

// ─────────────────────────────────────────────
// Node CRUD
// ─────────────────────────────────────────────

export async function listNodes(definitionId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_nodes')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return { ok: true, nodes: data ?? [] };
}

export async function createNode(definitionId, payload = {}, deps = {}) {
  const nodeType = clean(payload.node_type ?? payload.nodeType ?? '');
  const nodeMeta = getNodeMeta(nodeType);
  if (!nodeMeta) {
    return { ok: false, status: 400, error: 'invalid_node_type', node_type: nodeType };
  }

  const row = {
    workflow_definition_id: definitionId,
    node_key:
      normalizeKey(payload.node_key ?? payload.nodeKey ?? payload.label ?? '') ||
      `${nodeMeta.node_kind}_${crypto.randomUUID().slice(0, 8)}`,
    node_kind: nodeMeta.node_kind,
    node_type: nodeType,
    label: clean(payload.label ?? nodeMeta.label),
    config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    position_x: Number.isFinite(Number(payload.position_x ?? payload.x)) ? Number(payload.position_x ?? payload.x) : 0,
    position_y: Number.isFinite(Number(payload.position_y ?? payload.y)) ? Number(payload.position_y ?? payload.y) : 0,
    is_active: payload.is_active !== false,
  };

  const { data, error } = await db(deps).from('workflow_nodes').insert(row).select('*').single();
  if (error) throw error;
  return { ok: true, node: data, node_id: data.id };
}

export async function updateNode(nodeId, payload = {}, deps = {}) {
  const current = await db(deps).from('workflow_nodes').select('*').eq('id', nodeId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return { ok: false, status: 404, error: 'workflow_node_not_found' };

  const patch = {};
  if (payload.label !== undefined) patch.label = clean(payload.label ?? '');
  if (payload.config !== undefined && typeof payload.config === 'object') patch.config = payload.config;
  if (payload.position_x !== undefined || payload.x !== undefined) {
    patch.position_x = Number.isFinite(Number(payload.position_x ?? payload.x)) ? Number(payload.position_x ?? payload.x) : current.data.position_x;
  }
  if (payload.position_y !== undefined || payload.y !== undefined) {
    patch.position_y = Number.isFinite(Number(payload.position_y ?? payload.y)) ? Number(payload.position_y ?? payload.y) : current.data.position_y;
  }
  if (typeof payload.is_active === 'boolean') patch.is_active = payload.is_active;

  const { data, error } = await db(deps)
    .from('workflow_nodes')
    .update(patch)
    .eq('id', nodeId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, node: data, node_id: data.id };
}

export async function deleteNode(nodeId, deps = {}) {
  const { error } = await db(deps).from('workflow_nodes').delete().eq('id', nodeId);
  if (error) throw error;
  return { ok: true, node_id: nodeId, deleted: true };
}

// ─────────────────────────────────────────────
// Edge CRUD
// ─────────────────────────────────────────────

export async function listEdges(definitionId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_edges')
    .select('*')
    .eq('workflow_definition_id', definitionId);
  if (error) throw error;
  return { ok: true, edges: data ?? [] };
}

export async function createEdge(definitionId, payload = {}, deps = {}) {
  const sourceId = clean(payload.source_node_id ?? payload.sourceNodeId ?? '');
  const targetId = clean(payload.target_node_id ?? payload.targetNodeId ?? '');
  if (!sourceId || !targetId) {
    return { ok: false, status: 400, error: 'edge_source_and_target_required' };
  }
  if (sourceId === targetId) {
    return { ok: false, status: 400, error: 'edge_self_loop_forbidden' };
  }

  const [srcRes, tgtRes] = await Promise.all([
    db(deps).from('workflow_nodes').select('id, workflow_definition_id').eq('id', sourceId).maybeSingle(),
    db(deps).from('workflow_nodes').select('id, workflow_definition_id').eq('id', targetId).maybeSingle(),
  ]);
  if (!srcRes.data) return { ok: false, status: 404, error: 'edge_source_node_not_found' };
  if (!tgtRes.data) return { ok: false, status: 404, error: 'edge_target_node_not_found' };
  if (srcRes.data.workflow_definition_id !== definitionId || tgtRes.data.workflow_definition_id !== definitionId) {
    return { ok: false, status: 400, error: 'edge_nodes_belong_to_different_workflow' };
  }

  const rawEdgeType = clean(payload.edge_type ?? payload.edgeType ?? payload.condition_key ?? 'next');
  const edgeType = ['next', 'true', 'false'].includes(rawEdgeType) ? rawEdgeType : 'next';

  const row = {
    workflow_definition_id: definitionId,
    source_node_id: sourceId,
    target_node_id: targetId,
    edge_type: edgeType,
    condition_key: clean(payload.condition_key ?? payload.conditionKey ?? '') || null,
    label: clean(payload.label ?? '') || null,
    config: payload.config && typeof payload.config === 'object' ? payload.config : {},
  };

  const { data, error } = await db(deps).from('workflow_edges').insert(row).select('*').single();
  if (error) throw error;
  return { ok: true, edge: data, edge_id: data.id };
}

export async function updateEdge(edgeId, payload = {}, deps = {}) {
  const current = await db(deps).from('workflow_edges').select('*').eq('id', edgeId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return { ok: false, status: 404, error: 'workflow_edge_not_found' };

  const patch = {};
  if (payload.condition_key !== undefined) patch.condition_key = clean(payload.condition_key ?? '') || null;
  if (payload.label !== undefined) patch.label = clean(payload.label ?? '') || null;
  if (payload.config !== undefined && typeof payload.config === 'object') patch.config = payload.config;

  const { data, error } = await db(deps)
    .from('workflow_edges')
    .update(patch)
    .eq('id', edgeId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, edge: data, edge_id: data.id };
}

export async function deleteEdge(edgeId, deps = {}) {
  const { error } = await db(deps).from('workflow_edges').delete().eq('id', edgeId);
  if (error) throw error;
  return { ok: true, edge_id: edgeId, deleted: true };
}

// ─────────────────────────────────────────────
// Edge routing
// ─────────────────────────────────────────────

/**
 * Resolve the next node from currentNodeId following the correct edge.
 *
 * conditionResult:
 *   null  → follow edge_type='next' (non-condition nodes)
 *   true  → follow edge_type='true'
 *   false → follow edge_type='false'
 *
 * Falls back: if no typed match, uses the first outgoing edge.
 * Returns null if no outgoing edges exist (graph end).
 */
export function resolveNextNodeByEdge(currentNodeId, conditionResult, edges, nodesById) {
  const outgoing = edges.filter((e) => e.source_node_id === currentNodeId);
  if (!outgoing.length) return null;

  if (conditionResult === true) {
    const branch = outgoing.find((e) => e.edge_type === 'true' || e.condition_key === 'true');
    const target = branch ?? outgoing[0];
    return nodesById.get(target.target_node_id) ?? null;
  }

  if (conditionResult === false) {
    const branch = outgoing.find((e) => e.edge_type === 'false' || e.condition_key === 'false');
    const target = branch ?? outgoing[0];
    return nodesById.get(target.target_node_id) ?? null;
  }

  // Default: next edge
  const next = outgoing.find((e) => e.edge_type === 'next') ?? outgoing[0];
  return nodesById.get(next.target_node_id) ?? null;
}

// ─────────────────────────────────────────────
// Validate a full graph by definition ID
// ─────────────────────────────────────────────

export async function validateDefinitionGraph(definitionId, deps = {}) {
  const [nodesRes, edgesRes] = await Promise.all([
    listNodes(definitionId, deps),
    listEdges(definitionId, deps),
  ]);
  return validateGraph(nodesRes.nodes, edgesRes.edges);
}

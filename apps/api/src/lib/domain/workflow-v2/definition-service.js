import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  SYSTEM_WORKFLOW_TEMPLATES,
  protectSystemTemplateEdit,
} from '@/lib/domain/workflow-v2/system-templates.js';

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

function normalizeInput(payload = {}, existing = {}) {
  const row = {};
  const name = clean(payload.name ?? existing.name ?? 'Untitled Workflow V2');
  if (name) row.name = name;

  const key =
    normalizeKey(payload.definition_key ?? payload.definitionKey ?? payload.workflow_key ?? existing.definition_key ?? '') ||
    normalizeKey(payload.name ?? '') ||
    `wfv2_${crypto.randomUUID().slice(0, 8)}`;
  row.definition_key = key;

  if (payload.description !== undefined || existing.description !== undefined) {
    row.description = clean(payload.description ?? existing.description ?? '') || null;
  }

  const status = clean(payload.status ?? existing.status ?? 'draft');
  row.status = ['draft', 'published', 'active', 'paused', 'archived'].includes(status) ? status : 'draft';

  row.live_send_enabled = false;

  const triggerType = clean(payload.trigger_type ?? payload.triggerType ?? existing.trigger_type ?? '');
  row.trigger_type = triggerType || null;

  row.metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata
      : existing.metadata ?? {};

  return row;
}

function isLockedSystemTemplate(definition = {}) {
  return definition?.is_locked === true || definition?.is_system_template === true;
}

function isMetadataEnableToggle(payload = {}) {
  const keys = Object.keys(payload).filter((key) => payload[key] !== undefined);
  if (!keys.length) return false;
  if (!keys.every((key) => key === 'metadata')) return false;
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const metaKeys = Object.keys(metadata);
  if (!metaKeys.length) return false;
  return metaKeys.every((key) => ['enabled', 'is_enabled', 'disabled', 'is_active'].includes(key));
}

// ─────────────────────────────────────────────
// Mapping Helpers (V2 -> Dashboard Compatibility)
// ─────────────────────────────────────────────

function mapDefinitionToWorkflow(definition) {
  if (!definition) return null;
  return {
    ...definition,
    workflow_key: definition.definition_key,
    channel: definition.metadata?.channel ?? 'multichannel',
    workflow_type: definition.metadata?.workflow_type ?? 'automation',
    step_count: 0, // calculated later
    send_node_count: 0, // calculated later
    is_v2: true
  };
}

function mapNodeToStep(node) {
  if (!node) return null;
  return {
    id: node.id,
    workflow_id: node.workflow_definition_id,
    step_key: node.node_key,
    step_order: node.config?.step_order ?? 0,
    node_type: node.node_type,
    label: node.label,
    config: {
      ...node.config,
      position: { x: node.position_x, y: node.position_y },
      ui: { x: node.position_x, y: node.position_y }
    },
    conditions: node.config?.conditions ?? {},
    actions: node.config?.actions ?? [],
    stop_conditions: node.config?.stop_conditions ?? {},
    delay_amount: node.config?.delay_amount,
    delay_unit: node.config?.delay_unit,
    is_active: node.is_active,
  };
}

async function syncEdges(definitionId, node, deps = {}) {
  const client = db(deps);
  const conditions = node.config?.conditions || {};
  const nextPath = clean(conditions.next_path ?? node.config?.next_path ?? '');
  const truePath = clean(conditions.true_path ?? node.config?.true_path ?? '');
  const falsePath = clean(conditions.false_path ?? node.config?.false_path ?? '');

  // Delete existing outgoing edges for this node
  await client.from('workflow_edges').delete().eq('source_node_id', node.id);

  const edges = [];
  const nodesResult = await client.from('workflow_nodes').select('id, node_key').eq('workflow_definition_id', definitionId);
  const nodesByKey = new Map((nodesResult.data ?? []).map(n => [n.node_key, n.id]));

  if (nextPath && nodesByKey.has(nextPath)) {
    edges.push({
      workflow_definition_id: definitionId,
      source_node_id: node.id,
      target_node_id: nodesByKey.get(nextPath),
      edge_type: 'next'
    });
  }
  if (truePath && nodesByKey.has(truePath)) {
    edges.push({
      workflow_definition_id: definitionId,
      source_node_id: node.id,
      target_node_id: nodesByKey.get(truePath),
      edge_type: 'true',
      condition_key: 'true'
    });
  }
  if (falsePath && nodesByKey.has(falsePath)) {
    edges.push({
      workflow_definition_id: definitionId,
      source_node_id: node.id,
      target_node_id: nodesByKey.get(falsePath),
      edge_type: 'false',
      condition_key: 'false'
    });
  }

  if (edges.length) {
    await client.from('workflow_edges').insert(edges);
  }
}

// ─────────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────────

export async function listDefinitions(deps = {}) {
  const client = db(deps);
  const [v2Res, v1Res] = await Promise.all([
    client.from('workflow_definitions').select('*').order('created_at', { ascending: false }).limit(200),
    client.from('workflows').select('*').order('created_at', { ascending: false }).limit(100)
  ]);

  if (v2Res.error) throw v2Res.error;
  
  const v2Definitions = (v2Res.data ?? []).map((d) => ({ ...d, live_send_enabled: false }));
  const v2Workflows = v2Definitions.map(mapDefinitionToWorkflow);

  const v1Workflows = (v1Res.data ?? []).map(w => ({
    ...w,
    is_v2: false,
    is_legacy: true,
    live_send_enabled: false
  }));

  return { 
    ok: true, 
    definitions: v2Definitions,
    workflows: [...v2Workflows, ...v1Workflows]
  };
}

export async function getDefinition(id, deps = {}) {
  if (!clean(id)) return { ok: false, status: 400, error: 'workflow_definition_id_required' };

  let result = await db(deps).from('workflow_definitions').select('*').eq('id', id).maybeSingle();
  if (!result.data && !result.error) {
    result = await db(deps).from('workflow_definitions').select('*').eq('definition_key', id).maybeSingle();
  }
  
  if (result.error) throw result.error;

  // Fallback to V1 if not found in V2
  if (!result.data) {
    const v1 = await db(deps).from('workflows').select('*').eq('id', id).maybeSingle();
    if (v1.data) {
      const workflow = { ...v1.data, is_v2: false, is_legacy: true, live_send_enabled: false };
      const stepsResult = await db(deps).from('workflow_steps').select('*').eq('workflow_id', workflow.id).order('step_order', { ascending: true });
      return {
        ok: true,
        workflow,
        is_legacy: true,
        steps: stepsResult.data?.map(s => ({ ...s, workflow_id: s.workflow_id })) ?? []
      };
    }
    return { ok: false, status: 404, error: 'workflow_not_found' };
  }

  const definition = { ...result.data, live_send_enabled: false };

  const [nodesResult, edgesResult, templateSetsResult, senderPoolsResult, enrollmentsResult, runsResult] = await Promise.all([
    db(deps).from('workflow_nodes').select('*').eq('workflow_definition_id', definition.id).order('created_at', { ascending: true }),
    db(deps).from('workflow_edges').select('*').eq('workflow_definition_id', definition.id),
    db(deps).from('workflow_template_sets').select('*').eq('workflow_definition_id', definition.id),
    db(deps).from('workflow_sender_pools').select('*').eq('workflow_definition_id', definition.id),
    db(deps).from('workflow_enrollments').select('id, subject_type, subject_id, status, enrolled_at').eq('workflow_definition_id', definition.id).order('enrolled_at', { ascending: false }).limit(20),
    db(deps).from('workflow_runs').select('id, status, dry_run, started_at, completed_at').eq('workflow_definition_id', definition.id).order('created_at', { ascending: false }).limit(10),
  ]);

  const nodes = nodesResult.data ?? [];
  const steps = nodes.map(mapNodeToStep);

  const workflow = mapDefinitionToWorkflow(definition);
  workflow.step_count = nodes.length;
  workflow.send_node_count = nodes.filter(n => n.node_type?.startsWith('send_')).length;

  return {
    ok: true,
    definition,
    workflow,
    nodes,
    steps,
    edges: edgesResult.data ?? [],
    template_sets: templateSetsResult.data ?? [],
    sender_pools: senderPoolsResult.data ?? [],
    enrollments: enrollmentsResult.data ?? [],
    recent_runs: runsResult.data ?? [],
  };
}

export async function createDefinition(payload = {}, deps = {}) {
  if (payload.live_send_enabled === true) {
    return { ok: false, status: 423, error: 'workflow_v2_live_send_disabled', message: 'live_send_enabled cannot be enabled in Phase 1.' };
  }

  const row = normalizeInput(payload);
  let insert = await db(deps).from('workflow_definitions').insert(row).select('*').single();
  if (insert.error?.code === '23505') {
    row.definition_key = `${row.definition_key}_${Date.now().toString(36)}`;
    insert = await db(deps).from('workflow_definitions').insert(row).select('*').single();
  }
  if (insert.error) throw insert.error;
  
  const definition = { ...insert.data, live_send_enabled: false };
  return { 
    ok: true, 
    definition, 
    definition_id: definition.id,
    workflow: mapDefinitionToWorkflow(definition),
    workflow_id: definition.id
  };
}

export async function updateDefinition(id, payload = {}, deps = {}) {
  if (payload.live_send_enabled === true) {
    return { ok: false, status: 423, error: 'workflow_v2_live_send_disabled', message: 'live_send_enabled cannot be enabled in Phase 1.' };
  }

  const current = await getDefinition(id, deps);
  if (!current.ok) return current;
  if (current.is_legacy) {
    return { ok: false, status: 403, error: 'legacy_workflow_readonly', message: 'Legacy workflows are read-only in Workflow V2.' };
  }

  if (isLockedSystemTemplate(current.definition)) {
    const lockCheck = protectSystemTemplateEdit(current.definition);
    if (!lockCheck.ok && !isMetadataEnableToggle(payload)) {
      return { ok: false, status: 403, ...lockCheck };
    }
  }

  const patch = normalizeInput(payload, current.definition);
  delete patch.definition_key;
  patch.live_send_enabled = false;

  const { data, error } = await db(deps)
    .from('workflow_definitions')
    .update(patch)
    .eq('id', current.definition.id)
    .select('*')
    .single();
  if (error) throw error;
  
  const definition = { ...data, live_send_enabled: false };
  return { 
    ok: true, 
    definition, 
    definition_id: definition.id,
    workflow: mapDefinitionToWorkflow(definition),
    workflow_id: definition.id
  };
}

export async function cloneDefinition(id, deps = {}) {
  const current = await getDefinition(id, deps);
  if (!current.ok) return current;
  if (current.is_legacy) {
    return { ok: false, status: 403, error: 'legacy_workflow_clone_unsupported', message: 'Cloning legacy workflows into V2 is not yet supported.' };
  }

  const payload = {
    ...current.definition,
    name: `${current.definition.name} (Clone)`,
    definition_key: `${current.definition.definition_key}_clone_${Date.now().toString(36)}`,
    status: 'draft'
  };
  delete payload.id;
  delete payload.created_at;
  delete payload.updated_at;

  const created = await createDefinition(payload, deps);
  if (!created.ok) return created;

  // Clone nodes and edges
  const newId = created.definition.id;
  const nodes = current.nodes.map(n => {
    const newNode = { ...n, workflow_definition_id: newId };
    delete newNode.id;
    delete newNode.created_at;
    delete newNode.updated_at;
    return newNode;
  });

  if (nodes.length) {
    const { data: insertedNodes, error: nodeError } = await db(deps).from('workflow_nodes').insert(nodes).select('*');
    if (nodeError) throw nodeError;

    // Map old node IDs to new node IDs for edges
    const idMap = new Map();
    current.nodes.forEach((oldNode, i) => {
      idMap.set(oldNode.id, insertedNodes[i].id);
    });

    const edges = current.edges.map(e => {
      const newEdge = { 
        ...e, 
        workflow_definition_id: newId,
        source_node_id: idMap.get(e.source_node_id),
        target_node_id: idMap.get(e.target_node_id)
      };
      delete newEdge.id;
      delete newEdge.created_at;
      return newEdge;
    });

    if (edges.length) {
      const { error: edgeError } = await db(deps).from('workflow_edges').insert(edges);
      if (edgeError) throw edgeError;
    }
  }

  return getDefinition(newId, deps);
}

export async function pauseDefinition(id, deps = {}) {
  return updateDefinition(id, { status: 'paused' }, deps);
}

export async function resumeDefinition(id, deps = {}) {
  return updateDefinition(id, { status: 'active' }, deps);
}

// ─────────────────────────────────────────────
// Nodes (Steps)
// ─────────────────────────────────────────────

export async function createNode(definitionId, payload = {}, deps = {}) {
  const nodeType = clean(payload.node_type ?? payload.nodeType ?? '');
  
  // Minimal registry check or default to action if unknown for now
  const nodeKind = nodeType.startsWith('trigger') ? 'trigger' : 
                   nodeType.startsWith('condition') ? 'condition' : 
                   nodeType.startsWith('timing') || nodeType.startsWith('wait') ? 'timing' : 'action';

  const row = {
    workflow_definition_id: definitionId,
    node_key: normalizeKey(payload.step_key ?? payload.node_key ?? payload.label ?? '') || `node_${crypto.randomUUID().slice(0, 8)}`,
    node_kind: nodeKind,
    node_type: nodeType,
    label: clean(payload.label ?? nodeType),
    config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    position_x: Number(payload.position_x ?? payload.x ?? payload.config?.ui?.x ?? payload.config?.position?.x ?? 0),
    position_y: Number(payload.position_y ?? payload.y ?? payload.config?.ui?.y ?? payload.config?.position?.y ?? 0),
    is_active: payload.is_active !== false,
  };

  const { data, error } = await db(deps).from('workflow_nodes').insert(row).select('*').single();
  if (error) throw error;
  
  await syncEdges(definitionId, data, deps);
  return { ok: true, node: data, step: mapNodeToStep(data), node_id: data.id };
}

export async function updateNode(nodeId, payload = {}, deps = {}) {
  const current = await db(deps).from('workflow_nodes').select('*').eq('id', nodeId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return { ok: false, status: 404, error: 'workflow_node_not_found' };

  const definitionRes = await db(deps)
    .from('workflow_definitions')
    .select('*')
    .eq('id', current.data.workflow_definition_id)
    .maybeSingle();
  if (definitionRes.error) throw definitionRes.error;

  if (isLockedSystemTemplate(definitionRes.data)) {
    const lockCheck = protectSystemTemplateEdit(definitionRes.data);
    const allowedKeys = new Set(['is_active']);
    const patchKeys = Object.keys(payload).filter((key) => payload[key] !== undefined);
    const isEnableToggleOnly = patchKeys.length > 0 && patchKeys.every((key) => allowedKeys.has(key));
    if (!lockCheck.ok && !isEnableToggleOnly) {
      return { ok: false, status: 403, ...lockCheck };
    }
  }

  const patch = {};
  if (payload.label !== undefined) patch.label = clean(payload.label ?? '');
  if (payload.config !== undefined && typeof payload.config === 'object') {
    patch.config = { ...current.data.config, ...payload.config };
  }
  if (payload.position_x !== undefined || payload.x !== undefined || payload.config?.ui?.x !== undefined) {
    patch.position_x = Number(payload.position_x ?? payload.x ?? payload.config?.ui?.x ?? current.data.position_x);
  }
  if (payload.position_y !== undefined || payload.y !== undefined || payload.config?.ui?.y !== undefined) {
    patch.position_y = Number(payload.position_y ?? payload.y ?? payload.config?.ui?.y ?? current.data.position_y);
  }
  if (typeof payload.is_active === 'boolean') patch.is_active = payload.is_active;

  const { data, error } = await db(deps)
    .from('workflow_nodes')
    .update(patch)
    .eq('id', nodeId)
    .select('*')
    .single();
  if (error) throw error;
  
  await syncEdges(current.data.workflow_definition_id, data, deps);
  return { ok: true, node: data, step: mapNodeToStep(data), node_id: data.id };
}

// ─────────────────────────────────────────────
// Child Resources
// ─────────────────────────────────────────────

export async function listTemplateSets(definitionId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_template_sets')
    .select('*')
    .eq('workflow_definition_id', definitionId);
  if (error) throw error;
  return { ok: true, template_sets: data ?? [] };
}

export async function createTemplateSet(definitionId, payload = {}, deps = {}) {
  const row = {
    workflow_definition_id: definitionId,
    name: clean(payload.name ?? 'New Template Set'),
    channel: clean(payload.channel ?? 'sms'),
    language: clean(payload.language ?? 'en'),
    use_case: clean(payload.use_case ?? ''),
    is_active: payload.is_active !== false,
  };
  const { data, error } = await db(deps).from('workflow_template_sets').insert(row).select('*').single();
  if (error) throw error;
  return { ok: true, template_set: data };
}

export async function listSenderPools(definitionId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_sender_pools')
    .select('*')
    .eq('workflow_definition_id', definitionId);
  if (error) throw error;
  return { ok: true, sender_pools: data ?? [] };
}

export async function createSenderPool(definitionId, payload = {}, deps = {}) {
  const row = {
    workflow_definition_id: definitionId,
    name: clean(payload.name ?? 'New Sender Pool'),
    pool_key: normalizeKey(payload.pool_key ?? payload.name ?? ''),
    channel: clean(payload.channel ?? 'sms'),
    is_active: payload.is_active !== false,
  };
  const { data, error } = await db(deps).from('workflow_sender_pools').insert(row).select('*').single();
  if (error) throw error;
  return { ok: true, sender_pool: data };
}

export function listSystemTemplates() {
  return {
    ok: true,
    templates: SYSTEM_WORKFLOW_TEMPLATES.map((template) => ({ ...template })),
    total: SYSTEM_WORKFLOW_TEMPLATES.length,
  };
}

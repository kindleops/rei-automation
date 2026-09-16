// Workflow Studio — unified cockpit bridge.
// Canonical runtime: workflow_definitions + workflow_nodes + workflow_edges.
// Legacy workflows/workflow_steps are read-only compatibility views.

import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  cloneDefinition,
  pauseDefinition,
  resumeDefinition,
  createNode,
  updateNode,
} from '@/lib/domain/workflow-v2/definition-service.js';
import {
  validateDefinitionGraph,
  createEdge,
  deleteEdge,
  listEdges,
  listNodes,
} from '@/lib/domain/workflow-v2/graph-service.js';
import { dryRunDefinition } from '@/lib/domain/workflow-v2/dry-run-service.js';
import { getNodeMeta, NODE_TYPE_REGISTRY } from '@/lib/domain/workflow-v2/node-registry.js';
import {
  seedSystemWorkflowTemplates,
  seedMasterOrchestrator,
  protectSystemTemplateEdit,
  SYSTEM_WORKFLOW_TEMPLATES,
} from '@/lib/domain/workflow-v2/system-templates.js';
import {
  applyGraphMutation,
  insertNodeOnEdgeResolved,
} from '@/lib/domain/workflow-v2/graph-mutations.js';
import { SYSTEM_GRAPH_VERSION } from '@/lib/domain/workflow-v2/system-workflow-graphs.js';
import { isSellerFacingNodeType } from '@/lib/domain/workflow-v2/seller-facing-nodes.js';
import { describeTriggerBridge } from '@/lib/domain/workflow-v2/canonical-event-bridge.js';

const OPERATIONAL_MODES = Object.freeze([
  'draft',
  'test',
  'active_safe',
  'armed',
  'live',
  'paused',
  'archived',
]);

const SMOKE_KEY_PATTERNS = [
  /^workflow_studio_smoke_/i,
  /^owner_acquisition_follow_up_mq/i,
];

const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;
let registryCache = null;
let registryCacheAt = 0;

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function operationalMode(definition = {}) {
  return clean(definition.metadata?.operational_mode ?? definition.operational_mode ?? 'draft') || 'draft';
}

function isSmokeOrDuplicateLegacy(workflow = {}) {
  const key = clean(workflow.workflow_key ?? workflow.definition_key ?? '');
  if (SMOKE_KEY_PATTERNS.some((re) => re.test(key))) return true;
  if (key.startsWith('owner_acquisition_follow_up') && key !== 'owner_acquisition_follow_up') return true;
  return false;
}

function schemaForNodeType(nodeType) {
  const meta = getNodeMeta(nodeType);
  const kind = meta?.node_kind ?? 'action';
  const base = {
    general: {
      label: { type: 'string' },
      description: { type: 'string' },
      timeout_seconds: { type: 'number', default: 300 },
    },
    logic: {},
    safety: {},
    data: { mappings: { type: 'object' } },
  };
  if (kind === 'condition') {
    base.logic = {
      source_variable: { type: 'string' },
      operator: { type: 'enum', values: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] },
      value: { type: 'any' },
      true_path: { type: 'node_key' },
      false_path: { type: 'node_key' },
      unknown_path: { type: 'node_key' },
    };
  } else if (kind === 'action') {
    base.logic = {
      success_path: { type: 'node_key' },
      retry_path: { type: 'node_key' },
      failure_path: { type: 'node_key' },
    };
    if (meta?.is_communication) {
      base.safety = {
        suppression_guard: { type: 'boolean', default: true },
        opt_out_guard: { type: 'boolean', default: true },
        quiet_hours: { type: 'boolean', default: true },
        max_touches: { type: 'number', default: 8 },
        idempotency_key_strategy: { type: 'enum', values: ['enrollment_node', 'dedupe_explicit'] },
      };
    }
  } else if (kind === 'timing') {
    base.logic = {
      amount: { type: 'number' },
      unit: { type: 'enum', values: ['minutes', 'hours', 'days'] },
      until: { type: 'datetime' },
      timezone: { type: 'string' },
      cancel_on_events: { type: 'array' },
    };
  } else if (kind === 'guard') {
    base.safety = { reason: { type: 'string' }, block_terminal: { type: 'boolean', default: true } };
  }
  return { input_schema: base, output_schema: { status: { type: 'string' }, context_patch: { type: 'object' } } };
}

function presentationMeta(node = {}) {
  const internal = node.is_system === true || node.internal_only === true;
  return {
    operator_exposed: !internal && node.is_enabled !== false,
    ui_category: node.ui_category ?? node.category,
    icon: node.icon ?? null,
    display_order: node.display_order ?? 0,
    supports_canvas: node.supports_canvas !== false,
    internal_only: internal,
    deprecated: node.deprecated === true,
    replacement_node_type: node.replacement_node_type ?? null,
  };
}

export async function listWorkflowNodeRegistry(opts = {}, deps = {}) {
  const includeInternal = opts.include_internal === true || opts.developer_mode === true;
  const cacheKey = includeInternal ? 'internal' : 'operator';
  if (
    opts.bypass_cache !== true
    && registryCache?.[cacheKey]
    && Date.now() - registryCacheAt < REGISTRY_CACHE_TTL_MS
  ) {
    return registryCache[cacheKey];
  }

  const client = db(deps);
  const { data: dbRows, error } = await client
    .from('workflow_node_registry')
    .select('*')
    .order('category', { ascending: true });

  let rows = [];
  if (!error && dbRows?.length) {
    rows = dbRows;
  } else {
    rows = getRegistryRowsForSync();
  }

  const enriched = rows.map((row) => ({
    ...row,
    ...presentationMeta(row),
  }));

  const operatorNodes = enriched.filter((n) => n.operator_exposed);
  const internalNodes = enriched.filter((n) => n.internal_only);

  const visible = includeInternal ? enriched : operatorNodes;
  const categories = {};
  for (const node of visible) {
    const cat = node.ui_category ?? node.category ?? 'operations';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(node);
  }

  const result = {
    ok: true,
    nodes: visible,
    categories,
    counts: {
      total: enriched.length,
      operator: operatorNodes.length,
      internal: internalNodes.length,
    },
    source: error ? 'code_registry_fallback' : 'workflow_node_registry',
    registry_version: SYSTEM_GRAPH_VERSION,
  };

  registryCache = registryCache ?? {};
  registryCache[cacheKey] = result;
  registryCacheAt = Date.now();
  return result;
}

export async function cloneLegacyWorkflowToV2(legacyId, deps = {}) {
  const legacy = await getDefinition(legacyId, deps);
  if (!legacy.ok || !legacy.is_legacy) {
    return { ok: false, status: 400, error: 'legacy_workflow_required' };
  }

  const created = await createDefinition({
    name: `${legacy.workflow.name} (V2)`,
    definition_key: `${legacy.workflow.workflow_key}_v2_${Date.now().toString(36)}`,
    description: legacy.workflow.description,
    metadata: {
      channel: legacy.workflow.channel ?? 'multichannel',
      workflow_type: legacy.workflow.workflow_type ?? 'automation',
      operational_mode: 'draft',
      cloned_from_legacy_id: legacyId,
      market_scope: legacy.workflow.market_scope ?? ['default'],
      state_scope: legacy.workflow.state_scope ?? ['TX'],
      language_scope: legacy.workflow.language_scope ?? ['en'],
    },
    status: 'draft',
    trigger_type: 'trigger.lead_entered_workflow',
  }, deps);
  if (!created.ok) return created;

  const definitionId = created.definition_id;
  const steps = legacy.steps ?? [];
  const keyToId = new Map();

  for (const [index, step] of steps.entries()) {
    const pos = step.config?.position ?? step.config?.ui ?? {};
    const nodeRes = await createNode(definitionId, {
      node_type: step.node_type,
      label: step.label,
      node_key: step.step_key,
      config: step.config ?? {},
      position_x: pos.x ?? 120 + index * 80,
      position_y: pos.y ?? 180 + (index % 3) * 90,
    }, deps);
    if (nodeRes.ok && nodeRes.node_id) {
      keyToId.set(step.step_key, nodeRes.node_id);
    }
  }

  for (let i = 0; i < steps.length - 1; i += 1) {
    const fromId = keyToId.get(steps[i].step_key);
    const toId = keyToId.get(steps[i + 1].step_key);
    if (fromId && toId) {
      await createEdge(definitionId, { source_node_id: fromId, target_node_id: toId, edge_type: 'next' }, deps);
    }
  }

  return getWorkflowStudioDetail(definitionId, {}, deps);
}

export function getRegistryRowsForSync() {
  return NODE_TYPE_REGISTRY.map((node) => {
    const schemas = schemaForNodeType(node.node_type);
    return {
      node_type: node.node_type,
      node_kind: node.node_kind,
      label: node.label,
      description: node.description,
      category: node.category,
      is_communication: node.is_communication === true,
      requires_guard_before: node.requires_guard_before === true,
      is_terminal: node.is_terminal === true,
      is_enabled: true,
      is_system: node.is_system === true,
      input_schema: schemas.input_schema,
      output_schema: schemas.output_schema,
    };
  });
}

async function countRunsForWorkflow(workflowId, isLegacy, deps) {
  const client = db(deps);
  const col = isLegacy ? 'workflow_id' : 'workflow_definition_id';
  const { count, error } = await client
    .from('workflow_runs')
    .select('id', { count: 'exact', head: true })
    .eq(col, workflowId);
  if (error) return 0;
  return count ?? 0;
}

/**
 * §27 — the separate facts an operator needs, kept separate.
 *
 * "Published", "event bridge connected", "armed", "has ever fired" and "live
 * sends disabled" are five different things. Collapsing them is what produced
 * "Active Safe" for 14 workflows that could not run. None of these is a new
 * status: workflow_definitions.status remains the lifecycle authority.
 */
function triggerBridgeFacts(workflow, bridgeByTrigger, canonicalActivity) {
  if (workflow.is_legacy) {
    return {
      trigger_kind: null,
      trigger_bridge_connected: false,
      trigger_bridge_reason: 'legacy_workflow_read_only',
      canonical_event_types: [],
      canonical_event_count: null,
      canonical_last_seen_at: null,
    };
  }

  const bridge = bridgeByTrigger.get(clean(workflow.trigger_type))
    ?? { trigger_kind: null, bridge_connected: false, reason: 'unrecognised_trigger_type', canonical_event_types: [] };

  let count = null;
  let lastSeen = null;
  if (canonicalActivity?.available && bridge.canonical_event_types.length) {
    count = 0;
    for (const type of bridge.canonical_event_types) {
      const observed = canonicalActivity.activity.get(type);
      if (!observed) continue;
      count += observed.event_count;
      if (observed.last_seen_at && (!lastSeen || observed.last_seen_at > lastSeen)) {
        lastSeen = observed.last_seen_at;
      }
    }
  }

  return {
    trigger_kind: bridge.trigger_kind,
    trigger_bridge_connected: bridge.bridge_connected,
    trigger_bridge_reason: bridge.reason,
    canonical_event_types: bridge.canonical_event_types,
    // Occurrences of the CANONICAL events that feed this workflow. null means
    // unmeasured; 0 means measured and never.
    canonical_event_count: count,
    canonical_last_seen_at: lastSeen,
  };
}

function summarizeWorkflow(workflow, counts = {}) {
  const meta = workflow.metadata && typeof workflow.metadata === 'object' ? workflow.metadata : {};
  return {
    ...workflow,
    version: workflow.version ?? 1,
    operational_mode: operationalMode(workflow),
    is_system_template: workflow.is_system_template === true,
    is_locked: workflow.is_locked === true,
    node_count: counts.node_count ?? workflow.step_count ?? workflow.node_count ?? 0,
    step_count: 'step_count' in counts ? counts.step_count : (workflow.step_count ?? 0),
    edge_count: counts.edge_count ?? workflow.edge_count ?? 0,
    // Whether a workflow can text a seller is the first thing an operator needs
    // and the last thing that may be guessed. It was hardcoded to 0 for every
    // workflow, including the four that genuinely carry a send node — so the
    // surface reported "no sends" about workflows that send. Counted from the
    // same node scan that produces node_count, at no extra query cost.
    send_node_count: 'send_node_count' in counts ? counts.send_node_count : (workflow.send_node_count ?? 0),
    trigger_event_count: 'trigger_event_count' in counts ? counts.trigger_event_count : null,
    trigger_last_seen_at: 'trigger_last_seen_at' in counts ? counts.trigger_last_seen_at : null,
    trigger_matchable: 'trigger_matchable' in counts ? counts.trigger_matchable : null,
    trigger_kind: 'trigger_kind' in counts ? counts.trigger_kind : null,
    trigger_bridge_connected: 'trigger_bridge_connected' in counts ? counts.trigger_bridge_connected : null,
    trigger_bridge_reason: 'trigger_bridge_reason' in counts ? counts.trigger_bridge_reason : null,
    canonical_event_types: 'canonical_event_types' in counts ? counts.canonical_event_types : [],
    canonical_event_count: 'canonical_event_count' in counts ? counts.canonical_event_count : null,
    canonical_last_seen_at: 'canonical_last_seen_at' in counts ? counts.canonical_last_seen_at : null,
    validation_state: counts.validation_state ?? workflow.validation_state ?? 'unknown',
    stage_code: meta.stage_code ?? meta.stage ?? null,
    touch_number: meta.touch_number ?? meta.touch ?? null,
    last_updated: workflow.updated_at ?? workflow.created_at ?? null,
  };
}

async function listDefinitionsLightweight(deps = {}) {
  const client = db(deps);
  const [v2Res, v1Res] = await Promise.all([
    client
      .from('workflow_definitions')
      .select('id, name, description, definition_key, status, trigger_type, version, updated_at, created_at, published_at, metadata, is_system_template, is_locked')
      .order('updated_at', { ascending: false })
      .limit(200),
    client
      // Only columns that exist. `public.workflows` has no trigger_type and no
      // version — asking for them returned 42703 "column
      // workflows.trigger_type does not exist", which fails the WHOLE PostgREST
      // select, and the error was then swallowed by `v1Res.data ?? []` below.
      // Net effect measured 2026-09-15: all 9 legacy rows (5 after the smoke
      // and duplicate filters) were invisible in Workflow Studio with no error
      // and no signal — the list simply showed 18 instead of 23.
      .from('workflows')
      .select(
        'id, name, description, workflow_key, status, channel, workflow_type, '
        + 'live_send_enabled, updated_at, created_at',
      )
      .order('updated_at', { ascending: false })
      .limit(100),
  ]);

  if (v2Res.error) throw v2Res.error;
  // A legacy read failure must be visible. Silently omitting workflows is the
  // defect above; throwing here means the next schema drift is loud.
  if (v1Res.error) throw v1Res.error;

  const v2Workflows = (v2Res.data ?? []).map((definition) => ({
    ...mapDefinitionToWorkflowSummary(definition),
    live_send_enabled: false,
  }));

  const v1Workflows = (v1Res.data ?? []).map((workflow) => ({
    ...workflow,
    workflow_key: workflow.workflow_key,
    // The legacy table carries neither, and a legacy workflow is read-only in
    // V2 anyway. Reported as absent rather than defaulted to a plausible value.
    trigger_type: null,
    version: null,
    is_v2: false,
    is_legacy: true,
    // Legacy rows have a live_send_enabled column, but legacy cannot execute in
    // V2 at all, so the answer is false regardless of what it stores.
    live_send_enabled: false,
  }));

  return [...v2Workflows, ...v1Workflows];
}

function mapDefinitionToWorkflowSummary(definition) {
  const meta = definition.metadata && typeof definition.metadata === 'object' ? definition.metadata : {};
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    workflow_key: definition.definition_key,
    definition_key: definition.definition_key,
    status: definition.status,
    trigger_type: definition.trigger_type,
    version: definition.version ?? 1,
    updated_at: definition.updated_at,
    created_at: definition.created_at,
    published_at: definition.published_at ?? null,
    channel: meta.channel ?? 'multichannel',
    workflow_type: meta.workflow_type ?? 'automation',
    metadata: meta,
    is_v2: true,
    is_legacy: false,
    is_system_template: definition.is_system_template === true,
    is_locked: definition.is_locked === true,
    step_count: 0,
  };
}

/**
 * Observed activity for a set of trigger types.
 *
 * §3/§22. The catalog reported `operational_mode: 'active_safe'` for all 14
 * published workflows, which the mobile row rendered as "active safe" — while
 * measurement on 2026-09-15 showed ZERO events of any `trigger.*` type had ever
 * been emitted. Production emits `opportunity_created` / `opportunity_stage_changed`
 * / `opportunity_manual_override` / `opportunity_status_changed`; the workflow
 * library subscribes `trigger.inbound_message_received` and friends. The two
 * namespaces are disjoint, so none of those workflows can fire.
 *
 * This returns EVIDENCE, not a verdict, and deliberately does not introduce a
 * second status authority: `workflow_definitions.status` remains the lifecycle
 * truth. Callers get how many events of the trigger type have been seen and
 * when, and decide how to phrase it.
 *
 * An unavailable aggregate yields `null`, never 0 — "we could not measure" must
 * not render as "never happened".
 */
export async function fetchWorkflowTriggerActivity(triggerTypes = [], deps = {}) {
  const wanted = [...new Set((triggerTypes ?? []).map((t) => clean(t)).filter(Boolean))];
  const activity = new Map();
  if (!wanted.length) return { activity, available: true };

  const client = db(deps);
  if (typeof client?.rpc !== 'function') return { activity, available: false };

  const { data, error } = await client.rpc('workflow_event_type_activity', { p_event_types: wanted });
  if (error) return { activity, available: false, error };
  // NOTE: this reads workflow_events, Workflow V2's own inbox. It answers
  // "has this event type reached the workflow engine", which before the bridge
  // existed was always 0 for every `trigger.*`. The question an operator
  // actually asks - "has the acquisition event that feeds this workflow ever
  // occurred" - is one layer upstream, answered by
  // fetchCanonicalTriggerActivity below.

  for (const row of data ?? []) {
    activity.set(clean(row.event_type), {
      event_count: Number(row.event_count ?? 0),
      last_seen_at: row.last_seen_at ?? null,
    });
  }
  // A trigger type with no row has genuinely never been observed. That is a
  // measured zero, distinct from the unavailable case above.
  for (const type of wanted) {
    if (!activity.has(type)) activity.set(type, { event_count: 0, last_seen_at: null });
  }
  return { activity, available: true };
}

/**
 * Observed activity on the CANONICAL bus for a set of event types.
 *
 * §27. This is what makes "Event Bridge Connected" a measured claim rather than
 * a hopeful label: the bridge can deliver a kind, and these are the real
 * occurrences of the events that produce it.
 *
 * Unavailable yields `available: false` with an empty map - never a zero, which
 * would read as "this trigger has never fired".
 */
export async function fetchCanonicalTriggerActivity(canonicalEventTypes = [], deps = {}) {
  const wanted = [...new Set((canonicalEventTypes ?? []).map((t) => clean(t)).filter(Boolean))];
  const activity = new Map();
  if (!wanted.length) return { activity, available: true };

  const client = db(deps);
  if (typeof client?.rpc !== 'function') return { activity, available: false };

  const { data, error } = await client.rpc('automation_event_type_activity', { p_event_types: wanted });
  if (error) return { activity, available: false, error };

  for (const row of data ?? []) {
    activity.set(clean(row.event_type), {
      event_count: Number(row.event_count ?? 0),
      last_seen_at: row.last_seen_at ?? null,
    });
  }
  for (const type of wanted) {
    if (!activity.has(type)) activity.set(type, { event_count: 0, last_seen_at: null });
  }
  return { activity, available: true };
}

async function attachGraphCounts(workflows, deps) {
  const v2Ids = workflows.filter((w) => !w.is_legacy).map((w) => w.id);
  const legacyIds = workflows.filter((w) => w.is_legacy).map((w) => w.id);
  if (!v2Ids.length && !legacyIds.length) {
    return workflows.map((w) => summarizeWorkflow(w));
  }

  const client = db(deps);
  // §27. Every definition's stored trigger_type resolved to a kind, and the
  // canonical event types that feed each kind. Pure functions — no query.
  const bridgeByTrigger = new Map();
  for (const w of workflows) {
    const key = clean(w.trigger_type);
    if (!key || bridgeByTrigger.has(key)) continue;
    bridgeByTrigger.set(key, describeTriggerBridge(key));
  }
  const canonicalTypes = [
    ...new Set([...bridgeByTrigger.values()].flatMap((b) => b.canonical_event_types)),
  ];

  const [nodesRes, edgesRes, stepsRes, triggerActivity, canonicalActivity] = await Promise.all([
    v2Ids.length
      ? client.from('workflow_nodes').select('workflow_definition_id, node_type').in('workflow_definition_id', v2Ids)
      : Promise.resolve({ data: [], error: null }),
    v2Ids.length
      ? client.from('workflow_edges').select('workflow_definition_id').in('workflow_definition_id', v2Ids)
      : Promise.resolve({ data: [], error: null }),
    // A legacy workflow's shape lives in workflow_steps, so its size is
    // measurable after all — it was reported as 0 nodes only because
    // `step_count` was never read. Production carries 83 step rows across the
    // legacy workflows, 3 to 16 each.
    legacyIds.length
      ? client.from('workflow_steps').select('workflow_id').in('workflow_id', legacyIds)
      : Promise.resolve({ data: [], error: null }),
    fetchWorkflowTriggerActivity(workflows.map((w) => w.trigger_type), deps),
    fetchCanonicalTriggerActivity(canonicalTypes, deps),
  ]);

  // A failed count read must not become a zero. `send_node_count: 0` telling an
  // operator a workflow cannot text sellers is the defect this whole projection
  // exists to fix, so an unreadable graph surfaces instead of being averaged
  // down to "no sends".
  for (const [what, res] of [['workflow_nodes', nodesRes], ['workflow_edges', edgesRes], ['workflow_steps', stepsRes]]) {
    if (res?.error) {
      // Spreading the PostgREST error onto the Error would overwrite `message`
      // with its own, losing which count failed. Carry the code separately.
      const failure = new Error(`${what} count failed: ${res.error.message ?? res.error}`);
      failure.code = res.error.code ?? null;
      failure.cause = res.error;
      throw failure;
    }
  }

  const nodeCounts = {};
  const sendNodeCounts = {};
  const edgeCounts = {};
  for (const row of nodesRes.data ?? []) {
    nodeCounts[row.workflow_definition_id] = (nodeCounts[row.workflow_definition_id] ?? 0) + 1;
    if (isSellerFacingNodeType(row.node_type)) {
      sendNodeCounts[row.workflow_definition_id] = (sendNodeCounts[row.workflow_definition_id] ?? 0) + 1;
    }
  }
  for (const row of edgesRes.data ?? []) {
    edgeCounts[row.workflow_definition_id] = (edgeCounts[row.workflow_definition_id] ?? 0) + 1;
  }
  const stepCounts = {};
  for (const row of stepsRes.data ?? []) {
    stepCounts[row.workflow_id] = (stepCounts[row.workflow_id] ?? 0) + 1;
  }

  return workflows.map((w) => {
    const observed = triggerActivity.available
      ? triggerActivity.activity.get(clean(w.trigger_type)) ?? null
      : null;
    return summarizeWorkflow(w, {
      node_count: w.is_legacy ? (stepCounts[w.id] ?? 0) : (nodeCounts[w.id] ?? 0),
      step_count: w.is_legacy ? (stepCounts[w.id] ?? 0) : 0,
      edge_count: w.is_legacy ? 0 : (edgeCounts[w.id] ?? 0),
      // A legacy workflow's steps are not graph nodes, so its send count is not
      // measurable here; null says "unknown", which is not the same as zero.
      send_node_count: w.is_legacy ? null : (sendNodeCounts[w.id] ?? 0),
      // Evidence, not a verdict. null means unmeasured.
      trigger_event_count: observed ? observed.event_count : null,
      trigger_last_seen_at: observed ? observed.last_seen_at : null,
      // execution-service.js matchDefinitions selects on trigger_type AND
      // status='active'. A published workflow is therefore not selectable, which
      // is the single most load-bearing fact the list was not saying.
      trigger_matchable: w.is_legacy ? false : w.status === 'active',
      ...triggerBridgeFacts(w, bridgeByTrigger, canonicalActivity),
    });
  });
}

async function attachStats(workflow, deps) {
  const client = db(deps);
  const id = workflow.id;
  const isLegacy = workflow.is_legacy === true || workflow.is_v2 === false;
  const defCol = isLegacy ? null : id;

  const stats = {
    active_runs: 0,
    waiting_runs: 0,
    blocked_runs: 0,
    completed_today: 0,
    failed_today: 0,
    last_execution_at: null,
    last_published_at: workflow.published_at ?? null,
  };

  if (!isLegacy && defCol) {
    const today = todayStartIso();
    const [enrollRes, runsRes] = await Promise.all([
      client.from('workflow_enrollments').select('status').eq('workflow_definition_id', defCol),
      client
        .from('workflow_runs')
        .select('status, completed_at, started_at')
        .eq('workflow_definition_id', defCol)
        .order('started_at', { ascending: false })
        .limit(50),
    ]);
    for (const row of enrollRes.data ?? []) {
      if (row.status === 'active') stats.active_runs += 1;
      if (row.status === 'waiting') stats.waiting_runs += 1;
      if (row.status === 'cancelled') stats.blocked_runs += 1;
    }
    for (const run of runsRes.data ?? []) {
      if (!stats.last_execution_at && run.started_at) stats.last_execution_at = run.started_at;
      const doneAt = run.completed_at ?? run.started_at;
      if (doneAt && doneAt >= today) {
        if (run.status === 'completed') stats.completed_today += 1;
        if (run.status === 'failed') stats.failed_today += 1;
      }
    }
  }

  return {
    ...summarizeWorkflow(workflow),
    stats,
  };
}

async function attachStatsBatch(workflows, deps) {
  return Promise.all(workflows.map((w) => attachStats(w, deps)));
}

export async function listWorkflowStudioCatalog(opts = {}, deps = {}) {
  const includeArchived = opts.include_archived === true;
  const includeStats = opts.include_stats === true;
  const summaryMode = opts.summary !== false;

  let workflows = summaryMode
    ? await listDefinitionsLightweight(deps)
    : (await listDefinitions(deps)).workflows ?? [];

  if (!includeArchived) {
    workflows = workflows.filter((w) => {
      if (w.status === 'archived') return false;
      if (w.is_legacy && isSmokeOrDuplicateLegacy(w)) return false;
      return true;
    });
  }

  const enriched = includeStats
    ? await attachStatsBatch(workflows, deps)
    : await attachGraphCounts(workflows, deps);

  return {
    ok: true,
    workflows: enriched,
    canonical_model: 'workflow_definitions',
    legacy_read_only: true,
    summary: summaryMode,
  };
}

export async function getWorkflowStudioDetail(id, opts = {}, deps = {}) {
  const includeAnalytics = opts.include_analytics === true;
  const detail = await getDefinition(id, deps);
  if (!detail.ok) return detail;

  const validation = detail.is_legacy
    ? { ok: true, errors: [], warnings: ['legacy_workflow_read_only'] }
    : await validateDefinitionGraph(id, deps);

  let analyticsSummary = {};
  if (includeAnalytics && !detail.is_legacy) {
    const analytics = await getWorkflowAnalytics(id, deps);
    analyticsSummary = analytics.summary ?? {};
  }

  return {
    ...detail,
    validation,
    analytics_summary: analyticsSummary,
    operational_mode: operationalMode(detail.definition ?? detail.workflow),
    canonical_model: detail.is_legacy ? 'workflows_legacy' : 'workflow_definitions',
  };
}

export async function createWorkflowStudioDraft(payload = {}, deps = {}) {
  const operationalMode = clean(payload.operational_mode ?? 'draft') || 'draft';
  const meta = {
    ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
    channel: payload.channel ?? 'multichannel',
    workflow_type: payload.workflow_type ?? 'automation',
    operational_mode: operationalMode,
    market_scope: payload.market_scope ?? ['default'],
    state_scope: payload.state_scope ?? ['TX'],
    language_scope: payload.language_scope ?? ['en'],
    asset_scope: payload.asset_scope ?? payload.asset_type_scope ?? [],
    no_send: operationalMode !== 'armed' && operationalMode !== 'live',
  };
  const triggerType = clean(payload.trigger_type ?? payload.trigger ?? 'trigger.lead_entered_workflow');
  const result = await createDefinition({
    ...payload,
    metadata: meta,
    status: 'draft',
    trigger_type: triggerType,
  }, deps);
  if (!result.ok) return result;

  const definitionId = result.definition_id;
  if (payload.start_from === 'system_template' && payload.template_key) {
    const template = SYSTEM_WORKFLOW_TEMPLATES?.find?.(
      (t) => t.template_key === payload.template_key || t.definition_key === payload.template_key,
    );
    if (template?.graph) {
      await seedTemplateGraph(definitionId, template.graph, deps);
      return getWorkflowStudioDetail(definitionId, {}, deps);
    }
  }

  await createNode(definitionId, {
    node_type: triggerType,
    label: payload.trigger_label ?? 'Workflow Start',
    position_x: 120,
    position_y: 180,
    config: { step_order: 10 },
  }, deps);

  return getWorkflowStudioDetail(definitionId, {}, deps);
}

async function seedTemplateGraph(definitionId, graph, deps) {
  const client = db(deps);
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const keyToId = new Map();

  for (const node of nodes) {
    const row = {
      workflow_definition_id: definitionId,
      node_key: node.node_key ?? node.key,
      node_kind: node.node_kind ?? 'action',
      node_type: node.node_type,
      label: node.label,
      config: node.config ?? {},
      position_x: node.position_x ?? node.x ?? 0,
      position_y: node.position_y ?? node.y ?? 0,
      is_active: node.is_active !== false,
    };
    const { data, error } = await client.from('workflow_nodes').insert(row).select('id, node_key').single();
    if (error) throw error;
    keyToId.set(data.node_key, data.id);
  }

  for (const edge of edges) {
    const sourceId = keyToId.get(edge.source_node_key ?? edge.from);
    const targetId = keyToId.get(edge.target_node_key ?? edge.to);
    if (!sourceId || !targetId) continue;
    await createEdge(definitionId, {
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edge.edge_type ?? 'next',
      condition_key: edge.condition_key,
      label: edge.label,
    }, deps);
  }
}

export async function updateWorkflowStudioDraft(id, payload = {}, deps = {}) {
  const current = await getDefinition(id, deps);
  if (!current.ok) return current;
  if (current.is_legacy) {
    return { ok: false, status: 403, error: 'legacy_workflow_readonly' };
  }
  if (current.definition?.is_locked) {
    const lock = protectSystemTemplateEdit(current.definition);
    const metaOnly = Object.keys(payload).every((k) => k === 'metadata' || k === 'status');
    if (!lock.ok && !metaOnly) return { ok: false, status: 403, ...lock };
  }
  const result = await updateDefinition(id, payload, deps);
  if (!result.ok) return result;
  return getWorkflowStudioDetail(id, {}, deps);
}

export async function createWorkflowStudioNode(definitionId, payload = {}, deps = {}) {
  const result = await createNode(definitionId, payload, deps);
  if (!result.ok) return result;
  return getWorkflowStudioDetail(definitionId, {}, deps);
}

export async function updateWorkflowStudioNode(nodeId, payload = {}, deps = {}) {
  const current = await db(deps).from('workflow_nodes').select('workflow_definition_id').eq('id', nodeId).maybeSingle();
  if (!current.data) return { ok: false, status: 404, error: 'workflow_node_not_found' };
  const result = await updateNode(nodeId, payload, deps);
  if (!result.ok) return result;
  return getWorkflowStudioDetail(current.data.workflow_definition_id, {}, deps);
}

export async function insertNodeOnEdge(definitionId, payload = {}, deps = {}) {
  const raw = await insertNodeOnEdgeResolved(definitionId, payload, deps);
  if (!raw.ok) return raw;
  return getWorkflowStudioDetail(definitionId, {}, deps);
}

export async function mutateWorkflowGraph(definitionId, payload = {}, deps = {}) {
  const raw = await applyGraphMutation(definitionId, payload, deps);
  if (!raw.ok) return raw;
  return getWorkflowStudioDetail(definitionId, {}, deps);
}

export async function publishWorkflowVersion(id, deps = {}) {
  const detail = await getDefinition(id, deps);
  if (!detail.ok) return detail;
  if (detail.is_legacy) return { ok: false, status: 403, error: 'legacy_workflow_readonly' };
  if (detail.definition?.is_locked) {
    return { ok: false, status: 403, error: 'system_template_locked' };
  }

  const validation = await validateDefinitionGraph(id, deps);
  if (!validation.ok) {
    return { ok: false, status: 422, error: 'graph_validation_failed', validation };
  }

  const def = detail.definition;
  const version = Number(def.version ?? 1);
  const publishedVersions = Array.isArray(def.metadata?.published_versions) ? def.metadata.published_versions : [];
  const snapshot = {
    version,
    published_at: new Date().toISOString(),
    node_count: detail.nodes?.length ?? 0,
    edge_count: detail.edges?.length ?? 0,
    nodes: detail.nodes,
    edges: detail.edges,
  };
  publishedVersions.push(snapshot);

  const patch = {
    status: 'published',
    version: version + 1,
    published_at: new Date().toISOString(),
    metadata: {
      ...(def.metadata ?? {}),
      operational_mode: def.metadata?.operational_mode ?? 'armed',
      published_versions: publishedVersions,
      last_publish_validation: validation,
    },
  };

  const updated = await updateDefinition(id, patch, deps);
  if (!updated.ok) return updated;
  return {
    ok: true,
    published_version: version,
    next_version: version + 1,
    validation,
    detail: await getWorkflowStudioDetail(id, {}, deps),
  };
}

export async function getWorkflowConsole(definitionId, filters = {}, deps = {}) {
  const client = db(deps);
  const limit = Number(filters.limit ?? 100);
  const events = [];

  const [runs, steps, wfEvents, enrollments] = await Promise.all([
    client.from('workflow_runs').select('*').eq('workflow_definition_id', definitionId).order('started_at', { ascending: false }).limit(limit),
    client.from('workflow_run_steps').select('*').eq('workflow_definition_id', definitionId).order('created_at', { ascending: false }).limit(limit),
    client.from('workflow_events').select('*').order('created_at', { ascending: false }).limit(limit),
    client.from('workflow_enrollments').select('*').eq('workflow_definition_id', definitionId).order('enrolled_at', { ascending: false }).limit(limit),
  ]);

  const nodeLabelByKey = new Map();
  const { data: graphNodes } = await client
    .from('workflow_nodes')
    .select('node_key, label, node_type')
    .eq('workflow_definition_id', definitionId);
  for (const n of graphNodes ?? []) {
    nodeLabelByKey.set(n.node_key, n.label ?? n.node_type);
  }

  for (const step of steps.data ?? []) {
    const ctx = step.execution_result?._context ?? step.input_context ?? {};
    events.push({
      id: step.id,
      source: 'workflow_run_steps',
      timestamp: step.completed_at ?? step.started_at ?? step.created_at,
      workflow_id: definitionId,
      version: step.workflow_version ?? null,
      node_key: step.node_key,
      node_type: step.node_type,
      node: nodeLabelByKey.get(step.node_key) ?? step.node_key ?? step.node_type,
      seller: ctx.seller_display_name ?? ctx.seller_name ?? ctx.first_name ?? null,
      property: ctx.property_address ?? ctx.property_id ?? null,
      status: step.status,
      transition: step.status,
      duration_ms: step.duration_ms ?? step.elapsed_ms ?? null,
      blocker: step.block_reason ?? step.blocker ?? null,
      retry: step.retry_count ?? 0,
      trace_id: step.trace_id ?? step.workflow_run_id,
    });
  }

  for (const run of runs.data ?? []) {
    const ctx = run.context ?? {};
    events.push({
      id: run.id,
      source: 'workflow_runs',
      timestamp: run.completed_at ?? run.started_at,
      workflow_id: definitionId,
      version: run.workflow_version ?? null,
      seller: ctx.seller_display_name ?? ctx.seller_name ?? null,
      property: ctx.property_address ?? null,
      status: run.status,
      transition: run.status,
      trace_id: run.trace_id ?? run.id,
    });
  }

  for (const enrollment of enrollments.data ?? []) {
    const ctx = enrollment.context ?? {};
    events.push({
      id: enrollment.id,
      source: 'workflow_enrollments',
      timestamp: enrollment.enrolled_at ?? enrollment.updated_at,
      workflow_id: definitionId,
      seller: ctx.seller_display_name ?? ctx.seller_name ?? enrollment.subject_id,
      property: ctx.property_address ?? null,
      status: enrollment.status,
      transition: enrollment.status,
      node: enrollment.current_node_id,
      trace_id: enrollment.id,
    });
  }

  events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  return { ok: true, events: events.slice(0, limit), filters_applied: filters };
}

/**
 * §9 — "you are here", derived from durable run history.
 *
 * THE DEFECT. `workflow_enrollments.current_node_id` is a RESUME POINTER, not a
 * position. When the runner hits a timing node it calls
 * `advanceEnrollment(next)` and THEN `pauseEnrollmentForWait(...)`, so a
 * waiting enrollment's current_node_id names the node that will run when the
 * wait expires. Reporting it as the current step told the operator the run was
 * sitting at a node that had never executed — measured on the runtime proof:
 * status "waiting", step "guard_suppression", while the run was parked on
 * `wait_proof` and the guard had not run at all.
 *
 * Current position comes from what the engine actually recorded. The resume
 * pointer is still reported, labelled as what it is: the NEXT node.
 */
const TERMINAL_STEP_STATUSES = new Set(['completed', 'triggered', 'scaffolded', 'exit']);

async function loadRunPositions(definitionId, enrollmentIds, client) {
  const positions = new Map();
  if (!enrollmentIds.length) return positions;

  const { data: runs, error: runsError } = await client
    .from('workflow_runs')
    .select('id, enrollment_id, status, started_at, completed_at')
    .eq('workflow_definition_id', definitionId)
    .in('enrollment_id', enrollmentIds)
    .order('started_at', { ascending: true });
  if (runsError) throw runsError;

  const runRows = runs ?? [];
  if (!runRows.length) return positions;

  const { data: steps, error: stepsError } = await client
    .from('workflow_run_steps')
    .select('workflow_run_id, node_id, node_key, node_type, status, block_reason, created_at')
    .in('workflow_run_id', runRows.map((r) => r.id))
    .order('created_at', { ascending: true });
  if (stepsError) throw stepsError;

  const stepsByRun = new Map();
  for (const step of steps ?? []) {
    if (!stepsByRun.has(step.workflow_run_id)) stepsByRun.set(step.workflow_run_id, []);
    stepsByRun.get(step.workflow_run_id).push(step);
  }

  for (const run of runRows) {
    const runSteps = stepsByRun.get(run.id) ?? [];
    const completed = [];
    for (const step of runSteps) {
      if (TERMINAL_STEP_STATUSES.has(clean(step.status))) completed.push(step.node_key);
    }
    // The position is the last step the engine wrote. For a parked run that is
    // the `waiting` step; for a blocked run it is the guard that refused.
    const last = runSteps.length ? runSteps[runSteps.length - 1] : null;
    positions.set(run.enrollment_id, {
      run_id: run.id,
      run_status: run.status,
      started_at: run.started_at,
      completed_at: run.completed_at,
      step_count: runSteps.length,
      completed_node_keys: [...new Set(completed)],
      current_step: last
        ? {
            node_id: last.node_id,
            node_key: last.node_key,
            node_type: last.node_type,
            status: last.status,
            block_reason: last.block_reason ?? null,
            at: last.created_at,
          }
        : null,
    });
  }

  return positions;
}

export async function getWorkflowLiveState(definitionId, deps = {}) {
  const client = db(deps);
  const [{ data: enrollments }, { data: nodes }] = await Promise.all([
    client
      .from('workflow_enrollments')
      .select('*')
      .eq('workflow_definition_id', definitionId)
      .in('status', ['active', 'waiting', 'paused']),
    client
      .from('workflow_nodes')
      .select('id, node_key, label, node_type')
      .eq('workflow_definition_id', definitionId),
  ]);

  const nodesById = new Map((nodes ?? []).map((n) => [n.id, n]));
  const positions = await loadRunPositions(
    definitionId,
    (enrollments ?? []).map((e) => e.id),
    client,
  );

  const tokens = [];
  const nodeStates = new Map();

  for (const enrollment of enrollments ?? []) {
    const ctx = enrollment.context ?? {};
    const position = positions.get(enrollment.id) ?? null;
    // The resume pointer, named as such.
    const nextNode = nodesById.get(enrollment.current_node_id);
    // Where the run actually is, from what the engine recorded. Falls back to
    // the resume pointer only when no step has been written yet, which is the
    // one case where they genuinely coincide.
    const currentNodeId = position?.current_step?.node_id ?? enrollment.current_node_id;
    const current = nodesById.get(currentNodeId);
    const tokenStatus =
      enrollment.status === 'waiting' ? 'waiting' :
      enrollment.status === 'paused' ? 'blocked' :
      'progressing';

    const token = {
      id: enrollment.id,
      enrollment_id: enrollment.id,
      run_id: position?.run_id ?? enrollment.workflow_run_id ?? enrollment.id,
      step_id: currentNodeId,
      step_key: current?.node_key ?? position?.current_step?.node_key,
      node_type: current?.node_type ?? position?.current_step?.node_type,
      label: current?.label ?? current?.node_type,
      // Everything the engine has finished, so the canvas can mark a path
      // rather than inferring one from colours.
      completed_node_keys: position?.completed_node_keys ?? [],
      step_status: position?.current_step?.status ?? null,
      step_block_reason: position?.current_step?.block_reason ?? null,
      next_step_id: enrollment.current_node_id ?? null,
      next_step_key: nextNode?.node_key ?? null,
      next_step_label: nextNode?.label ?? nextNode?.node_type ?? null,
      run_status: position?.run_status ?? null,
      history_step_count: position?.step_count ?? 0,
      status: tokenStatus,
      seller: ctx.seller_display_name ?? ctx.seller_name ?? enrollment.subject_id,
      property: ctx.property_address ?? ctx.property_id ?? null,
      subject_id: enrollment.subject_id,
      context: ctx,
      next_execution_at: enrollment.next_execution_at,
      waiting_reason: enrollment.waiting_reason,
      blocker: enrollment.block_reason ?? null,
      trace_id: enrollment.workflow_run_id ?? enrollment.id,
      started_at: enrollment.enrolled_at,
    };
    tokens.push(token);

    if (current) {
      const existing = nodeStates.get(current.id) ?? {
        step_id: current.id,
        step_key: current.node_key,
        status: 'idle',
        token_count: 0,
        tokens: [],
      };
      existing.token_count += 1;
      existing.tokens.push(token);
      existing.status = tokenStatus;
      nodeStates.set(current.id, existing);
    }
  }

  return {
    ok: true,
    workflow_id: definitionId,
    tokens,
    nodes: [...nodeStates.values()],
    aggregate: {
      active: tokens.filter((t) => t.status === 'progressing').length,
      waiting: tokens.filter((t) => t.status === 'waiting').length,
      blocked: tokens.filter((t) => t.status === 'blocked').length,
    },
    updated_at: new Date().toISOString(),
  };
}

export async function getWorkflowAnalytics(definitionId, deps = {}) {
  const client = db(deps);
  const [enrollments, runs, steps] = await Promise.all([
    client.from('workflow_enrollments').select('status').eq('workflow_definition_id', definitionId),
    client.from('workflow_runs').select('status, started_at, completed_at').eq('workflow_definition_id', definitionId),
    client.from('workflow_run_steps').select('node_type, status, node_key').eq('workflow_definition_id', definitionId),
  ]);

  const summary = {
    total_enrolled: (enrollments.data ?? []).length,
    currently_active: 0,
    waiting: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    node_counts: {},
    branch_distribution: {},
  };

  for (const e of enrollments.data ?? []) {
    if (e.status === 'active') summary.currently_active += 1;
    else if (e.status === 'waiting') summary.waiting += 1;
    else if (e.status === 'completed') summary.completed += 1;
    else if (e.status === 'cancelled') summary.cancelled += 1;
    else if (e.status === 'failed') summary.failed += 1;
  }

  for (const step of steps.data ?? []) {
    const key = step.node_key ?? step.node_type;
    summary.node_counts[key] = (summary.node_counts[key] ?? 0) + 1;
    if (step.status === 'blocked') summary.blocked += 1;
  }

  return { ok: true, summary };
}

export async function cleanupObsoleteWorkflows(deps = {}) {
  const client = db(deps);
  const { data: legacy } = await client.from('workflows').select('id, workflow_key, name, status');
  const archived = [];
  const skipped = [];

  for (const row of legacy ?? []) {
    if (!isSmokeOrDuplicateLegacy(row)) continue;
    const runCount = await countRunsForWorkflow(row.id, true, deps);
    if (runCount > 0) {
      skipped.push({ id: row.id, workflow_key: row.workflow_key, reason: 'has_run_history' });
      continue;
    }
    await client.from('workflows').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', row.id);
    archived.push({ id: row.id, workflow_key: row.workflow_key });
  }

  return { ok: true, archived, skipped };
}

export async function setOperationalMode(id, mode, deps = {}) {
  const normalized = clean(mode).toLowerCase();
  if (!OPERATIONAL_MODES.includes(normalized)) {
    return { ok: false, status: 400, error: 'invalid_operational_mode', mode: normalized };
  }

  const detail = await getDefinition(id, deps);
  if (!detail.ok) return detail;
  if (detail.is_legacy) return { ok: false, status: 403, error: 'legacy_workflow_readonly' };

  if (normalized === 'live') {
    const approved = detail.definition?.metadata?.canary_approved === true;
    if (!approved) {
      return { ok: false, status: 423, error: 'canary_approval_required' };
    }
  }

  const metadata = {
    ...(detail.definition?.metadata ?? {}),
    operational_mode: normalized,
    no_send: normalized === 'active_safe' || normalized === 'test' || normalized === 'draft',
  };

  let statusPatch = {};
  if (normalized === 'paused') statusPatch = { status: 'paused' };
  if (normalized === 'live' || normalized === 'active_safe' || normalized === 'armed') statusPatch = { status: 'active' };
  if (normalized === 'archived') statusPatch = { status: 'archived' };

  return updateWorkflowStudioDraft(id, { metadata, ...statusPatch }, deps);
}

export async function dryRunWorkflowStudio(id, payload = {}, deps = {}) {
  return dryRunDefinition({ workflow_definition_id: id, workflow_id: id, ...payload }, deps);
}

export async function seedWorkflowStudioProduction(deps = {}) {
  const client = db(deps);
  const rows = getRegistryRowsForSync();
  let registryUpserted = 0;
  const registryErrors = [];

  // Batch upsert in chunks — registry sync is idempotent.
  const chunkSize = 25;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { data, error } = await client
      .from('workflow_node_registry')
      .upsert(chunk, { onConflict: 'node_type' })
      .select('node_type');
    if (error) {
      registryErrors.push(error.message ?? String(error));
      // Fallback: row-by-row for partial schema compatibility.
      for (const row of chunk) {
        const { is_system, ...safeRow } = row;
        const attempt = await client.from('workflow_node_registry').upsert(
          { ...safeRow, ...(is_system !== undefined ? { is_system } : {}) },
          { onConflict: 'node_type' },
        );
        if (!attempt.error) registryUpserted += 1;
        else registryErrors.push(`${row.node_type}:${attempt.error.message}`);
      }
    } else {
      registryUpserted += (data ?? chunk).length;
    }
  }

  const system = await seedSystemWorkflowTemplates(deps);
  const master = await seedMasterOrchestrator(deps);

  return {
    ok: registryErrors.length === 0 || registryUpserted > 0,
    registry_upserted: registryUpserted,
    registry_total: rows.length,
    registry_errors: registryErrors.slice(0, 5),
    system,
    master,
  };
}

export async function deleteWorkflowStudioDraft(id, deps = {}) {
  const detail = await getDefinition(id, deps);
  if (!detail.ok) return detail;
  if (detail.definition?.is_locked || detail.definition?.is_system_template) {
    return { ok: false, status: 403, error: 'system_template_locked' };
  }
  const runCount = await countRunsForWorkflow(id, false, deps);
  if (runCount > 0) {
    return { ok: false, status: 409, error: 'workflow_has_run_history_archive_instead' };
  }
  await db(deps).from('workflow_definitions').delete().eq('id', id);
  return { ok: true, deleted: true, workflow_id: id };
}

// Passthrough lifecycle
export const cloneWorkflowStudioDraft = cloneDefinition;
export const pauseWorkflowStudioDraft = pauseDefinition;
export const resumeWorkflowStudioDraft = resumeDefinition;
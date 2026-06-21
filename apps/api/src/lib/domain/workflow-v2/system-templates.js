// Workflow Studio V2 — locked system workflow templates.

import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

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

export const SYSTEM_WORKFLOW_TEMPLATES = Object.freeze([
  {
    key: 'delivery_recovery',
    name: 'Delivery Recovery',
    description: 'Retries transient delivery failures and routes permanent failures to suppression.',
    trigger_type: 'trigger.message_failed',
  },
  {
    key: 'inbound_classification',
    name: 'Inbound Classification',
    description: 'Classifies inbound seller messages and updates structured conversation facts.',
    trigger_type: 'trigger.inbound_message_received',
  },
  {
    key: 'ownership_verification',
    name: 'Ownership Verification',
    description: 'Confirms property ownership before advancing acquisition stages.',
    trigger_type: 'trigger.inbound_message_received',
  },
  {
    key: 'interest_qualification',
    name: 'Interest Qualification',
    description: 'Qualifies seller interest and routes to pricing or nurture paths.',
    trigger_type: 'trigger.ownership_confirmed',
  },
  {
    key: 'asking_price_extraction',
    name: 'Asking Price Extraction',
    description: 'Extracts and validates seller asking price from conversation.',
    trigger_type: 'trigger.interest_confirmed',
  },
  {
    key: 'underwriting_collection',
    name: 'Underwriting Collection',
    description: 'Collects asset-class underwriting facts with playbook-driven questions.',
    trigger_type: 'trigger.asking_price_extracted',
  },
  {
    key: 'acquisition_engine_orchestration',
    name: 'Acquisition Engine Orchestration',
    description: 'Runs acquisition engine and stores canonical offer output in context.',
    trigger_type: 'trigger.underwriting_fact_updated',
  },
  {
    key: 'offer_follow_up',
    name: 'Offer Follow-Up',
    description: 'Schedules offer-stage follow-ups and cancels on seller reply.',
    trigger_type: 'trigger.offer_sent',
  },
  {
    key: 'wrong_number_recovery',
    name: 'Wrong Number Recovery',
    description: 'Handles wrong-number replies and attempts alternate contact methods.',
    trigger_type: 'trigger.inbound_message_received',
  },
  {
    key: 'stage_aware_no_reply',
    name: 'Stage-Aware No-Reply',
    description: 'Schedules stage-aware no-reply follow-ups with cooperation adjustments.',
    trigger_type: 'trigger.follow_up_due',
  },
  {
    key: 'nurture_reactivation',
    name: 'Nurture/Reactivation',
    description: 'Long-cycle nurture cadence for latent-interest sellers.',
    trigger_type: 'trigger.pipeline_stage_changed',
  },
  {
    key: 'opt_out_suppression',
    name: 'Opt-Out/Suppression',
    description: 'Enforces opt-out and suppression guards across workflow actions.',
    trigger_type: 'trigger.inbound_message_received',
  },
  {
    key: 'human_review_escalation',
    name: 'Human Review Escalation',
    description: 'Requests operator approval before high-risk workflow actions.',
    trigger_type: 'trigger.classification_completed',
  },
]);

function buildTemplateGraph(template) {
  const triggerKey = 'trigger';
  const guardKey = 'guard';
  const actionKey = 'action';
  const exitKey = 'exit';

  return {
    nodes: [
      {
        node_key: triggerKey,
        node_kind: 'trigger',
        node_type: template.trigger_type,
        label: `${template.name} Trigger`,
        config: { system_template: template.key },
        position_x: 0,
        position_y: 0,
      },
      {
        node_key: guardKey,
        node_kind: 'guard',
        node_type: 'guard.workflow_kill_switch',
        label: 'Kill Switch Guard',
        config: {},
        position_x: 0,
        position_y: 120,
      },
      {
        node_key: actionKey,
        node_kind: 'action',
        node_type: 'action.notify_operator',
        label: `${template.name} Action`,
        config: { system_template: template.key },
        position_x: 0,
        position_y: 240,
      },
      {
        node_key: exitKey,
        node_kind: 'action',
        node_type: 'action.exit_workflow',
        label: 'Exit Workflow',
        config: {},
        position_x: 0,
        position_y: 360,
      },
    ],
    edges: [
      { source_node_key: triggerKey, target_node_key: guardKey, condition_key: null },
      { source_node_key: guardKey, target_node_key: actionKey, condition_key: null },
      { source_node_key: actionKey, target_node_key: exitKey, condition_key: null },
    ],
  };
}

export function protectSystemTemplateEdit(definition = {}) {
  if (definition?.is_locked === true || definition?.is_system_template === true) {
    return {
      ok: false,
      error: 'system_template_locked',
      message: 'Locked system workflow templates cannot be edited.',
    };
  }
  return { ok: true };
}

export async function seedSystemWorkflowTemplates(deps = {}) {
  const client = db(deps);
  const seeded = [];
  const skipped = [];

  for (const template of SYSTEM_WORKFLOW_TEMPLATES) {
    const definitionKey = `system_${normalizeKey(template.key)}`;
    const existing = await client
      .from('workflow_definitions')
      .select('*')
      .eq('definition_key', definitionKey)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (existing.data) {
      skipped.push({ definition_key: definitionKey, id: existing.data.id });
      continue;
    }

    const definitionInsert = await client
      .from('workflow_definitions')
      .insert({
        definition_key: definitionKey,
        name: template.name,
        description: template.description,
        status: 'published',
        live_send_enabled: false,
        trigger_type: template.trigger_type,
        version: 1,
        published_at: new Date().toISOString(),
        is_system_template: true,
        is_locked: true,
        metadata: {
          system_template_key: template.key,
          seeded_at: new Date().toISOString(),
        },
      })
      .select('*')
      .single();
    if (definitionInsert.error) throw definitionInsert.error;

    const definition = definitionInsert.data;
    const graph = buildTemplateGraph(template);
    const nodeIdByKey = new Map();

    for (const node of graph.nodes) {
      const nodeInsert = await client
        .from('workflow_nodes')
        .insert({
          workflow_definition_id: definition.id,
          node_key: node.node_key,
          node_kind: node.node_kind,
          node_type: node.node_type,
          label: node.label,
          config: node.config ?? {},
          position_x: node.position_x ?? 0,
          position_y: node.position_y ?? 0,
          is_active: true,
        })
        .select('*')
        .single();
      if (nodeInsert.error) throw nodeInsert.error;
      nodeIdByKey.set(node.node_key, nodeInsert.data.id);
    }

    for (const edge of graph.edges) {
      const sourceId = nodeIdByKey.get(edge.source_node_key);
      const targetId = nodeIdByKey.get(edge.target_node_key);
      if (!sourceId || !targetId) continue;
      const edgeInsert = await client.from('workflow_edges').insert({
        workflow_definition_id: definition.id,
        source_node_id: sourceId,
        target_node_id: targetId,
        condition_key: edge.condition_key ?? null,
        label: edge.condition_key ?? null,
        config: { system_template: template.key, seed_id: crypto.randomUUID().slice(0, 8) },
      });
      if (edgeInsert.error) throw edgeInsert.error;
    }

    seeded.push({ definition_key: definitionKey, id: definition.id });
  }

  return { ok: true, seeded, skipped, total: SYSTEM_WORKFLOW_TEMPLATES.length };
}

const MASTER_ORCHESTRATOR_STAGES = Object.freeze([
  { key: 'stage_0', label: 'Stage 0 — Intake & Safety', subworkflow_key: 'system_delivery_recovery' },
  { key: 'stage_1', label: 'Stage 1 — Ownership', subworkflow_key: 'system_ownership_verification' },
  { key: 'stage_2', label: 'Stage 2 — Interest', subworkflow_key: 'system_interest_qualification' },
  { key: 'stage_3', label: 'Stage 3 — Pricing', subworkflow_key: 'system_asking_price_extraction' },
  { key: 'stage_4', label: 'Stage 4 — Underwriting', subworkflow_key: 'system_underwriting_collection' },
  { key: 'stage_5', label: 'Stage 5 — Offer Engine', subworkflow_key: 'system_acquisition_engine_orchestration' },
  {
    key: 'stage_6',
    label: 'Stage 6 — Contract-to-Close',
    subworkflow_key: 'system_offer_follow_up',
    blocked: true,
    blocked_reason: 'pipeline_and_calendar_not_wired',
  },
]);

export async function seedMasterOrchestrator(deps = {}) {
  const client = db(deps);
  const definitionKey = 'system_master_acquisition_orchestrator';
  const existing = await client
    .from('workflow_definitions')
    .select('*')
    .eq('definition_key', definitionKey)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    return { ok: true, skipped: true, definition_key: definitionKey, id: existing.data.id };
  }

  const definitionInsert = await client
    .from('workflow_definitions')
    .insert({
      definition_key: definitionKey,
      name: 'Master Acquisition Orchestrator',
      description: 'Coordinates versioned acquisition subworkflows across stages 0–6.',
      status: 'published',
      live_send_enabled: false,
      trigger_type: 'trigger.manual_enrollment',
      version: 1,
      published_at: new Date().toISOString(),
      is_system_template: true,
      is_locked: true,
      metadata: {
        system_template_key: 'master_acquisition_orchestrator',
        operational_mode: 'active_safe',
        orchestrator: true,
        stages: MASTER_ORCHESTRATOR_STAGES,
      },
    })
    .select('*')
    .single();
  if (definitionInsert.error) throw definitionInsert.error;

  const definition = definitionInsert.data;
  const nodes = [
    {
      node_key: 'trigger',
      node_kind: 'trigger',
      node_type: 'trigger.manual_enrollment',
      label: 'Manual Enrollment',
      position_x: 0,
      position_y: 0,
    },
    ...MASTER_ORCHESTRATOR_STAGES.map((stage, index) => ({
      node_key: stage.key,
      node_kind: 'action',
      node_type: 'action.enroll_subworkflow',
      label: stage.label,
      config: {
        subworkflow_definition_key: stage.subworkflow_key,
        blocked: stage.blocked === true,
        blocked_reason: stage.blocked_reason ?? null,
      },
      position_x: 0,
      position_y: 120 + index * 120,
      is_active: stage.blocked !== true,
    })),
    {
      node_key: 'exit',
      node_kind: 'action',
      node_type: 'action.exit_workflow',
      label: 'Exit Orchestrator',
      position_x: 0,
      position_y: 120 + MASTER_ORCHESTRATOR_STAGES.length * 120,
    },
  ];

  const nodeIdByKey = new Map();
  for (const node of nodes) {
    const insert = await client
      .from('workflow_nodes')
      .insert({
        workflow_definition_id: definition.id,
        node_key: node.node_key,
        node_kind: node.node_kind,
        node_type: node.node_type,
        label: node.label,
        config: node.config ?? {},
        position_x: node.position_x ?? 0,
        position_y: node.position_y ?? 0,
        is_active: node.is_active !== false,
      })
      .select('*')
      .single();
    if (insert.error) throw insert.error;
    nodeIdByKey.set(node.node_key, insert.data.id);
  }

  const chain = ['trigger', ...MASTER_ORCHESTRATOR_STAGES.map((s) => s.key), 'exit'];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const sourceId = nodeIdByKey.get(chain[i]);
    const targetId = nodeIdByKey.get(chain[i + 1]);
    if (!sourceId || !targetId) continue;
    await client.from('workflow_edges').insert({
      workflow_definition_id: definition.id,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: 'next',
    });
  }

  return { ok: true, seeded: true, definition_key: definitionKey, id: definition.id };
}
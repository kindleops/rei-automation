import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { getWorkflow } from "@/lib/domain/workflows/workflow-service.js";
import { renderWorkflowTemplate } from "@/lib/domain/workflows/workflow-template-renderer.js";
import { routeWorkflowSender } from "@/lib/domain/workflows/workflow-sender-router.js";
import { writeWorkflowAuditLog } from "@/lib/domain/workflows/workflow-audit.js";
import {
  isApprovalNodeType,
  isSendNodeType,
} from "@/lib/domain/workflows/workflow-node-types.js";

function clean(value) {
  return String(value ?? "").trim();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isTriggerNodeType(nodeType) {
  return clean(nodeType).startsWith("trigger_");
}

function isWaitNodeType(nodeType) {
  return clean(nodeType) === "wait" || clean(nodeType).startsWith("wait_");
}

function isConditionNodeType(nodeType) {
  const normalized = clean(nodeType);
  return normalized === "condition" || normalized === "branch" || normalized.startsWith("condition_");
}

function envFlag(name, fallback = false) {
  const value = clean(process.env[name]).toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return fallback;
}

function defaultSampleContext() {
  return {
    conversation_thread_id: "workflow-dry-run-thread",
    first_name: "Jordan",
    seller_display_name: "Jordan Seller",
    property_address: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    market: "default",
    agent_name: "Nexus Operator",
    property_type: "SFR",
    unit_count: "1",
    asking_price: "$250,000",
    offer_price: "$210,000",
    language: "en",
  };
}

function stableChoice(rows = [], seed = "workflow-template") {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => {
    const weight = Number(row.weight);
    return sum + (Number.isFinite(weight) && weight > 0 ? weight : 1);
  }, 0);
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
  let cursor = Number.parseInt(digest, 16) % Math.max(1, Math.floor(total * 1000));
  cursor = cursor / 1000;
  for (const row of rows) {
    const weight = Number(row.weight);
    cursor -= Number.isFinite(weight) && weight > 0 ? weight : 1;
    if (cursor <= 0) return row;
  }
  return rows[0];
}

function selectTemplateVariant(detail = {}, step = {}, context = {}) {
  const config = ensureObject(step.config);
  const sets = Array.isArray(detail.template_sets) ? detail.template_sets : [];
  const set =
    sets.find((candidate) => clean(candidate.id) === clean(config.template_set_id)) ||
    sets.find((candidate) => clean(candidate.use_case) === clean(config.template_set_key)) ||
    sets.find((candidate) => clean(candidate.language) === clean(context.language || "en")) ||
    sets[0] ||
    null;
  const variants = (set?.variants || []).filter((variant) => clean(variant.status || "draft") !== "archived");
  const variant = stableChoice(
    variants,
    [
      clean(context.conversation_thread_id),
      clean(step.id || step.step_key),
      clean(set?.id),
    ].join(":")
  );
  return { template_set: set, variant };
}

async function maybeSingle(query) {
  if (typeof query?.maybeSingle === "function") return query.maybeSingle();
  if (typeof query?.single === "function") return query.single();
  return query;
}

async function createDryRunRecord({ db, workflow, context, steps, result }) {
  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  const runInsert = await maybeSingle(
    db
      .from("workflow_runs")
      .insert({
        workflow_id: workflow.id,
        conversation_thread_id: clean(context.conversation_thread_id) || null,
        property_id: clean(context.property_id) || null,
        prospect_id: clean(context.prospect_id) || null,
        master_owner_id: clean(context.master_owner_id) || null,
        current_step_id: steps[0]?.id || null,
        status: "dry_run",
        dry_run: true,
        live_send_enabled: false,
        context: {
          sample_context: context,
          warnings: result.warnings,
          live_send_blocked: true,
        },
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .select("*")
  );
  if (runInsert?.error) throw runInsert.error;
  const run = runInsert?.data;

  const eventRows = result.steps.map((step, index) => ({
    workflow_run_id: run.id,
    workflow_id: workflow.id,
    step_id: step.step_id || null,
    event_type: "workflow.dry_run.step",
    node_type: step.node_type || null,
    payload: step,
    status: step.status || "planned",
    dedupe_key: [
      "workflow-dry-run",
      run.id,
      clean(step.step_key || index),
    ].join(":"),
  }));

  if (eventRows.length) {
    const eventsInsert = await db.from("workflow_run_events").insert(eventRows).select("*");
    if (eventsInsert?.error) throw eventsInsert.error;
    return { ok: true, run, events: eventsInsert.data || [] };
  }

  return { ok: true, run, events: [] };
}

export async function dryRunWorkflow(input = {}, deps = {}) {
  const db = deps.supabase || deps.supabaseClient || input.supabase || getDefaultSupabaseClient();
  const workflow_id = clean(input.workflow_id || input.workflowId || input.id);
  const detail = await getWorkflow(workflow_id, { ...deps, supabase: db });
  if (!detail.ok) return detail;

  const workflow = detail.workflow;
  const context = {
    ...defaultSampleContext(),
    ...ensureObject(input.context || input.sample_context || input.sampleContext),
  };
  const steps = (detail.steps || []).filter((step) => step.is_active !== false);
  const warnings = [];
  const errors = [];
  const global_live_sends_enabled =
    envFlag("AUTOMATION_LIVE_SENDS_ENABLED", false) &&
    envFlag("WORKFLOW_LIVE_SENDS_ENABLED", false);

  const stepResults = [];

  for (const step of steps) {
    const base = {
      step_id: step.id,
      step_key: step.step_key,
      step_order: step.step_order,
      node_type: step.node_type,
      label: step.label,
      status: "planned",
      live_send_blocked: true,
      dry_run: true,
    };

    if (isSendNodeType(step.node_type)) {
      const { template_set, variant } = selectTemplateVariant(detail, step, context);
      const rendered = variant
        ? renderWorkflowTemplate(variant, {
            ...context,
            workflow_id: workflow.id,
            workflow_step_id: step.id,
            step_id: step.id,
          })
        : null;
      if (!variant) warnings.push(`send_node_missing_template:${step.step_key}`);

      const sender = await routeWorkflowSender({
        workflow_id: workflow.id,
        workflow,
        channel: step.node_type === "send_email" ? "email" : "sms",
        context: {
          ...context,
          step_id: step.id,
        },
      }, { supabase: db });
      if (sender.ok === false) warnings.push(`sender_route_blocked:${step.step_key}:${sender.reason}`);

      stepResults.push({
        ...base,
        template_set_id: template_set?.id || null,
        template_variant_id: variant?.id || null,
        rendered_template: rendered,
        sender_route: sender,
        actions: [
          {
            action_type: step.node_type,
            dry_run: true,
            live_enabled: false,
            live_send_blocked: true,
            block_reason: workflow.live_send_enabled === true
              ? "global_live_send_guard_disabled"
              : "workflow_live_send_enabled_false",
          },
        ],
      });
      continue;
    }

    if (isTriggerNodeType(step.node_type)) {
      stepResults.push({
        ...base,
        status: "triggered",
        trigger: {
          event_type: clean(step.config?.trigger_event || step.node_type.replace(/^trigger_/, "")),
          source: "dry_run",
        },
      });
      continue;
    }

    if (isWaitNodeType(step.node_type)) {
      stepResults.push({
        ...base,
        wait: {
          delay_amount: step.delay_amount,
          delay_unit: step.delay_unit,
          business_hours_only: step.config?.business_hours_only === true,
          timezone: step.config?.timezone || workflow.timezone || context.timezone || null,
          local_time_window: step.config?.local_time_window || null,
        },
      });
      continue;
    }

    if (isConditionNodeType(step.node_type)) {
      stepResults.push({
        ...base,
        conditions: step.conditions || {},
        stop_conditions: step.stop_conditions || {},
        true_path: step.conditions?.true_path || step.config?.true_path || null,
        false_path: step.conditions?.false_path || step.config?.false_path || null,
      });
      continue;
    }

    if (isApprovalNodeType(step.node_type)) {
      stepResults.push({
        ...base,
        approval_gate: true,
        actions: step.actions || [],
      });
      continue;
    }

    stepResults.push({
      ...base,
      actions: step.actions || [],
      conditions: step.conditions || {},
    });
  }

  if (!steps.length) warnings.push("workflow_has_no_steps");
  if (workflow.live_send_enabled !== true) warnings.push("workflow_live_send_enabled_false");
  if (!global_live_sends_enabled) warnings.push("global_live_send_guard_disabled");

  const result = {
    ok: true,
    workflow,
    selected_sample_context: context,
    dry_run: true,
    live_send_enabled: false,
    global_live_sends_enabled,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
    steps: stepResults,
    warnings: Array.from(new Set(warnings)),
    errors,
  };

  if (input.write_audit === true || input.persist === true) {
    const persisted = await createDryRunRecord({
      db,
      workflow,
      context,
      steps,
      result,
    });
    result.persisted = persisted;
    await writeWorkflowAuditLog({
      workflow_id: workflow.id,
      workflow_run_id: persisted?.run?.id || null,
      action: "workflow.dry_run",
      after: {
        step_count: stepResults.length,
        warning_count: result.warnings.length,
        live_send_blocked: true,
      },
      metadata: {
        dry_run: true,
        no_outbound_messages_sent: true,
      },
    }, { supabase: db });
  }

  return result;
}

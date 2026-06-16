import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";
import { writeWorkflowAuditLog } from "../lib/domain/workflows/workflow-audit.js";
import {
  cleanWorkflowValue as clean,
  isSupportedNodeType,
  isSupportedWorkflowChannel,
  isSupportedWorkflowStatus,
  isSupportedWorkflowType,
  normalizeWorkflowKey,
  PERSONALIZATION_TOKENS,
  TRANSLATION_LANGUAGES,
} from "../lib/domain/workflows/workflow-node-types.js";
import {
  renderWorkflowTemplate,
  renderWorkflowTemplatePreviews,
} from "../lib/domain/workflows/workflow-template-renderer.js";

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (!clean(value)) return [];
  return clean(value).split(",").map(clean).filter(Boolean);
}

function asJsonObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asJsonArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function asOptionalInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function compact(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function isMissingWorkflowSchemaError(error) {
  const code = clean(error?.code);
  const message = clean(error?.message || error?.details || error?.hint);
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (/schema cache/i.test(message) && /workflow/i.test(message)) ||
    /relation ["']?public\.workflow/i.test(message)
  );
}

function defaultWorkflowSteps() {
  return [
    {
      step_key: "new_lead_trigger",
      step_order: 10,
      node_type: "trigger_new_lead",
      label: "New Lead",
      config: {
        trigger_event: "new_lead",
        ui: { x: 120, y: 140 },
      },
    },
    {
      step_key: "send_initial_sms",
      step_order: 20,
      node_type: "send_sms",
      label: "Send SMS",
      config: {
        template_set_key: "default_owner_check",
        sender_pool_key: "default_dry_run_pool",
        language: "en",
        spin_syntax_enabled: true,
        send_window: "business_hours",
        approval_required: false,
        live_send_enabled: false,
        live_send_blocked: true,
        ui: { x: 410, y: 140 },
      },
      actions: [{ action_type: "send_sms", dry_run: true, live_enabled: false }],
    },
    {
      step_key: "wait_two_days",
      step_order: 30,
      node_type: "wait",
      label: "Wait 2 Days",
      delay_amount: 2,
      delay_unit: "days",
      config: {
        business_hours_only: true,
        timezone: "America/Chicago",
        ui: { x: 700, y: 140 },
      },
    },
    {
      step_key: "if_no_reply",
      step_order: 40,
      node_type: "condition_no_reply",
      label: "If No Reply",
      conditions: {
        field: "reply_status",
        operator: "equals",
        value: "no_reply",
        true_path: "send_follow_up_sms",
        false_path: "if_reply",
      },
      config: { ui: { x: 990, y: 140 } },
    },
    {
      step_key: "send_follow_up_sms",
      step_order: 50,
      node_type: "send_sms",
      label: "Send Follow-Up SMS",
      config: {
        template_set_key: "default_owner_check",
        sender_pool_key: "default_dry_run_pool",
        language: "en",
        spin_syntax_enabled: true,
        send_window: "business_hours",
        approval_required: false,
        live_send_enabled: false,
        live_send_blocked: true,
        ui: { x: 1280, y: 70 },
      },
      actions: [{ action_type: "send_sms", dry_run: true, live_enabled: false }],
    },
    {
      step_key: "if_reply",
      step_order: 60,
      node_type: "condition_seller_replied",
      label: "If Reply",
      conditions: {
        field: "seller_replied",
        operator: "equals",
        value: true,
        true_path: "update_stage",
        false_path: "stop_workflow",
      },
      config: { ui: { x: 1280, y: 230 } },
    },
    {
      step_key: "update_stage",
      step_order: 70,
      node_type: "update_stage",
      label: "Update Stage",
      config: {
        stage: "needs_review",
        ui: { x: 1570, y: 230 },
      },
      actions: [{ action_type: "update_stage", dry_run: true, live_enabled: false }],
    },
    {
      step_key: "create_notification",
      step_order: 80,
      node_type: "create_notification",
      label: "Create Notification",
      config: {
        notification_type: "seller_reply_review",
        priority: "high",
        ui: { x: 1860, y: 230 },
      },
      actions: [{ action_type: "create_notification", dry_run: true, live_enabled: false }],
    },
  ];
}

function workflowCreateSteps(payload = {}) {
  if (Array.isArray(payload.steps)) return payload.steps;
  if (payload.seed_defaults === false || payload.seedDefaults === false) return [];
  return defaultWorkflowSteps();
}

async function maybeSingle(query) {
  if (typeof query?.maybeSingle === "function") return query.maybeSingle();
  if (typeof query?.single === "function") return query.single();
  return query;
}

function dbFromDeps(deps = {}) {
  return deps.supabase || deps.supabaseClient || getDefaultSupabaseClient();
}

function liveSendRequested(payload = {}) {
  return payload.live_send_enabled === true || payload.liveSendEnabled === true;
}

function rejectLiveSend() {
  return {
    ok: false,
    status: 423,
    error: "workflow_live_send_disabled",
    message: "Workflow Studio foundation is dry-run/log-only. live_send_enabled cannot be enabled.",
    live_send_enabled: false,
  };
}

function workflowKeyFromPayload(payload = {}, existing = {}) {
  return (
    normalizeWorkflowKey(payload.workflow_key || payload.workflowKey || existing.workflow_key) ||
    normalizeWorkflowKey(payload.name || existing.name) ||
    `workflow_${crypto.randomUUID().slice(0, 8)}`
  );
}

export function normalizeWorkflowInput(payload = {}, existing = {}) {
  const status = clean(payload.status || existing.status || "draft") || "draft";
  const channel = clean(payload.channel || existing.channel || "sms") || "sms";
  const workflow_type =
    clean(payload.workflow_type || payload.workflowType || existing.workflow_type || "outbound") ||
    "outbound";

  return compact({
    workflow_key: workflowKeyFromPayload(payload, existing),
    name: clean(payload.name || existing.name) || "Untitled Workflow",
    description: payload.description ?? existing.description ?? null,
    channel: isSupportedWorkflowChannel(channel) ? channel : "sms",
    workflow_type: isSupportedWorkflowType(workflow_type) ? workflow_type : "outbound",
    status: isSupportedWorkflowStatus(status) ? status : "draft",
    live_send_enabled: false,
    market_scope: asArray(payload.market_scope ?? payload.marketScope ?? existing.market_scope),
    state_scope: asArray(payload.state_scope ?? payload.stateScope ?? existing.state_scope),
    property_type_scope: asArray(
      payload.property_type_scope ?? payload.propertyTypeScope ?? existing.property_type_scope
    ),
    language_scope: asArray(payload.language_scope ?? payload.languageScope ?? existing.language_scope),
    owner_type_scope: asArray(payload.owner_type_scope ?? payload.ownerTypeScope ?? existing.owner_type_scope),
    asset_type_scope: asArray(payload.asset_type_scope ?? payload.assetTypeScope ?? existing.asset_type_scope),
    daily_cap: asOptionalInteger(payload.daily_cap ?? payload.dailyCap ?? existing.daily_cap),
    hourly_cap: asOptionalInteger(payload.hourly_cap ?? payload.hourlyCap ?? existing.hourly_cap),
    timezone: clean(payload.timezone || existing.timezone) || null,
  });
}

export function normalizeWorkflowStepInput(payload = {}, existing = {}) {
  const node_type = clean(payload.node_type || payload.nodeType || existing.node_type || "wait");
  return compact({
    step_key:
      normalizeWorkflowKey(payload.step_key || payload.stepKey || existing.step_key || payload.label) ||
      `step_${crypto.randomUUID().slice(0, 8)}`,
    step_order: asOptionalInteger(payload.step_order ?? payload.stepOrder ?? existing.step_order) ?? 0,
    node_type,
    label: clean(payload.label || existing.label || node_type.replace(/_/g, " ")) || "Workflow Step",
    config: asJsonObject(payload.config ?? existing.config, {}),
    conditions: asJsonObject(payload.conditions ?? existing.conditions, {}),
    actions: asJsonArray(payload.actions ?? existing.actions, []),
    stop_conditions: asJsonObject(payload.stop_conditions ?? payload.stopConditions ?? existing.stop_conditions, {}),
    delay_amount: asOptionalInteger(payload.delay_amount ?? payload.delayAmount ?? existing.delay_amount),
    delay_unit: clean(payload.delay_unit || payload.delayUnit || existing.delay_unit) || null,
    is_active:
      typeof payload.is_active === "boolean"
        ? payload.is_active
        : typeof payload.isActive === "boolean"
          ? payload.isActive
          : existing.is_active !== false,
  });
}

export function validateWorkflowShape(workflow = {}, steps = []) {
  const errors = [];
  const warnings = [];

  if (!clean(workflow.name)) errors.push("workflow_name_required");
  if (!clean(workflow.workflow_key)) errors.push("workflow_key_required");
  if (!isSupportedWorkflowChannel(workflow.channel || "sms")) errors.push("unsupported_workflow_channel");
  if (!isSupportedWorkflowType(workflow.workflow_type || "outbound")) errors.push("unsupported_workflow_type");
  if (!isSupportedWorkflowStatus(workflow.status || "draft")) errors.push("unsupported_workflow_status");
  if (workflow.live_send_enabled === true) errors.push("workflow_live_send_enabled_must_remain_false");

  for (const step of Array.isArray(steps) ? steps : []) {
    if (!isSupportedNodeType(step.node_type)) {
      errors.push(`unsupported_node_type:${clean(step.node_type) || "unknown"}`);
    }
    if (clean(step.node_type).startsWith("send_") && step.actions?.some((action) => action?.live_enabled === true)) {
      errors.push(`step_live_send_enabled:${clean(step.step_key || step.id)}`);
    }
  }

  if (!steps.length) warnings.push("workflow_has_no_steps");
  return { ok: errors.length === 0, errors, warnings };
}

export async function listWorkflows(deps = {}) {
  const supabase = dbFromDeps(deps);
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingWorkflowSchemaError(error)) {
      return {
        ok: true,
        workflows: [],
        schema_ready: false,
        schema_error: "workflow_schema_missing_or_stale",
      };
    }
    throw error;
  }

  const workflows = data || [];
  const ids = workflows.map((workflow) => workflow.id).filter(Boolean);
  let steps = [];
  if (ids.length) {
    const stepResult = await supabase
      .from("workflow_steps")
      .select("id,workflow_id,node_type,is_active")
      .in("workflow_id", ids)
      .limit(5000);
    if (!stepResult.error) steps = stepResult.data || [];
  }

  return {
    ok: true,
    workflows: workflows.map((workflow) => ({
      ...workflow,
      live_send_enabled: false,
      step_count: steps.filter((step) => step.workflow_id === workflow.id).length,
      send_node_count: steps.filter((step) =>
        step.workflow_id === workflow.id && clean(step.node_type).startsWith("send_")
      ).length,
    })),
  };
}

export async function getWorkflow(workflowIdOrKey, deps = {}) {
  const supabase = dbFromDeps(deps);
  const identifier = clean(workflowIdOrKey);
  if (!identifier) return { ok: false, status: 400, error: "workflow_id_required" };

  let result = await maybeSingle(supabase.from("workflows").select("*").eq("id", identifier));
  if (!result?.data && !result?.error) {
    result = await maybeSingle(supabase.from("workflows").select("*").eq("workflow_key", identifier));
  }
  if (result?.error) throw result.error;
  if (!result?.data) return { ok: false, status: 404, error: "workflow_not_found" };

  const workflow = { ...result.data, live_send_enabled: false };
  const [
    stepsResult,
    templateSetsResult,
    senderPoolsResult,
    runsResult,
    auditResult,
  ] = await Promise.all([
    supabase.from("workflow_steps").select("*").eq("workflow_id", workflow.id).order("step_order", { ascending: true }),
    supabase.from("workflow_template_sets").select("*").eq("workflow_id", workflow.id).order("created_at", { ascending: true }),
    supabase.from("workflow_sender_pools").select("*").eq("workflow_id", workflow.id).order("created_at", { ascending: true }),
    supabase.from("workflow_runs").select("*").eq("workflow_id", workflow.id).order("created_at", { ascending: false }).limit(20),
    supabase.from("workflow_audit_log").select("*").eq("workflow_id", workflow.id).order("created_at", { ascending: false }).limit(50),
  ]);

  const templateSets = templateSetsResult.data || [];
  const senderPools = senderPoolsResult.data || [];
  const templateSetIds = templateSets.map((set) => set.id).filter(Boolean);
  const senderPoolIds = senderPools.map((pool) => pool.id).filter(Boolean);

  let variants = [];
  let translations = [];
  let senderMembers = [];

  if (templateSetIds.length) {
    const variantResult = await supabase
      .from("workflow_template_variants")
      .select("*")
      .in("template_set_id", templateSetIds)
      .order("created_at", { ascending: true });
    if (!variantResult.error) variants = variantResult.data || [];
    const variantIds = variants.map((variant) => variant.id).filter(Boolean);
    if (variantIds.length) {
      const translationResult = await supabase
        .from("workflow_template_translations")
        .select("*")
        .in("source_variant_id", variantIds)
        .order("created_at", { ascending: true });
      if (!translationResult.error) translations = translationResult.data || [];
    }
  }

  if (senderPoolIds.length) {
    const memberResult = await supabase
      .from("workflow_sender_pool_members")
      .select("*")
      .in("sender_pool_id", senderPoolIds)
      .order("created_at", { ascending: true });
    if (!memberResult.error) senderMembers = memberResult.data || [];
  }

  return {
    ok: true,
    workflow,
    validation: validateWorkflowShape(workflow, stepsResult.data || []),
    steps: stepsResult.data || [],
    template_sets: templateSets.map((set) => ({
      ...set,
      variants: variants
        .filter((variant) => variant.template_set_id === set.id)
        .map((variant) => ({
          ...variant,
          translations: translations.filter((translation) => translation.source_variant_id === variant.id),
        })),
    })),
    sender_pools: senderPools.map((pool) => ({
      ...pool,
      members: senderMembers.filter((member) => member.sender_pool_id === pool.id),
    })),
    runs: runsResult.data || [],
    audit: auditResult.data || [],
    translation_languages: TRANSLATION_LANGUAGES,
    personalization_tokens: PERSONALIZATION_TOKENS,
  };
}

export async function createWorkflow(payload = {}, deps = {}) {
  if (liveSendRequested(payload)) return rejectLiveSend();
  const supabase = dbFromDeps(deps);
  const row = normalizeWorkflowInput(payload);
  const stepsToCreate = workflowCreateSteps(payload);
  const validation = validateWorkflowShape(row, stepsToCreate);
  if (!validation.ok) return { ok: false, status: 400, error: "workflow_invalid", validation };

  let insert = await supabase.from("workflows").insert(row).select("*").single();
  if (insert.error?.code === "23505" && !clean(payload.workflow_key || payload.workflowKey)) {
    row.workflow_key = `${row.workflow_key}_${Date.now().toString(36)}`;
    insert = await supabase.from("workflows").insert(row).select("*").single();
  }
  if (insert.error) throw insert.error;
  const data = insert.data;

  await writeWorkflowAuditLog({
    workflow_id: data.id,
    action: "workflow.created",
    after: data,
    metadata: { workflow_key: data.workflow_key },
  }, deps);

  for (const step of stepsToCreate) {
    await createWorkflowStep(data.id, step, deps);
  }

  if (stepsToCreate.length && payload.seed_defaults !== false && payload.seedDefaults !== false) {
    const templateSet = await createWorkflowTemplateSet(data.id, {
      name: "Default Owner Check",
      channel: data.channel === "multichannel" ? "sms" : data.channel,
      language: data.language_scope?.[0] || "en",
      use_case: "default_owner_check",
      stage_code: "S1",
      rotation_mode: "weighted",
    }, deps);
    if (templateSet.ok) {
      await createWorkflowTemplateVariant(templateSet.template_set_id, {
        variant_key: "initial_owner_check",
        language: data.language_scope?.[0] || "en",
        body:
          "Hi {first_name}, this is {agent_name}. I was checking on {property_address} in {market}. {Are you the owner?|Do I have the right owner?}",
        spin_syntax_enabled: true,
        personalization_tokens: ["first_name", "agent_name", "property_address", "market"],
        status: "draft",
      }, deps);
    }

    const senderPool = await createWorkflowSenderPool(data.id, {
      pool_key: "default_dry_run_pool",
      name: "Default Dry-Run SMS Pool",
      channel: "sms",
      market_scope: data.market_scope?.length ? data.market_scope : ["default"],
      state_scope: data.state_scope || [],
      language_scope: data.language_scope?.length ? data.language_scope : ["en"],
      routing_mode: "exact_market",
      daily_cap: data.daily_cap || 75,
      hourly_cap: data.hourly_cap || 15,
      health_thresholds: {
        max_failure_rate: 0.05,
        max_opt_out_rate: 0.012,
      },
    }, deps);
    if (senderPool.ok) {
      await createWorkflowSenderPoolMember(senderPool.sender_pool_id, {
        sender_value: "+15550001000",
        sender_label: "Dry-Run Sender",
        weight: 1,
        daily_cap: 75,
        hourly_cap: 15,
        status: "active",
      }, deps);
    }
  }

  return { ok: true, workflow: { ...data, live_send_enabled: false }, workflow_id: data.id };
}

export async function updateWorkflow(workflowId, payload = {}, deps = {}) {
  if (liveSendRequested(payload)) return rejectLiveSend();
  const current = await getWorkflow(workflowId, deps);
  if (!current.ok) return current;
  const supabase = dbFromDeps(deps);
  const patch = normalizeWorkflowInput(payload, current.workflow);
  delete patch.workflow_key;
  patch.live_send_enabled = false;
  const validation = validateWorkflowShape({ ...current.workflow, ...patch }, current.steps);
  if (!validation.ok) return { ok: false, status: 400, error: "workflow_invalid", validation };

  const { data, error } = await supabase
    .from("workflows")
    .update(patch)
    .eq("id", current.workflow.id)
    .select("*")
    .single();
  if (error) throw error;

  await writeWorkflowAuditLog({
    workflow_id: data.id,
    action: "workflow.updated",
    before: current.workflow,
    after: data,
    metadata: { patch_keys: Object.keys(payload || {}) },
  }, deps);
  return { ok: true, workflow: { ...data, live_send_enabled: false }, workflow_id: data.id };
}

export async function cloneWorkflow(workflowId, payload = {}, deps = {}) {
  if (liveSendRequested(payload)) return rejectLiveSend();
  const source = await getWorkflow(workflowId, deps);
  if (!source.ok) return source;
  const supabase = dbFromDeps(deps);
  const clonePayload = {
    ...source.workflow,
    ...payload,
    name: clean(payload.name) || `${source.workflow.name} Copy`,
    workflow_key:
      normalizeWorkflowKey(payload.workflow_key || payload.workflowKey) ||
      `${normalizeWorkflowKey(source.workflow.workflow_key)}_copy_${Date.now().toString(36)}`,
    status: "draft",
    live_send_enabled: false,
  };
  const created = await createWorkflow(clonePayload, deps);
  if (!created.ok) return created;
  const newWorkflowId = created.workflow_id;

  for (const step of source.steps || []) {
    const { id, workflow_id, created_at, updated_at, ...copy } = step;
    await supabase.from("workflow_steps").insert({ ...copy, workflow_id: newWorkflowId }).select("*").maybeSingle();
  }

  for (const set of source.template_sets || []) {
    const { id, workflow_id, created_at, updated_at, variants = [], ...setCopy } = set;
    const setResult = await maybeSingle(
      supabase.from("workflow_template_sets").insert({ ...setCopy, workflow_id: newWorkflowId }).select("*")
    );
    if (setResult?.error) throw setResult.error;
    for (const variant of variants) {
      const { id: variantId, template_set_id, created_at, updated_at, translations = [], ...variantCopy } = variant;
      const variantResult = await maybeSingle(
        supabase
          .from("workflow_template_variants")
          .insert({ ...variantCopy, template_set_id: setResult.data.id })
          .select("*")
      );
      if (variantResult?.error) throw variantResult.error;
      for (const translation of translations) {
        const { id: translationId, source_variant_id, created_at, updated_at, ...translationCopy } = translation;
        await supabase
          .from("workflow_template_translations")
          .insert({ ...translationCopy, source_variant_id: variantResult.data.id });
      }
    }
  }

  for (const pool of source.sender_pools || []) {
    const { id, workflow_id, created_at, updated_at, members = [], ...poolCopy } = pool;
    const poolResult = await maybeSingle(
      supabase.from("workflow_sender_pools").insert({ ...poolCopy, workflow_id: newWorkflowId }).select("*")
    );
    if (poolResult?.error) throw poolResult.error;
    for (const member of members) {
      const { id: memberId, sender_pool_id, created_at, updated_at, ...memberCopy } = member;
      await supabase
        .from("workflow_sender_pool_members")
        .insert({ ...memberCopy, sender_pool_id: poolResult.data.id });
    }
  }

  await writeWorkflowAuditLog({
    workflow_id: newWorkflowId,
    action: "workflow.cloned",
    after: { source_workflow_id: source.workflow.id, workflow_id: newWorkflowId },
  }, deps);

  return getWorkflow(newWorkflowId, deps);
}

export async function pauseWorkflow(workflowId, deps = {}) {
  return updateWorkflow(workflowId, { status: "paused", live_send_enabled: false }, deps);
}

export async function resumeWorkflow(workflowId, deps = {}) {
  return updateWorkflow(workflowId, { status: "active", live_send_enabled: false }, deps);
}

export async function listWorkflowSteps(workflowId, deps = {}) {
  const supabase = dbFromDeps(deps);
  const { data, error } = await supabase
    .from("workflow_steps")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("step_order", { ascending: true });
  if (error) throw error;
  return { ok: true, steps: data || [] };
}

export async function createWorkflowStep(workflowId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const row = { ...normalizeWorkflowStepInput(payload), workflow_id: workflowId };
  if (!isSupportedNodeType(row.node_type)) {
    return { ok: false, status: 400, error: "unsupported_node_type", node_type: row.node_type };
  }
  const { data, error } = await supabase.from("workflow_steps").insert(row).select("*").single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: workflowId,
    action: "workflow.step.created",
    after: data,
    metadata: { node_type: data.node_type, step_key: data.step_key },
  }, deps);
  return { ok: true, step: data, step_id: data.id };
}

export async function updateWorkflowStep(stepId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const current = await maybeSingle(supabase.from("workflow_steps").select("*").eq("id", stepId));
  if (current?.error) throw current.error;
  if (!current?.data) return { ok: false, status: 404, error: "workflow_step_not_found" };
  const patch = normalizeWorkflowStepInput(payload, current.data);
  if (!isSupportedNodeType(patch.node_type)) {
    return { ok: false, status: 400, error: "unsupported_node_type", node_type: patch.node_type };
  }
  delete patch.step_key;
  const { data, error } = await supabase
    .from("workflow_steps")
    .update(patch)
    .eq("id", stepId)
    .select("*")
    .single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: data.workflow_id,
    action: "workflow.step.updated",
    before: current.data,
    after: data,
    metadata: { node_type: data.node_type, step_key: data.step_key },
  }, deps);
  return { ok: true, step: data, step_id: data.id };
}

export async function listWorkflowTemplateSets(workflowId, deps = {}) {
  const detail = await getWorkflow(workflowId, deps);
  if (!detail.ok) return detail;
  return { ok: true, template_sets: detail.template_sets };
}

export async function createWorkflowTemplateSet(workflowId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const row = {
    workflow_id: workflowId,
    name: clean(payload.name) || "Workflow Templates",
    channel: clean(payload.channel || "sms") || "sms",
    language: clean(payload.language || "en") || "en",
    use_case: clean(payload.use_case || payload.useCase) || null,
    stage_code: clean(payload.stage_code || payload.stageCode) || null,
    rotation_mode: clean(payload.rotation_mode || payload.rotationMode || "weighted") || "weighted",
    is_active: payload.is_active !== false,
  };
  const { data, error } = await supabase.from("workflow_template_sets").insert(row).select("*").single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: workflowId,
    action: "workflow.template_set.created",
    after: data,
  }, deps);
  return { ok: true, template_set: data, template_set_id: data.id };
}

export async function createWorkflowTemplateVariant(templateSetId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const set = await maybeSingle(supabase.from("workflow_template_sets").select("*").eq("id", templateSetId));
  if (set?.error) throw set.error;
  if (!set?.data) return { ok: false, status: 404, error: "workflow_template_set_not_found" };
  const row = {
    template_set_id: templateSetId,
    sms_template_id: payload.sms_template_id || payload.smsTemplateId || null,
    email_template_id: payload.email_template_id || payload.emailTemplateId || null,
    variant_key:
      normalizeWorkflowKey(payload.variant_key || payload.variantKey || payload.name) ||
      `variant_${crypto.randomUUID().slice(0, 8)}`,
    language: clean(payload.language || set.data.language || "en") || "en",
    subject: clean(payload.subject) || null,
    body: String(payload.body ?? ""),
    weight: Number.isFinite(Number(payload.weight)) ? Number(payload.weight) : 1,
    spin_syntax_enabled: payload.spin_syntax_enabled !== false && payload.spinSyntaxEnabled !== false,
    personalization_tokens: asJsonArray(payload.personalization_tokens ?? payload.personalizationTokens, []),
    status: clean(payload.status || "draft") || "draft",
  };
  if (!clean(row.body)) return { ok: false, status: 400, error: "template_body_required" };

  const { data, error } = await supabase.from("workflow_template_variants").insert(row).select("*").single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: set.data.workflow_id,
    action: "workflow.template_variant.created",
    after: data,
    metadata: { template_set_id: templateSetId },
  }, deps);
  return { ok: true, variant: data, variant_id: data.id };
}

export async function renderTemplateVariantTest(variantId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const variant = await maybeSingle(supabase.from("workflow_template_variants").select("*").eq("id", variantId));
  if (variant?.error) throw variant.error;
  if (!variant?.data) return { ok: false, status: 404, error: "workflow_template_variant_not_found" };
  const context = ensureObject(payload.context);
  const preview_count = Number(payload.preview_count || payload.previewCount || 10);
  return {
    ok: true,
    variant: variant.data,
    rendered: renderWorkflowTemplate(variant.data, context),
    previews: renderWorkflowTemplatePreviews(variant.data, context, preview_count),
  };
}

export async function upsertWorkflowTemplateTranslation(variantId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const variant = await maybeSingle(supabase.from("workflow_template_variants").select("*").eq("id", variantId));
  if (variant?.error) throw variant.error;
  if (!variant?.data) return { ok: false, status: 404, error: "workflow_template_variant_not_found" };
  const row = {
    source_variant_id: variantId,
    language: clean(payload.language || "custom") || "custom",
    translated_subject: clean(payload.translated_subject || payload.translatedSubject) || null,
    translated_body: String(payload.translated_body ?? payload.translatedBody ?? ""),
    translation_status:
      clean(payload.translation_status || payload.translationStatus || "pending") || "pending",
  };
  if (!clean(row.translated_body)) return { ok: false, status: 400, error: "translated_body_required" };
  const result = await maybeSingle(
    supabase
      .from("workflow_template_translations")
      .upsert(row, { onConflict: "source_variant_id,language" })
      .select("*")
  );
  if (result?.error) throw result.error;
  return { ok: true, translation: result?.data || row };
}

export async function listWorkflowSenderPools(workflowId, deps = {}) {
  const detail = await getWorkflow(workflowId, deps);
  if (!detail.ok) return detail;
  return { ok: true, sender_pools: detail.sender_pools };
}

export async function createWorkflowSenderPool(workflowId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const row = {
    workflow_id: workflowId,
    pool_key:
      normalizeWorkflowKey(payload.pool_key || payload.poolKey || payload.name) ||
      `pool_${crypto.randomUUID().slice(0, 8)}`,
    name: clean(payload.name) || "Workflow Sender Pool",
    channel: clean(payload.channel || "sms") || "sms",
    market_scope: asArray(payload.market_scope ?? payload.marketScope),
    state_scope: asArray(payload.state_scope ?? payload.stateScope),
    language_scope: asArray(payload.language_scope ?? payload.languageScope),
    routing_mode: clean(payload.routing_mode || payload.routingMode || "exact_market") || "exact_market",
    daily_cap: asOptionalInteger(payload.daily_cap ?? payload.dailyCap),
    hourly_cap: asOptionalInteger(payload.hourly_cap ?? payload.hourlyCap),
    health_thresholds: asJsonObject(payload.health_thresholds ?? payload.healthThresholds, {}),
    is_active: payload.is_active !== false,
  };
  const { data, error } = await supabase.from("workflow_sender_pools").insert(row).select("*").single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: workflowId,
    action: "workflow.sender_pool.created",
    after: data,
  }, deps);
  return { ok: true, sender_pool: data, sender_pool_id: data.id };
}

export async function createWorkflowSenderPoolMember(senderPoolId, payload = {}, deps = {}) {
  const supabase = dbFromDeps(deps);
  const pool = await maybeSingle(supabase.from("workflow_sender_pools").select("*").eq("id", senderPoolId));
  if (pool?.error) throw pool.error;
  if (!pool?.data) return { ok: false, status: 404, error: "workflow_sender_pool_not_found" };
  const row = {
    sender_pool_id: senderPoolId,
    textgrid_number_id: clean(payload.textgrid_number_id || payload.textgridNumberId) || null,
    email_sender_id: clean(payload.email_sender_id || payload.emailSenderId) || null,
    sender_value: clean(payload.sender_value || payload.senderValue) || null,
    sender_label: clean(payload.sender_label || payload.senderLabel) || null,
    weight: Number.isFinite(Number(payload.weight)) ? Number(payload.weight) : 1,
    daily_cap: asOptionalInteger(payload.daily_cap ?? payload.dailyCap),
    hourly_cap: asOptionalInteger(payload.hourly_cap ?? payload.hourlyCap),
    status: clean(payload.status || "active") || "active",
  };
  if (!row.sender_value) return { ok: false, status: 400, error: "sender_value_required" };
  const { data, error } = await supabase
    .from("workflow_sender_pool_members")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  await writeWorkflowAuditLog({
    workflow_id: pool.data.workflow_id,
    action: "workflow.sender_pool_member.created",
    after: data,
    metadata: { sender_pool_id: senderPoolId },
  }, deps);
  return { ok: true, member: data, member_id: data.id };
}

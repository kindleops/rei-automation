import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";
import { normalizeUsPhoneToE164 } from "../lib/sms/sanitize.js";
import { scheduleFollowUp } from "../lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  AUTOMATION_LOG_TAGS,
  logAutomationConsole,
  writeAutomationAuditLog,
} from "../lib/domain/automation/automation-audit.js";
import { hashAutomationPayload } from "../lib/domain/automation/automation-events.js";

const ACTIVE_QUEUE_STATUSES = [
  "queued",
  "pending",
  "scheduled",
  "ready",
  "runnable",
  "sending",
  "processing",
  "approval",
  "pending_approval",
];

const SEND_CAPABLE_ACTION_TYPES = new Set([
  "send_sms",
  "send_email",
  "send_rvm",
  "send_direct_mail",
  "send_message",
  "send_outbound_message",
  "enqueue_sms",
  "enqueue_email",
  "schedule_follow_up",
  "dry_run_schedule_followup",
  "dry_run_schedule_follow_up",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizePhone(value) {
  return normalizeUsPhoneToE164(value) || clean(value) || null;
}

function payloadOf(event = {}) {
  return ensureObject(event.payload);
}

function eventEntityPatch(event = {}) {
  return {
    conversation_thread_id: clean(event.conversation_thread_id) || null,
    property_id: clean(event.property_id) || null,
    prospect_id: clean(event.prospect_id) || null,
    master_owner_id: clean(event.master_owner_id) || null,
    phone_number_id: clean(event.phone_number_id) || null,
    queue_item_id: clean(event.queue_item_id) || null,
  };
}

function workflowContextPatch(event = {}, rule = {}, action = {}) {
  const event_payload = payloadOf(event);
  return {
    workflow_id:
      clean(action.workflow_id || event.workflow_id || rule.workflow_id || event_payload.workflow_id) ||
      null,
    workflow_run_id: clean(action.workflow_run_id || event.workflow_run_id || event_payload.workflow_run_id) || null,
    workflow_step_id:
      clean(
        action.workflow_step_id ||
          event.workflow_step_id ||
          rule.workflow_step_id ||
          event_payload.workflow_step_id
      ) || null,
    channel:
      clean(action.channel || event.channel || rule.channel || event_payload.channel || event_payload.provider) ||
      null,
    node_type: clean(action.node_type || event.node_type || rule.node_type || event_payload.node_type) || null,
  };
}

function isMissingTargetError(error = null) {
  const code = clean(error?.code);
  const message = clean(error?.message).toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    /relation .* does not exist/.test(message) ||
    /column .* does not exist/.test(message) ||
    /schema cache/.test(message)
  );
}

function skippedMissingTarget(table, error = null, extra = {}) {
  return {
    ok: true,
    skipped: true,
    reason: "target_schema_unavailable",
    target_table: table,
    error: error?.message || null,
    ...extra,
  };
}

function resolvePhoneE164(event = {}, params = {}) {
  const payload = payloadOf(event);
  return normalizePhone(
    params.phone_e164 ||
      params.phone_number ||
      event.phone_e164 ||
      payload.phone_e164 ||
      payload.canonical_e164 ||
      payload.inbound_from ||
      payload.from_phone_number ||
      payload.from ||
      payload.seller_phone ||
      payload.to_phone_number ||
      payload.to
  );
}

function buildThreadKey(event = {}, params = {}) {
  const payload = payloadOf(event);
  const explicit =
    clean(params.thread_key) ||
    clean(event.conversation_thread_id) ||
    clean(payload.thread_key) ||
    clean(payload.conversation_thread_id);
  if (explicit) return explicit;
  return resolvePhoneE164(event, params);
}

function buildActionDedupeKey({ event = {}, rule = {}, action = {} } = {}) {
  return [
    "automation-action",
    clean(event.dedupe_key || event.id),
    clean(rule.rule_key),
    clean(action.action_type),
    hashAutomationPayload(action.params || {}),
  ].join(":");
}

function actionDryRun({ action = {}, rule = {}, engine_dry_run = null } = {}) {
  if (typeof action.dry_run === "boolean") return action.dry_run;
  if (typeof engine_dry_run === "boolean") return engine_dry_run;
  return rule.dry_run_default !== false;
}

function actionLiveEnabled({ action = {}, rule = {}, options = {} } = {}) {
  return (
    action.live_enabled === true ||
    action.liveEnabled === true ||
    rule.live_enabled === true ||
    rule.liveEnabled === true ||
    options.live_enabled === true
  );
}

function liveSendBlockedResult({ event = {}, action = {}, reason = "automation_live_send_blocked" } = {}) {
  logAutomationConsole(AUTOMATION_LOG_TAGS.live_send_blocked, {
    event_type: event.event_type || null,
    action_type: action.action_type || null,
    reason,
  });
  return {
    ok: true,
    skipped: true,
    dry_run: true,
    planned: true,
    reason,
    live_send_blocked: true,
  };
}

function canRunLiveSend({ event = {}, rule = {}, action = {}, options = {} } = {}) {
  if (!SEND_CAPABLE_ACTION_TYPES.has(action.action_type)) return true;
  if (actionLiveEnabled({ action, rule, options }) !== true) {
    return liveSendBlockedResult({
      event,
      action,
      reason: "action_live_enabled_false",
    });
  }
  if (options.global_live_sends_enabled !== true) {
    return liveSendBlockedResult({
      event,
      action,
      reason: "global_live_send_guard_disabled",
    });
  }
  return true;
}

function compact(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

async function maybeSingle(query) {
  if (typeof query?.maybeSingle === "function") return query.maybeSingle();
  if (typeof query?.single === "function") return query.single();
  return query;
}

async function createAutomationActionRecord({
  db,
  event,
  run,
  rule,
  action,
  dry_run,
} = {}) {
  const dedupe_key = buildActionDedupeKey({ event, rule, action });

  if (!db?.from) {
    return {
      ok: true,
      record: {
        id: null,
        dedupe_key,
        action_type: action.action_type,
        dry_run,
        status: "running",
      },
      skipped_persist: true,
    };
  }

  const existing_result = await maybeSingle(
    db.from("automation_actions").select("*").eq("dedupe_key", dedupe_key)
  );

  if (existing_result?.data?.id) {
    return {
      ok: true,
      duplicate: true,
      record: existing_result.data,
    };
  }

  const row = compact({
    automation_event_id: event.id || null,
    automation_run_id: run.id || null,
    rule_id: rule.id || null,
    rule_key: rule.rule_key || null,
    event_type: event.event_type || null,
    action_type: action.action_type,
    status: "running",
    dedupe_key,
    dry_run,
    live_enabled: actionLiveEnabled({ action, rule }),
    ...workflowContextPatch(event, rule, action),
    ...eventEntityPatch(event),
    input: {
      params: ensureObject(action.params),
      event_payload: payloadOf(event),
    },
    payload: {
      params: ensureObject(action.params),
      event_payload: payloadOf(event),
    },
    run_started_at: nowIso(),
  });

  const insert_result = await maybeSingle(
    db.from("automation_actions").insert(row).select()
  );

  if (insert_result?.error) throw insert_result.error;
  return { ok: true, record: insert_result?.data || row };
}

async function updateAutomationActionRecord(db, action_id, patch = {}) {
  if (!db?.from || !action_id) return { ok: true, skipped: true };
  const result = await maybeSingle(
    db.from("automation_actions").update(patch).eq("id", action_id).select()
  );
  if (result?.error) return { ok: false, error: result.error.message };
  return { ok: true, record: result?.data || null };
}

async function upsertAutomationSuppression({ db, event, action, params, dry_run } = {}) {
  const phone_e164 = resolvePhoneE164(event, params);
  if (!phone_e164) {
    return { ok: false, skipped: true, reason: "missing_phone" };
  }

  const suppression_type = clean(params.suppression_type) || clean(params.reason) || "suppressed";
  const suppression_reason =
    clean(params.suppression_reason) || clean(params.reason) || suppression_type;
  const dedupe_key = [
    "automation-suppression",
    phone_e164,
    suppression_type,
  ].join(":");

  const row = {
    event_type: event.event_type || null,
    action_type: action.action_type,
    rule_key: action.rule_key || params.rule_key || null,
    status: "active",
    suppression_type,
    suppression_reason,
    dedupe_key,
    ...eventEntityPatch(event),
    phone_e164,
    source_event_id: event.id || null,
    payload: {
      dry_run,
      event_payload: payloadOf(event),
      params,
    },
    suppressed_at: nowIso(),
  };

  if (dry_run) {
    return { ok: true, dry_run: true, suppression: row };
  }

  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  const suppression_result = await maybeSingle(
    db
      .from("automation_suppressions")
      .upsert(row, { onConflict: "dedupe_key" })
      .select()
  );
  if (suppression_result?.error) {
    if (isMissingTargetError(suppression_result.error)) {
      return skippedMissingTarget("automation_suppressions", suppression_result.error, {
        intended_row: row,
      });
    }
    return {
      ok: false,
      suppression: row,
      error: suppression_result.error.message || "automation_suppression_failed",
    };
  }

  const mirror_results = [];

  if (suppression_type === "wrong_number") {
    let phone_query = db.from("phones").update({
      phone_contact_status: "wrong_number",
      wrong_number_at: nowIso(),
      wrong_number_source_thread_key: buildThreadKey(event, params),
    });

    if (clean(event.phone_number_id)) {
      phone_query = phone_query.eq("id", event.phone_number_id);
    } else {
      phone_query = phone_query.eq("canonical_e164", phone_e164);
    }

    const phone_result = await phone_query;
    mirror_results.push({
      table: "phones",
      ok: !phone_result?.error,
      skipped: isMissingTargetError(phone_result?.error),
      reason: isMissingTargetError(phone_result?.error) ? "target_schema_unavailable" : null,
      error: phone_result?.error?.message || null,
    });
  } else {
    const sms_result = await db.from("sms_suppression_list").upsert(
      {
        phone_number: phone_e164,
        phone_e164,
        suppression_reason,
        suppression_type,
        is_active: true,
        suppressed_at: nowIso(),
        source: "automation_engine",
      },
      { onConflict: "phone_number,suppression_type" }
    );
    mirror_results.push({
      table: "sms_suppression_list",
      ok: !sms_result?.error,
      skipped: isMissingTargetError(sms_result?.error),
      reason: isMissingTargetError(sms_result?.error) ? "target_schema_unavailable" : null,
      error: sms_result?.error?.message || null,
    });
  }

  return {
    ok: true,
    suppression: suppression_result?.data || row,
    mirror_results,
    error: null,
  };
}

async function cancelPendingQueue({ db, event, params, dry_run } = {}) {
  const phone_e164 = resolvePhoneE164(event, params);
  const queue_item_id = clean(params.queue_item_id || event.queue_item_id);
  const reason = clean(params.reason) || "automation_cancel_pending_queue";

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      planned: true,
      reason,
      queue_item_id: queue_item_id || null,
      phone_e164,
    };
  }

  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  let select_query = db
    .from("send_queue")
    .select("id,queue_status")
    .in("queue_status", ACTIVE_QUEUE_STATUSES)
    .limit(500);

  if (queue_item_id) {
    select_query = db.from("send_queue").select("id,queue_status").eq("id", queue_item_id).limit(1);
  } else if (phone_e164) {
    select_query = select_query.eq("to_phone_number", phone_e164);
  } else if (clean(event.master_owner_id)) {
    select_query = select_query.eq("master_owner_id", event.master_owner_id);
  } else {
    return { ok: true, skipped: true, reason: "missing_queue_filter", canceled_count: 0 };
  }

  if (!queue_item_id && clean(event.master_owner_id) && phone_e164) {
    select_query = select_query.eq("master_owner_id", event.master_owner_id);
  }

  const { data, error } = await select_query;
  if (error) {
    if (isMissingTargetError(error)) return skippedMissingTarget("send_queue", error);
    return { ok: false, reason: "queue_select_failed", error: error.message };
  }

  const ids = (Array.isArray(data) ? data : [])
    .map((row) => clean(row?.id))
    .filter(Boolean);

  if (!ids.length) {
    return { ok: true, canceled_count: 0, reason: "no_cancelable_queue_items" };
  }

  const update_payload = {
    queue_status: "cancelled",
    safety_status: "blocked",
    guard_status: "blocked",
    guard_reason: reason,
    failed_reason: reason,
    updated_at: nowIso(),
  };

  const update_result = await db.from("send_queue").update(update_payload).in("id", ids);
  if (isMissingTargetError(update_result?.error)) {
    return skippedMissingTarget("send_queue", update_result.error, {
      intended_patch: update_payload,
      queue_item_ids: ids,
    });
  }

  return {
    ok: !update_result?.error,
    canceled_count: update_result?.error ? 0 : ids.length,
    queue_item_ids: ids,
    reason,
    error: update_result?.error?.message || null,
  };
}

async function patchThreadState({ db, event, params, dry_run } = {}) {
  const thread_key = buildThreadKey(event, params);
  if (!thread_key) return { ok: false, skipped: true, reason: "missing_thread_key" };

  const payload = payloadOf(event);
  const metadata_patch = ensureObject(params.metadata);
  let existing_metadata = {};

  if (!dry_run && db?.from) {
    const existing = await maybeSingle(
      db.from("inbox_thread_state").select("thread_key,metadata").eq("thread_key", thread_key)
    );
    if (!existing?.error) {
      existing_metadata = ensureObject(existing?.data?.metadata);
    }
  }

  const row = compact({
    thread_key,
    master_owner_id: clean(event.master_owner_id) || null,
    prospect_id: clean(event.prospect_id) || null,
    property_id: clean(event.property_id) || null,
    canonical_e164: resolvePhoneE164(event, params),
    seller_phone: resolvePhoneE164(event, params),
    market: clean(payload.market) || null,
    status: clean(params.status) || undefined,
    stage: clean(params.stage) || undefined,
    priority: clean(params.priority) || undefined,
    is_urgent: typeof params.is_urgent === "boolean" ? params.is_urgent : undefined,
    last_intent: clean(payload.detected_intent || payload.intent) || undefined,
    next_action: clean(params.next_action) || undefined,
    metadata: {
      ...existing_metadata,
      automation_engine: {
        ...ensureObject(existing_metadata.automation_engine),
        ...metadata_patch,
        last_event_type: event.event_type,
        last_rule_key: params.rule_key || null,
        patched_at: nowIso(),
      },
    },
    updated_by: "automation_engine",
  });

  if (dry_run) return { ok: true, dry_run: true, planned_patch: row };
  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  const result = await maybeSingle(
    db.from("inbox_thread_state").upsert(row, { onConflict: "thread_key" }).select()
  );

  if (
    result?.error &&
    (result.error.code === "42703" || /column/i.test(clean(result.error.message)))
  ) {
    return {
      ok: true,
      skipped: true,
      thread_key,
      patched: false,
      reason: "state_columns_pending_migration",
      intended_patch: row,
      error: result.error.message || null,
    };
  }
  if (isMissingTargetError(result?.error)) {
    return skippedMissingTarget("inbox_thread_state", result.error, {
      thread_key,
      intended_patch: row,
    });
  }

  return {
    ok: !result?.error,
    thread_key,
    patched: !result?.error,
    row: result?.data || row,
    error: result?.error?.message || null,
  };
}

async function markBadContact({ db, event, params, dry_run } = {}) {
  const phone_e164 = resolvePhoneE164(event, params);
  const reason = clean(params.reason) || "bad_contact";
  if (!phone_e164 && !clean(event.phone_number_id)) {
    return { ok: false, skipped: true, reason: "missing_phone" };
  }

  if (dry_run) {
    return { ok: true, dry_run: true, phone_e164, reason };
  }

  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  let query = db.from("phones").update({
    phone_contact_status: reason === "wrong_number" ? "wrong_number" : "bad_contact",
    wrong_number_at: reason === "wrong_number" ? nowIso() : undefined,
    wrong_number_source_thread_key:
      reason === "wrong_number" ? buildThreadKey(event, params) : undefined,
  });

  if (clean(event.phone_number_id)) query = query.eq("id", event.phone_number_id);
  else query = query.eq("canonical_e164", phone_e164);

  const result = await query;
  if (isMissingTargetError(result?.error)) {
    return skippedMissingTarget("phones", result.error, { phone_e164, reason });
  }
  return {
    ok: !result?.error,
    phone_e164,
    reason,
    error: result?.error?.message || null,
  };
}

async function createAlert({ db, event, action, params, dry_run } = {}) {
  const payload = payloadOf(event);
  const notification_key = [
    "automation",
    clean(action.rule_key || params.rule_key),
    clean(event.dedupe_key || event.id),
    clean(params.notification_type || action.action_type),
  ].join(":");

  const row = {
    notification_key,
    notification_type: clean(params.notification_type) || "automation",
    severity: clean(params.severity) || "info",
    campaign_key: clean(payload.campaign_key) || null,
    title: clean(params.title) || "Automation notification",
    message:
      clean(params.message) ||
      clean(payload.error_message) ||
      clean(payload.failure_reason) ||
      `Automation rule ${clean(action.rule_key)} matched ${event.event_type}`,
    metrics: {
      automation_event_id: event.id || null,
      event_type: event.event_type,
      rule_key: action.rule_key || null,
      ...eventEntityPatch(event),
    },
    recommended_action: clean(params.recommended_action) || "review",
    status: "pending",
    expires_at: params.expires_at || null,
  };

  if (dry_run) return { ok: true, dry_run: true, alert: row };
  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  const result = await maybeSingle(
    db.from("ops_notifications").upsert(row, { onConflict: "notification_key" }).select()
  );
  if (isMissingTargetError(result?.error)) {
    return skippedMissingTarget("ops_notifications", result.error, { intended_row: row });
  }
  return {
    ok: !result?.error,
    notification: result?.data || row,
    error: result?.error?.message || null,
  };
}

async function scheduleFollowUpAction({ db, event, rule, action, params, dry_run, options } = {}) {
  const thread_key = buildThreadKey(event, params);
  const intent = clean(params.intent || payloadOf(event).detected_intent) || "unclear";

  if (!thread_key) return { ok: false, skipped: true, reason: "missing_thread_key" };

  if (dry_run || !options.allow_send_queue_writes) {
    return {
      ok: true,
      dry_run: true,
      planned: true,
      reason: clean(params.reason) || "followup_planned_dry_run",
      intent,
      thread_key,
    };
  }

  const live_check = canRunLiveSend({ event, rule, action, options });
  if (live_check !== true) return live_check;

  const result = await scheduleFollowUp(
    intent,
    thread_key,
    {
      source: "automation_engine",
      automation_event_id: event.id || null,
      automation_dedupe_key: event.dedupe_key || null,
    },
    db
  );

  return result;
}

async function markTemplateRecommendation({ event, params, dry_run }) {
  return {
    ok: true,
    dry_run: dry_run !== false,
    planned: true,
    template_id: clean(params.template_id || payloadOf(event).template_id) || null,
    recommendation: clean(params.recommendation) || "REVIEW",
    reason: clean(params.reason) || "template_health_rule",
    note: "Template health action is recorded for review; destructive template changes are disabled.",
  };
}

async function markSenderHealth({ event, params, dry_run, options }) {
  return {
    ok: true,
    dry_run: dry_run !== false || !options.allow_sender_pause,
    planned: true,
    phone_number_id: clean(event.phone_number_id || payloadOf(event).phone_number_id) || null,
    recommendation: clean(params.recommendation) || "REVIEW",
    reason: clean(params.reason) || "sender_health_rule",
    note: "Sender pause is review-only unless allow_sender_pause is explicitly enabled.",
  };
}

async function triggerDryRunJob({ event, action, params }) {
  return {
    ok: true,
    dry_run: true,
    planned: true,
    action_type: action.action_type,
    reason: clean(params.reason) || `${action.action_type}_dry_run`,
    property_id: clean(event.property_id || payloadOf(event).property_id) || null,
    prospect_id: clean(event.prospect_id || payloadOf(event).prospect_id) || null,
    payload: {
      event_payload: payloadOf(event),
      params,
    },
  };
}

function paramsForThreadAlias(action_type, params = {}) {
  if (action_type === "update_thread_status") {
    return { ...params, status: clean(params.status || params.value) || "open" };
  }
  if (action_type === "update_stage") {
    return { ...params, stage: clean(params.stage || params.value) || "new_reply" };
  }
  if (action_type === "update_temperature") {
    return {
      ...params,
      metadata: {
        ...ensureObject(params.metadata),
        lead_temperature: clean(params.temperature || params.value) || "warm",
      },
    };
  }
  return params;
}

function paramsForTemplateAlias(action_type, params = {}) {
  if (action_type === "mark_template_review") {
    return { ...params, recommendation: clean(params.recommendation) || "REVIEW" };
  }
  if (action_type === "mark_template_kill") {
    return { ...params, recommendation: clean(params.recommendation) || "KILL" };
  }
  if (action_type === "mark_template_scale") {
    return { ...params, recommendation: clean(params.recommendation) || "SCALE" };
  }
  return params;
}

function paramsForSenderAlias(action_type, params = {}) {
  if (action_type === "mark_sender_review") {
    return { ...params, recommendation: clean(params.recommendation) || "REVIEW" };
  }
  if (action_type === "mark_sender_pause_candidate") {
    return { ...params, recommendation: clean(params.recommendation) || "PAUSE_CANDIDATE" };
  }
  return params;
}

async function runActionImplementation({ db, event, rule, action, params, dry_run, options }) {
  if (
    SEND_CAPABLE_ACTION_TYPES.has(action.action_type) &&
    !["schedule_follow_up", "dry_run_schedule_followup", "dry_run_schedule_follow_up"].includes(
      action.action_type
    )
  ) {
    return liveSendBlockedResult({
      event,
      action,
      reason: "send_action_type_not_supported",
    });
  }

  switch (action.action_type) {
    case "suppress_phone":
      return upsertAutomationSuppression({ db, event, action, params, dry_run });
    case "cancel_pending_queue":
      return cancelPendingQueue({ db, event, params, dry_run });
    case "patch_thread_state":
      return patchThreadState({ db, event, params, dry_run });
    case "update_thread_status":
    case "update_stage":
    case "update_temperature":
      return patchThreadState({
        db,
        event,
        params: paramsForThreadAlias(action.action_type, params),
        dry_run,
      });
    case "mark_bad_contact":
      return markBadContact({ db, event, params, dry_run });
    case "create_alert":
    case "create_notification":
      return createAlert({ db, event, action, params, dry_run });
    case "schedule_follow_up":
      return scheduleFollowUpAction({ db, event, rule, action, params, dry_run, options });
    case "dry_run_schedule_followup":
    case "dry_run_schedule_follow_up":
      return scheduleFollowUpAction({
        db,
        event,
        rule,
        action,
        params,
        dry_run: true,
        options,
      });
    case "mark_template_recommendation":
    case "mark_template_review":
    case "mark_template_kill":
    case "mark_template_scale":
      return markTemplateRecommendation({
        event,
        params: paramsForTemplateAlias(action.action_type, params),
        dry_run,
      });
    case "mark_sender_health":
    case "mark_sender_review":
    case "mark_sender_pause_candidate":
      return markSenderHealth({
        event,
        params: paramsForSenderAlias(action.action_type, params),
        dry_run,
        options,
      });
    case "trigger_deal_intelligence_refresh":
    case "trigger_comp_pull":
    case "trigger_buyer_match":
      return triggerDryRunJob({ event, action, params });
    default:
      return { ok: false, skipped: true, reason: "unsupported_action_type" };
  }
}

export async function executeAutomationAction({
  event = {},
  run = {},
  rule = {},
  action = {},
  supabaseClient = null,
  dry_run = null,
  options = {},
} = {}) {
  const db = supabaseClient || getDefaultSupabaseClient();
  const params = {
    ...ensureObject(action.params),
    rule_key: rule.rule_key || action.rule_key || null,
  };
  const effective_dry_run = actionDryRun({ action, rule, engine_dry_run: dry_run });
  const action_with_rule = { ...action, rule_key: rule.rule_key };

  let action_record = null;

  try {
    const record_result = await createAutomationActionRecord({
      db,
      event,
      run,
      rule,
      action: action_with_rule,
      dry_run: effective_dry_run,
    });

    action_record = record_result.record;

    if (record_result.duplicate) {
      await writeAutomationAuditLog(
        {
          event,
          run,
          action: action_record,
          status: "skipped",
          log_type: "action",
          message: "Automation action skipped because dedupe key already exists",
          payload: { dedupe_key: action_record?.dedupe_key },
          console_tag: AUTOMATION_LOG_TAGS.idempotency_skip,
        },
        { supabaseClient: db }
      );
      return {
        ok: true,
        skipped: true,
        duplicate: true,
        action_type: action.action_type,
        action_id: action_record?.id || null,
      };
    }

    await writeAutomationAuditLog(
      {
        event,
        run,
        action: action_record,
        status: "started",
        log_type: "action",
        message: "Automation action started",
        console_tag: AUTOMATION_LOG_TAGS.action_started,
      },
      { supabaseClient: db }
    );

    const result = await runActionImplementation({
      db,
      event,
      rule,
      action: action_with_rule,
      params,
      dry_run: effective_dry_run,
      options,
    });

    const final_status = result?.ok === false ? "failed" : result?.skipped ? "skipped" : "completed";
    await updateAutomationActionRecord(db, action_record?.id, {
      status: final_status,
      result: result || {},
      output: result || {},
      run_completed_at: nowIso(),
      error_message: result?.ok === false ? result?.error || result?.reason || "action_failed" : null,
    });

    const console_tag =
      action.action_type === "patch_thread_state" && final_status === "completed"
        ? AUTOMATION_LOG_TAGS.state_patched
        : action.action_type === "suppress_phone" && final_status === "completed"
          ? AUTOMATION_LOG_TAGS.suppression_applied
          : final_status === "skipped"
            ? AUTOMATION_LOG_TAGS.action_skipped
            : final_status === "failed"
              ? AUTOMATION_LOG_TAGS.action_failed
              : AUTOMATION_LOG_TAGS.action_success;

    await writeAutomationAuditLog(
      {
        event,
        run,
        action: action_record,
        status: final_status,
        log_type: "action",
        message: `Automation action ${final_status}`,
        payload: result || {},
        error_message:
          final_status === "failed" ? result?.error || result?.reason || "action_failed" : null,
        console_tag,
      },
      { supabaseClient: db }
    );

    return {
      ok: result?.ok !== false,
      status: final_status,
      action_type: action.action_type,
      action_id: action_record?.id || null,
      dry_run: effective_dry_run,
      result,
    };
  } catch (error) {
    await updateAutomationActionRecord(db, action_record?.id, {
      status: "failed",
      run_completed_at: nowIso(),
      error_message: error?.message || "action_failed",
      error_payload: { action_type: action.action_type },
      output: { error: error?.message || "action_failed" },
    });

    await writeAutomationAuditLog(
      {
        event,
        run,
        action: action_record || action,
        action_type: action.action_type,
        status: "failed",
        log_type: "action",
        message: "Automation action failed",
        error_message: error?.message || "action_failed",
        console_tag: AUTOMATION_LOG_TAGS.action_failed,
      },
      { supabaseClient: db }
    );

    return {
      ok: false,
      status: "failed",
      action_type: action.action_type,
      action_id: action_record?.id || null,
      error: error?.message || "action_failed",
    };
  }
}

export default executeAutomationAction;

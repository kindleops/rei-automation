import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";
import { hasSupabaseConfig } from "../lib/supabase/client.js";
import {
  AUTOMATION_LOG_TAGS,
  logAutomationConsole,
  writeAutomationAuditLog,
} from "../lib/domain/automation/automation-audit.js";

function clean(value) {
  return String(value ?? "").trim();
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function hashAutomationPayload(value) {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function payloadOf(input = {}) {
  return input.payload && typeof input.payload === "object" ? input.payload : {};
}

function firstClean(...values) {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function automationContextFields(input = {}, payload = payloadOf(input)) {
  const workflow = payload.workflow && typeof payload.workflow === "object" ? payload.workflow : {};
  const campaign = payload.campaign && typeof payload.campaign === "object" ? payload.campaign : {};
  const template = payload.template && typeof payload.template === "object" ? payload.template : {};
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};

  return {
    workflow_id: firstClean(input.workflow_id, payload.workflow_id, workflow.id) || null,
    workflow_run_id:
      firstClean(input.workflow_run_id, payload.workflow_run_id, workflow.run_id) || null,
    workflow_step_id:
      firstClean(input.workflow_step_id, payload.workflow_step_id, workflow.step_id) || null,
    channel: firstClean(input.channel, payload.channel, payload.provider) || null,
    node_type: firstClean(input.node_type, payload.node_type, payload.action_type) || null,
    campaign_id: firstClean(input.campaign_id, payload.campaign_id, campaign.id) || null,
    campaign_key: firstClean(input.campaign_key, payload.campaign_key, campaign.key) || null,
    template_id:
      firstClean(input.template_id, payload.template_id, template.id, payload.selected_template_id) ||
      null,
    sender_id: firstClean(input.sender_id, payload.sender_id, sender.id) || null,
    sender_phone_number_id:
      firstClean(
        input.sender_phone_number_id,
        payload.sender_phone_number_id,
        payload.sender_phone_id,
        sender.phone_number_id,
        sender.phone_id
      ) || null,
  };
}

export function buildAutomationEventDedupeKey(input = {}) {
  const payload = payloadOf(input);
  const explicit =
    clean(input.dedupe_key) ||
    clean(input.dedupeKey) ||
    clean(payload.dedupe_key) ||
    clean(payload.dedupeKey);
  if (explicit) return explicit;

  const provider_message_id =
    clean(input.provider_message_id) ||
    clean(input.provider_message_sid) ||
    clean(payload.provider_message_id) ||
    clean(payload.provider_message_sid) ||
    clean(payload.message_id) ||
    clean(payload.textgrid_message_id);

  const queue_item_id =
    clean(input.queue_item_id) ||
    clean(input.queue_id) ||
    clean(payload.queue_item_id) ||
    clean(payload.queue_id) ||
    clean(payload.queue_row_id);

  const base = {
    event_type: clean(input.event_type),
    provider_message_id: provider_message_id || null,
    queue_item_id: queue_item_id || null,
    conversation_thread_id:
      clean(input.conversation_thread_id || input.thread_key || payload.thread_key) || null,
    message_body: clean(payload.message_body || payload.body || payload.text || "").slice(0, 500),
    status: clean(payload.status || payload.delivery_status || payload.queue_status) || null,
  };

  return `${base.event_type}:${hashAutomationPayload(base)}`;
}

export function normalizeAutomationEvent(input = {}) {
  const payload = payloadOf(input);
  const event_type = clean(input.event_type || payload.event_type);

  return {
    event_type,
    status: clean(input.status) || "pending",
    dedupe_key: buildAutomationEventDedupeKey({ ...input, event_type }),
    source: clean(input.source) || "api",
    conversation_thread_id:
      clean(input.conversation_thread_id || input.thread_key || payload.conversation_thread_id || payload.thread_key) ||
      null,
    property_id: clean(input.property_id || payload.property_id) || null,
    prospect_id: clean(input.prospect_id || payload.prospect_id) || null,
    master_owner_id: clean(input.master_owner_id || payload.master_owner_id) || null,
    phone_number_id:
      clean(input.phone_number_id || input.phone_id || payload.phone_number_id || payload.phone_id) ||
      null,
    queue_item_id:
      clean(input.queue_item_id || input.queue_id || payload.queue_item_id || payload.queue_row_id || payload.queue_id) ||
      null,
    ...automationContextFields(input, payload),
    payload,
  };
}

export async function persistAutomationEvent(input = {}, options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  const event = normalizeAutomationEvent(input);

  if (!event.event_type) {
    return { ok: false, reason: "missing_event_type", event };
  }

  if (!db?.from) {
    return { ok: false, reason: "supabase_unavailable", event };
  }

  try {
    if (event.dedupe_key) {
      const { data: existing, error: existing_error } = await db
        .from("automation_events")
        .select("*")
        .eq("dedupe_key", event.dedupe_key)
        .maybeSingle();

      if (existing_error && existing_error.code !== "PGRST116") throw existing_error;
      if (existing?.id) {
        await writeAutomationAuditLog(
          {
            event: existing,
            status: "skipped",
            log_type: "idempotency",
            message: "Automation event skipped because dedupe key already exists",
            payload: { dedupe_key: event.dedupe_key },
            console_tag: AUTOMATION_LOG_TAGS.idempotency_skip,
          },
          { supabaseClient: db }
        );
        return {
          ok: true,
          duplicate: true,
          event: existing,
          normalized_event: event,
        };
      }
    }

    const { data, error } = await db
      .from("automation_events")
      .insert(event)
      .select()
      .maybeSingle();
    if (error) throw error;

    const persisted = data || event;
    await writeAutomationAuditLog(
      {
        event: persisted,
        status: "ingested",
        log_type: "event",
        message: "Automation event ingested",
        console_tag: AUTOMATION_LOG_TAGS.event_ingested,
      },
      { supabaseClient: db }
    );

    return { ok: true, duplicate: false, event: persisted, normalized_event: event };
  } catch (error) {
    return {
      ok: false,
      reason: "automation_event_persist_failed",
      error: error?.message || "automation_event_persist_failed",
      event,
    };
  }
}

export async function updateAutomationEventStatus(
  automation_event_id,
  patch = {},
  options = {}
) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  if (!db?.from || !automation_event_id) {
    return { ok: false, skipped: true, reason: "missing_db_or_event_id" };
  }

  try {
    const { data, error } = await db
      .from("automation_events")
      .update(patch)
      .eq("id", automation_event_id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return { ok: true, event: data || null };
  } catch (error) {
    return {
      ok: false,
      reason: "automation_event_status_update_failed",
      error: error?.message || "automation_event_status_update_failed",
    };
  }
}

export async function emitAutomationEvent(input = {}, options = {}) {
  const explicit_supabase = options.supabaseClient || options.supabase;
  if (!explicit_supabase && !hasSupabaseConfig()) {
    return {
      ok: false,
      skipped: true,
      reason: "supabase_not_configured",
      event_type: input?.event_type || null,
    };
  }

  try {
    const { runAutomationEngine } = await import(
      "../lib/domain/automation/automation-engine.js"
    );
    return await runAutomationEngine({
      event: input,
      supabaseClient: options.supabaseClient || options.supabase,
      source: input.source || options.source,
      dry_run: options.dry_run,
      allow_send_queue_writes: options.allow_send_queue_writes,
      logger: options.logger,
    });
  } catch (error) {
    if (options.logger?.warn) {
      options.logger.warn("automation.emit_failed", {
        event_type: input?.event_type || null,
        error: error?.message || "automation_emit_failed",
      });
    } else {
      logAutomationConsole(AUTOMATION_LOG_TAGS.emit_failed_non_blocking, {
        event_type: input?.event_type || null,
        error: error?.message || "automation_emit_failed",
      });
      console.warn("automation.emit_failed", error?.message || error);
    }
    return {
      ok: false,
      reason: "automation_emit_failed",
      error: error?.message || "automation_emit_failed",
    };
  }
}

export async function listAutomationRuns(options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  if (!db?.from) return { ok: false, reason: "supabase_unavailable", runs: [] };

  const limit = Number(options.limit || 100);
  let query = db
    .from("automation_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Number.isFinite(limit) ? limit : 100);

  if (clean(options.status)) query = query.eq("status", clean(options.status));
  if (clean(options.event_type)) query = query.eq("event_type", clean(options.event_type));

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message, runs: [] };
  return { ok: true, runs: Array.isArray(data) ? data : [] };
}

export async function replayAutomationEvent(input = {}, options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  const event_id = clean(input.event_id || input.id);
  if (!event_id) return { ok: false, reason: "missing_event_id" };
  if (!db?.from) return { ok: false, reason: "supabase_unavailable" };

  const { data, error } = await db
    .from("automation_events")
    .select("*")
    .eq("id", event_id)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: "automation_event_not_found", error: error?.message };
  }

  const { runAutomationEngine } = await import("../lib/domain/automation/automation-engine.js");
  return runAutomationEngine({
    event: data,
    replay: true,
    supabaseClient: db,
    dry_run: input.dry_run ?? options.dry_run,
    allow_send_queue_writes: options.allow_send_queue_writes,
  });
}

export default emitAutomationEvent;

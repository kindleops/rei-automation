import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";
import {
  normalizeAutomationEvent,
  persistAutomationEvent,
  updateAutomationEventStatus,
} from "../lib/domain/automation/automation-events.js";
import {
  loadActiveAutomationRules,
  matchAutomationRule,
} from "../lib/domain/automation/automation-rules.js";
import { executeAutomationAction } from "../lib/domain/automation/automation-actions.js";
import {
  AUTOMATION_LOG_TAGS,
  writeAutomationAuditLog,
} from "../lib/domain/automation/automation-audit.js";

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function envFlag(name, fallback = false) {
  const normalized = clean(process.env[name]).toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function compact(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function eventEntities(event = {}) {
  return {
    conversation_thread_id: clean(event.conversation_thread_id) || null,
    property_id: clean(event.property_id) || null,
    prospect_id: clean(event.prospect_id) || null,
    master_owner_id: clean(event.master_owner_id) || null,
    phone_number_id: clean(event.phone_number_id) || null,
    queue_item_id: clean(event.queue_item_id) || null,
  };
}

function workflowContext(event = {}, rule = {}) {
  const payload = ensureObject(event.payload);
  return {
    workflow_id: clean(event.workflow_id || rule.workflow_id || payload.workflow_id) || null,
    workflow_run_id: clean(event.workflow_run_id || payload.workflow_run_id) || null,
    workflow_step_id:
      clean(event.workflow_step_id || rule.workflow_step_id || payload.workflow_step_id) || null,
    channel: clean(event.channel || rule.channel || payload.channel || payload.provider) || null,
    node_type: clean(event.node_type || rule.node_type || payload.node_type) || null,
    step_type: clean(rule.step_type || payload.step_type) || null,
  };
}

async function maybeSingle(query) {
  if (typeof query?.maybeSingle === "function") return query.maybeSingle();
  if (typeof query?.single === "function") return query.single();
  return query;
}

async function createAutomationRunRecord({ db, event, rule, match, dry_run } = {}) {
  const row = compact({
    id: !db?.from ? crypto.randomUUID() : undefined,
    automation_event_id: event.id || null,
    rule_id: rule.id || null,
    rule_key: rule.rule_key,
    event_type: event.event_type,
    status: "running",
    dry_run,
    live_send_enabled: false,
    ...workflowContext(event, rule),
    ...eventEntities(event),
    matched_conditions: {
      matcher: match.matcher || rule.condition?.matcher || null,
      reason: match.reason || null,
      details: match.details || {},
    },
    payload: {
      rule_description: rule.description || null,
      rule_condition: rule.condition || {},
      action_count: Array.isArray(rule.actions) ? rule.actions.length : 0,
    },
    context: {
      rule_scope: clean(rule.rule_scope) || null,
      source: clean(event.source) || null,
      dry_run,
    },
    run_started_at: nowIso(),
  });

  if (!db?.from) return { ok: true, run: row, skipped_persist: true };

  const result = await maybeSingle(db.from("automation_runs").insert(row).select());
  if (result?.error) throw result.error;
  return { ok: true, run: result?.data || row };
}

async function updateAutomationRunRecord(db, run_id, patch = {}) {
  if (!db?.from || !run_id) return { ok: true, skipped: true };
  const result = await maybeSingle(
    db.from("automation_runs").update(patch).eq("id", run_id).select()
  );
  if (result?.error) return { ok: false, error: result.error.message };
  return { ok: true, run: result?.data || null };
}

function summarizeActions(results = []) {
  return results.reduce(
    (summary, result) => {
      summary.total += 1;
      if (result?.ok === false) summary.failed += 1;
      else if (result?.skipped) summary.skipped += 1;
      else summary.completed += 1;
      if (result?.dry_run || result?.result?.dry_run) summary.dry_run += 1;
      return summary;
    },
    { total: 0, completed: 0, skipped: 0, failed: 0, dry_run: 0 }
  );
}

export async function runAutomationEngine(input = {}) {
  const db = input.supabaseClient || input.supabase || getDefaultSupabaseClient();
  const replay = input.replay === true;
  const engine_options = {
    allow_send_queue_writes:
      input.allow_send_queue_writes === true ||
      process.env.AUTOMATION_ALLOW_SEND_QUEUE_WRITES === "true",
    allow_sender_pause:
      input.allow_sender_pause === true ||
      process.env.AUTOMATION_ALLOW_SENDER_PAUSE === "true",
    automation_live_sends_enabled: envFlag("AUTOMATION_LIVE_SENDS_ENABLED", false),
    workflow_live_sends_enabled: envFlag("WORKFLOW_LIVE_SENDS_ENABLED", false),
  };
  engine_options.global_live_sends_enabled =
    engine_options.automation_live_sends_enabled === true &&
    engine_options.workflow_live_sends_enabled === true;

  let persisted_event = null;
  let persist_result = null;

  if (replay && input.event?.id) {
    persisted_event = {
      ...normalizeAutomationEvent(input.event),
      ...input.event,
      payload: ensureObject(input.event.payload),
    };
  } else {
    persist_result = await persistAutomationEvent(
      {
        ...input.event,
        source: input.source || input.event?.source || "automation_engine",
      },
      { supabaseClient: db }
    );

    if (persist_result?.duplicate && !replay) {
      return {
        ok: true,
        duplicate: true,
        reason: "duplicate_event_ignored",
        event: persist_result.event,
        matched_rules: [],
        runs: [],
        action_summary: { total: 0, completed: 0, skipped: 0, failed: 0, dry_run: 0 },
      };
    }

    if (persist_result?.ok === false) {
      return {
        ok: false,
        reason: persist_result.reason || "automation_event_persist_failed",
        error: persist_result.error,
        event: persist_result.event,
      };
    }

    persisted_event = persist_result.event;
  }

  await updateAutomationEventStatus(
    persisted_event.id,
    {
      status: "running",
      run_started_at: nowIso(),
    },
    { supabaseClient: db }
  );

  const rules = await loadActiveAutomationRules({ supabaseClient: db });
  const matched_rules = [];
  const runs = [];
  const all_action_results = [];
  let failed = false;

  for (const rule of rules) {
    const match = matchAutomationRule(rule, persisted_event);
    if (!match.matched) continue;

    matched_rules.push({ rule_key: rule.rule_key, match });
    await writeAutomationAuditLog(
      {
        event: persisted_event,
        rule_key: rule.rule_key,
        status: "matched",
        log_type: "rule",
        message: "Automation rule matched",
        payload: match,
        console_tag: AUTOMATION_LOG_TAGS.rule_matched,
      },
      { supabaseClient: db }
    );

    const rule_dry_run =
      typeof input.dry_run === "boolean" ? input.dry_run : rule.dry_run_default !== false;

    let run_record = null;
    try {
      const run_result = await createAutomationRunRecord({
        db,
        event: persisted_event,
        rule,
        match,
        dry_run: rule_dry_run,
      });
      run_record = run_result.run;

      const action_results = [];
      for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
        const action_result = await executeAutomationAction({
          event: persisted_event,
          run: run_record,
          rule,
          action,
          supabaseClient: db,
          dry_run: input.dry_run,
          options: engine_options,
        });
        action_results.push(action_result);
        all_action_results.push(action_result);
      }

      const action_summary = summarizeActions(action_results);
      const run_status = action_summary.failed > 0 ? "failed" : "completed";
      if (run_status === "failed") failed = true;

      await updateAutomationRunRecord(db, run_record?.id, {
        status: run_status,
        action_summary,
        run_completed_at: nowIso(),
        error_message: run_status === "failed" ? "one_or_more_actions_failed" : null,
      });

      runs.push({
        ...run_record,
        status: run_status,
        action_summary,
        actions: action_results,
      });
    } catch (error) {
      failed = true;
      await updateAutomationRunRecord(db, run_record?.id, {
        status: "failed",
        run_completed_at: nowIso(),
        error_message: error?.message || "automation_run_failed",
      });
      await writeAutomationAuditLog(
        {
          event: persisted_event,
          run: run_record || { rule_key: rule.rule_key, event_type: persisted_event.event_type },
          rule_key: rule.rule_key,
          status: "failed",
          log_type: "run",
          message: "Automation run failed",
          error_message: error?.message || "automation_run_failed",
        },
        { supabaseClient: db }
      );
      runs.push({
        ...(run_record || {}),
        rule_key: rule.rule_key,
        status: "failed",
        error: error?.message || "automation_run_failed",
      });
    }
  }

  const action_summary = summarizeActions(all_action_results);
  const final_status = failed ? "failed" : "completed";

  await updateAutomationEventStatus(
    persisted_event.id,
    {
      status: final_status,
      run_completed_at: nowIso(),
      error_message: failed ? "one_or_more_automation_runs_failed" : null,
    },
    { supabaseClient: db }
  );

  return {
    ok: !failed,
    event: persisted_event,
    matched_rules,
    runs,
    action_summary,
  };
}

export async function runAutomationPendingEvents(options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  if (!db?.from) return { ok: false, reason: "supabase_unavailable", results: [] };

  const limit = Number(options.limit || 25);
  const { data, error } = await db
    .from("automation_events")
    .select("*")
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(Number.isFinite(limit) ? limit : 25);

  if (error) return { ok: false, error: error.message, results: [] };

  const results = [];
  for (const event of Array.isArray(data) ? data : []) {
    results.push(
      await runAutomationEngine({
        event,
        replay: true,
        supabaseClient: db,
        dry_run: options.dry_run,
        allow_send_queue_writes: options.allow_send_queue_writes,
      })
    );
  }

  return { ok: results.every((result) => result.ok !== false), results };
}

export default runAutomationEngine;

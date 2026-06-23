import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

function clean(value) {
  return String(value ?? "").trim();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function missingColumnOrTable(error = {}) {
  const code = clean(error.code);
  const message = clean(error.message).toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    /relation .* does not exist/.test(message) ||
    /column .* does not exist/.test(message) ||
    /schema cache/.test(message)
  );
}

export async function writeWorkflowAuditLog(input = {}, deps = {}) {
  const db = deps.supabase || deps.supabaseClient || getDefaultSupabaseClient();
  const row = compact({
    workflow_id: clean(input.workflow_id || input.workflow?.id) || null,
    workflow_run_id: clean(input.workflow_run_id || input.run?.id) || null,
    actor_type: clean(input.actor_type || "operator") || "operator",
    action: clean(input.action || "workflow.activity") || "workflow.activity",
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: ensureObject(input.metadata),
  });

  if (!db?.from) return { ok: false, skipped: true, reason: "supabase_unavailable", row };

  const result = { ok: true, row, workflow_audit: null, automation_audit: null };

  try {
    const inserted = await maybeSingle(db.from("workflow_audit_log").insert(row).select());
    if (inserted?.error) throw inserted.error;
    result.workflow_audit = inserted?.data || row;
  } catch (error) {
    result.ok = false;
    result.workflow_audit = {
      ok: false,
      skipped: missingColumnOrTable(error),
      error: error?.message || "workflow_audit_write_failed",
    };
  }

  try {
    const mirror = await maybeSingle(
      db
        .from("automation_audit_log")
        .insert({
          workflow_id: row.workflow_id,
          workflow_run_id: row.workflow_run_id,
          event_type: "workflow_studio_activity",
          action_type: row.action,
          status: "logged",
          log_type: "workflow_studio",
          message: row.action,
          payload: {
            actor_type: row.actor_type,
            before: row.before,
            after: row.after,
            metadata: row.metadata,
          },
        })
        .select()
    );
    if (mirror?.error) throw mirror.error;
    result.automation_audit = mirror?.data || null;
  } catch (error) {
    result.automation_audit = {
      ok: false,
      skipped: missingColumnOrTable(error),
      error: error?.message || "automation_audit_mirror_failed",
    };
  }

  return result;
}

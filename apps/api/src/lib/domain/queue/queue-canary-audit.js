export async function persistCanaryExecutionAudit(supabase, audit = {}) {
  if (!supabase) return { ok: false, reason: "supabase_required" };
  const row = {
    canary_run_id: audit.canary_run_id,
    campaign_id: audit.campaign_id,
    processing_run_id: audit.processing_run_id,
    validate_only: audit.validate_only === true,
    requested_ids: audit.requested_ids || [],
    selected_ids: audit.selected_ids || [],
    claimed_ids: audit.claimed_ids || [],
    dispatched_ids: audit.dispatched_ids || [],
    excluded: audit.excluded || [],
    queue_execution_mode: audit.queue_execution_mode || null,
    emergency_stop_active: audit.emergency_stop_active === true,
    authorization_id: audit.authorization_id || null,
    audit_payload: audit.audit_payload || {},
  };
  const { data, error } = await supabase
    .from("queue_canary_execution_audits")
    .insert(row)
    .select("id,created_at")
    .single();
  if (error) {
    return { ok: false, reason: "audit_persist_failed", message: error.message };
  }
  return { ok: true, audit_id: data.id, created_at: data.created_at };
}
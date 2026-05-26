import crypto from "node:crypto";
import { info, warn } from "@/lib/logging/logger.js";
import { getSystemFlag, buildDisabledResponse } from "@/lib/system-control.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { 
  processSendQueueItem as defaultProcessSendQueueItem,
  loadQueueRowById
} from "@/lib/domain/queue/process-send-queue.js";
import { loadRunnableSendQueueRows } from "@/lib/supabase/sms-engine.js";
import { reconcileCanonicalQueueLifecycle } from "@/lib/supabase/sms-engine.js";
function normalizeRows(data) {
  return Array.isArray(data) ? data : [];
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

async function buildSupabaseCandidateSummary(limit = 50, now = nowIso(), deps = {}) {
  const load_runnable_send_queue_rows = deps.loadRunnableSendQueueRows || loadRunnableSendQueueRows;
  const loaded = await load_runnable_send_queue_rows(limit, {
    ...deps,
    now,
  });

  const rows = normalizeRows(loaded.rows);
  const raw_rows = normalizeRows(loaded.raw_rows);
  const skipped = normalizeRows(loaded.skipped);

  return {
    rows,
    raw_rows,
    total_rows_loaded: raw_rows.length,
    queued_rows_loaded: raw_rows.length,
    due_rows: rows.length,
    future_rows: skipped.filter((entry) =>
      ["scheduled_for_in_future", "next_retry_pending"].includes(entry?.reason)
    ).length,
    outside_window_rows: Number(loaded.preclaim_outside_window_excluded_count || 0),
    preclaim_scanned_count: loaded.preclaim_scanned_count || 0,
    preclaim_outside_window_excluded_count: loaded.preclaim_outside_window_excluded_count || 0,
    preclaim_retry_pending_excluded_count: loaded.preclaim_retry_pending_excluded_count || 0,
    preclaim_paused_name_missing_count: loaded.preclaim_paused_name_missing_count || 0,
    preclaim_paused_invalid_count: loaded.preclaim_paused_invalid_count || 0,
    preclaim_paused_max_retries_count: loaded.preclaim_paused_max_retries_count || 0,
    skipped_invalid_phone_count: loaded.skipped_invalid_phone_count || 0,
    skipped_missing_body_count: loaded.skipped_missing_body_count || 0,
    eligible_claim_count: loaded.eligible_claim_count || 0,
    skipped,
  };
}

async function buildQueueCandidates(limit = 50, now = nowIso(), deps = {}) {
  return buildSupabaseCandidateSummary(limit, now, deps);
}

export async function runSendQueue(
  {
    limit = 50,
    dry_run = false,
    now = new Date().toISOString(),
  } = {},
  deps = {}
) {
  const get_system_flag =
    deps.getSystemFlag ||
    (typeof getSystemFlag === "function"
      ? getSystemFlag
      : async () => true);
  const log_info = deps.info || info;
  const log_warn = deps.warn || warn;
  const supabase = deps.supabaseClient || defaultSupabase;
  const process_item = deps.processSendQueueItem || defaultProcessSendQueueItem;

  const run_started_at = now;
  const processing_run_id = crypto.randomUUID();

  log_info("queue.run_started", { limit, dry_run, now_utc: now });

  // Canonical lifecycle reconciliation before claiming rows so stale runnable
  // rows don't re-enter active processing unexpectedly.
  try {
    const reconcile = await (deps.reconcileCanonicalQueueLifecycle || reconcileCanonicalQueueLifecycle)({
      now,
      dry_run,
      stale_minutes: deps.stale_queue_minutes ?? 180,
      lease_minutes: deps.processing_lease_minutes ?? 10,
      max_rows: 1000,
      supabaseClient: supabase,
      supabase,
    });
    log_info("queue.lifecycle_reconcile", reconcile);
  } catch (reconcile_error) {
    log_warn("queue.lifecycle_reconcile_failed", {
      error: reconcile_error?.message || "unknown_error",
    });
  }

  // ── System control gate ────────────────────────────────────────────────
  if (!dry_run) {
    const queue_runner_enabled = await get_system_flag("queue_runner_enabled");
    if (!queue_runner_enabled) {
      log_info("queue_runner.blocked", { flag: "queue_runner_enabled" });
      return { ok: false, status: 423, ...buildDisabledResponse("queue_runner_enabled", "runSendQueue"), skipped: true, reason: "system_control_disabled", sent_count: 0, results: [] };
    }
    const outbound_sms_enabled = await get_system_flag("outbound_sms_enabled");
    const auto_reply_live_enabled = await get_system_flag("auto_reply_live_enabled");
    if (!outbound_sms_enabled && !auto_reply_live_enabled) {
      log_info("queue_runner.blocked", { flag: "outbound_sms_enabled", auto_reply_live_enabled });
      return { ok: false, status: 423, ...buildDisabledResponse("outbound_sms_enabled", "runSendQueue"), skipped: true, reason: "system_control_disabled", sent_count: 0, results: [] };
    }
  }

  // 1. Stale-lock recovery for stuck "processing" rows
  try {
    const { data: recycled, error: recycle_error } = await supabase
        .from('send_queue')
        .update({
            queue_status: 'queued',
            is_locked: false,
            locked_at: null,
            processing_run_id: null,
        })
        .eq('queue_status', 'processing')
        .lt('locked_at', new Date(Date.now() - 10 * 60000).toISOString())
        .select('id');
    
    if (recycled?.length) {
        log_info("queue_stuck_rows_recycled", { count: recycled.length });
    }
  } catch (err) {
    log_warn("queue.stuck_row_recovery_failed", { error: err.message });
  }

  // 2. Fetch candidates (no global lock skip)
  const candidates = await buildQueueCandidates(limit, now, { ...deps, dry_run, supabaseClient: supabase });
  const rows = normalizeRows(candidates.rows);

  log_info("queue_rows_claimed", { count: rows.length });

  const results = [];
  let sent_count = 0;
  let failed_count = 0;
  let skipped_count = 0;
  let processed_count = 0;

  // 3. Process rows with canonical row-level atomic claims in processSendQueueItem.
  // Do not pre-claim here; the processor owns claim->send->finalize.
  for (const row of rows) {
    const queue_item_id = row.id;
    
    if (dry_run) {
        processed_count += 1;
        results.push({ ok: true, queue_item_id, dry_run: true });
        continue;
    }

    log_info("queue_row_selected", {
      queue_item_id,
      queue_status: row.queue_status,
      message_type: row.message_type || null,
      use_case_template: row.use_case_template || null,
      scheduled_for: row.scheduled_for || null,
      to_phone_number: row.to_phone_number || null,
      from_phone_number: row.from_phone_number || null,
    });

    try {
        const result = await process_item(row, {
          ...deps,
          now,
          supabaseClient: supabase,
          processing_run_id,
          run_started_at,
        });
        processed_count += 1;
        
        if (result?.sent) {
            sent_count += 1;
            results.push({
              ok: true,
              queue_item_id,
              status: 'sent',
              provider_message_id: result.provider_message_id || null,
            });
            log_info("queue_row_provider_send_attempted", {
              queue_item_id,
              provider_message_id: result.provider_message_id || null,
              final_queue_status: result.final_queue_status || result.queue_status || 'sent',
            });
        } else if (result?.skipped) {
            skipped_count += 1;
            results.push({
              ok: true,
              skipped: true,
              queue_item_id,
              reason: result.reason || 'skipped',
              final_queue_status: result.final_queue_status || result.queue_status || null,
            });
            log_info("queue_row_skipped", {
              queue_item_id,
              reason: result.reason || 'skipped',
              final_queue_status: result.final_queue_status || result.queue_status || null,
            });
        } else {
            failed_count += 1;
            results.push({
              ok: false,
              queue_item_id,
              reason: result?.reason || 'failed',
              final_queue_status: result?.final_queue_status || result?.queue_status || null,
            });
            log_warn("queue_row_failed", {
              queue_item_id,
              reason: result?.reason || 'failed',
              final_queue_status: result?.final_queue_status || result?.queue_status || null,
            });
        }
    } catch (err) {
        failed_count += 1;
        results.push({ ok: false, queue_item_id, reason: err?.message || 'queue_processing_exception' });
        log_warn("queue_row_failed", { queue_item_id, error: err.message });
    }
  }

  log_info("queue_run_completed", {
      processing_run_id,
      claimed_count: rows.length,
      sent_count,
      failed_count,
      skipped_count,
      batch_duration_ms: Date.now() - new Date(run_started_at).getTime()
  });

  return { 
    ok: true, 
    sent_count, 
    failed_count, 
    skipped_count,
    claimed_count: rows.length,
    processed_count,
    results,
    eligible_claim_count: candidates.eligible_claim_count,
    due_rows: candidates.due_rows,
    future_rows: candidates.future_rows,
    preclaim_outside_window_excluded_count: candidates.preclaim_outside_window_excluded_count,
    skipped_invalid_phone_count: candidates.skipped_invalid_phone_count,
    skipped_missing_body_count: candidates.skipped_missing_body_count,
  };
}

import crypto from "node:crypto";
import { info, warn } from "@/lib/logging/logger.js";
import { getSystemFlag, getSystemValue, buildDisabledResponse } from "@/lib/system-control.js";
import {
  blockedRuntimeBrakeResult,
  evaluateQueueSendRuntimeBrakes,
} from "@/lib/domain/queue/queue-control-safety.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { 
  processSendQueueItem as defaultProcessSendQueueItem,
  loadQueueRowById
} from "@/lib/domain/queue/process-send-queue.js";
import { loadRunnableSendQueueRows } from "@/lib/supabase/sms-engine.js";
import { reconcileCanonicalQueueLifecycle } from "@/lib/supabase/sms-engine.js";
import { isLiveCampaignStatus, LIVE_CAMPAIGN_STATES } from "@/lib/domain/campaigns/campaign-state-machine.js";
function normalizeRows(data) {
  return Array.isArray(data) ? data : [];
}

/**
 * Campaign-gated dispatch: a send_queue row that belongs to a campaign is only
 * eligible to send while that campaign is live (ACTIVE/activating). Rows with no
 * campaign_id are unaffected and flow exactly as before. Returns a Set of live
 * campaign ids, or null if the lookup failed (caller fails closed for campaign
 * rows so a transient error can never dispatch a non-active campaign).
 */
async function fetchLiveCampaignIds(supabase) {
  try {
    const { data, error } = await supabase
      .from("campaigns")
      .select("id,status")
      .in("status", [...LIVE_CAMPAIGN_STATES]);
    if (error) {
      warn("queue.live_campaign_fetch_failed", { error: error.message });
      return null;
    }
    return new Set((data || []).filter((c) => isLiveCampaignStatus(c.status)).map((c) => c.id));
  } catch (err) {
    warn("queue.live_campaign_fetch_failed", { error: err?.message });
    return null;
  }
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

async function loadQueueSendBrakeSettings(get_system_value) {
  return {
    queue_processor_mode: await get_system_value("queue_processor_mode"),
    queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
  };
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
  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const log_info = deps.info || info;
  const log_warn = deps.warn || warn;
  const supabase = deps.supabaseClient || defaultSupabase;
  const process_item = deps.processSendQueueItem || defaultProcessSendQueueItem;

  const run_started_at = now;
  const processing_run_id = crypto.randomUUID();

  log_info("queue.run_started", { limit, dry_run, now_utc: now });

  if (!dry_run) {
    const runtime_brake = evaluateQueueSendRuntimeBrakes(
      await loadQueueSendBrakeSettings(get_system_value),
      { action: "runSendQueue", failClosed: false }
    );
    if (!runtime_brake.ok) {
      log_info("queue_runner.blocked_runtime_brake", {
        reason: runtime_brake.reason,
        diagnostics: runtime_brake.diagnostics,
      });
      return {
        status: 423,
        ...blockedRuntimeBrakeResult(runtime_brake, "runSendQueue"),
        skipped: true,
        sent_count: 0,
        results: [],
      };
    }
  }

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
  const candidateRows = normalizeRows(candidates.rows);

  // 2b. Campaign-gated dispatch. Rows belonging to a campaign only send while
  // that campaign is live (ACTIVE/activating). Unlinked rows flow as today.
  const liveCampaignIds = await fetchLiveCampaignIds(supabase);
  const rows = candidateRows.filter((row) => {
    const campaignId = row.campaign_id || row.metadata?.campaign_id || null;
    if (!campaignId) return true;
    return liveCampaignIds ? liveCampaignIds.has(campaignId) : false;
  });
  const campaign_gated_held_back = candidateRows.length - rows.length;
  if (campaign_gated_held_back > 0) {
    log_info("queue.campaign_gated_rows_held", {
      held_back: campaign_gated_held_back,
      live_campaigns: liveCampaignIds ? liveCampaignIds.size : 0,
    });
  }

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
        processed_count += 1;
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

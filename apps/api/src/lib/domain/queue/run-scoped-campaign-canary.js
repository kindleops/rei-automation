import crypto from "node:crypto";
import { info, warn } from "@/lib/logging/logger.js";
import {
  normalizeSendQueueRow,
  shouldRunSendQueueRow,
  validateSendQueueRowPreclaim,
} from "@/lib/supabase/sms-engine.js";
import { processSendQueueItem as defaultProcessSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";

export const SCOPED_CANARY_MAX_ROWS = 5;

const RUNNABLE_STATUSES = new Set(["queued", "pending", "approved", "ready", "scheduled"]);
const COMPLETED_STATUSES = new Set([
  "sent",
  "delivered",
  "cancelled",
  "canceled",
  "failed",
  "expired",
  "duplicate_blocked",
  "suppressed",
  "blocked",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function metadataObject(row = {}) {
  const metadata = row?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

export function isProofOrNoSendQueueRow(row = {}) {
  const metadata = metadataObject(row);
  return Boolean(
    metadata.proof === true ||
    metadata.proof_mode ||
    metadata.no_send === true ||
    metadata.proof_hydration === true ||
    metadata.launch_mode === "proof_hydration_no_send" ||
    metadata.internal_test_phone === true ||
    metadata.exclude_from_kpis === true
  );
}

export function parseScopedCanaryRequest(input = {}) {
  const campaign_id = clean(input.campaign_id || input.campaignId);
  const canary_run_id = clean(input.canary_run_id || input.canaryRunId);
  const validate_only = input.validate_only === true || input.validateOnly === true;
  const dry_run = input.dry_run === true || input.dryRun === true || validate_only;
  const raw_ids = input.queue_row_ids || input.queueRowIds || input.queue_row_id || input.queueRowId;
  const queue_row_ids = (Array.isArray(raw_ids) ? raw_ids : raw_ids ? [raw_ids] : [])
    .map((value) => clean(value))
    .filter(Boolean);
  const unique_ids = [...new Set(queue_row_ids)];
  const max_rows = Math.max(
    1,
    Math.min(
      SCOPED_CANARY_MAX_ROWS,
      Number(input.max_rows ?? input.maxRows ?? unique_ids.length) || unique_ids.length || SCOPED_CANARY_MAX_ROWS
    )
  );

  const scoped =
    Boolean(campaign_id) &&
    unique_ids.length > 0 &&
    (input.scoped_canary === true ||
      input.scopedCanary === true ||
      input.canary_scope === true ||
      input.canaryScope === true ||
      Boolean(canary_run_id));

  return {
    scoped,
    campaign_id,
    queue_row_ids: unique_ids,
    max_rows,
    canary_run_id: canary_run_id || null,
    validate_only,
    dry_run,
  };
}

export function validateScopedCanaryRequest(request = {}) {
  const errors = [];
  if (!request.campaign_id) errors.push("campaign_id_required");
  if (!request.queue_row_ids?.length) errors.push("queue_row_ids_required");
  if (request.queue_row_ids?.length > SCOPED_CANARY_MAX_ROWS) {
    errors.push("queue_row_ids_exceeds_max_rows");
  }
  if (!request.canary_run_id) errors.push("canary_run_id_required");
  if (request.max_rows > SCOPED_CANARY_MAX_ROWS) errors.push("max_rows_exceeds_cap");
  if (request.queue_row_ids?.length > request.max_rows) errors.push("queue_row_ids_exceeds_max_rows");
  return {
    ok: errors.length === 0,
    errors,
    status: errors.length ? 400 : 200,
  };
}

export function validateScopedCanaryAllowlist(rows = [], request = {}) {
  const campaign_id = clean(request.campaign_id);
  const requested_ids = [...new Set((request.queue_row_ids || []).map((value) => clean(value)).filter(Boolean))];
  const found_ids = new Set(rows.map((row) => clean(row.id)).filter(Boolean));

  if (requested_ids.length > SCOPED_CANARY_MAX_ROWS) {
    return { ok: false, status: 423, reason: "queue_row_ids_exceeds_max_rows", requested_ids };
  }

  const missing_ids = requested_ids.filter((id) => !found_ids.has(id));
  if (missing_ids.length) {
    return {
      ok: false,
      status: 423,
      reason: "scoped_canary_row_not_found_or_wrong_campaign",
      missing_ids,
      campaign_id,
    };
  }

  if (found_ids.size !== requested_ids.length || rows.length !== requested_ids.length) {
    return {
      ok: false,
      status: 423,
      reason: "scoped_canary_allowlist_mismatch",
      requested_ids,
      found_ids: [...found_ids],
      campaign_id,
    };
  }

  for (const row of rows) {
    const row_campaign_id = clean(row.campaign_id);
    if (!row_campaign_id) {
      return { ok: false, status: 423, reason: "scoped_canary_null_campaign_row", queue_row_id: row.id };
    }
    if (row_campaign_id !== campaign_id) {
      return {
        ok: false,
        status: 423,
        reason: "scoped_canary_wrong_campaign_row",
        queue_row_id: row.id,
        expected_campaign_id: campaign_id,
        actual_campaign_id: row_campaign_id,
      };
    }
    if (isProofOrNoSendQueueRow(row)) {
      return { ok: false, status: 423, reason: "scoped_canary_proof_row_excluded", queue_row_id: row.id };
    }
    const status = clean(row.queue_status).toLowerCase();
    if (COMPLETED_STATUSES.has(status)) {
      return {
        ok: false,
        status: 423,
        reason: "scoped_canary_completed_row_excluded",
        queue_row_id: row.id,
        queue_status: status,
      };
    }
    if (!RUNNABLE_STATUSES.has(status)) {
      return {
        ok: false,
        status: 423,
        reason: "scoped_canary_non_runnable_status",
        queue_row_id: row.id,
        queue_status: status,
      };
    }
  }

  return { ok: true, requested_ids, campaign_id };
}

export async function loadScopedCanaryRows(request = {}, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  if (!supabase) throw new Error("scoped_canary_supabase_required");

  const validation = validateScopedCanaryRequest(request);
  if (!validation.ok) {
    return { ok: false, status: validation.status, reason: validation.errors[0], errors: validation.errors };
  }

  const ids = request.queue_row_ids.slice(0, request.max_rows);
  const { data, error } = await supabase
    .from("send_queue")
    .select("*")
    .in("id", ids)
    .eq("campaign_id", request.campaign_id)
    .not("campaign_id", "is", null);

  if (error) {
    return { ok: false, status: 500, reason: "scoped_canary_load_failed", message: error.message };
  }

  const rows = (data || []).map((row) => normalizeSendQueueRow(row));
  const allowlist = validateScopedCanaryAllowlist(rows, { ...request, queue_row_ids: ids });
  if (!allowlist.ok) return { ok: false, ...allowlist };

  const ordered = ids
    .map((id) => rows.find((row) => clean(row.id) === id) || null)
    .filter(Boolean);

  return {
    ok: true,
    rows: ordered,
    requested_ids: ids,
    campaign_id: request.campaign_id,
    canary_run_id: request.canary_run_id,
  };
}

export async function evaluateScopedCanaryCandidates(request = {}, deps = {}) {
  const now = deps.now || new Date().toISOString();
  const loaded = await loadScopedCanaryRows(request, deps);
  if (!loaded.ok) return loaded;

  const candidates = [];
  const excluded = [];

  for (const row of loaded.rows) {
    const preclaim = validateSendQueueRowPreclaim(row, now);
    if (!preclaim.ok) {
      excluded.push({ queue_row_id: row.id, reason: preclaim.reason });
      continue;
    }
    candidates.push(preclaim.row);
  }

  if (candidates.length !== loaded.rows.length) {
    return {
      ok: false,
      status: 423,
      reason: "scoped_canary_preclaim_failed",
      campaign_id: request.campaign_id,
      canary_run_id: request.canary_run_id,
      candidate_ids: candidates.map((row) => row.id),
      excluded,
    };
  }

  return {
    ok: true,
    campaign_id: request.campaign_id,
    canary_run_id: request.canary_run_id,
    requested_ids: loaded.requested_ids,
    candidate_ids: candidates.map((row) => row.id),
    candidates,
    validate_only: request.validate_only === true,
    dry_run: request.dry_run === true,
  };
}

export async function runScopedCampaignCanary(request = {}, deps = {}) {
  const parsed = typeof request.scoped === "boolean" ? request : parseScopedCanaryRequest(request);
  const log_info = deps.info || info;
  const log_warn = deps.warn || warn;
  const process_item = deps.processSendQueueItem || defaultProcessSendQueueItem;
  const supabase = deps.supabase || deps.supabaseClient;
  const now = deps.now || new Date().toISOString();
  const processing_run_id = deps.processing_run_id || crypto.randomUUID();

  const evaluation = await evaluateScopedCanaryCandidates(parsed, { ...deps, now });
  if (!evaluation.ok) return evaluation;

  if (parsed.validate_only || parsed.dry_run) {
    return {
      ok: true,
      scoped_canary: true,
      validate_only: true,
      dry_run: true,
      sent_count: 0,
      campaign_id: evaluation.campaign_id,
      canary_run_id: evaluation.canary_run_id,
      requested_ids: evaluation.requested_ids,
      candidate_ids: evaluation.candidate_ids,
      claimed_count: 0,
      processed_count: 0,
      results: evaluation.candidate_ids.map((queue_row_id) => ({
        ok: true,
        queue_row_id,
        dry_run: true,
        validate_only: true,
      })),
    };
  }

  const results = [];
  let sent_count = 0;
  let failed_count = 0;
  let skipped_count = 0;

  for (const row of evaluation.candidates) {
    try {
      const result = await process_item(row, {
        ...deps,
        now,
        supabaseClient: supabase,
        processing_run_id,
        run_started_at: now,
        canary_run_id: parsed.canary_run_id,
        scoped_canary: true,
      });
      if (result?.sent) {
        sent_count += 1;
        results.push({
          ok: true,
          queue_row_id: row.id,
          sent: true,
          provider_message_id: result.provider_message_id || null,
          final_queue_status: result.final_queue_status || result.queue_status || "sent",
        });
      } else if (result?.skipped) {
        skipped_count += 1;
        results.push({
          ok: true,
          skipped: true,
          queue_row_id: row.id,
          reason: result.reason || "skipped",
          final_queue_status: result.final_queue_status || result.queue_status || null,
        });
      } else {
        failed_count += 1;
        results.push({
          ok: false,
          queue_row_id: row.id,
          reason: result?.reason || "failed",
          final_queue_status: result?.final_queue_status || result?.queue_status || null,
        });
      }
    } catch (error) {
      failed_count += 1;
      results.push({
        ok: false,
        queue_row_id: row.id,
        reason: error?.message || "queue_processing_exception",
      });
      log_warn("scoped_canary.row_failed", { queue_row_id: row.id, error: error?.message });
    }
  }

  log_info("scoped_canary.completed", {
    campaign_id: parsed.campaign_id,
    canary_run_id: parsed.canary_run_id,
    sent_count,
    failed_count,
    skipped_count,
    candidate_ids: evaluation.candidate_ids,
  });

  return {
    ok: failed_count === 0,
    scoped_canary: true,
    campaign_id: parsed.campaign_id,
    canary_run_id: parsed.canary_run_id,
    requested_ids: evaluation.requested_ids,
    candidate_ids: evaluation.candidate_ids,
    claimed_count: evaluation.candidates.length,
    processed_count: results.length,
    sent_count,
    failed_count,
    skipped_count,
    results,
  };
}
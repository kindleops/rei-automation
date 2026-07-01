import crypto from "node:crypto";

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import {
  buildSendQueueDedupeKey,
  enqueueSendQueueItem,
  isReplaceableStaleExpiredQueueRow,
} from "@/lib/supabase/sms-engine.js";
import { checkOutreachSuppression } from "@/lib/domain/outreach/outreach-service.js";
import { evaluatePreSendEligibility } from "@/lib/domain/outbound/presend-eligibility-engine.js";
import { computeNextValidSendInstant } from "@/lib/domain/campaigns/campaign-convert-to-live.js";
import { countActiveLiveQueueRows } from "@/lib/domain/campaigns/run-campaign-outbound-feeder.js";
import { isProofQueueRow } from "@/lib/domain/campaigns/campaign-sync-metrics.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";

const STALE_FAILED_REASON = "stale_runnable_row_expired";
const SUPERSESSION_REASON = "premature_stale_expiration_recovery";
const RECOVERABLE_TARGET_STATUSES = new Set(["ready", "planned", "queued", "active"]);
const ACTIVE_QUEUE_STATUSES = [
  "queued",
  "scheduled",
  "pending",
  "ready",
  "approved",
  "processing",
  "sending",
];

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function rowHasSendEvidence(row = {}) {
  return Boolean(
    row.sent_at ||
      row.delivered_at ||
      clean(row.provider_message_id) ||
      clean(row.textgrid_message_id)
  );
}

function metadataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function targetKeyFromRow(row = {}) {
  const targetId = clean(row.campaign_target_id);
  if (targetId) return `target:${targetId}`;
  const phone = normalizePhone(row.to_phone_number);
  if (phone) return `phone:${phone}`;
  return `row:${clean(row.id)}`;
}

export function isRecoveryCandidateExpiredRow(row = {}) {
  if (lower(row.queue_status) !== "expired") return false;
  if (clean(row.failed_reason) !== STALE_FAILED_REASON) return false;
  if (rowHasSendEvidence(row)) return false;
  if (isProofQueueRow(row)) return false;
  const metadata = metadataObject(row.metadata);
  if (metadata.no_send === true || metadata.proof_no_send === true) return false;
  if (clean(metadata.launch_mode) === "proof_hydration_no_send") return false;
  return Boolean(normalizePhone(row.to_phone_number));
}

export async function analyzeReplaceableExpiredTargets(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const { data: rows, error } = await supabase
    .from("send_queue")
    .select(
      "id,campaign_id,campaign_target_id,to_phone_number,from_phone_number,queue_status,failed_reason,sent_at,delivered_at,provider_message_id,textgrid_message_id,scheduled_for,created_at,updated_at,metadata,template_id,message_body,master_owner_id,prospect_id,property_id,phone_id,market,timezone,touch_number,dedupe_key"
    )
    .eq("campaign_id", campaignId);
  if (error) throw error;

  const allRows = Array.isArray(rows) ? rows : [];
  const sentPhones = new Set();
  const sentTargets = new Set();
  const activePhones = new Set();
  const activeTargets = new Set();

  for (const row of allRows) {
    const phone = normalizePhone(row.to_phone_number);
    const targetId = clean(row.campaign_target_id);
    if (rowHasSendEvidence(row)) {
      if (phone) sentPhones.add(phone);
      if (targetId) sentTargets.add(targetId);
    }
    if (ACTIVE_QUEUE_STATUSES.includes(lower(row.queue_status))) {
      if (phone) activePhones.add(phone);
      if (targetId) activeTargets.add(targetId);
    }
  }

  const expiredByTarget = new Map();
  for (const row of allRows) {
    if (!isRecoveryCandidateExpiredRow(row)) continue;
    const key = targetKeyFromRow(row);
    const existing = expiredByTarget.get(key);
    if (!existing || new Date(row.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
      expiredByTarget.set(key, row);
    }
  }

  const replaceable = [];
  const skipped = [];
  for (const [key, row] of expiredByTarget.entries()) {
    const phone = normalizePhone(row.to_phone_number);
    const targetId = clean(row.campaign_target_id);
    let skipReason = null;
    if (sentPhones.has(phone)) skipReason = "sent_evidence_for_phone";
    else if (targetId && sentTargets.has(targetId)) skipReason = "sent_evidence_for_target";
    else if (activePhones.has(phone)) skipReason = "active_queue_row_for_phone";
    else if (targetId && activeTargets.has(targetId)) skipReason = "active_queue_row_for_target";
    if (skipReason) {
      skipped.push({ key, row_id: row.id, campaign_target_id: targetId || null, reason: skipReason });
      continue;
    }
    replaceable.push({ key, row });
  }

  replaceable.sort(
    (a, b) =>
      new Date(a.row.scheduled_for || a.row.created_at).getTime() -
      new Date(b.row.scheduled_for || b.row.created_at).getTime()
  );

  return {
    campaign_id: campaignId,
    expired_row_count: allRows.filter((row) => clean(row.failed_reason) === STALE_FAILED_REASON).length,
    unique_expired_targets: expiredByTarget.size,
    replaceable_unique_targets: replaceable.length,
    skipped_unique_targets: skipped.length,
    replaceable,
    skipped,
    sent_unique_targets: sentTargets.size,
    active_unique_targets: activeTargets.size,
  };
}

async function validateRecoveryCandidate(row = {}, campaign = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const phone = normalizePhone(row.to_phone_number);
  const metadata = metadataObject(row.metadata);
  const candidateSnapshot = metadataObject(metadata.candidate_snapshot);
  const targetSnapshot = metadataObject(metadata.target_snapshot);
  const outreachSnapshot = metadataObject(metadata.outreach_snapshot);
  const rawCandidate = metadataObject(candidateSnapshot.raw);

  if (!phone) return { ok: false, reason: "missing_phone" };
  if (!clean(row.message_body)) return { ok: false, reason: "missing_message_body" };
  if (!clean(row.template_id)) return { ok: false, reason: "missing_template_id" };
  if (!clean(row.from_phone_number)) return { ok: false, reason: "missing_sender_number" };
  if (outreachSnapshot.wrong_number === true) return { ok: false, reason: "wrong_number" };
  if (outreachSnapshot.true_post_contact_suppression === true) {
    return { ok: false, reason: "suppressed_post_contact" };
  }

  const campaignTargetId = clean(row.campaign_target_id || targetSnapshot.campaign_target_id);
  if (campaignTargetId) {
    const targetQuery = await supabase
      .from("campaign_targets")
      .select("id,target_status,suppression_status,routing_status,template_status,to_phone_number")
      .eq("id", campaignTargetId)
      .maybeSingle();
    if (targetQuery.error) throw targetQuery.error;
    if (!targetQuery.data) return { ok: false, reason: "campaign_target_missing" };
    if (!RECOVERABLE_TARGET_STATUSES.has(lower(targetQuery.data.target_status))) {
      return { ok: false, reason: `campaign_target_not_recoverable:${targetQuery.data.target_status}` };
    }
    if (clean(targetQuery.data.suppression_status)) {
      return { ok: false, reason: "campaign_target_suppressed" };
    }
  }

  const senderQuery = await supabase
    .from("textgrid_numbers")
    .select("id,phone_number,status,market")
    .eq("phone_number", normalizePhone(row.from_phone_number))
    .maybeSingle();
  if (senderQuery.error) throw senderQuery.error;
  if (!senderQuery.data || lower(senderQuery.data.status) !== "active") {
    return { ok: false, reason: "sender_not_active" };
  }

  const masterOwnerId = clean(row.master_owner_id || candidateSnapshot.master_owner_id);
  if (masterOwnerId) {
    const suppression = await checkOutreachSuppression(masterOwnerId, phone, { supabase });
    if (suppression?.suppressed) {
      return { ok: false, reason: "suppressed", detail: suppression.reason || null };
    }
  }

  const eligibility = evaluatePreSendEligibility(
    {
      ...rawCandidate,
      ...candidateSnapshot,
      likely_owner: rawCandidate.likely_owner ?? candidateSnapshot.likely_owner,
      likely_renting: rawCandidate.likely_renting ?? candidateSnapshot.likely_renting,
      matching_flags:
        rawCandidate.matching_flags ||
        candidateSnapshot.matching_flags ||
        rawCandidate.prospect_matching_flags,
      identity_status: targetSnapshot.identity_status || rawCandidate.identity_status,
    },
    {
      allow_identity_unknown: true,
      allow_weak_identity_outbound: true,
      identity_gate_mode: clean(campaign.identity_policy) || "auto",
    }
  );
  if (!eligibility.eligible && eligibility.block_reason === "RENTER_NOT_OWNER") {
    return { ok: false, reason: eligibility.block_reason };
  }

  return { ok: true, phone, sender: senderQuery.data };
}

function resolveRecoveryScheduleCursor(campaign = {}, activeRows = [], intervalSeconds = 45) {
  const schedule = computeNextValidSendInstant(campaign);
  let cursor = new Date(schedule.scheduled_for).getTime();
  for (const row of activeRows) {
    const ts = new Date(row.scheduled_for || row.scheduled_for_utc || 0).getTime();
    if (Number.isFinite(ts) && ts >= cursor) {
      cursor = ts + intervalSeconds * 1000;
    }
  }
  return cursor;
}

function buildRecoveryQueueRow({
  expiredRow,
  campaign,
  scheduledFor,
  recoveryExecutionId,
  sender,
}) {
  const metadata = metadataObject(expiredRow.metadata);
  const candidateSnapshot = metadataObject(metadata.candidate_snapshot);
  const targetSnapshot = metadataObject(metadata.target_snapshot);
  const scheduledIso = new Date(scheduledFor).toISOString();
  const campaignTargetId = clean(expiredRow.campaign_target_id || targetSnapshot.campaign_target_id);
  const phone = normalizePhone(expiredRow.to_phone_number);
  const templateId = clean(expiredRow.template_id);
  const touchNumber = asPositiveInteger(
    expiredRow.touch_number || candidateSnapshot.touch_number,
    1
  );
  const dedupeKey = buildSendQueueDedupeKey({
    master_owner_id: clean(expiredRow.master_owner_id || candidateSnapshot.master_owner_id),
    property_id: clean(expiredRow.property_id || candidateSnapshot.property_id),
    to_phone_number: phone,
    template_use_case:
      clean(metadata.template_snapshot?.template_use_case) ||
      clean(campaign.objective) ||
      "ownership_check",
    touch_number: touchNumber,
    campaign_session_id: campaign.id,
  });
  const queueKey = `campaign-recovery:${crypto
    .createHash("sha1")
    .update([campaign.id, campaignTargetId || phone, templateId, scheduledIso, recoveryExecutionId].join("|"))
    .digest("hex")}`;

  return {
    queue_key: queueKey,
    queue_id: queueKey,
    queue_status: "scheduled",
    scheduled_for: scheduledIso,
    scheduled_for_utc: scheduledIso,
    message_body: clean(expiredRow.message_body),
    message_text: clean(expiredRow.message_body),
    rendered_message: clean(expiredRow.message_body),
    to_phone_number: phone,
    from_phone_number: normalizePhone(expiredRow.from_phone_number),
    textgrid_number_id: clean(sender?.id || expiredRow.textgrid_number_id),
    textgrid_number: normalizePhone(expiredRow.from_phone_number),
    master_owner_id: clean(expiredRow.master_owner_id || candidateSnapshot.master_owner_id) || null,
    prospect_id: clean(expiredRow.prospect_id || candidateSnapshot.prospect_id) || null,
    property_id: clean(expiredRow.property_id || candidateSnapshot.property_id) || null,
    phone_id: clean(expiredRow.phone_id || candidateSnapshot.phone_id) || null,
    market: clean(expiredRow.market || candidateSnapshot.market || campaign.market) || null,
    property_address_state: clean(candidateSnapshot.state || campaign.state) || null,
    timezone: clean(expiredRow.timezone || candidateSnapshot.timezone || "America/Los_Angeles"),
    template_id: templateId,
    selected_template_id: templateId,
    template_key: templateId,
    touch_number: touchNumber,
    dedupe_key: dedupeKey,
    campaign_id: campaign.id,
    campaign_target_id: campaignTargetId || null,
    type: "campaign_recovery",
    source: "premature_stale_expiration_recovery",
    thread_key: phone,
    metadata: {
      ...metadata,
      source: "premature_stale_expiration_recovery",
      launch_mode: "guarded_live_queue_creation",
      recovery_execution_id: recoveryExecutionId,
      supersedes_queue_row_id: expiredRow.id,
      supersession_reason: SUPERSESSION_REASON,
      original_campaign_target_id: campaignTargetId || null,
      recovered_from_failed_reason: STALE_FAILED_REASON,
      recovered_at: new Date().toISOString(),
      candidate_snapshot: candidateSnapshot,
      target_snapshot: targetSnapshot,
      dedupe_key: dedupeKey,
    },
  };
}

export async function recoverCampaignStaleExpiredTargets(campaignId, options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const dryRun = options.dry_run === true;
  const recoveryExecutionId =
    clean(options.recovery_execution_id) ||
    `la-stale-recovery:${campaignId}:${Date.now()}`;

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();
  if (campaignError) throw campaignError;
  if (!campaign) return { ok: false, error: "campaign_not_found" };

  const analysis = await analyzeReplaceableExpiredTargets(campaignId, deps);
  const activeLiveRows = await countActiveLiveQueueRows(supabase, campaignId);
  const batchMax = asPositiveInteger(campaign.batch_max, 50);
  const availableSlots = Math.max(0, batchMax - activeLiveRows);
  const requestedLimit = asPositiveInteger(options.limit, availableSlots);
  const createLimit = Math.min(availableSlots, requestedLimit, analysis.replaceable_unique_targets);

  const { data: activeScheduledRows } = await supabase
    .from("send_queue")
    .select("id,scheduled_for,scheduled_for_utc,queue_status,metadata")
    .eq("campaign_id", campaignId)
    .in("queue_status", ["scheduled", "queued", "pending", "processing", "sending"])
    .order("scheduled_for", { ascending: true });
  const liveScheduled = (activeScheduledRows || []).filter((row) => !isProofQueueRow(row));

  const intervalSeconds = asPositiveInteger(
    campaign.send_interval_seconds || options.spread_interval_seconds,
    45
  );
  let scheduleCursor = resolveRecoveryScheduleCursor(campaign, liveScheduled, intervalSeconds);

  const created = [];
  const validationSkipped = [];
  let candidatesScanned = 0;
  for (const entry of analysis.replaceable) {
    if (created.length >= createLimit) break;
    candidatesScanned += 1;
    const expiredRow = entry.row;
    const validation = await validateRecoveryCandidate(expiredRow, campaign, deps);
    if (!validation.ok) {
      validationSkipped.push({
        row_id: expiredRow.id,
        campaign_target_id: expiredRow.campaign_target_id || null,
        reason: validation.reason,
        detail: validation.detail || null,
      });
      continue;
    }

    const payload = buildRecoveryQueueRow({
      expiredRow,
      campaign,
      scheduledFor: scheduleCursor,
      recoveryExecutionId,
      sender: validation.sender,
    });
    scheduleCursor += intervalSeconds * 1000;

    if (dryRun) {
      created.push({
        dry_run: true,
        supersedes_queue_row_id: expiredRow.id,
        campaign_target_id: payload.campaign_target_id,
        scheduled_for: payload.scheduled_for,
        to_phone_number: payload.to_phone_number,
      });
      continue;
    }

    const insertResult = await enqueueSendQueueItem(payload, { supabase });
    if (insertResult?.ok === false && !insertResult?.idempotent_replay) {
      validationSkipped.push({
        row_id: expiredRow.id,
        campaign_target_id: expiredRow.campaign_target_id || null,
        reason: insertResult.reason || "enqueue_failed",
      });
      continue;
    }
    created.push({
      supersedes_queue_row_id: expiredRow.id,
      replacement_row_id:
        insertResult.queue_row_id || insertResult.item_id || insertResult.raw?.id || null,
      campaign_target_id: payload.campaign_target_id,
      scheduled_for: payload.scheduled_for,
      to_phone_number: payload.to_phone_number,
      replaced_expired_row: Boolean(insertResult.replaced_expired_row),
      idempotent_replay: Boolean(insertResult.idempotent_replay),
    });
  }

  return {
    ok: true,
    campaign_id: campaignId,
    dry_run: dryRun,
    recovery_execution_id: recoveryExecutionId,
    batch_max: batchMax,
    active_live_rows_before: activeLiveRows,
    available_slots: availableSlots,
    create_limit: createLimit,
    replaceable_unique_expired_targets: analysis.replaceable_unique_targets,
    sent_unique_targets_preserved: analysis.sent_unique_targets,
    scheduled_unique_targets_preserved: analysis.active_unique_targets,
    replacement_rows_created: dryRun ? 0 : created.filter((row) => row.replacement_row_id).length,
    planned_replacements: created,
    validation_skipped: validationSkipped,
    candidates_scanned: candidatesScanned,
    analysis,
  };
}
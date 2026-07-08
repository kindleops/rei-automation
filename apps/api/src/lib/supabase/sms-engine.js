import crypto from "node:crypto";

import {
  mapTextgridFailureBucket,
  normalizePhone,
} from "@/lib/providers/textgrid.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { captureRouteException, addSentryBreadcrumb } from "@/lib/monitoring/sentry.js";
import { captureSystemEvent } from "@/lib/analytics/posthog-server.js";
import { sendCriticalAlert } from "@/lib/alerts/discord.js";
import { info, warn } from "@/lib/logging/logger.js";
import { isManualInboxSend, isUnknownAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";
import { isUuid } from "@/lib/utils/is-uuid.js";
import { enrichMessageEventContext, buildMessageEventEnrichmentUpdate } from "@/lib/domain/inbox/enrich-message-event-context.js";
import {
  classifyThreadFromChronology,
  patchToInboxThreadState,
} from "@/lib/domain/inbox/classify-thread-from-chronology.js";
import { buildThreadStatePatchFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { updateContactOutreachState } from "@/lib/domain/outreach/outreach-service.js";
import {
  normalizeTextGridFailure,
  textGridFailureMetadata,
} from "@/lib/domain/messaging/textgrid-failure-normalization.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { validateOutboundSmsPayload } from "@/lib/domain/messaging/MessageValidationService.js";
import { normalizeTimestamp } from "@/lib/utils/normalize-timestamp.js";
import {
  mergeDeliveryReceiptState,
  mergeQueueDeliveryState,
  shouldPromoteThreadDelivery,
} from "@/lib/domain/delivery/delivery-receipt-reconcile.js";
import { getSystemValue } from "@/lib/system-control.js";
import {
  evaluateGlobalSendBrakeState,
  rowCampaignId,
  shouldHoldRowFromStaleExpiration,
} from "@/lib/domain/queue/queue-send-brake-state.js";
import { normalizeCampaignStatus } from "@/lib/domain/campaigns/campaign-state-machine.js";
import { attachOutboundProvenance } from "@/lib/domain/automation/outbound-provenance.js";

const SEND_QUEUE_TABLE = "send_queue";
const MESSAGE_EVENTS_TABLE = "message_events";
const TEXTGRID_NUMBERS_TABLE = "textgrid_numbers";
const WEBHOOK_LOG_TABLE = "webhook_log";
export const QUEUE_RECONCILE_LIFECYCLE_VERSION = "stale-expiration-containment-v3";

const CANONICAL_ACTIVE_QUEUE_STATUSES = ["queued", "pending", "approval", "scheduled", "processing"];
const STALE_RUNNABLE_FAILED_REASON = "stale_runnable_row_expired";
const CANONICAL_TERMINAL_QUEUE_STATUSES = [
  "sent",
  "delivered",
  "carrier_blocked",
  "duplicate_blocked",
  "invalid_number",
  "opted_out",
  "failed_transport",
  "failed",
  "blocked",
  "cancelled",
  "expired",
];

function mapTransportTerminalStatus({ error_message = "", error_status = "" } = {}) {
  const normalized = normalizeTextGridFailure({ error_message, error_status, status: "failed" });
  if (normalized.failure_class === "content_filter_blocked") return "carrier_blocked";
  if (normalized.failure_class === "recipient_opted_out") return "opted_out";
  if (normalized.failure_class === "invalid_to_number") return "invalid_number";

  const msg = lower(error_message);
  const status = lower(error_status);
  const combined = `${msg} ${status}`;
  if (combined.includes("duplicate")) return "duplicate_blocked";
  if (combined.includes("21610") || combined.includes("opt out") || combined.includes("opt-out") || combined.includes("stop")) return "opted_out";
  if (combined.includes("invalid") || combined.includes("not a valid phone") || combined.includes("unknown destination")) return "invalid_number";
  if (combined.includes("carrier") || combined.includes("spam") || combined.includes("blocked")) return "carrier_blocked";
  return "failed_transport";
}

function legacyFailureBucketForTextGrid(normalized = {}, fallbackInput = {}) {
  if (normalized.failure_class === "content_filter_blocked") return "Spam";
  if (normalized.failure_class === "recipient_opted_out") return "DNC";
  if (normalized.failure_class === "invalid_to_number") return "Hard Bounce";
  if (normalized.failure_class === "recipient_out_of_credit") return "Soft Bounce";
  return mapTextgridFailureBucket(fallbackInput) || null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(value, minutes = 5) {
  const base = new Date(value || nowIso());
  base.setMinutes(base.getMinutes() + Number(minutes || 0));
  return base.toISOString();
}

// Returns true for provider errors that must never be retried on the same from/to pair.
function isNonRetryableProviderError(error) {
  if (!error) return false;
  const classified = classifyTextGridProviderError(error);
  if (classified.compliance_related || classified.is_terminal) return true;
  if (error.retryable === false) return true;
  return false;
}

function hashPhoneForMetrics(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

async function persistProviderBlacklistSuppression(row = {}, error = {}, options = {}) {
  const classified = classifyTextGridProviderError(error, {
    campaign_id: row?.metadata?.campaign_id || null,
    market: row?.market || row?.metadata?.market || null,
    sender_hash: hashPhoneForMetrics(row?.from_phone_number),
    destination_hash: hashPhoneForMetrics(row?.to_phone_number),
  });
  if (!classified.compliance_related || classified.provider_code !== "21610") {
    return { ok: false, skipped: true };
  }

  const supabase_client = options.supabase || options.supabaseClient || defaultSupabase;
  const to_phone = normalizePhone(row?.to_phone_number);
  const from_phone = normalizePhone(row?.from_phone_number);
  const now = options.now || nowIso();

  if (!to_phone) return { ok: false, reason: "missing_to_phone_number" };

  try {
    await supabase_client.from("sms_suppression_list").upsert(
      {
        phone_e164: to_phone,
        sender_phone_e164: from_phone || null,
        phone_number: to_phone,
        suppression_type: "provider_blacklist_pair",
        suppression_reason: classified.provider_message || "provider_blacklist_21610",
        is_active: true,
        suppressed_at: now,
        source: "textgrid_21610",
      },
      { onConflict: "phone_e164,sender_phone_e164", ignoreDuplicates: false }
    );
  } catch (suppression_error) {
    warn("provider_blacklist_suppression_persist_failed", {
      queue_row_id: row?.id || null,
      message: suppression_error?.message || "unknown_error",
    });
    return { ok: false, reason: "suppression_persist_failed" };
  }

  captureSystemEvent("queue.send.suppressed", {
    reason: "provider_blacklist",
    provider_code: classified.provider_code,
    campaign_id: row?.metadata?.campaign_id || null,
    market: row?.market || null,
    sender_hash: hashPhoneForMetrics(from_phone),
    destination_hash: hashPhoneForMetrics(to_phone),
  });

  return { ok: true, scope: "pair_and_recipient_sms" };
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableBoolean(value, fallback = null) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return fallback;
  const normalized = lower(value);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function normalizeQueueRowId(value, fallback = null) {
  if (value === null || value === undefined) return fallback;

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  }

  const normalized = clean(value);
  if (!normalized) return fallback;

  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  }

  return normalized;
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && clean(value) !== "") {
      return value;
    }
  }
  return null;
}

function firstToken(value) {
  const normalized = clean(value);
  if (!normalized) return "";
  return clean(normalized.split(/\s+/).filter(Boolean)[0] || "");
}

function resolveQueueSellerFirstNameFromSources(row = null) {
  const safe_row = ensureObject(row);
  const metadata = ensureObject(safe_row.metadata);
  const queue_context = ensureObject(metadata.queue_context);
  const snapshot = ensureObject(metadata.candidate_snapshot);

  return clean(
    pickFirst(
      safe_row.seller_first_name,
      firstToken(safe_row.seller_name),
      safe_row.contact_first_name,
      metadata.seller_first_name,
      queue_context.seller_first_name,
      snapshot.seller_first_name,
      snapshot.prospect_first_name,
      snapshot.phone_first_name,
      snapshot.owner_first_name,
      firstToken(snapshot.display_name),
      firstToken(snapshot.seller_full_name),
      firstToken(snapshot.phone_full_name),
      firstToken(snapshot.owner_display_name)
    )
  );
}

function getQueueRowDestinationCandidates(row = null) {
  const safe_row = ensureObject(row);
  const metadata = ensureObject(safe_row.metadata);
  const queue_context = ensureObject(metadata.queue_context);

  return [
    ["to_phone_number", safe_row.to_phone_number],
    ["metadata.resolved_to_phone_number", metadata.resolved_to_phone_number],
    ["metadata.canonical_e164", metadata.canonical_e164],
    ["metadata.phone_hidden", metadata.phone_hidden],
    ["metadata.raw_phone_number", metadata.raw_phone_number],
    ["metadata.normalized_target", metadata.normalized_target],
    ["metadata.queue_context.phone_e164", queue_context.phone_e164],
    ["metadata.queue_context.canonical_e164", queue_context.canonical_e164],
    ["metadata.queue_context.phone_hidden", queue_context.phone_hidden],
  ];
}

function toTimestamp(value) {
  return normalizeTimestamp(value);
}

function lowerStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function rowHasSendEvidence(row = {}) {
  return Boolean(
    clean(row.provider_message_id) ||
    clean(row.textgrid_message_id) ||
    row.sent_at ||
    row.delivered_at
  );
}

export function isReplaceableStaleExpiredQueueRow(row = {}) {
  if (lowerStatus(row.queue_status) !== "expired") return false;
  if (clean(row.failed_reason) !== "stale_runnable_row_expired") return false;
  if (rowHasSendEvidence(row)) return false;
  return true;
}

export function isRowEligibleForStaleExpiration(row = {}, options = {}) {
  const now = options.now || nowIso();
  const now_ts = toTimestamp(now) ?? Date.now();
  const status = lowerStatus(row.queue_status);

  if (rowHasSendEvidence(row)) {
    return false;
  }

  // Containment: never stale-expire scheduled or queued rows from created/updated age.
  if (["scheduled", "queued"].includes(status)) {
    return false;
  }

  // Only allow stale_runnable expiration for processing rows whose lease has expired.
  if (status !== "processing") {
    return false;
  }

  if (row.is_locked) {
    return false;
  }

  const lease_minutes = Math.max(Number(options.lease_minutes ?? 10), 1);
  const lease_cutoff_ts =
    options.lease_cutoff_ts ??
    (now_ts - lease_minutes * 60 * 1000);
  const timeout_at =
    toTimestamp(row.metadata?.processing_timeout_at) ??
    toTimestamp(row.locked_at) ??
    toTimestamp(row.updated_at);

  if (timeout_at === null) {
    return false;
  }

  return timeout_at <= lease_cutoff_ts;
}

function emitFutureRowExpirationBlocked(row = {}, context = {}) {
  const schedule_at = row.scheduled_for || row.scheduled_for_utc || null;
  warn("queue.lifecycle.FUTURE_ROW_EXPIRATION_BLOCKED", {
    event: "FUTURE_ROW_EXPIRATION_BLOCKED",
    row_id: row.id,
    queue_status: row.queue_status,
    scheduled_for: schedule_at,
    now: context.now || nowIso(),
    caller_route: context.caller_route || null,
    deploy_sha: context.deploy_sha || null,
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
  });
}

async function applySendQueueLifecyclePatch(supabase, { id, patch, context = {} }) {
  const is_stale_runnable_expire =
    lowerStatus(patch.queue_status) === "expired" &&
    clean(patch.failed_reason) === STALE_RUNNABLE_FAILED_REASON;

  if (is_stale_runnable_expire) {
    const stale_cutoff =
      context.stale_cutoff ||
      new Date(
        (toTimestamp(context.now || nowIso()) ?? Date.now()) -
          Math.max(Number(context.stale_minutes ?? 180), 1) * 60 * 1000
      ).toISOString();
    const metadata = {
      ...(patch.metadata || {}),
      lifecycle_caller_route: context.caller_route || null,
      lifecycle_deploy_sha: context.deploy_sha || null,
    };

    const { data, error } = await supabase.rpc("apply_send_queue_stale_expiration", {
      p_row_id: id,
      p_stale_cutoff: stale_cutoff,
      p_caller_route: context.caller_route || null,
      p_deploy_sha: context.deploy_sha || null,
      p_metadata: metadata,
    });

    if (error) {
      throw error;
    }

    if (data?.blocked) {
      emitFutureRowExpirationBlocked({ id, ...patch }, context);
      return { applied: false, blocked: true };
    }

    return { applied: Boolean(data?.applied), blocked: false };
  }

  const { error } = await supabase.from(SEND_QUEUE_TABLE).update(patch).eq("id", id);
  if (error) {
    throw error;
  }
  return { applied: true, blocked: false };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isLifecycleDebugEnabled() {
  const flag = lower(process.env.SMS_LIFECYCLE_DEBUG || process.env.VITE_SHOW_DEBUG || "");
  return ["1", "true", "yes", "on"].includes(flag);
}

function debugLifecycle(event, payload = {}) {
  if (!isLifecycleDebugEnabled()) return;
  info(`sms_lifecycle.${event}`, payload);
}

function normalizeQueueStatusValue(value) {
  const raw = lower(value);
  if (!raw) return "";
  if (raw === "delivered") return "sent";
  return raw;
}

const TERMINAL_QUEUE_STATUSES = new Set([
  "sent",
  "failed",
  "blocked",
  "paused_name_missing",
  "paused_deferred_unresolved",
  "paused_invalid_queue_row",
  "paused_duplicate",
  "paused_global_lock",
  "paused_max_retries",
  "cancelled",
]);

function isTerminalQueueStatus(value) {
  return TERMINAL_QUEUE_STATUSES.has(normalizeQueueStatusValue(value));
}

function hasCurrentProcessingRun(row = null, options = {}) {
  const expected_run_id = clean(options.processing_run_id || options.run_id);
  if (!expected_run_id) return true;
  return clean(row?.metadata?.processing_run_id) === expected_run_id;
}

function getSupabase(deps = {}) {
  if (!deps.supabase && !deps.supabaseClient && !hasSupabaseConfig()) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return deps.supabase || deps.supabaseClient || defaultSupabase;
}

export function normalizeSendQueueRow(row) {
  const safe_row = ensureObject(row);
  const resolved_seller_first_name = resolveQueueSellerFirstNameFromSources(safe_row);
  const row_id = normalizeQueueRowId(
    safe_row.id ??
      safe_row.queue_row_id ??
      safe_row.queue_item_id ??
      safe_row.item_id,
    null
  );
  const body = clean(safe_row.message_body || safe_row.message_text || "");

  const normalized_to_phone = normalizePhone(safe_row.to_phone_number || null) || null;
  const normalized_from_phone = normalizePhone(safe_row.from_phone_number || null) || null;
  const raw_thread_key = clean(safe_row.thread_key || safe_row.metadata?.thread_key) || null;
  const canonical_thread_key =
    normalized_to_phone ||
    normalizePhone(raw_thread_key) ||
    raw_thread_key ||
    null;

  return {
    id: row_id,
    queue_row_id: row_id,
    queue_item_id: row_id,
    item_id: row_id,
    queue_key: safe_row.queue_key || safe_row.queue_id,
    queue_id: safe_row.queue_id || safe_row.queue_key,
    queue_status: String(safe_row.queue_status || "").toLowerCase(),
    scheduled_for:
      safe_row.scheduled_for ||
      safe_row.scheduled_for_utc ||
      safe_row.scheduled_for_local ||
      safe_row.created_at ||
      null,
    send_priority: Number(safe_row.send_priority ?? 5),
    is_locked: Boolean(safe_row.is_locked),
    locked_at: safe_row.locked_at || null,
    lock_token: safe_row.lock_token || null,
    retry_count: Number(safe_row.retry_count ?? 0),
    max_retries: Number(safe_row.max_retries ?? 3),
    next_retry_at: safe_row.next_retry_at || null,
    message_body: body,
    message_text: safe_row.message_text || safe_row.message_body || "",
    to_phone_number: normalized_to_phone,
    from_phone_number: normalized_from_phone,
    provider_message_id: safe_row.provider_message_id || null,
    master_owner_id: safe_row.master_owner_id || null,
    prospect_id: safe_row.prospect_id || null,
    property_id: safe_row.property_id || null,
    // Canonical phones.phone_id is ph_-prefixed TEXT; phone_number_id is a UUID column.
    // Preserve the text id as phone_id (rescuing a mis-placed non-UUID phone_number_id),
    // and only keep a genuine UUID in phone_number_id — never coerce ph_ text into it.
    phone_id:
      safe_row.phone_id ||
      (isUuid(safe_row.phone_number_id) ? null : safe_row.phone_number_id) ||
      safe_row.phone_item_id ||
      null,
    phone_number_id: isUuid(safe_row.phone_number_id) ? safe_row.phone_number_id : null,
    market_id: safe_row.market_id || null,
    sms_agent_id:
      safe_row.sms_agent_id ||
      safe_row.agent_id ||
      safe_row.metadata?.agent_id ||
      safe_row.metadata?.legacy_agent_id ||
      null,
    selected_agent_id:
      safe_row.selected_agent_id ||
      safe_row.metadata?.selected_agent_id ||
      safe_row.metadata?.routing_agent_id ||
      null,
    agent_name: clean(safe_row.agent_name) || null,
    textgrid_number_id: safe_row.textgrid_number_id || null,
    template_id: safe_row.template_id || null,
    seller_first_name: resolved_seller_first_name || null,
    seller_display_name: safe_row.seller_display_name || null,
    property_address: safe_row.property_address || null,
    property_type: safe_row.property_type || null,
    owner_type: safe_row.owner_type || null,
    timezone: safe_row.timezone || "America/Chicago",
    contact_window: safe_row.contact_window || null,
    touch_number: safe_row.touch_number || null,
    dnc_check: safe_row.dnc_check || null,
    current_stage: safe_row.current_stage || null,
    message_type: safe_row.message_type || null,
    use_case_template: safe_row.use_case_template || null,
    personalization_tags_used: safe_row.personalization_tags_used || null,
    character_count: Number(safe_row.character_count ?? body.length),
    metadata: ensureObject(safe_row.metadata),
    scheduled_for_local: safe_row.scheduled_for_local || null,
    scheduled_for_utc: safe_row.scheduled_for_utc || null,
    created_at: safe_row.created_at || null,
    updated_at: safe_row.updated_at || null,
    sent_at: safe_row.sent_at || null,
    delivered_at: safe_row.delivered_at || null,
    failed_reason: safe_row.failed_reason || null,
    guard_status: safe_row.guard_status || null,
    guard_reason: safe_row.guard_reason || null,
    paused_reason: safe_row.paused_reason || null,
    delivery_confirmed: safe_row.delivery_confirmed || null,
    // Offer record sync tracking (added 2026-04-22)
    cash_offer_snapshot_id:    safe_row.cash_offer_snapshot_id    || null,
    type: safe_row.type || null,
    thread_key: canonical_thread_key,
    owner_id: safe_row.owner_id || null,
    agent_id:
      safe_row.sms_agent_id ||
      safe_row.agent_id ||
      safe_row.metadata?.agent_id ||
      safe_row.metadata?.legacy_agent_id ||
      null,
    template_source: safe_row.template_source || null,
    template_selected: clean(safe_row.template_selected) || null,
    rendered_message: safe_row.rendered_message || null,
    sms_eligible: safe_row.sms_eligible,
    routing_allowed: safe_row.routing_allowed,
    safety_status: safe_row.safety_status || null,
    source_event_id: safe_row.source_event_id || null,
    inbound_message_id: safe_row.inbound_message_id || null,
    detected_intent: safe_row.detected_intent || null,
    stage_before: safe_row.stage_before || null,
    stage_after: safe_row.stage_after || null,
    textgrid_message_id: safe_row.textgrid_message_id || null,
    textgrid_number: clean(safe_row.textgrid_number) || null,
    market: safe_row.market || null,
    offer_podio_item_id:       safe_row.offer_podio_item_id       || null,
    offer_record_sync_status:  safe_row.offer_record_sync_status  || null,
    offer_record_sync_error:   safe_row.offer_record_sync_error   || null,
    offer_record_synced_at:    safe_row.offer_record_synced_at    || null,
    campaign_id: safe_row.campaign_id || null,
    campaign_target_id: safe_row.campaign_target_id || null,
    campaign_send_window_id: safe_row.campaign_send_window_id || null,
    dedupe_key: clean(safe_row.dedupe_key || safe_row.metadata?.idempotency_key) || null,
  };
}

export function resolveQueueDestinationPhone(row = null) {
  for (const [source, candidate] of getQueueRowDestinationCandidates(row)) {
    const normalized = normalizePhone(candidate);
    if (normalized) {
      return {
        phone: normalized,
        source,
        raw: clean(candidate) || null,
      };
    }
  }

  return {
    phone: "",
    source: null,
    raw: null,
  };
}

function canonicalThreadKeyForDirection(direction, from_phone_number, to_phone_number) {
  const dir = clean(direction).toLowerCase();
  const from = normalizePhone(from_phone_number) || null;
  const to = normalizePhone(to_phone_number) || null;
  if (dir === "inbound") return from || to || null;
  if (dir === "outbound") return to || from || null;
  return to || from || null;
}

export function shouldRunSendQueueRow(row, now = nowIso()) {
  const normalized = normalizeSendQueueRow(row);
  const metadata = ensureObject(normalized.metadata);
  const destination = resolveQueueDestinationPhone(normalized);
  const now_ts = toTimestamp(now) ?? Date.now();
  const scheduled_ts = toTimestamp(normalized.scheduled_for_utc || normalized.scheduled_for || normalized.created_at);
  const next_retry_ts = toTimestamp(normalized.next_retry_at);
  const queue_status_value = normalizeQueueStatusValue(normalized.queue_status);

  const allowed_statuses = new Set(["queued", "pending", "approved", "ready", "scheduled"]);
  if (!allowed_statuses.has(queue_status_value)) {
    return {
      ok: false,
      reason: "queue_status_not_queued",
      row: normalized,
    };
  }

  if (
    asNullableBoolean(metadata.no_send, false) === true ||
    asNullableBoolean(metadata.proof_no_send, false) === true ||
    clean(metadata.proof_mode).toLowerCase() === "no_send"
  ) {
    return {
      ok: false,
      reason: "no_send_queue_row",
      row: normalized,
    };
  }

  if (normalized.sms_eligible === false) {
    return {
      ok: false,
      reason: "sms_ineligible",
      row: normalized,
    };
  }

  if (normalized.routing_allowed === false) {
    return {
      ok: false,
      reason: "routing_not_allowed",
      row: normalized,
    };
  }

  if (normalized.is_locked || clean(normalized.lock_token)) {
    return {
      ok: false,
      reason: "row_locked",
      row: normalized,
    };
  }

  if (scheduled_ts !== null && scheduled_ts > now_ts) {
    return {
      ok: false,
      reason: "scheduled_for_in_future",
      row: normalized,
    };
  }

  if (next_retry_ts !== null && next_retry_ts > now_ts) {
    return {
      ok: false,
      reason: "next_retry_pending",
      row: normalized,
    };
  }

  if (normalized.retry_count >= normalized.max_retries) {
    return {
      ok: false,
      reason: "max_retries_reached",
      row: normalized,
    };
  }

  if (!clean(normalized.message_body)) {
    return {
      ok: false,
      reason: "missing_message_body",
      row: normalized,
    };
  }

  if (!clean(destination.phone)) {
    return {
      ok: false,
      reason: "missing_to_phone_number",
      row: normalized,
    };
  }

  return {
    ok: true,
    reason: "runnable",
    row: normalized,
  };
}

function getCandidateSnapshot(row = null) {
  const metadata = ensureObject(row?.metadata);
  const snapshot = metadata.candidate_snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : null;
}

function buildWithinBatchDedupeKey(row = null) {
  const normalized = normalizeSendQueueRow(row);
  const explicit = clean(normalized.dedupe_key);
  if (explicit) return `dedupe:${explicit}`;

  const snapshot = getCandidateSnapshot(normalized);
  const owner_id = clean(normalized.master_owner_id || snapshot?.master_owner_id);
  const phone_id = clean(
    normalized.phone_number_id ||
      normalized.phone_id ||
      snapshot?.phone_id ||
      snapshot?.best_phone_id
  );
  const touch_number = normalized.touch_number ?? snapshot?.touch_number;

  if (!owner_id && !phone_id) return null;
  return `owner_phone_touch:${owner_id || "no_owner"}:${phone_id || "no_phone"}:${touch_number ?? "no_touch"}`;
}

function hasSelectedTemplateReference(row = null) {
  const metadata = ensureObject(row?.metadata);
  return Boolean(
    clean(row?.template_id) ||
      clean(metadata.selected_template_id) ||
      clean(metadata.template_id) ||
      clean(metadata.template?.id) ||
      clean(metadata.selected_template?.id)
  );
}

export function resolveQueueSellerFirstName(row = null) {
  return resolveQueueSellerFirstNameFromSources(row);
}

export function validateSendQueueRowPreclaim(row = null, now = nowIso()) {
  const decision = shouldRunSendQueueRow(row, now);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, row: decision.row || normalizeSendQueueRow(row) };
  }
  const invalid_reason = preclaimInvalidQueueRowReason(decision.row);
  if (invalid_reason) {
    return { ok: false, reason: invalid_reason, row: decision.row };
  }
  return { ok: true, row: decision.row };
}

function preclaimInvalidQueueRowReason(row = null) {
  const normalized = normalizeSendQueueRow(row);
  const manual_inbox_send = isManualInboxSend(normalized);
  const unknown_auto_reply = isUnknownAutoReply(normalized);

  if (!normalizeQueueRowId(normalized.id, null)) return "missing_queue_row_id";
  if (!clean(normalized.message_body || normalized.message_text)) return "missing_message_body";
  if (!clean(resolveQueueDestinationPhone(normalized).phone)) return "missing_to_phone_number";
  if (!clean(normalized.from_phone_number)) return "missing_from_phone_number";

  // paused_review rows must never be runnable — they require human intervention.
  if (lower(normalized.queue_status) === "paused_review") return "paused_review_not_runnable";

  // Enforce canonical thread_key: outbound thread_key must match to_phone_number.
  const to_phone = normalizePhone(resolveQueueDestinationPhone(normalized).phone) || null;
  const thread_key_value = clean(normalized.thread_key);
  if (thread_key_value && to_phone && normalizePhone(thread_key_value) !== to_phone) {
    return "noncanonical_thread_key";
  }

  // Manual inbox sends and unknown auto replies may omit template/snapshot/seller checks.
  if (manual_inbox_send || unknown_auto_reply) return null;

  if (!hasSelectedTemplateReference(normalized)) return "missing_selected_template_id";
  if (!getCandidateSnapshot(normalized)) return "missing_candidate_snapshot";
  if (!resolveQueueSellerFirstName(normalized)) return "missing_seller_first_name";
  return null;
}

function getQueueSortValues(row) {
  const normalized = normalizeSendQueueRow(row);
  return {
    send_priority_value: asNumber(normalized.send_priority, 5),
    scheduled_ts: toTimestamp(normalized.scheduled_for) ?? Number.MIN_SAFE_INTEGER,
  };
}

export function sortQueuedRows(rows = []) {
  return [...rows].sort((left, right) => {
    const left_values = getQueueSortValues(left);
    const right_values = getQueueSortValues(right);

    if (left_values.send_priority_value !== right_values.send_priority_value) {
      return right_values.send_priority_value - left_values.send_priority_value;
    }

    return left_values.scheduled_ts - right_values.scheduled_ts;
  });
}

function resolvePreclaimScanLimit(limit = 50, deps = {}) {
  const requested_limit = Math.max(1, Math.trunc(asNumber(limit, 50)));
  const requested_scan_cap = Math.trunc(
    asNumber(
      deps.preclaim_scan_cap ??
        deps.preclaimScanCap ??
        deps.scan_cap ??
        deps.scanLimit,
      0
    )
  );

  if (requested_scan_cap > 0) {
    return Math.max(requested_limit, Math.min(requested_scan_cap, 5000));
  }

  return Math.min(Math.max(requested_limit * 20, 250), 1000);
}

export async function loadRunnableSendQueueRows(limit = 50, deps = {}) {
  const supabase = getSupabase(deps);
  const log_warn = deps.warn || warn;
  const now = deps.now || nowIso();
  const requested_limit = Math.max(1, Math.trunc(asNumber(limit, 50)));
  const preclaim_scan_limit = resolvePreclaimScanLimit(requested_limit, deps);
  const evaluate_contact_window = deps.evaluateContactWindow || evaluateContactWindow;
  const dry_run = Boolean(deps.dry_run || deps.dryRun);

  const stale_lock_recovery_enabled =
    deps.stale_lock_recovery_enabled ??
    deps.enableStaleLockRecovery ??
    deps.staleLockRecoveryEnabled ??
    true;

  const stale_lock_minutes = Number(deps.stale_lock_minutes ?? deps.staleLockMinutes ?? 15);

  // ── Stale queued+locked lock recovery ────────────────────────────────
  // If a prior queue run crashed after claiming a row but before finalizing,
  // rows can remain `queue_status='queued'` with `is_locked=true`.
  // We unlock them before selecting due rows.
  if (!dry_run && stale_lock_recovery_enabled && Number.isFinite(stale_lock_minutes) && stale_lock_minutes > 0) {
    const cutoff_iso = new Date(Date.now() - stale_lock_minutes * 60_000).toISOString();

    try {
      const { data: unlocked_rows, error: unlock_error } = await supabase
        .from(SEND_QUEUE_TABLE)
        .update({
          is_locked: false,
          locked_at: null,
          lock_token: null,
          updated_at: now,
        })
        .or("queue_status.eq.queued,queue_status.eq.ready,queue_status.eq.scheduled")
        .eq("is_locked", true)
        .lt("locked_at", cutoff_iso)
        .select("id");

      if (unlock_error) throw unlock_error;

      info("queue.unlock_stale_locked_rows", {
        cutoff_iso,
        stale_lock_minutes,
        unlocked_count: Array.isArray(unlocked_rows) ? unlocked_rows.length : 0,
      });
    } catch (unlock_error) {
      warn("queue.unlock_stale_locked_rows_failed", {
        cutoff_iso,
        stale_lock_minutes,
        message: unlock_error?.message || "unknown_error",
      });
    }
  }

  let query = supabase
    .from(SEND_QUEUE_TABLE)
    .select("*")
    .in("queue_status", ["queued", "pending", "approved", "ready", "scheduled"])
    .not("is_locked", "is", "true");

  if (Array.isArray(deps.queue_types) && deps.queue_types.length) {
    query = query.in("type", deps.queue_types);
  }

  const { data, error } = await query
    .order("send_priority", { ascending: false, nullsFirst: false })
    .order("scheduled_for", { ascending: true, nullsFirst: true })
    .limit(preclaim_scan_limit);

  if (error) throw error;

  const raw_rows = Array.isArray(data) ? data : [];
  const runnable = [];
  const skipped = [];
  const seen_batch_dedupe_keys = new Set();
  let batch_duplicate_suppressed_count = 0;
  let preclaim_scanned_count = 0;
  let preclaim_outside_window_excluded_count = 0;
  let preclaim_retry_pending_excluded_count = 0;
  let preclaim_paused_name_missing_count = 0;
  let preclaim_paused_invalid_count = 0;
  let preclaim_paused_max_retries_count = 0;
  let skipped_invalid_phone_count = 0;
  let skipped_missing_body_count = 0;

  const recordPaused = async (row, reason, status) => {
    const normalized = normalizeSendQueueRow(row);
    const queue_row_id = normalizeQueueRowId(normalized.id, null);

    skipped.push({
      id: queue_row_id,
      reason,
      row: normalized,
      queue_status: status,
      dry_run,
    });

    if (dry_run) return null;

    try {
      if (status === "paused_name_missing") {
        return await pauseNameMissingQueueRow(normalized, reason, {
          ...deps,
          now,
        });
      }
      if (status === "paused_max_retries") {
        return await pauseMaxRetriesQueueRow(normalized, reason, {
          ...deps,
          now,
        });
      }
      return await pauseInvalidQueueRow(normalized, reason, {
        ...deps,
        now,
      });
    } catch (pause_error) {
      skipped.push({
        id: queue_row_id,
        reason: `${reason}_pause_failed`,
        row: normalized,
        queue_status: normalized.queue_status,
        error: clean(pause_error?.message) || "preclaim_pause_failed",
      });
      return null;
    }
  };

  for (const row of sortQueuedRows(raw_rows)) {
    preclaim_scanned_count += 1;
    const decision = shouldRunSendQueueRow(row, now);
    if (!decision.ok) {
      if (decision.reason === "next_retry_pending") {
        preclaim_retry_pending_excluded_count += 1;
      } else if (decision.reason === "max_retries_reached") {
        preclaim_paused_max_retries_count += 1;
        await recordPaused(decision.row, decision.reason, "paused_max_retries");
      } else if (["missing_message_body", "missing_to_phone_number"].includes(decision.reason)) {
        preclaim_paused_invalid_count += 1;
        await recordPaused(decision.row, decision.reason, "paused_invalid_queue_row");
      }
      if (!["max_retries_reached", "missing_message_body", "missing_to_phone_number"].includes(decision.reason)) {
        skipped.push({
          id: decision.row?.id || null,
          reason: decision.reason,
          row: decision.row,
        });
      }
      continue;
    }

    const invalid_reason = preclaimInvalidQueueRowReason(decision.row);
    if (invalid_reason) {
      if (invalid_reason === "missing_seller_first_name") {
        preclaim_paused_name_missing_count += 1;
        await recordPaused(decision.row, invalid_reason, "paused_name_missing");
      } else {
        preclaim_paused_invalid_count += 1;
        await recordPaused(decision.row, invalid_reason, "paused_invalid_queue_row");
      }
      continue;
    }

    const contact_window = evaluate_contact_window(decision.row, { ...deps, now });
    const manual_inbox_send = isManualInboxSend(decision.row);
    if (contact_window && contact_window.allowed === false && !manual_inbox_send) {
      preclaim_outside_window_excluded_count += 1;
      skipped.push({
        id: decision.row?.id || null,
        reason: contact_window.reason || "outside_contact_window",
        row: decision.row,
        contact_window,
      });
      continue;
    }

    const batch_dedupe_key = buildWithinBatchDedupeKey(decision.row);
    if (batch_dedupe_key && seen_batch_dedupe_keys.has(batch_dedupe_key)) {
      batch_duplicate_suppressed_count += 1;
      skipped.push({
        id: decision.row?.id || null,
        reason: "batch_duplicate_suppressed",
        row: decision.row,
        batch_dedupe_key,
      });
      log_warn("queue.run_batch_duplicates_suppressed", {
        batch_dedupe_key,
        queue_item_id: decision.row?.id || null,
        duplicate_count: 1,
      });
      continue;
    }
    if (batch_dedupe_key) seen_batch_dedupe_keys.add(batch_dedupe_key);

    runnable.push(decision.row);
    if (runnable.length >= requested_limit) break;
  }

  return {
    rows: runnable.slice(0, requested_limit),
    raw_rows,
    skipped,
    now,
    preclaim_outside_window_excluded_count,
    preclaim_retry_pending_excluded_count,
    preclaim_paused_name_missing_count,
    preclaim_paused_invalid_count,
    preclaim_paused_max_retries_count,
    preclaim_scanned_count,
    skipped_invalid_phone_count,
    skipped_missing_body_count,
    eligible_claim_count: Math.min(runnable.length, requested_limit),
    preclaim_scan_limit,
    batch_duplicate_suppressed_count,
  };
}

export async function claimSendQueueRow(row, deps = {}) {
  const normalized = normalizeSendQueueRow(row);
  if (!normalized.id) {
    return {
      ok: false,
      claimed: false,
      reason: "missing_queue_row_id",
      row: normalized,
    };
  }

  if (typeof deps.claimSendQueueRow === "function") {
    const claimed_at = deps.now || nowIso();
    const lock_token = crypto.randomUUID();
    const metadata = ensureObject(normalized.metadata);
    const processing_run_id = clean(deps.processing_run_id || deps.run_id || metadata.processing_run_id || lock_token);
    return deps.claimSendQueueRow(normalized, {
      queue_status: "processing",
      is_locked: true,
      locked_at: claimed_at,
      lock_token,
      metadata: {
        ...metadata,
        processing_run_id,
        claimed_at,
        claimed_by: deps.scoped_canary ? "scoped_canary" : "queue_runner",
        claim_authorization_token: lock_token,
      },
      updated_at: claimed_at,
    });
  }

  const { atomicClaimSendQueueRow } = await import("@/lib/domain/queue/queue-atomic-claim.js");
  const metadata = ensureObject(normalized.metadata);
  return atomicClaimSendQueueRow(normalized, {
    ...deps,
    supabase: getSupabase(deps),
    campaign_id: deps.campaign_id || normalized.campaign_id || metadata.campaign_id,
  });
}

export async function updateSendQueueRowWithLock(row_id, lock_token, payload, deps = {}) {
  const normalized_row_id = normalizeQueueRowId(row_id, null);

  if (!normalized_row_id) {
    throw new Error("missing_queue_row_id");
  }

  if (typeof deps.updateSendQueueRowWithLock === "function") {
    return deps.updateSendQueueRowWithLock(normalized_row_id, lock_token, payload);
  }

  const supabase = getSupabase(deps);

  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .update(payload)
    .eq("id", normalized_row_id)
    .eq("lock_token", lock_token)
    .select()
    .maybeSingle();

  if (error) throw error;

  return data ? normalizeSendQueueRow(data) : null;
}

function buildTimeFormatter(timezone = "America/Chicago") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
}

function buildDateParts(date, timezone = "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);

  return {
    hour,
    minute,
    minutes_of_day: hour * 60 + minute,
  };
}

function parseWindowTime(raw = "", previous_period = null) {
  const normalized = clean(raw).toUpperCase();
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = match[3] || previous_period;

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null;
  }

  if (!period) return null;

  if (period === "AM") {
    if (hour === 12) hour = 0;
  } else if (period === "PM") {
    if (hour !== 12) hour += 12;
  } else {
    return null;
  }

  return {
    minutes_of_day: hour * 60 + minute,
    period,
  };
}

function parseContactWindow(window_text = "") {
  const normalized = clean(window_text)
    .replace(/\bLOCAL\b/gi, "")
    .replace(/\bCT\b/gi, "")
    .replace(/\bCST\b/gi, "")
    .replace(/\bCDT\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return {
      valid: false,
      reason: "missing_contact_window",
    };
  }

  const parts = normalized
    .split(/\s*-\s*|\s+to\s+/i)
    .map((part) => clean(part))
    .filter(Boolean);

  if (parts.length !== 2) {
    return {
      valid: false,
      reason: "invalid_contact_window_format",
    };
  }

  const start = parseWindowTime(parts[0], null);
  const end = parseWindowTime(parts[1], start?.period || null);

  if (!start || !end) {
    return {
      valid: false,
      reason: "invalid_contact_window_time",
    };
  }

  return {
    valid: true,
    start_minutes: start.minutes_of_day,
    end_minutes: end.minutes_of_day,
  };
}

export function evaluateContactWindow(row, deps = {}) {
  const normalized = normalizeSendQueueRow(row);
  const timezone_raw = clean(normalized.timezone) || "America/Chicago";
  const current_time = deps.now ? new Date(deps.now) : new Date();
  let resolved_timezone = timezone_raw;

  // Resolve abbreviated labels (Eastern, Central, etc.) to IANA names.
  const TIMEZONE_MAP = {
    eastern: "America/New_York",
    et: "America/New_York",
    est: "America/New_York",
    edt: "America/New_York",
    central: "America/Chicago",
    ct: "America/Chicago",
    cst: "America/Chicago",
    cdt: "America/Chicago",
    mountain: "America/Denver",
    mt: "America/Denver",
    mst: "America/Denver",
    mdt: "America/Denver",
    pacific: "America/Los_Angeles",
    pt: "America/Los_Angeles",
    pst: "America/Los_Angeles",
    pdt: "America/Los_Angeles",
  };
  const tz_lower = timezone_raw.toLowerCase();
  if (TIMEZONE_MAP[tz_lower]) {
    resolved_timezone = TIMEZONE_MAP[tz_lower];
  }

  try {
    buildTimeFormatter(resolved_timezone).format(current_time);
  } catch {
    resolved_timezone = "America/Chicago";
  }

  // Hard local-time window: 08:00 ≤ local < 21:00 (8 AM – 9 PM).
  const LOCAL_SEND_START = 8 * 60;   // 480
  const LOCAL_SEND_END   = 21 * 60;  // 1260 (exclusive)

  const local_parts = buildDateParts(current_time, resolved_timezone);
  const current_minutes = local_parts.minutes_of_day;

  if (current_minutes < LOCAL_SEND_START || current_minutes >= LOCAL_SEND_END) {
    return {
      allowed: false,
      reason: "outside_local_send_window",
      timezone: resolved_timezone,
      valid_window: true,
      current_minutes,
      start_minutes: LOCAL_SEND_START,
      end_minutes: LOCAL_SEND_END,
    };
  }

  // If the row has a finer-grained contact_window, also honour that.
  if (!clean(normalized.contact_window)) {
    return {
      allowed: true,
      reason: "inside_local_send_window",
      timezone: resolved_timezone,
      valid_window: true,
      current_minutes,
      start_minutes: LOCAL_SEND_START,
      end_minutes: LOCAL_SEND_END,
    };
  }

  const parsed_window = parseContactWindow(normalized.contact_window);
  if (!parsed_window.valid) {
    return {
      allowed: true,
      reason: "inside_local_send_window_contact_window_unparseable",
      timezone: resolved_timezone,
      valid_window: false,
      current_minutes,
    };
  }

  const start_minutes = parsed_window.start_minutes;
  const end_minutes = parsed_window.end_minutes;

  let within_window = false;
  if (start_minutes <= end_minutes) {
    within_window = current_minutes >= start_minutes && current_minutes <= end_minutes;
  } else {
    within_window = current_minutes >= start_minutes || current_minutes <= end_minutes;
  }

  return {
    allowed: within_window,
    reason: within_window ? "inside_contact_window" : "outside_contact_window",
    timezone: resolved_timezone,
    valid_window: true,
    current_minutes,
    start_minutes,
    end_minutes,
  };
}

export async function selectAvailableTextgridNumber(row, deps = {}) {
  const normalized = normalizeSendQueueRow(row);

  if (clean(normalized.from_phone_number)) {
    return {
      ok: true,
      selected: {
        id: normalized.textgrid_number_id || null,
        phone_number: normalizePhone(normalized.from_phone_number),
        metadata: {},
      },
      from_phone_number: normalizePhone(normalized.from_phone_number),
      reason: "queue_row_from_phone_number_present",
    };
  }

  if (typeof deps.selectAvailableTextgridNumber === "function") {
    return deps.selectAvailableTextgridNumber(normalized);
  }

  const supabase = getSupabase(deps);

  const { data, error } = await supabase
    .from(TEXTGRID_NUMBERS_TABLE)
    .select("*")
    .order("messages_sent_today", { ascending: true, nullsFirst: true })
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .limit(50);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const active_rows = rows.filter((candidate) => {
    const status = lower(candidate?.status);
    const daily_limit = asNullableNumber(candidate?.daily_limit, null);
    const sent_today = asNumber(candidate?.messages_sent_today, 0);

    if (status && status !== "active") return false;
    if (daily_limit !== null && sent_today >= daily_limit) return false;
    return Boolean(normalizePhone(candidate?.phone_number));
  });

  const preferred = active_rows.find(
    (candidate) =>
      String(candidate?.id || "") === String(normalized.textgrid_number_id || "")
  );
  const selected = preferred || active_rows[0] || null;

  if (!selected) {
    return {
      ok: false,
      reason: "no_available_textgrid_numbers",
      selected: null,
      from_phone_number: null,
    };
  }

  return {
    ok: true,
    reason: preferred ? "preferred_textgrid_number_selected" : "rotation_textgrid_number_selected",
    selected,
    from_phone_number: normalizePhone(selected.phone_number),
  };
}

export async function reserveFromPhoneNumber(row, lock_token, selection, deps = {}) {
  const normalized = normalizeSendQueueRow(row);
  const from_phone_number = normalizePhone(selection?.from_phone_number);
  const textgrid_number_id = selection?.selected?.id || null;
  const now = deps.now || nowIso();

  if (!from_phone_number) {
    throw new Error("missing_from_phone_number");
  }

  const updated = await updateSendQueueRowWithLock(
    normalized.id,
    lock_token,
    {
      from_phone_number,
      textgrid_number_id,
      updated_at: now,
    },
    deps
  );

  return updated || {
    ...normalized,
    from_phone_number,
    textgrid_number_id,
  };
}

export async function incrementTextgridNumberUsage(selection, deps = {}) {
  const selected = selection?.selected || null;

  if (!selected?.id) return null;

  if (typeof deps.incrementTextgridNumberUsage === "function") {
    return deps.incrementTextgridNumberUsage(selected);
  }

  const supabase = getSupabase(deps);

  const next_sent_today = asNumber(selected.messages_sent_today, 0) + 1;
  const payload = {
    messages_sent_today: next_sent_today,
    last_used_at: deps.now || nowIso(),
    updated_at: deps.now || nowIso(),
  };

  const { data, error } = await supabase
    .from(TEXTGRID_NUMBERS_TABLE)
    .update(payload)
    .eq("id", selected.id)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function resolveOutboundMessageEventSourceApp(row_metadata = {}) {
  if (row_metadata.proof) return "internal_test";
  if (
    clean(row_metadata.source) === "map_command" ||
    clean(row_metadata.send_source) === "map_command" ||
    clean(row_metadata.origin_surface) === "command_map" ||
    clean(row_metadata.message_events_source_app) === "LeadCommand Map"
  ) {
    return "LeadCommand Map";
  }
  return "Send Queue";
}

export function buildSuccessMessageEvent(row, send_result, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const row_metadata = ensureObject(normalized.metadata);
  const event_timestamp = options.now || nowIso();
  const queue_key = clean(normalized.queue_key) || clean(normalized.queue_id) || String(normalized.id);
  const thread_key = canonicalThreadKeyForDirection(
    "outbound",
    normalized.from_phone_number,
    normalized.to_phone_number
  );

  const sid = clean(
    options.provider_message_sid ||
      send_result?.sid ||
      send_result?.provider_message_id ||
      send_result?.message_id
  );

  return {
    message_event_key: `outbound_${queue_key}`,
    provider_message_sid: sid,
    message_id: sid,
    direction: "outbound",
    type: "outbound",
    event_type: "outbound_send",
    source_app: resolveOutboundMessageEventSourceApp(row_metadata),
    trigger_name: clean(row_metadata.proof_source) || "queue-send",
    triggered_by: clean(row_metadata.proof_source) || "queue_runner",
    processed_by: "Queue Runner",
    message_body: normalized.message_body,
    to_phone_number: normalized.to_phone_number,
    from_phone_number: normalized.from_phone_number,
    queue_id: normalized.id,
    sent_at: event_timestamp,
    event_timestamp,
    created_at: event_timestamp,
    provider_delivery_status: clean(send_result?.status) || null,
    delivery_status: "sent",
    character_count: normalized.character_count || normalized.message_body.length,
    latency_ms: options.latency_ms ?? null,
    master_owner_id: normalized.master_owner_id,
    prospect_id: normalized.prospect_id,
    property_id: normalized.property_id,
    market_id: normalized.market_id,
    sms_agent_id: normalized.sms_agent_id,
    textgrid_number_id: normalized.textgrid_number_id,
    template_id: normalized.template_id,
    property_address: normalized.property_address,
    market: normalized.market || null,
    thread_key,
    auto_reply_status: normalized.type === "auto_reply" ? "sent" : null,
    auto_reply_queue_id: normalized.type === "auto_reply" ? String(normalized.id || "") : null,
    detected_intent: normalized.detected_intent || null,
    stage_before: normalized.stage_before || normalized.current_stage || null,
    stage_after: normalized.stage_after || normalized.current_stage || null,
    safety_status: normalized.safety_status || "pending",
    risk: normalized.risk || "low",
    priority: normalized.priority || "normal",
    language: normalized.language || null,
    classification_confidence: normalized.classification_confidence || null,
    metadata: {
      source:
        clean(row_metadata.source) ||
        clean(row_metadata.send_source) ||
        "supabase_send_queue",
      // message_events has no canonical text phone_id column; preserve the ph_ id here.
      canonical_phone_id:
        clean(normalized.phone_id) ||
        (isUuid(normalized.phone_number_id) ? null : clean(normalized.phone_number_id)) ||
        clean(row_metadata.canonical_phone_id) ||
        null,
      queue_key,
      send_result,
      client_send_id: normalized.metadata?.client_send_id || null,
      enrichment: {
        thread_key,
        property_id: normalized.property_id || null,
        master_owner_id: normalized.master_owner_id || null,
        seller_name: normalized.seller_display_name || normalized.seller_first_name || null,
        property_address: normalized.property_address || null,
        market: normalized.market || null,
        timezone: normalized.timezone || null,
      },
      queue_row: {
        id: normalized.id,
        queue_key: normalized.queue_key,
        queue_status: normalized.queue_status,
      },
      proof: Boolean(row_metadata.proof),
      proof_key: clean(row_metadata.proof_key) || null,
      proof_source: clean(row_metadata.proof_source) || null,
      internal_test: Boolean(row_metadata.internal_test || row_metadata.internal_test_phone),
      internal_test_phone: Boolean(row_metadata.internal_test_phone),
      exclude_from_kpis: Boolean(row_metadata.exclude_from_kpis),
      no_send: Boolean(row_metadata.no_send),
    },
  };
}

function buildFailureMessageEvent(row, error, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const row_metadata = ensureObject(normalized.metadata);
  const event_timestamp = options.now || nowIso();
  const queue_key = clean(normalized.queue_key) || clean(normalized.queue_id) || String(normalized.id);
  const timestamp_key = event_timestamp.replace(/[^0-9]/g, "").slice(0, 14);
  const thread_key = canonicalThreadKeyForDirection(
    "outbound",
    normalized.from_phone_number,
    normalized.to_phone_number
  );
  const failure_result =
    ensureObject(options.send_result).error_message || ensureObject(options.send_result).error_status
      ? options.send_result
      : {
          ok: false,
          error_message: clean(error?.message),
          error_status: error?.status || null,
        };
  const normalized_failure = normalizeTextGridFailure({
    ...failure_result,
    status: failure_result?.status || "failed",
    message: error?.message,
    error,
    metadata: row_metadata,
  });
  const provider_failure_reason =
    clean(normalized_failure.provider_failure_reason) ||
    clean(error?.message) ||
    clean(options.send_result?.error_message) ||
    "send_failed";

  return {
    message_event_key: `failed_${queue_key}_${timestamp_key}`,
    direction: "outbound",
    type: "outbound",
    event_type: "outbound_send_failed",
    source_app: resolveOutboundMessageEventSourceApp(row_metadata),
    trigger_name: clean(row_metadata.proof_source) || "queue-send-failed",
    triggered_by: clean(row_metadata.proof_source) || "queue_runner",
    processed_by: "Queue Runner",
    message_body: normalized.message_body,
    to_phone_number: normalized.to_phone_number,
    from_phone_number: normalized.from_phone_number,
    queue_id: normalized.id,
    failed_at: event_timestamp,
    event_timestamp,
    provider_delivery_status: clean(options.send_result?.status) || "failed",
    raw_carrier_status: String(options.send_result?.error_status || options.send_result?.status || "failed"),
    delivery_status: normalized_failure.delivery_status || "failed",
    error_message: provider_failure_reason,
    failure_reason: provider_failure_reason,
    failure_bucket: legacyFailureBucketForTextGrid(normalized_failure, failure_result),
    is_final_failure:
      normalized_failure.is_terminal || normalized.retry_count + 1 >= normalized.max_retries,
    master_owner_id: normalized.master_owner_id,
    prospect_id: normalized.prospect_id,
    property_id: normalized.property_id,
    market_id: normalized.market_id,
    sms_agent_id: normalized.sms_agent_id,
    textgrid_number_id: normalized.textgrid_number_id,
    template_id: normalized.template_id,
    property_address: normalized.property_address,
    thread_key,
    detected_intent: normalized.detected_intent || null,
    stage_before: normalized.stage_before || normalized.current_stage || null,
    stage_after: normalized.stage_after || normalized.current_stage || null,
    safety_status: normalized.safety_status || "pending",
    risk: normalized.risk || "low",
    priority: normalized.priority || "normal",
    language: normalized.language || null,
    classification_confidence: normalized.classification_confidence || null,
    metadata: {
      source: "supabase_send_queue",
      // message_events has no canonical text phone_id column; preserve the ph_ id here.
      canonical_phone_id:
        clean(normalized.phone_id) ||
        (isUuid(normalized.phone_number_id) ? null : clean(normalized.phone_number_id)) ||
        clean(row_metadata.canonical_phone_id) ||
        null,
      queue_key,
      ...textGridFailureMetadata(normalized_failure),
      error: {
        message: provider_failure_reason || null,
        status: error?.status || null,
      },
      send_result: options.send_result || null,
      proof: Boolean(row_metadata.proof),
      proof_key: clean(row_metadata.proof_key) || null,
      proof_source: clean(row_metadata.proof_source) || null,
      internal_test: Boolean(row_metadata.internal_test || row_metadata.internal_test_phone),
      internal_test_phone: Boolean(row_metadata.internal_test_phone),
      exclude_from_kpis: Boolean(row_metadata.exclude_from_kpis),
      no_send: Boolean(row_metadata.no_send),
    },
  };
}

export async function writeOutboundSuccessMessageEvent(row, send_result, options = {}) {
  const payload = buildSuccessMessageEvent(row, send_result, options);
  const normalized = normalizeSendQueueRow(row);

  // Analytics fires regardless of whether the DB write is real or injected —
  // the SMS is already confirmed sent at this call site.
  captureSystemEvent("sms_send_succeeded", {
    queue_row_id: normalized.id,
    queue_key: normalized.queue_key,
    provider_message_id: normalized.provider_message_id || send_result?.sid || null,
    master_owner_id: normalized.master_owner_id || null,
    template_id: normalized.template_id || null,
    touch_number: normalized.touch_number ?? null,
    character_count: normalized.character_count ?? 0,
    campaign_id: normalized.metadata?.campaign_id ?? null,
  });

  captureSystemEvent("message_event_created", {
    queue_row_id: normalized.id,
    queue_key: normalized.queue_key,
    provider_message_id: normalized.provider_message_id || send_result?.sid || null,
    master_owner_id: normalized.master_owner_id || null,
    template_id: normalized.template_id || null,
    campaign_id: normalized.metadata?.campaign_id ?? null,
    direction: "outbound",
    event_type: "outbound_sms",
  });

  if (typeof options.writeOutboundSuccessMessageEvent === "function") {
    return options.writeOutboundSuccessMessageEvent(payload);
  }

  try {
    await updateContactOutreachState({
      master_owner_id: payload.master_owner_id,
      to_phone_number: payload.to_phone_number,
      event_type: 'outbound_sent',
      queue_id: normalized.id,
      message_event_id: payload.id,
      template_id: payload.template_id,
      agent_id: payload.sms_agent_id,
      market: normalized.market,
      property_id: payload.property_id,
      property_address: payload.property_address,
      timestamp: payload.created_at
    }, options);
  } catch (outreachErr) {
    console.error("FAILED TO UPDATE OUTREACH STATE ON OUTBOUND SUCCESS", outreachErr);
  }

  const supabase = getSupabase(options);

  try {
    const { data, error } = await supabase
      .from(MESSAGE_EVENTS_TABLE)
      .upsert(payload, {
        onConflict: "message_event_key",
        ignoreDuplicates: false,
      })
      .select()
      .maybeSingle();

    if (error) {
      warn("message_events.upsert_failed", {
        queue_row_id: normalized.id,
        queue_key: normalized.queue_key,
        message: error?.message || "Unknown error",
        payload: {
          message_event_key: payload.message_event_key,
          to_phone_number: payload.to_phone_number,
        },
      });
    } else {
      addSentryBreadcrumb("sms_send", "sms_send_succeeded", {
        queue_row_id: normalized.id,
        queue_key: normalized.queue_key,
        provider_message_id: normalized.provider_message_id,
        master_owner_id: normalized.master_owner_id,
      });

      const savedPayload = data || payload;
      try {
        await syncClassifiedInboxThreadState({
          thread_key: savedPayload.thread_key,
          seller_phone: savedPayload.to_phone_number,
          our_number: savedPayload.from_phone_number,
          master_owner_id: savedPayload.master_owner_id,
          prospect_id: savedPayload.prospect_id,
          property_id: savedPayload.property_id,
          market: normalized.market || null,
          conversationStage: savedPayload.stage_after || savedPayload.stage_before,
          messageEvent: savedPayload,
          is_read: true,
          increment_direction: "outbound",
        }, options);
      } catch (syncErr) {
        console.error("FAILED TO SYNC CLASSIFIED THREAD STATE ON OUTBOUND SUCCESS", syncErr);
      }

      // Hard guarantee: even if full classify/sync is slow or partial, ensure the canonical latest
      // conversational message fields are set from this successful outbound event immediately.
      // This fixes "recent outbound messages missing" and Waiting eligibility.
      try {
        const evt = savedPayload;
        const ts = evt.sent_at || evt.event_timestamp || evt.created_at || new Date().toISOString();
        // Use the canonical waiting resolver to decide "waiting" vs follow-up/cold for this outbound
        const { resolveOutboundReplyState } = await import("@/lib/domain/inbox/resolve-waiting-cold-state.js");
        const outboundState = resolveOutboundReplyState({
          lastOutboundAt: ts,
          lastInboundAt: null, // fresh; will be corrected on next inbound
          latestDeliveryStatus: evt.delivery_status || "sent",
          workflowRow: {},
          now: Date.now(),
        });
        const directPatch = {
          latest_message_event_id: evt.id || evt.provider_message_sid || evt.message_id || null,
          latest_message_body: evt.message_body || null,
          latest_message_at: ts,
          latest_direction: "outbound",
          latest_delivery_status: evt.delivery_status || "sent",
          last_outbound_at: ts,
          inbox_bucket: outboundState.inbox_bucket || "waiting", // default recent outbound to waiting per contract
          updated_at: new Date().toISOString(),
        };
        await supabase
          .from("inbox_thread_state")
          .upsert(
            {
              thread_key: evt.thread_key,
              ...directPatch,
            },
            { onConflict: "thread_key" }
          );
      } catch (ensureErr) {
        console.error("OUTBOUND ENSURE LATEST PATCH FAILED", ensureErr?.message || ensureErr);
      }

      return savedPayload;
    }
  } catch (db_error) {
    warn("message_events.upsert_caught", {
      queue_row_id: normalized.id,
      queue_key: normalized.queue_key,
      message: db_error?.message || "Unknown caught error",
    });
  }

  return payload;
}

export async function writeOutboundFailureMessageEvent(row, error, options = {}) {
  const payload = buildFailureMessageEvent(row, error, options);

  const normalized_for_sentry = normalizeSendQueueRow(row);
  const classified = classifyTextGridProviderError(error, {
    campaign_id: normalized_for_sentry.metadata?.campaign_id || null,
    market: normalized_for_sentry.market || null,
  });
  const is_handled_terminal_compliance =
    classified.compliance_related && classified.sentry_level === "warning";

  if (!is_handled_terminal_compliance) {
    captureRouteException(error, {
      route: "sms-engine/writeOutboundFailureMessageEvent",
      subsystem: "sms_engine",
      context: {
        queue_row_id: normalized_for_sentry.id,
        queue_key: normalized_for_sentry.queue_key,
        master_owner_id: normalized_for_sentry.master_owner_id,
      },
    });
  }
  addSentryBreadcrumb("sms_send", is_handled_terminal_compliance ? "sms_send_suppressed_terminal" : "sms_send_failed", {
    queue_row_id: normalized_for_sentry.id,
    queue_key: normalized_for_sentry.queue_key,
    master_owner_id: normalized_for_sentry.master_owner_id,
    provider_code: classified.provider_code || null,
    error_message: error?.message || String(error),
  });

  captureSystemEvent("sms_send_failed", {
    queue_row_id: normalized_for_sentry.id,
    queue_key: normalized_for_sentry.queue_key,
    master_owner_id: normalized_for_sentry.master_owner_id || null,
    template_id: normalized_for_sentry.template_id || null,
    touch_number: normalized_for_sentry.touch_number ?? null,
    campaign_id: normalized_for_sentry.metadata?.campaign_id ?? null,
    error_message: error?.message || String(error),
  });

  if (!is_handled_terminal_compliance) {
    sendCriticalAlert({
      title: "SMS Send Failed",
      description: `Failed to send SMS for queue row ${normalized_for_sentry.id ?? "unknown"}`,
      color: 0xe74c3c,
      fields: [
        { name: "Queue Row ID", value: String(normalized_for_sentry.id ?? "?"), inline: true },
        { name: "Master Owner ID", value: String(normalized_for_sentry.master_owner_id ?? "?"), inline: true },
        { name: "Touch", value: String(normalized_for_sentry.touch_number ?? "?"), inline: true },
        { name: "Error", value: (error?.message || String(error)).slice(0, 256), inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "sms_engine/writeOutboundFailureMessageEvent" },
    });
  }

  if (typeof options.writeOutboundFailureMessageEvent === "function") {
    return options.writeOutboundFailureMessageEvent(payload);
  }

  try {
    const normalized = normalizeSendQueueRow(row);
    await updateContactOutreachState({
      master_owner_id: payload.master_owner_id,
      to_phone_number: payload.to_phone_number,
      event_type: 'failed',
      queue_id: normalized.id,
      message_event_id: payload.id,
      timestamp: payload.created_at
    }, options);
  } catch (outreachErr) {
    console.error("FAILED TO UPDATE OUTREACH STATE ON OUTBOUND FAILURE", outreachErr);
  }

  const supabase = getSupabase(options);

  const { data: insert_data, error: insert_error } = await supabase
    .from(MESSAGE_EVENTS_TABLE)
    .insert(payload)
    .select()
    .maybeSingle();

  if (insert_error) {
    captureRouteException(insert_error, {
      route: "sms-engine/writeOutboundFailureMessageEvent/db_write",
      subsystem: "sms_engine",
      context: {
        queue_row_id: normalized_for_sentry.id,
        queue_key: normalized_for_sentry.queue_key,
        master_owner_id: normalized_for_sentry.master_owner_id,
      },
    });
    throw insert_error;
  }
  return insert_data || payload;
}

export async function finalizeSendQueueSuccess(row, lock_token, send_result, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const provider_message_id = clean(
    send_result?.sid || send_result?.provider_message_id || send_result?.message_id
  );

  if (!provider_message_id) {
    throw new Error("SEND FAILED - NO SID");
  }

  const now = options.now || nowIso();
  const payload = {
    queue_status: "sent",
    sent_at: now,
    delivery_confirmed: "pending",
    provider_message_id,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    character_count: normalized.message_body.length,
    updated_at: now,
    failed_reason: null,
    from_phone_number: normalized.from_phone_number,
    textgrid_number_id: normalized.textgrid_number_id,
  };

  const updated_row = await updateSendQueueRowWithLock(
    normalized.id,
    lock_token,
    payload,
    options
  );

  if (!updated_row) {
    throw new Error("queue_row_lock_mismatch_after_send");
  }

  return updated_row;
}

export async function finalizeSendQueueFailure(row, lock_token, error, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const next_retry_count = normalized.retry_count + 1;
  const classified = classifyTextGridProviderError(error, {
    campaign_id: normalized.metadata?.campaign_id || null,
    market: normalized.market || normalized.metadata?.market || null,
    sender_hash: hashPhoneForMetrics(normalized.from_phone_number),
    destination_hash: hashPhoneForMetrics(normalized.to_phone_number),
  });
  const normalized_failure = normalizeTextGridFailure({
    ...ensureObject(options.send_result),
    status: ensureObject(options.send_result).status,
    message: error?.message,
    error,
    metadata: normalized.metadata,
  });
  const non_retryable = isNonRetryableProviderError(error);
  const is_final_failure =
    classified.is_terminal || normalized_failure.is_terminal || non_retryable || next_retry_count >= normalized.max_retries;
  const error_message =
    clean(classified.provider_message) ||
    clean(normalized_failure.provider_failure_reason) ||
    clean(error?.message) ||
    "send_failed";
  const failure_bucket = classified.failure_bucket ||
    (normalized_failure.failure_class && normalized_failure.failure_class !== "unknown_failure"
      ? legacyFailureBucketForTextGrid(normalized_failure, {
          ok: false,
          error_message,
          error_status: error?.status || null,
        })
      : non_retryable
        ? "provider_blacklist_pair"
        : null);

  const terminal_queue_status =
    is_final_failure && !classified.retryable
      ? (classified.queue_disposition || "failed")
      : is_final_failure
        ? "failed"
        : "queued";

  const payload = {
    queue_status: terminal_queue_status,
    failed_reason: error_message,
    retry_count: next_retry_count,
    next_retry_at: is_final_failure ? null : addMinutesIso(now, 5),
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...normalized.metadata,
      provider_error: {
        message: error_message,
        status: error?.status || null,
        code: classified.provider_code || null,
        retryable: classified.retryable && !is_final_failure,
        failure_class: classified.failure_class || normalized_failure.failure_class || null,
        normalized_reason: classified.normalized_reason || normalized_failure.normalized_reason || null,
        provider_failure_reason: error_message,
        provider_payload: classified.provider_payload || null,
        ...(non_retryable
          ? { non_retryable_reason: classified.non_retryable_reason || "textgrid_non_retryable_failure" }
          : {}),
        final_queue_status: terminal_queue_status,
        recorded_at: now,
      },
      ...textGridFailureMetadata(normalized_failure),
      ...(failure_bucket ? { failure_bucket, final_failure: true } : {}),
      final_queue_status: terminal_queue_status,
      finalized_at: now,
    },
  };

  info("queue_failure_classified", {
    queue_id: normalized.id,
    from_phone_number: normalized.from_phone_number || null,
    to_phone_number: normalized.to_phone_number || null,
    failed_reason: error_message,
    failure_bucket: failure_bucket || "unknown",
    failure_class: normalized_failure.failure_class || null,
    retryable: normalized_failure.retry_allowed && !is_final_failure,
    non_retryable,
    next_action: is_final_failure ? "terminal_failed" : "requeue_with_backoff",
    retry_count: next_retry_count,
    max_retries: normalized.max_retries,
  });

  if (non_retryable) {
    addSentryBreadcrumb("queue_failure", "provider_blacklist_21610_terminal", {
      queue_id: normalized.id,
      failure_bucket: failure_bucket || "provider_blacklist_pair",
      provider_code: classified.provider_code || null,
      from_phone_number: normalized.from_phone_number || null,
      to_phone_number: normalized.to_phone_number || null,
    });
    if (classified.provider_code === "21610") {
      await persistProviderBlacklistSuppression(normalized, error, options);
    }
  }

  const updated_row = await updateSendQueueRowWithLock(
    normalized.id,
    lock_token,
    payload,
    options
  );

  return updated_row || {
    ...normalized,
    ...payload,
  };
}

// ─── Delivery-failure safety guards ─────────────────────────────────────────

/**
 * Check whether a given from/to pair has a prior 21610 blacklist failure.
 * Returns { blocked: true, reason, count } or { blocked: false, reason: null }.
 * Non-fatal: any DB error returns blocked=false so sends are never silently lost.
 */
export async function checkBlacklistPriorFailure(
  { to_phone_number, from_phone_number },
  deps = {}
) {
  if (!to_phone_number || !from_phone_number) return { blocked: false, reason: null };

  const supabase_client = deps.supabase || deps.supabaseClient || defaultSupabase;

  try {
    const { count } = await supabase_client
      .from(SEND_QUEUE_TABLE)
      .select("*", { count: "exact", head: true })
      .eq("to_phone_number", to_phone_number)
      .eq("from_phone_number", from_phone_number)
      .eq("queue_status", "failed")
      .ilike("failed_reason", "%21610%");

    if (count > 0) {
      return { blocked: true, reason: "prior_blacklist_21610", count };
    }
    return { blocked: false, reason: null };
  } catch (err) {
    warn("blacklist_check_failed", {
      to_phone_number,
      from_phone_number,
      message: err?.message || "unknown_error",
    });
    return { blocked: false, reason: null };
  }
}

/**
 * Check whether a recipient has too many recent delivery_failed rows and should
 * be temporarily suppressed.
 *
 * Rules:
 *   - Same from/to pair: >= 2 delivery_failed in last 24 h → block pair
 *   - Same to_phone (any sender): >= 3 delivery_failed in last 7 days → suppress recipient
 *
 * Returns { suppress: true, reason, ... } or { suppress: false, reason: null }.
 * Non-fatal: any DB error returns suppress=false.
 */
export async function shouldSuppressDeliveryFailedRecipient(
  { to_phone_number, from_phone_number },
  deps = {}
) {
  if (!to_phone_number) return { suppress: false, reason: null };

  const supabase_client = deps.supabase || deps.supabaseClient || defaultSupabase;
  const now = deps.now || nowIso();
  const since_24h = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since_7d = new Date(new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Rule 1: same pair >= 2 failures in last 24 h
    if (from_phone_number) {
      const { count: pair_count } = await supabase_client
        .from(SEND_QUEUE_TABLE)
        .select("*", { count: "exact", head: true })
        .eq("to_phone_number", to_phone_number)
        .eq("from_phone_number", from_phone_number)
        .eq("queue_status", "failed")
        .eq("failed_reason", "delivery_failed")
        .gte("updated_at", since_24h);

      if ((pair_count ?? 0) >= 2) {
        return {
          suppress: true,
          reason: "repeated_delivery_failed_same_pair",
          pair_count,
          window: "24h",
        };
      }
    }

    // Rule 2: same recipient >= 3 failures from any sender in last 7 days
    const { count: recipient_count } = await supabase_client
      .from(SEND_QUEUE_TABLE)
      .select("*", { count: "exact", head: true })
      .eq("to_phone_number", to_phone_number)
      .eq("queue_status", "failed")
      .eq("failed_reason", "delivery_failed")
      .gte("updated_at", since_7d);

    if ((recipient_count ?? 0) >= 3) {
      return {
        suppress: true,
        reason: "repeated_delivery_failed_recipient",
        recipient_count,
        window: "7d",
      };
    }

    return { suppress: false, reason: null };
  } catch (err) {
    warn("delivery_failed_suppression_check_failed", {
      to_phone_number,
      from_phone_number: from_phone_number || null,
      message: err?.message || "unknown_error",
    });
    return { suppress: false, reason: null };
  }
}

export async function reconcileCanonicalQueueLifecycle(options = {}) {
  const supabase = getSupabase(options);
  const now = options.now || nowIso();
  const stale_minutes = Math.max(Number(options.stale_minutes ?? 180), 1);
  const lease_minutes = Math.max(Number(options.lease_minutes ?? 10), 1);
  const stale_cutoff = new Date(new Date(now).getTime() - stale_minutes * 60 * 1000).toISOString();
  const lifecycle_context = {
    now,
    stale_minutes,
    stale_cutoff,
    caller_route: clean(options.caller_route) || null,
    deploy_sha: clean(options.deploy_sha) || null,
  };
  const lease_cutoff = new Date(new Date(now).getTime() - lease_minutes * 60 * 1000).toISOString();
  const max_rows = Math.max(Number(options.max_rows ?? 500), 1);
  const dry_run = Boolean(options.dry_run);

  const { data: active_rows, error: active_error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("id,queue_status,created_at,updated_at,scheduled_for,scheduled_for_utc,sent_at,delivered_at,provider_message_id,textgrid_message_id,is_locked,lock_token,retry_count,max_retries,dedupe_key,to_phone_number,from_phone_number,metadata")
    .in("queue_status", CANONICAL_ACTIVE_QUEUE_STATUSES)
    .order("updated_at", { ascending: true })
    .limit(max_rows);
  if (active_error) throw active_error;

  const rows = Array.isArray(active_rows) ? active_rows : [];
  const [emergencyStop, processorMode] = await Promise.all([
    options.queue_emergency_stop_at ?? getSystemValue("queue_emergency_stop_at", { supabase }),
    options.queue_processor_mode ?? getSystemValue("queue_processor_mode", { supabase }),
  ]);
  const brakeState = evaluateGlobalSendBrakeState({
    queue_emergency_stop_at: emergencyStop,
    queue_processor_mode: processorMode,
  });
  const campaignIds = [...new Set(rows.map((row) => rowCampaignId(row)).filter(Boolean))];
  const campaignStatusById = new Map();
  if (campaignIds.length) {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("id,status")
      .in("id", campaignIds);
    for (const campaign of campaigns || []) {
      campaignStatusById.set(campaign.id, normalizeCampaignStatus(campaign.status));
    }
  }
  const active_with_send_evidence = rows.filter((row) =>
    Boolean(clean(row.provider_message_id) || clean(row.textgrid_message_id) || row.sent_at || row.delivered_at)
  );
  const stale_cutoff_ts = toTimestamp(stale_cutoff) ?? 0;
  const stale_rows = rows.filter((row) =>
    isRowEligibleForStaleExpiration(row, {
      now,
      stale_minutes,
      stale_cutoff_ts,
    })
  );
  const past_due_scheduled = rows.filter((row) => {
    const status = lower(row.queue_status);
    if (!["scheduled", "queued"].includes(status)) return false;
    const schedule_at = row.scheduled_for_utc || row.scheduled_for;
    const schedule_ts = toTimestamp(schedule_at);
    return schedule_ts !== null && schedule_ts <= (toTimestamp(now) ?? Date.now());
  });
  const expired_leases = rows.filter((row) => {
    const status = lower(row.queue_status);
    if (status !== "processing") return false;
    const timeout_at = toTimestamp(row.metadata?.processing_timeout_at) ?? toTimestamp(row.locked_at) ?? toTimestamp(row.updated_at);
    return timeout_at !== null && timeout_at <= (toTimestamp(now) ?? Date.now());
  });
  const duplicate_map = new Map();
  rows.forEach((row) => {
    const key = clean(row.dedupe_key);
    if (!key) return;
    duplicate_map.set(key, (duplicate_map.get(key) ?? 0) + 1);
  });
  const duplicate_fingerprints = Array.from(duplicate_map.entries()).filter(([, count]) => count > 1).map(([key]) => key);
  const retried_gt_one = rows.filter((row) => Number(row.retry_count || 0) > 1);

  const updates = [];
  for (const row of active_with_send_evidence) {
    updates.push({
      id: row.id,
      patch: {
        queue_status: row.delivered_at ? "delivered" : "sent",
        is_locked: false,
        lock_token: null,
        locked_at: null,
        updated_at: now,
      },
    });
  }

  const AUTOPILOT_REPLY_STALE_GRACE_MS = 6 * 60 * 60 * 1000;

  function shouldPreserveAutopilotReplyRow(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    if (clean(metadata.action_type) !== "autopilot_inbound_reply") return false;
    const status = lower(row.queue_status);
    if (!["queued", "scheduled", "pending"].includes(status)) return false;
    const created_ts = toTimestamp(row.created_at) ?? toTimestamp(row.updated_at);
    if (created_ts === null) return false;
    return Date.now() - created_ts < AUTOPILOT_REPLY_STALE_GRACE_MS;
  }

  let brake_held_rows = 0;
  let future_row_expiration_blocked = 0;
  for (const row of stale_rows) {
    if (["scheduled", "queued"].includes(lower(row.queue_status))) {
      future_row_expiration_blocked += 1;
      emitFutureRowExpirationBlocked(row, lifecycle_context);
      continue;
    }
    if (shouldPreserveAutopilotReplyRow(row)) {
      continue;
    }
    const status = lower(row.queue_status);
    const has_send_evidence = Boolean(clean(row.provider_message_id) || clean(row.textgrid_message_id) || row.sent_at || row.delivered_at);
    const campaignStatus = campaignStatusById.get(rowCampaignId(row)) || null;
    if (
      shouldHoldRowFromStaleExpiration(row, {
        brakeState,
        campaignStatus,
      })
    ) {
      brake_held_rows += 1;
      updates.push({
        id: row.id,
        patch: {
          metadata: {
            ...(row.metadata || {}),
            send_brake_hold: true,
            send_brake_reasons: brakeState.reasons,
            send_brake_held_at: now,
            processing_started_at: null,
            processing_worker_id: null,
            processing_timeout_at: null,
          },
          updated_at: now,
        },
      });
      continue;
    }
    let next_status = status;
    let failed_reason = null;
    if (has_send_evidence) {
      next_status = "cancelled";
      failed_reason = "stale_row_with_send_evidence_cancelled";
    } else if (Number(row.retry_count || 0) >= Number(row.max_retries || 3)) {
      next_status = "failed";
      failed_reason = "stale_max_retries_exceeded";
    } else {
      next_status = "expired";
      failed_reason = "stale_runnable_row_expired";
    }

    if (next_status !== status) {
      updates.push({
        id: row.id,
        patch: {
          queue_status: next_status,
          failed_reason,
          is_locked: false,
          lock_token: null,
          locked_at: null,
          metadata: {
            ...(row.metadata || {}),
            send_brake_hold: false,
            expired_due_to_send_brake: false,
            processing_started_at: null,
            processing_worker_id: null,
            processing_timeout_at: null,
          },
          updated_at: now,
        },
      });
    }
  }

  if (!brakeState.send_blocked) {
    const { data: expired_brake_rows } = await supabase
      .from(SEND_QUEUE_TABLE)
      .select("id,queue_status,scheduled_for,scheduled_for_utc,metadata,failed_reason")
      .eq("queue_status", "expired")
      .in("failed_reason", ["stale_runnable_row_expired"])
      .order("updated_at", { ascending: true })
      .limit(max_rows);
    for (const row of expired_brake_rows || []) {
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      if (metadata.expired_due_to_send_brake !== true && metadata.send_brake_hold !== true) continue;
      const schedule_at = row.scheduled_for_utc || row.scheduled_for;
      if (!schedule_at) continue;
      updates.push({
        id: row.id,
        patch: {
          queue_status: "scheduled",
          failed_reason: null,
          metadata: {
            ...metadata,
            send_brake_hold: false,
            expired_due_to_send_brake: false,
            send_brake_recovered_at: now,
          },
          updated_at: now,
        },
      });
    }
  }

  for (const row of rows) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    if (!metadata.send_brake_hold || brakeState.send_blocked) continue;
    updates.push({
      id: row.id,
      patch: {
        metadata: {
          ...metadata,
          send_brake_hold: false,
          send_brake_cleared_at: now,
        },
        updated_at: now,
      },
    });
  }

  for (const row of past_due_scheduled) {
    const status = lower(row.queue_status);
    if (status !== "scheduled") continue;
    if (
      shouldHoldRowFromStaleExpiration(row, {
        brakeState,
        campaignStatus: campaignStatusById.get(rowCampaignId(row)) || null,
      })
    ) {
      continue;
    }
    updates.push({
      id: row.id,
      patch: {
        queue_status: "queued",
        updated_at: now,
      },
    });
  }

  for (const row of expired_leases) {
    updates.push({
      id: row.id,
      patch: {
        queue_status: "expired",
        failed_reason: "processing_lease_expired_manual_review",
        is_locked: false,
        lock_token: null,
        locked_at: null,
        metadata: {
          ...(row.metadata || {}),
          processing_started_at: null,
          processing_worker_id: null,
          processing_timeout_at: null,
        },
        updated_at: now,
      },
    });
  }

  const deduped_updates = Array.from(
    new Map(updates.map((entry) => [String(entry.id), entry])).values()
  );

  let blocked_expiration_count = 0;
  let applied_patch_count = 0;

  if (!dry_run) {
    for (const { id, patch } of deduped_updates) {
      const patch_result = await applySendQueueLifecyclePatch(supabase, {
        id,
        patch,
        context: lifecycle_context,
      });
      if (patch_result.blocked) {
        blocked_expiration_count += 1;
      } else if (patch_result.applied) {
        applied_patch_count += 1;
      }
    }
  }

  return {
    ok: true,
    now,
    dry_run,
    stale_minutes,
    lease_minutes,
    lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
    scanned_active_rows: rows.length,
    stale_rows: stale_rows.length,
    past_due_scheduled_rows: past_due_scheduled.length,
    expired_processing_leases: expired_leases.length,
    duplicate_fingerprint_count: duplicate_fingerprints.length,
    retried_gt_one_count: retried_gt_one.length,
    reconciled_rows: dry_run ? deduped_updates.length : applied_patch_count,
    blocked_expiration_count,
    future_row_expiration_blocked,
    lock_conflicts: 0,
    send_brake_state: brakeState,
    brake_held_rows,
  };
}

export async function releaseSkippedQueueRow(row, lock_token, reason, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const skip_reason = clean(reason) || "skipped";

  const payload = {
    queue_status: "queued",
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...normalized.metadata,
      skip_reason,
      final_queue_status: "queued",
      finalized_at: now,
    },
  };

  const updated_row = await updateSendQueueRowWithLock(
    normalized.id,
    lock_token,
    payload,
    options
  );

  return updated_row || {
    ...normalized,
    ...payload,
    skip_reason,
  };
}

export async function pauseInvalidQueueRow(row, reason = "invalid_queue_row", options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const queue_row_id = normalizeQueueRowId(normalized.id, null);
  const skip_reason = clean(reason) || "invalid_queue_row";

  if (!queue_row_id) {
    throw new Error("missing_queue_row_id");
  }

  const payload = {
    queue_status: "paused_invalid_queue_row",
    guard_status: "blocked",
    guard_reason: skip_reason,
    paused_reason: skip_reason,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...normalized.metadata,
      skip_reason,
      invalid_queue_row: true,
      final_queue_status: "paused_invalid_queue_row",
      finalized_at: now,
    },
  };

  if (typeof options.pauseInvalidQueueRow === "function") {
    return options.pauseInvalidQueueRow(normalized, payload);
  }

  if (typeof options.updateQueueRow === "function") {
    await options.updateQueueRow(queue_row_id, payload);
    return {
      ...normalized,
      ...payload,
    };
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .update(payload)
    .eq("id", queue_row_id)
    .select()
    .maybeSingle();

  if (error) throw error;

  return data ? normalizeSendQueueRow(data) : {
    ...normalized,
    ...payload,
  };
}

export async function pauseNameMissingQueueRow(row, reason = "missing_seller_first_name", options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const queue_row_id = normalizeQueueRowId(normalized.id, null);
  const skip_reason = clean(reason) || "missing_seller_first_name";

  if (!queue_row_id) {
    throw new Error("missing_queue_row_id");
  }

  const payload = {
    queue_status: "paused_name_missing",
    guard_status: "blocked",
    guard_reason: skip_reason,
    paused_reason: skip_reason,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...normalized.metadata,
      skip_reason,
      final_queue_status: "paused_name_missing",
      paused_at: now,
      finalized_at: now,
    },
  };

  if (typeof options.pauseNameMissingQueueRow === "function") {
    return options.pauseNameMissingQueueRow(normalized, payload);
  }

  if (typeof options.updateQueueRow === "function") {
    await options.updateQueueRow(queue_row_id, payload);
    return {
      ...normalized,
      ...payload,
    };
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .update(payload)
    .eq("id", queue_row_id)
    .select()
    .maybeSingle();

  if (error) throw error;

  return data ? normalizeSendQueueRow(data) : {
    ...normalized,
    ...payload,
  };
}

export async function pauseMaxRetriesQueueRow(row, reason = "max_retries_reached", options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const queue_row_id = normalizeQueueRowId(normalized.id, null);
  const skip_reason = clean(reason) || "max_retries_reached";

  if (!queue_row_id) {
    throw new Error("missing_queue_row_id");
  }

  const payload = {
    queue_status: "paused_max_retries",
    guard_status: "blocked",
    guard_reason: skip_reason,
    paused_reason: skip_reason,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...normalized.metadata,
      skip_reason,
      final_queue_status: "paused_max_retries",
      finalized_at: now,
    },
  };

  if (typeof options.pauseMaxRetriesQueueRow === "function") {
    return options.pauseMaxRetriesQueueRow(normalized, payload);
  }

  if (typeof options.updateQueueRow === "function") {
    await options.updateQueueRow(queue_row_id, payload);
    return {
      ...normalized,
      ...payload,
    };
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .update(payload)
    .eq("id", queue_row_id)
    .select()
    .maybeSingle();

  if (error) throw error;

  return data ? normalizeSendQueueRow(data) : {
    ...normalized,
    ...payload,
  };
}

export async function loadClaimedQueueRow(row, options = {}) {
  const normalized = normalizeSendQueueRow(row);
  const queue_row_id = normalizeQueueRowId(normalized.id, null);

  if (!queue_row_id) return null;

  if (typeof options.loadQueueRowById === "function") {
    const loaded = await options.loadQueueRowById(queue_row_id);
    return loaded ? normalizeSendQueueRow(loaded) : null;
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("*")
    .eq("id", queue_row_id)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeSendQueueRow(data) : null;
}

export async function recycleClaimedSendingRow(row, lock_token, reason = "finalize_safety_net", options = {}) {
  const latest = normalizeSendQueueRow(row);
  const now = options.now || nowIso();
  const queue_row_id = normalizeQueueRowId(latest.id, null);
  const resolved_lock_token = clean(lock_token || latest.lock_token);

  if (!queue_row_id) {
    return null;
  }

  if (isTerminalQueueStatus(latest.queue_status)) {
    return null;
  }

  if (!["sending", "processing"].includes(lower(latest.queue_status))) {
    return null;
  }

  if (!hasCurrentProcessingRun(latest, options)) {
    return null;
  }

  const metadata_final_status = normalizeQueueStatusValue(latest.metadata?.final_queue_status);
  const preserve_terminal_status = isTerminalQueueStatus(metadata_final_status)
    ? metadata_final_status
    : null;
  const next_retry_count = preserve_terminal_status ? latest.retry_count : latest.retry_count + 1;
  const final_queue_status = preserve_terminal_status || (next_retry_count >= latest.max_retries ? "failed" : "queued");
  const finalization_reason = clean(reason) || "finalize_safety_net";
  const payload = {
    queue_status: final_queue_status,
    failed_reason: final_queue_status === "failed" ? finalization_reason : latest.failed_reason || null,
    retry_count: next_retry_count,
    next_retry_at:
      final_queue_status === "failed" || preserve_terminal_status
        ? null
        : addMinutesIso(now, 5),
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...latest.metadata,
      finalize_safety_net: true,
      skip_reason: latest.metadata?.skip_reason || finalization_reason,
      finalization_error: finalization_reason,
      final_queue_status,
      finalized_at: now,
    },
  };

  if (typeof options.recycleClaimedSendingRow === "function") {
    return options.recycleClaimedSendingRow(latest, resolved_lock_token, payload);
  }

  if (resolved_lock_token) {
    const updated = await updateSendQueueRowWithLock(
      queue_row_id,
      resolved_lock_token,
      payload,
      options
    );
    return updated || null;
  }

  if (typeof options.updateQueueRow === "function") {
    await options.updateQueueRow(queue_row_id, payload);
    return {
      ...latest,
      ...payload,
    };
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .update(payload)
    .eq("id", queue_row_id)
    .in("queue_status", ["sending", "processing"])
    .select()
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeSendQueueRow(data) : null;
}

export async function finalizeClaimedSendQueueRows(claimed_rows = [], options = {}) {
  const rows = Array.isArray(claimed_rows) ? claimed_rows : [];
  const finalized = [];
  const errors = [];

  if (typeof options.finalizeClaimedSendQueueRows === "function") {
    return options.finalizeClaimedSendQueueRows(rows, options);
  }

  for (const claimed of rows) {
    const row = claimed?.row || claimed;
    const lock_token = clean(claimed?.lock_token || row?.lock_token);
    const queue_row_id = normalizeQueueRowId(row?.id ?? row?.queue_row_id, null);
    if (!queue_row_id) continue;

    try {
      const latest = await loadClaimedQueueRow(row, options);
      const metadata_final_status = normalizeQueueStatusValue(latest?.metadata?.final_queue_status);
      if (!latest || isTerminalQueueStatus(latest.queue_status) || !["sending", "processing"].includes(lower(latest.queue_status))) {
        continue;
      }
      if (metadata_final_status && isTerminalQueueStatus(metadata_final_status)) {
        continue;
      }
      if (!hasCurrentProcessingRun(latest, options)) {
        continue;
      }
      if (lock_token && clean(latest.lock_token) && clean(latest.lock_token) !== lock_token) {
        continue;
      }

      const recycled = await recycleClaimedSendingRow(
        latest,
        lock_token || latest.lock_token,
        claimed?.reason || "finalize_safety_net",
        options
      );

      if (recycled) {
        finalized.push(recycled);
      }
    } catch (error) {
      errors.push({
        queue_row_id,
        error: clean(error?.message) || "finalize_safety_net_failed",
      });
    }
  }

  return {
    ok: errors.length === 0,
    finalized_count: finalized.length,
    stuck_recycled_count: finalized.length,
    finalized,
    errors,
  };
}

function buildWebhookLogCandidates({
  event_type,
  direction = null,
  provider_message_sid = null,
  payload = {},
  headers = {},
  received_at = nowIso(),
  source = "textgrid",
} = {}) {
  const raw_payload = ensureObject(payload);
  const raw_headers = ensureObject(headers);

  return [
    {
      provider: source,
      event_type,
      direction,
      provider_message_sid,
      payload: raw_payload,
      headers: raw_headers,
      created_at: received_at,
    },
    {
      source,
      event_type,
      direction,
      provider_message_sid,
      raw_payload,
      headers: raw_headers,
      created_at: received_at,
    },
    {
      event_type,
      provider_message_sid,
      payload: raw_payload,
      created_at: received_at,
    },
    {
      raw_payload,
      created_at: received_at,
    },
  ];
}

export async function writeWebhookLog(options = {}) {
  const candidates = buildWebhookLogCandidates(options);

  if (typeof options.writeWebhookLog === "function") {
    return options.writeWebhookLog(candidates[0]);
  }

  const supabase = getSupabase(options);

  let last_error = null;
  for (const payload of candidates) {
    const { data, error } = await supabase
      .from(WEBHOOK_LOG_TABLE)
      .insert(payload)
      .select()
      .maybeSingle();

    if (!error) return data || payload;
    last_error = error;
  }

  throw last_error || new Error("webhook_log_write_failed");
}

function normalizeWebhookLogId(webhook_log_id) {
  const id = clean(webhook_log_id);
  if (!id) return null;
  return id;
}

export async function markWebhookLogProcessed(webhook_log_id, options = {}) {
  const id = normalizeWebhookLogId(webhook_log_id);
  if (!id) return null;
  const now = options.now || nowIso();

  if (typeof options.markWebhookLogProcessed === "function") {
    return options.markWebhookLogProcessed(id, { now });
  }

  const supabase = getSupabase(options);
  const update = {
    processed: true,
    processed_at: now,
    error_message: null,
  };

  if (options.processor_version) update.processor_version = clean(options.processor_version);
  if (options.deployed_sha) update.deployed_sha = clean(options.deployed_sha);
  if (options.reconciliation_execution_id) {
    update.reconciliation_execution_id = clean(options.reconciliation_execution_id);
  }
  if (options.processing_result) update.processing_result = ensureObject(options.processing_result);
  if (options.matched_record_id) update.matched_record_id = clean(options.matched_record_id);
  if (options.processing_error_code !== undefined) {
    update.processing_error_code = options.processing_error_code
      ? clean(options.processing_error_code)
      : null;
  }

  const { data, error } = await supabase
    .from(WEBHOOK_LOG_TABLE)
    .update(update)
    .eq("id", id)
    .select("id, processed, processed_at, processor_version, processing_result, matched_record_id")
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function markWebhookLogFailed(webhook_log_id, error_message, options = {}) {
  const id = normalizeWebhookLogId(webhook_log_id);
  if (!id) return null;

  if (typeof options.markWebhookLogFailed === "function") {
    return options.markWebhookLogFailed(id, error_message);
  }

  const supabase = getSupabase(options);
  const { data, error } = await supabase
    .from(WEBHOOK_LOG_TABLE)
    .update({
      processed: false,
      error_message: clean(error_message).slice(0, 2000) || "delivery_reconcile_failed",
    })
    .eq("id", id)
    .select("id, processed, error_message")
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function reconcileDeliveryReceiptViaRpc({
  supabase,
  provider_message_sid,
  provider_status,
  raw_carrier_status,
  incoming_delivery_status,
  incoming_sent_at,
  incoming_delivered_at,
  provider_failure_reason,
  normalized_failure,
  webhook_log_id,
  now,
}) {
  const terminal_queue_status = mapTransportTerminalStatus({
    error_message: provider_failure_reason,
    error_status: normalized_failure?.error_status,
  });

  const rpc_args = {
    p_provider_message_sid: provider_message_sid,
    p_provider_status: provider_status || null,
    p_raw_carrier_status: raw_carrier_status || null,
    p_incoming_delivery_status: incoming_delivery_status,
    p_sent_at: incoming_sent_at,
    p_delivered_at: incoming_delivered_at,
    p_failed_at: incoming_delivery_status === "failed" ? now : null,
    p_failure_reason: incoming_delivery_status === "failed" ? provider_failure_reason : null,
    p_failure_bucket:
      incoming_delivery_status === "failed"
        ? legacyFailureBucketForTextGrid(normalized_failure, {
            ok: false,
            error_message: provider_failure_reason,
            error_status: normalized_failure?.error_status,
          })
        : null,
    p_failure_metadata:
      incoming_delivery_status === "failed" ? textGridFailureMetadata(normalized_failure) : null,
    p_webhook_log_id: normalizeWebhookLogId(webhook_log_id),
    p_now: now,
  };

  const { data, error } = await supabase.rpc("reconcile_delivery_receipt", rpc_args);
  if (error) throw error;

  const result = ensureObject(data);
  return {
    ...result,
    terminal_queue_status,
  };
}

async function reconcileDeliveryReceiptLocal({
  supabase,
  provider_message_sid,
  provider_status,
  raw_carrier_status,
  incoming_delivery_status,
  incoming_sent_at,
  incoming_delivered_at,
  provider_failure_reason,
  normalized_failure,
  webhook_log_id,
  now,
  options = {},
}) {
  const { data: loaded_events, error: existing_events_error } = await supabase
    .from(MESSAGE_EVENTS_TABLE)
    .select(
      "id, thread_key, queue_id, metadata, delivery_status, provider_delivery_status, raw_carrier_status, sent_at, delivered_at, failed_at, error_message, failure_reason, failure_bucket, master_owner_id, to_phone_number"
    )
    .eq("provider_message_sid", provider_message_sid);

  if (existing_events_error) throw existing_events_error;

  const message_events_data = [];
  let final_delivery_status = incoming_delivery_status;
  let reconciled_event_id = null;
  let reconciled_thread_key = null;

  for (const existing of loaded_events || []) {
    const merged = mergeDeliveryReceiptState(existing, {
      delivery_status: incoming_delivery_status,
      provider_delivery_status: provider_status || null,
      raw_carrier_status: raw_carrier_status || null,
      sent_at: incoming_sent_at,
      delivered_at: incoming_delivered_at,
      failed_at: incoming_delivery_status === "failed" ? now : null,
      error_message: incoming_delivery_status === "failed" ? provider_failure_reason : null,
      failure_reason: incoming_delivery_status === "failed" ? provider_failure_reason : null,
      failure_bucket:
        incoming_delivery_status === "failed"
          ? legacyFailureBucketForTextGrid(normalized_failure, {
              ok: false,
              error_message: provider_failure_reason,
              error_status: normalized_failure?.error_status,
            })
          : null,
      updated_at: now,
    });

    final_delivery_status = merged.delivery_status;
    const event_update = {
      ...merged,
      updated_at: now,
    };

    if (incoming_delivery_status === "failed") {
      event_update.metadata = {
        ...ensureObject(existing.metadata),
        ...textGridFailureMetadata(normalized_failure),
      };
    }

    const { data: updated_event, error: update_event_error } = await supabase
      .from(MESSAGE_EVENTS_TABLE)
      .update(event_update)
      .eq("id", existing.id)
      .select()
      .maybeSingle();

    if (update_event_error) throw update_event_error;
    if (updated_event) {
      message_events_data.push(updated_event);
      reconciled_event_id = updated_event.id;
      reconciled_thread_key = updated_event.thread_key;
    }
  }

  const terminal_queue_status = mapTransportTerminalStatus({
    error_message: provider_failure_reason,
    error_status: normalized_failure?.error_status,
  });

  const { data: queue_rows, error: queue_load_error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("*")
    .or(`provider_message_id.eq.${provider_message_sid},textgrid_message_id.eq.${provider_message_sid}`);

  if (queue_load_error) throw queue_load_error;

  const send_queue_data = [];
  for (const row of queue_rows || []) {
    const merged_queue = mergeQueueDeliveryState(row, {
      delivery_status: final_delivery_status,
      provider_delivery_status: provider_status || null,
      delivered_at: incoming_delivered_at,
      sent_at: incoming_sent_at,
      failed_at: final_delivery_status === "failed" ? now : null,
      failed_reason: final_delivery_status === "failed" ? provider_failure_reason : null,
      queue_status_terminal: terminal_queue_status,
      updated_at: now,
    });

    const queue_update = {
      ...merged_queue,
      textgrid_message_id: row.textgrid_message_id || provider_message_sid,
      updated_at: now,
    };

    if (final_delivery_status === "failed" && normalized_failure.failure_class) {
      queue_update.metadata = {
        ...ensureObject(row.metadata),
        ...textGridFailureMetadata(normalized_failure),
      };
    }

    const { data: updated_queue, error: queue_update_error } = await supabase
      .from(SEND_QUEUE_TABLE)
      .update(queue_update)
      .eq("id", row.id)
      .select()
      .maybeSingle();

    if (queue_update_error) throw queue_update_error;
    if (updated_queue) send_queue_data.push(updated_queue);
  }

  if (reconciled_thread_key && reconciled_event_id) {
    const { data: current_thread } = await supabase
      .from("inbox_thread_state")
      .select("latest_direction, latest_message_event_id")
      .eq("thread_key", reconciled_thread_key)
      .maybeSingle();

    if (
      shouldPromoteThreadDelivery({
        latest_direction: current_thread?.latest_direction,
        latest_message_event_id: current_thread?.latest_message_event_id,
        reconciled_event_id,
      })
    ) {
      await supabase
        .from("inbox_thread_state")
        .update({
          latest_delivery_status: final_delivery_status,
          updated_at: now,
        })
        .eq("thread_key", reconciled_thread_key);
    }
  }

  if (webhook_log_id) {
    await markWebhookLogProcessed(webhook_log_id, { ...options, supabase, now });
  }

  return {
    ok: true,
    final_delivery_status,
    message_events_updated: message_events_data.length,
    send_queue_updated: send_queue_data.length,
    message_events_data,
    send_queue_data,
    reconciled_event_id,
    reconciled_thread_key,
    terminal_queue_status,
  };
}

export async function logInboundMessageEvent(payload, options = {}) {
  const now = options.now || nowIso();
  const message_sid = clean(
    payload?.message_id || payload?.provider_message_sid || payload?.sid
  );
  const from_phone_number = normalizePhone(payload?.from || payload?.from_phone_number);
  const to_phone_number = normalizePhone(payload?.to || payload?.to_phone_number);

  // Extract body from all possible field names. The normalizer outputs .message
  // and .message_body; raw/un-normalized payloads may use Body, MessageBody, etc.
  const body_candidates = [
    ["message",      payload?.message],
    ["message_body", payload?.message_body],
    ["body",         payload?.body],
    ["Body",         payload?.Body],
    ["MessageBody",  payload?.MessageBody],
    ["Message",      payload?.Message],
    ["Text",         payload?.Text],
    ["text",         payload?.text],
    ["payload.Body", payload?.payload?.Body],
    ["payload.body", payload?.payload?.body],
    ["data.Body",    payload?.data?.Body],
    ["data.body",    payload?.data?.body],
  ];

  let message_body = null;
  let body_source = payload?.body_source || null;

  if (body_source && payload?.message) {
    message_body = clean(payload.message);
  } else {
    for (const [key, val] of body_candidates) {
      const s = clean(val);
      if (s) {
        message_body = s;
        body_source = key;
        break;
      }
    }
  }

  const body_missing = !message_body;
  const raw_body_keys = payload?.raw_body_keys || Object.keys(payload || {});

  if (body_missing) {
    console.warn("INBOUND BODY MISSING", JSON.stringify({
      message_sid,
      from_phone_number,
      available_payload_keys: raw_body_keys,
    }));
  }

  // Extract classification fields from payload to store in metadata and
  // authoritative message_events columns.
  const classificationFields = ensureObject(payload?.metadata);
  const detected_intent = clean(
    payload?.detected_intent || classificationFields?.detected_intent
  ) || null;
  const sentiment = clean(payload?.sentiment || classificationFields?.sentiment) || null;
  const seller_stage = clean(payload?.seller_stage || classificationFields?.seller_stage) || null;
  const conversation_stage = clean(
    payload?.conversation_stage || classificationFields?.conversation_stage
  ) || null;
  const classification_confidence = asNullableNumber(
    payload?.classification_confidence ?? classificationFields?.classification_confidence,
    null
  );
  const needs_human_review = asNullableBoolean(
    payload?.needs_human_review ?? classificationFields?.needs_human_review,
    null
  );
  const is_dnc = asNullableBoolean(payload?.is_dnc ?? classificationFields?.is_dnc, null);
  const is_wrong_number = asNullableBoolean(
    payload?.is_wrong_number ?? classificationFields?.is_wrong_number,
    null
  );
  const is_not_interested = asNullableBoolean(
    payload?.is_not_interested ?? classificationFields?.is_not_interested,
    null
  );
  // Classification veto: negative signals override any positive hot-lead token.
  // "No / No I do not own that / No wrong number / Not interested / STOP" must never be hot.
  const is_hot_lead_raw = asNullableBoolean(
    payload?.is_hot_lead ?? classificationFields?.is_hot_lead,
    null
  );
  const negative_veto = is_wrong_number === true || is_not_interested === true || is_dnc === true;
  const is_hot_lead = negative_veto ? false : is_hot_lead_raw;
  const language = clean(payload?.language || classificationFields?.language) || null;
  const next_action = clean(payload?.next_action || classificationFields?.next_action) || null;
  const priority = clean(payload?.priority || classificationFields?.priority) || null;
  const risk = clean(payload?.risk || classificationFields?.risk) || null;
  const safety_status = clean(payload?.safety_status || classificationFields?.safety_status) || null;
  const routing_allowed = asNullableBoolean(
    payload?.routing_allowed ?? classificationFields?.routing_allowed,
    null
  );
  const auto_reply_status = clean(
    payload?.auto_reply_status || classificationFields?.auto_reply_status
  ) || null;
  const auto_reply_queue_id = clean(
    payload?.auto_reply_queue_id || classificationFields?.auto_reply_queue_id
  ) || null;
  const automation_decision =
    ensureObject(payload?.automation_decision).should_queue_reply !== undefined
      ? payload.automation_decision
      : ensureObject(classificationFields?.automation_decision).should_queue_reply !== undefined
        ? classificationFields.automation_decision
        : null;
  const human_review_required = asNullableBoolean(
    payload?.human_review_required ??
      classificationFields?.human_review_required ??
      payload?.needs_human_review ??
      classificationFields?.needs_human_review,
    null
  );

  const use_injected_logger = typeof options.logInboundMessageEvent === "function";

  let existing_row = null;
  const supabase = use_injected_logger ? null : getSupabase(options);

  if (!use_injected_logger && message_sid) {
    let existing_query = await supabase
      .from(MESSAGE_EVENTS_TABLE)
      .select("id, message_event_key, metadata, created_at")
      .eq("provider_message_sid", message_sid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing_query.error) throw existing_query.error;
    existing_row = existing_query.data || null;

    if (!existing_row) {
      existing_query = await supabase
        .from(MESSAGE_EVENTS_TABLE)
        .select("id, message_event_key, metadata, created_at")
        .eq("message_id", message_sid)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing_query.error) throw existing_query.error;
      existing_row = existing_query.data || null;
    }
  }
  let event = {
    message_event_key:
      clean(existing_row?.message_event_key) ||
      `inbound_${message_sid || crypto.randomUUID()}`,
    provider_message_sid: message_sid || null,
    message_id: message_sid || null,
    direction: "inbound",
    event_type: "inbound_sms",
    message_body: message_body || null,
    to_phone_number,
    from_phone_number,
    received_at: pickFirst(payload?.received_at, now),
    event_timestamp: pickFirst(payload?.received_at, now),
    created_at: existing_row?.created_at || now,
    updated_at: now,
    character_count: message_body ? message_body.length : 0,
    detected_intent:
      detected_intent ||
      clean(payload?.metadata?.classification_result) ||
      null,
    type: clean(payload?.type || payload?.metadata?.type) || "inbound",
    safety_status: safety_status || "pending",
    auto_reply_status,
    auto_reply_queue_id,
    priority: priority || "normal",
    risk: risk || "low",
    routing_allowed: routing_allowed ?? true,
    language,
    classification_confidence: classification_confidence ?? 0,
    stage_before: clean(payload?.stage_before || payload?.metadata?.stage_before) || null,
    stage_after: clean(payload?.stage_after || payload?.metadata?.stage_after) || null,
    thread_key: canonicalThreadKeyForDirection("inbound", from_phone_number, to_phone_number),
    metadata: {
      ...ensureObject(existing_row?.metadata),
      source: "textgrid_inbound_webhook",
      raw_body_keys,
      body_source,
      // Classification fields from handle-textgrid-inbound
      ...(detected_intent ? { detected_intent } : {}),
      ...(sentiment ? { sentiment } : {}),
      ...(seller_stage ? { seller_stage } : {}),
      ...(conversation_stage ? { conversation_stage } : {}),
      ...(classification_confidence !== null ? { classification_confidence } : {}),
      ...(needs_human_review !== null ? { needs_human_review } : {}),
      ...(is_hot_lead !== null ? { is_hot_lead } : {}),
      ...(is_dnc !== null ? { is_dnc } : {}),
      ...(is_wrong_number !== null ? { is_wrong_number } : {}),
      ...(is_not_interested !== null ? { is_not_interested } : {}),
      ...(language ? { language } : {}),
      ...(next_action ? { next_action } : {}),
      ...(priority ? { priority } : {}),
      ...(risk ? { risk } : {}),
      ...(safety_status ? { safety_status } : {}),
      ...(routing_allowed !== null ? { routing_allowed } : {}),
      ...(auto_reply_status ? { auto_reply_status } : {}),
      ...(auto_reply_queue_id ? { auto_reply_queue_id } : {}),
      ...(automation_decision ? { automation_decision } : {}),
      ...(human_review_required !== null ? { human_review_required } : {}),
      ...(body_missing ? {
        body_missing: true,
        available_payload_keys: raw_body_keys,
      } : {}),
      payload,
    },
  };

  if (!use_injected_logger) {
    try {
      const enrichment = await enrichMessageEventContext(event, getSupabase(options));
      event = { ...event, ...buildMessageEventEnrichmentUpdate(enrichment) };
      event.thread_key =
        canonicalThreadKeyForDirection("inbound", event.from_phone_number, event.to_phone_number) ||
        event.thread_key;
    } catch (_) {
      event.metadata = { ...event.metadata, enrichment: { source: "inbound_enrichment_failed", enriched_at: now } };
    }
  }

  // Analytics fires regardless of DI injection path — the inbound message
  // payload is already validated at this point.
  captureSystemEvent("inbound_sms_logged", {
    provider_message_sid: message_sid || null,
    character_count: event.character_count,
  });

  if (use_injected_logger) {
    return options.logInboundMessageEvent(event);
  }

  try {
    await updateContactOutreachState({
      master_owner_id: event.master_owner_id,
      to_phone_number: event.from_phone_number, // seller is the sender
      event_type: 'inbound_reply',
      message_event_id: event.id,
      timestamp: event.created_at || now
    }, options);
  } catch (outreachErr) {
    console.error("FAILED TO UPDATE OUTREACH STATE ON INBOUND", outreachErr);
  }

  const { data, error } = await supabase
    .from(MESSAGE_EVENTS_TABLE)
    .upsert(event, {
      onConflict: "message_event_key",
      ignoreDuplicates: false,
    })
    .select()
    .maybeSingle();

  if (error) throw error;

  const savedEvent = data || event;

  try {
    await syncClassifiedInboxThreadState({
      thread_key: savedEvent.thread_key,
      seller_phone: savedEvent.from_phone_number,
      our_number: savedEvent.to_phone_number,
      master_owner_id: savedEvent.master_owner_id,
      prospect_id: savedEvent.prospect_id,
      property_id: savedEvent.property_id,
      market: payload.market || null,
      conversationStage: savedEvent.stage_after || savedEvent.stage_before || conversation_stage,
      classification: payload.classification || null,
      messageEvent: savedEvent,
      is_read: false,
      increment_direction: "inbound",
    }, options);
  } catch (syncErr) {
    console.error("FAILED TO SYNC CLASSIFIED THREAD STATE ON INBOUND", syncErr);
  }

  // Hard guarantee for inbound: ensure latest conversational points to this inbound immediately.
  // Critical: inbound must overwrite any prior delivery status as thread latest.
  try {
    const evt = savedEvent;
    const ts = evt.received_at || evt.event_timestamp || evt.created_at || new Date().toISOString();
    const directPatch = {
      latest_message_event_id: evt.id || evt.provider_message_sid || evt.message_id || null,
      latest_message_body: evt.message_body || null,
      latest_message_at: ts,
      latest_direction: "inbound",
      // Do not set delivery_status here; inbound has none. Delivery stays on prior outbound events.
      latest_delivery_status: null,
      last_inbound_at: ts,
      updated_at: new Date().toISOString(),
    };
    await supabase
      .from("inbox_thread_state")
      .upsert(
        {
          thread_key: evt.thread_key,
          ...directPatch,
        },
        { onConflict: "thread_key" }
      );
  } catch (ensureErr) {
    console.error("INBOUND ENSURE LATEST PATCH FAILED", ensureErr?.message || ensureErr);
  }

  return savedEvent;
}

export async function syncClassifiedInboxThreadState({
  thread_key,
  seller_phone,
  our_number,
  master_owner_id,
  prospect_id,
  property_id,
  market,
  conversationStage,
  classification,
  messageEvent,
  is_read,
  increment_direction,
} = {}, deps = {}) {
  const supabase = getSupabase(deps);
  const normalizedThreadKey = clean(thread_key);
  if (!normalizedThreadKey) return { ok: false, reason: "missing_thread_key" };

  const { data: existingState } = await supabase
    .from("inbox_thread_state")
    .select("*")
    .eq("thread_key", normalizedThreadKey)
    .maybeSingle();

  let patch;
  if (classification && messageEvent) {
    patch = buildThreadStatePatchFromClassification({
      messageEvent,
      classification,
      existingState: existingState || {},
    });
    patch = {
      ...patch,
      seller_phone,
      our_number,
      canonical_e164: seller_phone,
      latest_message_event_id: messageEvent.id || messageEvent.provider_message_sid || null,
      detected_intent: patch.detected_intent || patch.primary_intent || null,
    };

    // Preserve authoritative last outbound/inbound timestamps from prior state or recent events
    // (inbound classification path does not re-scan full chronology by default)
    const priorLastOutbound = existingState?.last_outbound_at || existingState?.lastOutboundAt || null;
    const priorLastInbound = existingState?.last_inbound_at || existingState?.lastInboundAt || null;
    if (!patch.last_outbound_at && priorLastOutbound) {
      patch.last_outbound_at = priorLastOutbound;
    }
    if (!patch.last_inbound_at) {
      patch.last_inbound_at = messageEvent.received_at || messageEvent.event_timestamp || messageEvent.created_at || new Date().toISOString();
    }
    // If we have prior outbound but no explicit last_outbound yet, keep it
    if (priorLastOutbound && (!patch.last_outbound_at || new Date(priorLastOutbound) > new Date(patch.last_outbound_at || 0))) {
      patch.last_outbound_at = priorLastOutbound;
    }
  } else {
    const { data: messages, error: messagesError } = await supabase
      .from(MESSAGE_EVENTS_TABLE)
      .select("*")
      .eq("thread_key", normalizedThreadKey)
      .order("created_at", { ascending: false });

    if (messagesError) throw messagesError;
    patch = await classifyThreadFromChronology(messages || [], {
      existingState: existingState || {},
      conversationStage,
    });
  }

  if (!patch) return { ok: false, reason: "classification_patch_empty" };

  const inboxPayload = patchToInboxThreadState(patch, {
    thread_key: normalizedThreadKey,
    seller_phone,
    canonical_e164: seller_phone,
    our_number,
    master_owner_id,
    prospect_id,
    property_id,
    market,
    is_read,
    increment_direction,
    status: "active",
    automation_state: "running",
  });

  return upsertInboxThreadState(inboxPayload, deps);
}

export async function syncDeliveryEvent(payload, options = {}) {
  const now = options.now || nowIso();
  const provider_message_sid = clean(payload?.message_id || payload?.provider_message_sid || payload?.sid);
  if (!provider_message_sid) {
    return {
      provider_message_sid: null,
      provider_status: null,
      message_events_count: 0,
      send_queue_count: 0,
      skipped: "missing_provider_message_sid",
    };
  }
  const provider_status = lower(payload?.status || payload?.provider_delivery_status);
  const raw_carrier_status = clean(payload?.error_status || payload?.status || "");
  const normalized_failure = normalizeTextGridFailure({
    status: payload?.status || payload?.provider_delivery_status,
    error_message: payload?.error_message,
    error_status: payload?.error_status,
    reason: payload?.reason,
    raw:
      payload?.raw && typeof payload.raw === "object" && !Array.isArray(payload.raw)
        ? payload.raw
        : {},
    metadata: payload?.metadata,
  });
  const provider_failure_reason =
    clean(normalized_failure.provider_failure_reason) ||
    clean(payload?.error_message) ||
    "delivery_failed";
  // Normalize provider status to the three canonical delivery states.
  // Intermediate TextGrid states (queued, pending, awaiting_response, etc.) are
  // accepted-but-not-yet-delivered and must not overwrite delivery_status with
  // non-final values — they map to "sent" (in-flight).
  const FINAL_FAILED_STATUSES = new Set(["failed", "undelivered", "error", "delivery_failed"]);
  const INTERMEDIATE_PROVIDER_STATUSES = new Set([
    "queued", "accepted", "pending", "sending", "sending_to_carrier",
    "pending_delivered_to_carrier", "awaiting_response",
  ]);
  const incoming_delivery_status =
    normalized_failure.failure_class
      ? "failed"
      : provider_status === "delivered"
      ? "delivered"
      : FINAL_FAILED_STATUSES.has(provider_status)
        ? "failed"
        : "sent";
  const incoming_sent_at = toIsoOrNull(payload?.sent_at) || now;
  const incoming_delivered_at = toIsoOrNull(payload?.delivered_at) || now;

  let final_delivery_status = incoming_delivery_status;
  let message_events_data = [];
  let send_queue_data = [];

  if (typeof options.syncDeliveryEvent === "function") {
    captureSystemEvent("sms_delivery_updated", {
      provider_message_sid: provider_message_sid || null,
      delivery_status: final_delivery_status,
      provider_delivery_status: provider_status || null,
      error_status: clean(payload?.error_status) || null,
      error_message: clean(payload?.error_message) || null,
    });
    return options.syncDeliveryEvent(provider_message_sid, {
      provider_delivery_status: provider_status || null,
      raw_carrier_status: raw_carrier_status || null,
      delivery_status: final_delivery_status,
      failure_reason: final_delivery_status === "failed" ? provider_failure_reason : null,
      metadata: final_delivery_status === "failed" ? textGridFailureMetadata(normalized_failure) : undefined,
      updated_at: now,
    });
  }

  const supabase = getSupabase(options);
  const webhook_log_id = options.webhook_log_id || payload?.webhook_log_id || null;
  const reconcile_args = {
    supabase,
    provider_message_sid,
    provider_status,
    raw_carrier_status,
    incoming_delivery_status,
    incoming_sent_at,
    incoming_delivered_at,
    provider_failure_reason,
    normalized_failure,
    webhook_log_id,
    now,
    options,
  };

  let reconcile_result;
  try {
    if (typeof options.reconcileDeliveryReceipt === "function") {
      reconcile_result = await options.reconcileDeliveryReceipt(reconcile_args);
    } else if (typeof supabase.rpc === "function" && options.force_local_delivery_reconcile !== true) {
      reconcile_result = await reconcileDeliveryReceiptViaRpc(reconcile_args);
    } else {
      reconcile_result = await reconcileDeliveryReceiptLocal(reconcile_args);
    }
  } catch (reconcile_error) {
    if (webhook_log_id) {
      await markWebhookLogFailed(webhook_log_id, reconcile_error?.message || "delivery_reconcile_failed", {
        ...options,
        supabase,
      }).catch(() => {});
    }
    throw reconcile_error;
  }

  final_delivery_status =
    reconcile_result?.final_delivery_status || incoming_delivery_status;
  message_events_data = reconcile_result?.message_events_data || [];
  send_queue_data = reconcile_result?.send_queue_data || [];

  if (!message_events_data.length && Number(reconcile_result?.message_events_updated || 0) > 0) {
    const { data: refreshed_events } = await supabase
      .from(MESSAGE_EVENTS_TABLE)
      .select("id, thread_key, queue_id, metadata, delivery_status, delivered_at, master_owner_id, to_phone_number")
      .eq("provider_message_sid", provider_message_sid);
    message_events_data = refreshed_events || [];
  }

  if (!send_queue_data.length && Number(reconcile_result?.send_queue_updated || 0) > 0) {
    const { data: refreshed_queue } = await supabase
      .from(SEND_QUEUE_TABLE)
      .select("*")
      .or(`provider_message_id.eq.${provider_message_sid},textgrid_message_id.eq.${provider_message_sid}`);
    send_queue_data = refreshed_queue || [];
  }

  const outreachUpdater = options.updateContactOutreachState || updateContactOutreachState;

  if (Array.isArray(message_events_data) && message_events_data.length > 0) {
    const event = message_events_data[0];
    try {
      await outreachUpdater({
        master_owner_id: event.master_owner_id,
        to_phone_number: event.to_phone_number,
        event_type: final_delivery_status === "delivered" ? "delivered" : "failed",
        message_event_id: event.id,
        timestamp: event.delivered_at || event.updated_at || now,
      }, options);
    } catch (outreachErr) {
      console.error("FAILED TO UPDATE OUTREACH STATE ON DELIVERY", outreachErr);
    }
  }

  captureSystemEvent("sms_delivery_updated", {
    provider_message_sid: provider_message_sid || null,
    delivery_status: final_delivery_status,
    provider_delivery_status: provider_status || null,
    error_status: clean(payload?.error_status) || null,
    error_message: clean(payload?.error_message) || null,
    message_events_updated: Array.isArray(message_events_data) ? message_events_data.length : 0,
  });

  const acquisition_delivery_handler =
    options.handleAcquisitionDeliveryReceipt || options.handleDeliveryReceipt || null;
  if (typeof acquisition_delivery_handler === "function") {
    for (const row of send_queue_data || []) {
      const metadata = ensureObject(row?.metadata);
      const source = clean(row?.source || metadata.source).toLowerCase();
      const acquisition_managed =
        metadata.acquisition_managed === true ||
        metadata.default_acquisition_engine === true ||
        source.startsWith("default_acquisition_") ||
        source === "campaign_launch_execution";
      if (!acquisition_managed) continue;
      await acquisition_delivery_handler(
        { queue_row: row, ...metadata },
        {
          delivery_status: final_delivery_status,
          provider_delivery_status: provider_status || null,
          failure_reason:
            final_delivery_status === "failed" ? provider_failure_reason : null,
          delivered_at: final_delivery_status === "delivered" ? incoming_delivered_at : null,
          provider_message_id: provider_message_sid,
        },
        options,
      );
    }
  }

  return {
    provider_message_sid,
    provider_status,
    final_delivery_status,
    message_events_count: Array.isArray(message_events_data) ? message_events_data.length : 0,
    send_queue_count: Array.isArray(send_queue_data) ? send_queue_data.length : 0,
  };
}

/**
 * Build the canonical dedupe key for a send_queue row.
 * The unique partial index on send_queue prevents active rows with the same key.
 */
export function buildSendQueueDedupeKey({
  master_owner_id,
  property_id,
  to_phone_number,
  template_use_case,
  touch_number,
  campaign_session_id,
} = {}) {
  const parts = [
    clean(master_owner_id) || "no_owner",
    clean(property_id) || "no_property",
    clean(to_phone_number) || "no_phone",
    clean(template_use_case) || "no_use_case",
    String(touch_number ?? "0"),
    clean(campaign_session_id) || "no_session",
  ];
  return parts.join(":");
}

// Verified against production information_schema.columns (public.send_queue, 2026-06-24).
export const SEND_QUEUE_INSERT_COLUMNS = [
  "queue_key",
  "queue_status",
  "scheduled_for",
  "send_priority",
  "is_locked",
  "locked_at",
  "lock_token",
  "retry_count",
  "max_retries",
  "next_retry_at",
  "message_body",
  "phone_number_id",
  "to_phone_number",
  "from_phone_number",
  "metadata",
  "created_at",
  "updated_at",
  "property_address",
  "queue_id",
  "queue_sequence",
  "property_type",
  "owner_type",
  "scheduled_for_local",
  "scheduled_for_utc",
  "timezone",
  "contact_window",
  "sent_at",
  "delivered_at",
  "failed_reason",
  "delivery_confirmed",
  "master_owner_id",
  "prospect_id",
  "property_id",
  "market_id",
  "sms_agent_id",
  "textgrid_number_id",
  "template_id",
  "touch_number",
  "dnc_check",
  "current_stage",
  "message_type",
  "use_case_template",
  "message_text",
  "personalization_tags_used",
  "character_count",
  "provider_message_id",
  "local_send_date",
  "local_send_hour",
  "paused_reason",
  "last_guard_checked_at",
  "dedupe_key",
  "seller_first_name",
  "seller_display_name",
  "thread_key",
  "template_source",
  "priority",
  "risk",
  "sms_eligible",
  "routing_allowed",
  "safety_status",
  "type",
  "detected_intent",
  "stage_before",
  "stage_after",
  "textgrid_message_id",
  "selected_template_id",
  "market",
  "textgrid_number",
  "guard_status",
  "guard_reason",
  "selected_agent_id",
  "risk_level",
  "ai_confidence",
  "estimated_cost",
  "approved_at",
  "held_at",
  "language",
  "owner_id",
  "blocked_reason",
  "blocked_reasons",
  "source",
  "property_address_state",
  "routing_tier",
  "routing_reason",
  "rendered_message",
  "source_event_id",
  "inbound_message_id",
  "template_selected",
  "property_address_city",
  "property_address_zip",
  "seller_status",
  "pipeline_stage",
  "agent_name",
  "template_key",
  "campaign_id",
  "campaign_target_id",
  "campaign_send_window_id",
  "phone_id",
];

const SEND_QUEUE_INSERT_COLUMN_SET = new Set(SEND_QUEUE_INSERT_COLUMNS);

function mapLegacyAgentFields(payload = {}) {
  const mapped = { ...payload };
  const metadata = ensureObject(mapped.metadata);
  const legacy_agent_id = clean(
    mapped.agent_id || metadata.agent_id || metadata.legacy_agent_id
  );
  const routing_agent_id = clean(metadata.routing_agent_id || mapped.selected_agent_id);

  if (legacy_agent_id && !clean(mapped.sms_agent_id)) {
    mapped.sms_agent_id = legacy_agent_id;
  }
  if (routing_agent_id && !clean(mapped.selected_agent_id)) {
    mapped.selected_agent_id = routing_agent_id;
  }
  if (legacy_agent_id) {
    metadata.legacy_agent_id = legacy_agent_id;
  }
  delete mapped.agent_id;
  mapped.metadata = metadata;
  return mapped;
}

function sanitizeSendQueuePayload(payload) {
  const mapped = mapLegacyAgentFields(payload);
  const sanitized = {};
  const unknown = {};
  const metadata = { ...(mapped.metadata || {}) };

  for (const [key, value] of Object.entries(mapped)) {
    if (SEND_QUEUE_INSERT_COLUMN_SET.has(key)) {
      sanitized[key] = value;
    } else if (key === "owner_id") {
      sanitized.owner_id = value;
      metadata.owner_id = value;
    } else if (key !== "metadata") {
      unknown[key] = value;
    }
  }

  if (Object.keys(unknown).length > 0) {
    metadata.unknown_payload_fields = {
      ...(metadata.unknown_payload_fields || {}),
      ...unknown,
    };
  }

  sanitized.metadata = metadata;
  return sanitized;
}

export function buildSendQueueInsertPayload(row = {}, now = null) {
  const ts = now || nowIso();
  const normalized = normalizeSendQueueRow(row);
  const metadata = ensureObject(normalized.metadata);
  // Preserve the canonical ph_ text phone id in metadata (message_events has no
  // canonical text phone_id column; provenance must survive on the queue row too).
  if (normalized.phone_id && metadata.canonical_phone_id == null) {
    metadata.canonical_phone_id = normalized.phone_id;
  }

  const candidate = {
    queue_key: clean(normalized.queue_key) || crypto.randomUUID(),
    queue_id: clean(normalized.queue_id) || clean(normalized.queue_key) || crypto.randomUUID(),
    queue_status: normalizeQueueStatusValue(normalized.queue_status) || "queued",
    scheduled_for: normalized.scheduled_for || ts,
    send_priority: asNumber(normalized.send_priority, 5),
    is_locked: false,
    locked_at: null,
    lock_token: null,
    retry_count: asNumber(normalized.retry_count, 0),
    max_retries: asNumber(normalized.max_retries, 3),
    next_retry_at: normalized.next_retry_at || null,
    message_body: normalized.message_body,
    message_text: normalized.message_text || normalized.message_body,
    phone_number_id: isUuid(normalized.phone_number_id) ? normalized.phone_number_id : null,
    phone_id: normalized.phone_id || null,
    to_phone_number: resolveQueueDestinationPhone(normalized).phone || null,
    from_phone_number: normalizePhone(normalized.from_phone_number) || null,
    metadata,
    created_at: normalized.created_at || ts,
    updated_at: normalized.updated_at || ts,
    property_address: normalized.property_address || null,
    queue_sequence: normalized.touch_number || null,
    property_type: normalized.property_type || null,
    owner_type: normalized.owner_type || null,
    scheduled_for_local: normalized.scheduled_for_local || normalized.scheduled_for || ts,
    scheduled_for_utc: normalized.scheduled_for_utc || normalized.scheduled_for || ts,
    timezone: normalized.timezone || "America/Chicago",
    contact_window: normalized.contact_window || null,
    sent_at: normalized.sent_at || null,
    delivered_at: normalized.delivered_at || null,
    failed_reason: normalized.failed_reason || null,
    delivery_confirmed: normalized.delivery_confirmed || null,
    owner_id: normalized.owner_id || metadata.owner_id || null,
    master_owner_id: normalized.master_owner_id || null,
    prospect_id: normalized.prospect_id || null,
    property_id: normalized.property_id || null,
    market_id: normalized.market_id || null,
    sms_agent_id: normalized.sms_agent_id || metadata.legacy_agent_id || metadata.agent_id || null,
    selected_agent_id:
      normalized.selected_agent_id || metadata.selected_agent_id || metadata.routing_agent_id || null,
    textgrid_number_id: normalized.textgrid_number_id || null,
    template_id: normalized.template_id || null,
    touch_number: normalized.touch_number || null,
    dnc_check: normalized.dnc_check || null,
    current_stage: normalized.current_stage || null,
    message_type: normalized.message_type || null,
    use_case_template: normalized.use_case_template || null,
    personalization_tags_used: normalized.personalization_tags_used || null,
    character_count: asNumber(
      normalized.character_count,
      normalized.message_body ? normalized.message_body.length : 0
    ),
    provider_message_id: normalized.provider_message_id || null,
    dedupe_key:
      clean(normalized.dedupe_key || metadata.idempotency_key || normalized.queue_key) || null,
    seller_first_name:
      clean(
        normalized.seller_first_name ||
          metadata.seller_first_name ||
          metadata.queue_context?.seller_first_name
      ) || null,
    seller_display_name:
      clean(normalized.seller_display_name || metadata.seller_display_name) || null,
    thread_key: normalizePhone(normalized.to_phone_number) || clean(normalized.thread_key) || null,
    template_source: clean(normalized.template_source || "catalog") || null,
    rendered_message: clean(normalized.rendered_message || normalized.message_body) || null,
    priority: clean(normalized.priority || "normal") || "normal",
    risk: clean(normalized.risk || "low") || "low",
    sms_eligible: typeof normalized.sms_eligible === "boolean" ? normalized.sms_eligible : true,
    routing_allowed:
      typeof normalized.routing_allowed === "boolean" ? normalized.routing_allowed : true,
    safety_status: clean(normalized.safety_status || "pending") || "pending",
    type: clean(normalized.type || "outbound") || "outbound",
    source: clean(normalized.source || metadata.source) || null,
    source_event_id: normalized.source_event_id || null,
    inbound_message_id: clean(normalized.inbound_message_id) || null,
    detected_intent: clean(normalized.detected_intent) || null,
    stage_before: clean(normalized.stage_before) || null,
    stage_after: clean(normalized.stage_after) || null,
    template_selected: clean(normalized.template_selected) || null,
    textgrid_message_id: clean(normalized.textgrid_message_id || normalized.provider_message_id) || null,
    textgrid_number: clean(normalized.textgrid_number) || null,
    market: clean(normalized.market) || null,
    selected_template_id: clean(normalized.selected_template_id || normalized.template_id) || null,
    guard_status: clean(normalized.guard_status) || null,
    guard_reason: clean(normalized.guard_reason) || null,
    property_address_state: clean(normalized.property_address_state || normalized.seller_state) || null,
    language: clean(normalized.language) || null,
    routing_tier: asNumber(normalized.routing_tier, null),
    routing_reason: clean(normalized.routing_reason) || null,
    property_address_city: clean(normalized.property_address_city) || null,
    property_address_zip: clean(normalized.property_address_zip) || null,
    seller_status:
      clean(normalized.seller_status || normalized.contact_status || normalized.activity_status) ||
      null,
    pipeline_stage:
      clean(normalized.pipeline_stage || normalized.stage_code || normalized.conversation_stage) ||
      null,
    agent_name: clean(normalized.agent_name || normalized.agent_first_name) || null,
    template_key:
      clean(normalized.template_key || normalized.template_id || normalized.selected_template_id) ||
      null,
    campaign_id: normalized.campaign_id || null,
    campaign_target_id: normalized.campaign_target_id || null,
    campaign_send_window_id: normalized.campaign_send_window_id || null,
  };

  const payload = {};
  for (const column of SEND_QUEUE_INSERT_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(candidate, column)) {
      payload[column] = candidate[column];
    }
  }
  return payload;
}

function insertPayloadForGuard(row = {}, now = null) {
  const ts = now || nowIso();
  return {
    queue_key: clean(row.queue_key) || `inbox:send_now:guard:${Date.now()}`,
    queue_id: clean(row.queue_id) || clean(row.queue_key) || `inbox:send_now:guard:${Date.now()}`,
    queue_status: "paused_invalid_queue_row",
    scheduled_for: ts,
    send_priority: 5,
    is_locked: false,
    retry_count: 0,
    max_retries: 3,
    message_body: clean(row.message_body || row.message_text) || "",
    message_text: clean(row.message_text || row.message_body) || "",
    to_phone_number: resolveQueueDestinationPhone(row).phone || null,
    from_phone_number: normalizePhone(row.from_phone_number) || null,
    thread_key: clean(row.thread_key || row.metadata?.thread_key) || null,
    metadata: row.metadata || {},
    created_at: ts,
    updated_at: ts,
  };
}

function isInboxSendNowRow(row = {}) {
  const queue_key = clean(row.queue_key || row.queue_id || "");
  return queue_key.startsWith("inbox:send_now:") || queue_key.startsWith("map:ownership_check:");
}

function metadataSourceValue(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  return clean(meta.source);
}

function metadataActionValue(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  return clean(meta.action);
}

function metadataCreatedFromValue(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  return clean(meta.created_from);
}

const TERMINAL_ENQUEUE_STATUSES = new Set([
  "sent",
  "failed",
  "blocked",
  "cancelled",
  "duplicate_blocked",
  "invalid_number",
  "opted_out",
  "carrier_blocked",
  "suppressed",
]);

async function isPhoneSuppressedFor21610({ to_phone_number, from_phone_number }, deps = {}) {
  const to_phone = normalizePhone(to_phone_number);
  if (!to_phone) return { suppressed: false };

  const supabase_client = deps.supabase || deps.supabaseClient || defaultSupabase;
  const from_phone = normalizePhone(from_phone_number);
  try {
    if (from_phone) {
      const pair_checks = await Promise.all([
        supabase_client
          .from(SEND_QUEUE_TABLE)
          .select("id", { count: "exact", head: true })
          .eq("to_phone_number", to_phone)
          .eq("from_phone_number", from_phone)
          .or("failed_reason.ilike.%21610%,metadata->>non_retryable_reason.eq.textgrid_21610_blacklist"),
        supabase_client
          .from(MESSAGE_EVENTS_TABLE)
          .select("id", { count: "exact", head: true })
          .eq("to_phone_number", to_phone)
          .eq("from_phone_number", from_phone)
          .eq("failure_bucket", "provider_blacklist_pair"),
        supabase_client
          .from("sms_suppression_list")
          .select("id", { count: "exact", head: true })
          .eq("phone_e164", to_phone)
          .eq("suppression_type", "provider_blacklist_pair")
          .ilike("suppression_reason", "%21610%"),
      ]);

      const pair_blocked = pair_checks.some((result) => Number(result.count || 0) > 0);
      if (pair_blocked) {
        return { suppressed: true, reason: "phone_suppressed_21610", scope: "pair" };
      }
    }

    const recipient_result = await supabase_client
      .from("sms_suppression_list")
      .select("id", { count: "exact", head: true })
      .eq("phone_e164", to_phone)
      .ilike("suppression_reason", "%21610%");
    if ((recipient_result.count ?? 0) > 0) {
      return { suppressed: true, reason: "phone_suppressed_21610", scope: "recipient" };
    }
  } catch (check_error) {
    warn("enqueue_21610_suppression_check_failed", {
      message: check_error?.message || "unknown_error",
    });
  }
  return { suppressed: false };
}

/**
 * Canonical guarded writer for send_queue rows (feeder, auto-reply, manual paths).
 */
export async function enqueueSendQueueItem(payload = {}, deps = {}) {
  const queue_status = lower(payload.queue_status || "queued");
  if (TERMINAL_ENQUEUE_STATUSES.has(queue_status)) {
    return insertSupabaseSendQueueRow(payload, deps);
  }

  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const executionMode = clean(metadata.execution_mode);
  const isProofRow =
    metadata.no_send === true ||
    metadata.proof_hydration === true ||
    metadata.proof_no_send === true ||
    clean(metadata.launch_mode) === "proof_hydration_no_send";
  const isLiveRow =
    metadata.confirm_live === true &&
    metadata.no_send !== true &&
    metadata.proof_hydration !== true;
  if (isProofRow && isLiveRow) {
    return { ok: false, reason: "contradictory_execution_mode_flags" };
  }
  if (executionMode === "immediate_live" || executionMode === "scheduled_live") {
    if (isProofRow) {
      return { ok: false, reason: "live_execution_mode_with_proof_flags" };
    }
  }

  const validation = validateOutboundSmsPayload(payload);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const suppression = await isPhoneSuppressedFor21610(
    {
      to_phone_number: payload.to_phone_number,
      from_phone_number: payload.from_phone_number,
    },
    deps
  );
  if (suppression.suppressed) {
    return { ok: false, reason: suppression.reason };
  }

  return insertSupabaseSendQueueRow(payload, deps);
}

export async function insertSupabaseSendQueueRow(payload, deps = {}) {
  const now = deps.now || nowIso();
  const sanitized = sanitizeSendQueuePayload({
    ...payload,
    queue_status: payload.queue_status || "queued",
    scheduled_for: payload.scheduled_for || payload.scheduled_for_utc || now,
    scheduled_for_utc: payload.scheduled_for_utc || payload.scheduled_for || now,
    scheduled_for_local: payload.scheduled_for_local || payload.scheduled_for || now,
    created_at: payload.created_at || now,
    updated_at: payload.updated_at || now,
  });

  const row = normalizeSendQueueRow(sanitized);

  // Canonical automation provenance: every outbound row carries the same
  // source-surface/lifecycle record so all surfaces enter one lifecycle.
  try {
    row.metadata = attachOutboundProvenance(row);
  } catch {
    // Provenance stamping must never block a send.
  }

  // ── Inbox send-now validation guard ────────────────────────────────
  const is_inbox_send_now =
    isInboxSendNowRow(row) ||
    metadataSourceValue(row) === "inbox" ||
    metadataSourceValue(row) === "manual_inbox" ||
    metadataSourceValue(row) === "map_command" ||
    metadataActionValue(row) === "send_now" ||
    metadataActionValue(row) === "send_ownership_check" ||
    metadataCreatedFromValue(row) === "leadcommand_inbox" ||
    metadataCreatedFromValue(row) === "leadcommand_map";

  if (is_inbox_send_now && normalizeQueueStatusValue(row.queue_status) === "queued") {
    const has_message_body = Boolean(clean(row.message_body || row.message_text));
    const to_phone = resolveQueueDestinationPhone(row).phone;
    const from_phone = normalizePhone(row.from_phone_number);
    const has_to_phone = Boolean(to_phone);
    const has_from_phone = Boolean(from_phone);
    const has_thread_key = Boolean(payload.thread_key || row.thread_key);
    const message_body = clean(row.message_body || row.message_text);
    const is_manual = clean(row.message_type || row.use_case_template).toLowerCase() === "manual_reply";
    const min_body_length = is_manual ? 2 : 10;
    const is_same_number = has_to_phone && has_from_phone && to_phone === from_phone;

    if (!has_thread_key || !has_to_phone || !has_from_phone || !has_message_body || message_body.length < min_body_length || is_same_number) {
      const paused_row = {
        ...insertPayloadForGuard(row, now),
        queue_status: "paused_invalid_queue_row",
        queue_key: clean(row.queue_key) || `inbox:send_now:failed:${Date.now()}`,
        metadata: {
          ...(row.metadata || {}),
          source: metadataSourceValue(row) || "inbox",
          action: metadataActionValue(row) || "send_now",
          created_from: metadataCreatedFromValue(row) || "leadcommand_inbox",
          guard_status: "blocked",
          guard_reason: !has_thread_key ? "missing_thread_key"
            : !has_to_phone ? "missing_to_phone_number"
            : !has_from_phone ? "missing_from_phone_number"
            : is_same_number ? "SAME_FROM_TO_NUMBER"
            : !has_message_body ? "missing_message_body"
            : "message_too_short",
        },
      };

      if (typeof deps.insertSupabaseSendQueueRow === "function") {
        return deps.insertSupabaseSendQueueRow(paused_row);
      }

      const supabase = getSupabase(deps);
      const paused_insert_payload = buildSendQueueInsertPayload(paused_row, now);
      const { data } = await supabase
        .from(SEND_QUEUE_TABLE)
        .insert(paused_insert_payload)
        .select()
        .maybeSingle();

      return {
        ok: false,
        reason: paused_row.metadata.guard_reason,
        item_id: data?.id || null,
        queue_row_id: data?.id || null,
        queue_item_id: data?.id || null,
        queue_key: paused_row.queue_key,
        raw: data || paused_row,
      };
    }
  }

  const insert_payload = buildSendQueueInsertPayload(row, now);

  if (typeof deps.insertSupabaseSendQueueRow === "function") {
    return deps.insertSupabaseSendQueueRow(insert_payload);
  }

  const supabase = getSupabase(deps);

  const { data, error } = await supabase
    .from(SEND_QUEUE_TABLE)
    .insert(insert_payload)
    .select()
    .maybeSingle();

  if (!error) {
    return {
      ok: true,
      item_id: data?.id || null,
      queue_row_id: data?.id || null,
      queue_item_id: data?.id || null,
      queue_id: data?.queue_id || insert_payload.queue_id,
      queue_key: data?.queue_key || insert_payload.queue_key,
      raw: data || insert_payload,
    };
  }

  if (error.code === "23505") {
    let existing = null;
    let existing_error = null;

    if (insert_payload.dedupe_key) {
      let dedupe_query = supabase
        .from(SEND_QUEUE_TABLE)
        .select("*")
        .eq("dedupe_key", insert_payload.dedupe_key);
      if (typeof dedupe_query.order === "function") {
        dedupe_query = dedupe_query.order("created_at", { ascending: false });
      }
      if (typeof dedupe_query.limit === "function") {
        dedupe_query = dedupe_query.limit(1);
      }
      const by_dedupe = await dedupe_query.maybeSingle();
      existing = by_dedupe.data || null;
      existing_error = by_dedupe.error || null;
    }

    if (!existing) {
      const by_queue_key = await supabase
        .from(SEND_QUEUE_TABLE)
        .select("*")
        .eq("queue_key", insert_payload.queue_key)
        .maybeSingle();
      existing = by_queue_key.data || null;
      existing_error = by_queue_key.error || existing_error;
    }

    if (existing_error) throw existing_error;

    if (existing && isReplaceableStaleExpiredQueueRow(existing)) {
      const superseded_key = `${clean(insert_payload.dedupe_key)}:superseded:${Date.now()}`;
      const existing_metadata =
        existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
      await supabase
        .from(SEND_QUEUE_TABLE)
        .update({
          dedupe_key: superseded_key,
          metadata: {
            ...existing_metadata,
            superseded_by_replacement: true,
            superseded_at: now,
            replacement_reason: "stale_runnable_row_expired",
          },
          updated_at: now,
        })
        .eq("id", existing.id);

      const retry = await supabase
        .from(SEND_QUEUE_TABLE)
        .insert(insert_payload)
        .select()
        .maybeSingle();
      if (!retry.error) {
        return {
          ok: true,
          replaced_expired_row: true,
          replaced_row_id: existing.id || null,
          item_id: retry.data?.id || null,
          queue_row_id: retry.data?.id || null,
          queue_item_id: retry.data?.id || null,
          queue_id: retry.data?.queue_id || insert_payload.queue_id,
          queue_key: retry.data?.queue_key || insert_payload.queue_key,
          raw: retry.data || insert_payload,
        };
      }
      throw retry.error;
    }

    if (existing) {
      return {
        ok: true,
        idempotent_replay: true,
        reason: "idempotent_replay",
        item_id: existing.id || null,
        queue_row_id: existing.id || null,
        queue_item_id: existing.id || null,
        queue_id: existing.queue_id || insert_payload.queue_id,
        queue_key: existing.queue_key || insert_payload.queue_key,
        queue_status: existing.queue_status || null,
        scheduled_for: existing.scheduled_for || null,
        raw: existing,
      };
    }

    return {
      ok: false,
      reason: "duplicate_blocked",
      item_id: null,
      queue_row_id: null,
      queue_item_id: null,
      queue_id: insert_payload.queue_id,
      queue_key: insert_payload.queue_key,
      raw: insert_payload,
    };
  }

  throw error;
}

/**
 * Upserts a row into the inbox_thread_state table.
 * This table is used to drive the Nexus Inbox dashboard.
 */
export async function upsertInboxThreadState(payload, deps = {}) {
  const supabase = getSupabase(deps);
  const now = new Date().toISOString();
  const canonical_seller_phone =
    normalizePhone(payload.seller_phone) ||
    normalizePhone(payload.canonical_e164) ||
    normalizePhone(payload.thread_key) ||
    null;
  const thread_key = canonical_seller_phone || clean(payload.thread_key);
  if (!thread_key) return { ok: false, reason: "missing_thread_key" };

  // Hard guard: refuse any write that isn't a canonical E.164 (+1XXXXXXXXXX).
  // This catches the fallback path where canonical_seller_phone is null and
  // payload.thread_key is a legacy composite (e.g. "PODIO_ID:+from:+to").
  if (!/^\+1\d{10}$/.test(thread_key)) {
    console.error("THREAD_KEY_UNRESOLVED: refused inbox_thread_state write with non-canonical key", {
      thread_key,
      seller_phone: payload.seller_phone ?? null,
      canonical_e164: payload.canonical_e164 ?? null,
    });
    return { ok: false, reason: "THREAD_KEY_UNRESOLVED" };
  }

  let prior = null;
  const { data: existing_state } = await supabase
    .from('inbox_thread_state')
    .select('inbound_count,outbound_count')
    .eq('thread_key', thread_key)
    .limit(1)
    .maybeSingle();
  prior = existing_state || null;

  const prior_inbound_count = Number(prior?.inbound_count || 0);
  const prior_outbound_count = Number(prior?.outbound_count || 0);
  const increment_direction = clean(payload.increment_direction).toLowerCase();
  const inbound_count = increment_direction === "inbound" ? prior_inbound_count + 1 : prior_inbound_count;
  const outbound_count = increment_direction === "outbound" ? prior_outbound_count + 1 : prior_outbound_count;

  const insert_payload = {
    thread_key,
    seller_phone: canonical_seller_phone || clean(payload.seller_phone),
    canonical_e164: canonical_seller_phone || clean(payload.canonical_e164),
    our_number: clean(payload.our_number),
    master_owner_id: clean(payload.master_owner_id),
    prospect_id: clean(payload.prospect_id),
    property_id: clean(payload.property_id),
    market: clean(payload.market),
    stage: clean(payload.stage),
    status: clean(payload.status || "active"),
    priority: clean(payload.priority || "normal"),
    last_intent: clean(payload.last_intent),
    next_action: clean(payload.next_action),
    automation_state: clean(payload.automation_state),
    latest_reply_template_id: clean(payload.latest_reply_template_id),
    inbound_count,
    outbound_count,
    is_read: typeof payload.is_read === 'boolean' ? payload.is_read : false,
    updated_at: now,
    metadata: {
      ...(payload.metadata || {}),
      last_sync_at: now,
    }
  };

  if (payload.latest_message_body !== undefined) insert_payload.latest_message_body = clean(payload.latest_message_body);
  if (payload.latest_message_at !== undefined) insert_payload.latest_message_at = payload.latest_message_at;
  if (payload.latest_direction !== undefined) insert_payload.latest_direction = clean(payload.latest_direction);
  if (payload.latest_delivery_status !== undefined) {
    // Enforce: if latest direction is (becoming) inbound, delivery status must not be promoted to thread.
    const willBeInbound = (insert_payload.latest_direction || payload.latest_direction || "").toLowerCase() === "inbound";
    insert_payload.latest_delivery_status = willBeInbound ? null : clean(payload.latest_delivery_status);
  }
  if (payload.latest_message_event_id !== undefined) {
    insert_payload.latest_message_event_id = clean(payload.latest_message_event_id);
  }
  if (payload.message_count !== undefined) insert_payload.message_count = Number(payload.message_count) || 0;
  if (payload.inbox_bucket !== undefined) {
    insert_payload.inbox_bucket = payload.inbox_bucket == null ? null : clean(payload.inbox_bucket);
  }
  if (payload.automation_lane !== undefined) {
    insert_payload.automation_lane = payload.automation_lane == null ? null : clean(payload.automation_lane);
  }
  if (payload.disposition !== undefined) {
    insert_payload.disposition = payload.disposition == null ? null : clean(payload.disposition);
  }
  if (typeof payload.is_suppressed === "boolean") insert_payload.is_suppressed = payload.is_suppressed;
  if (payload.last_inbound_at !== undefined) insert_payload.last_inbound_at = payload.last_inbound_at;
  if (payload.last_outbound_at !== undefined) insert_payload.last_outbound_at = payload.last_outbound_at;

  const { data, error } = await supabase
    .from('inbox_thread_state')
    .upsert(insert_payload, { onConflict: 'thread_key' })
    .select()
    .maybeSingle();

  if (error) {
    console.error("UPSERT THREAD STATE FAILED", error);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

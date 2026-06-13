import {
  buildQueueMessageEventMetadata,
  buildQueueSendFailedTriggerName,
} from "@/lib/domain/events/message-event-metadata.js";
import { logOutboundMessageEvent } from "@/lib/domain/events/log-outbound-message-event.js";
import {
  buildBaseSellerMessageEventFields,
  buildFailedMessageEventKey,
} from "@/lib/domain/events/seller-message-event.js";
import { updateBrainAfterSend } from "@/lib/domain/brain/update-brain-after-send.js";
import { updateMasterOwnerAfterSend } from "@/lib/domain/master-owners/update-master-owner-after-send.js";
import { info, warn } from "@/lib/logging/logger.js";
import {
  mapTextgridFailureBucket,
  normalizePhone,
  sendTextgridSMS,
} from "@/lib/providers/textgrid.js";
import { evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import { evaluateSmsHealthGuard } from "@/lib/domain/delivery/sms-health-guard.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import {
  AUTOMATION_LOG_TAGS,
  logAutomationConsole,
} from "@/lib/domain/automation/automation-audit.js";
import {
  hasSupabaseConfig,
  supabase as defaultSupabase,
} from "@/lib/supabase/client.js";
import { getSystemValue } from "@/lib/system-control.js";
import {
  cancelBlacklistedPhoneQueueRows,
  claimSendQueueRow,
  evaluateContactWindow,
  finalizeSendQueueFailure,
  finalizeSendQueueSuccess,
  incrementTextgridNumberUsage,
  normalizeSendQueueRow,
  normalizeQueueRowId,
  releaseSkippedQueueRow,
  resolveQueueSellerFirstName,
  resolveQueueDestinationPhone,
  reserveFromPhoneNumber,
  selectAvailableTextgridNumber,
  writeOutboundFailureMessageEvent,
  writeOutboundSuccessMessageEvent,
} from "@/lib/supabase/sms-engine.js";
import { addSentryBreadcrumb } from "@/lib/monitoring/sentry.js";
import { captureSystemEvent } from "@/lib/analytics/posthog-server.js";
import { syncOfferRecord } from "@/lib/domain/offers/sync-offer-record.js";
import { sanitizeSmsTextValue } from "@/lib/sms/sanitize.js";
import { isManualInboxSend } from "@/lib/domain/queue/is-manual-inbox-send.js";
import {
  acquisitionQueueOperation,
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "@/lib/domain/acquisition/acquisition-runtime-control.js";

const QUEUE_TABLE = "send_queue";

const TEXTGRID_NUMBER_FIELDS = {
  title: "title",
  status: "status",
  hard_pause: "hard-pause",
  pause_until: "pause-until",
};

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function nowPodioDateTimeCentral(value = nowIso()) {
  const now = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function asPositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function asNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function asArrayAppRef(value) {
  const parsed = asPositiveInteger(value, null);
  return parsed ? [parsed] : undefined;
}

function isPositiveCategory(value) {
  return [
    "yes",
    "true",
    "active",
    "enabled",
    "available",
    "on",
    "_ active",
    "_ warming up",
  ].includes(lower(value));
}

function isNegativeCategory(value) {
  return [
    "no",
    "false",
    "inactive",
    "disabled",
    "retired",
    "blocked",
    "off",
    "_ paused",
    "_ flagged",
    "⚫ retired",
  ].includes(lower(value));
}

function getSupabase(deps = {}) {
  if (!deps.supabase && !deps.supabaseClient && !hasSupabaseConfig()) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return deps.supabase || deps.supabaseClient || defaultSupabase;
}

function getPlainValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return raw;
  if ("value" in raw) {
    const value = raw.value;
    if (value && typeof value === "object" && "text" in value) return value.text;
    if (value && typeof value === "object" && "item_id" in value) return value.item_id;
    return value;
  }
  if ("start" in raw) return raw.start;
  if ("text" in raw) return raw.text;
  if ("item_id" in raw) return raw.item_id;
  return raw;
}

function getRecordFieldValues(record = null, key = "") {
  if (!record || typeof record !== "object") return [];

  if (Object.prototype.hasOwnProperty.call(record, key)) {
    const direct = record[key];
    return Array.isArray(direct) ? direct : [direct];
  }

  const fields = Array.isArray(record.fields) ? record.fields : [];
  const matched = fields.find((field) => clean(field?.external_id) === clean(key));
  if (!matched) return [];
  return Array.isArray(matched.values) ? matched.values : [];
}

function getTextLike(record = null, key = "", fallback = null) {
  const values = getRecordFieldValues(record, key);
  if (!values.length) return fallback;
  const raw = getPlainValue(values[0]);
  return clean(raw) || fallback;
}

function getCategoryLike(record = null, key = "", fallback = null) {
  const values = getRecordFieldValues(record, key);
  if (!values.length) return fallback;
  const first = values[0];
  if (first?.value?.text) return clean(first.value.text) || fallback;
  const raw = getPlainValue(first);
  return clean(raw) || fallback;
}

function getDateLike(record = null, key = "", fallback = null) {
  const values = getRecordFieldValues(record, key);
  if (!values.length) return fallback;
  const raw = values[0]?.start ?? getPlainValue(values[0]);
  return clean(raw) || fallback;
}

function getNumberLike(record = null, key = "", fallback = null) {
  const values = getRecordFieldValues(record, key);
  if (!values.length) return fallback;
  const raw = Number(getPlainValue(values[0]));
  return Number.isFinite(raw) ? raw : fallback;
}

function getQueueRowId(queue_row = null) {
  return normalizeQueueRowId(
    queue_row?.queue_row_id ??
      queue_row?.id ??
      queue_row?.queue_item_id ??
      queue_row?.item_id,
    null
  );
}

function isSupabaseQueueRow(queue_row = null) {
  return Boolean(getQueueRowId(queue_row)) && !Array.isArray(queue_row?.fields);
}

function getQueueRowValue(queue_row = null, keys = [], fallback = null) {
  for (const key of keys) {
    if (queue_row && Object.prototype.hasOwnProperty.call(queue_row, key)) {
      const value = queue_row[key];
      if (value !== null && value !== undefined && clean(value) !== "") {
        return value;
      }
    }
  }

  for (const key of keys) {
    const text = getTextLike(queue_row, key, null);
    if (text !== null && text !== undefined && clean(text) !== "") {
      return text;
    }
  }

  return fallback;
}

function buildSafeQueueRowShape(queue_row = null) {
  return {
    keys:
      queue_row && typeof queue_row === "object" && !Array.isArray(queue_row)
        ? Object.keys(queue_row).sort()
        : [],
    row: {
      id: queue_row?.id ?? null,
      queue_row_id: queue_row?.queue_row_id ?? null,
      queue_item_id: queue_row?.queue_item_id ?? null,
      item_id: queue_row?.item_id ?? null,
      queue_key: queue_row?.queue_key ?? null,
      queue_id: queue_row?.queue_id ?? null,
      queue_status: queue_row?.queue_status ?? null,
      lock_token_present: Boolean(clean(queue_row?.lock_token)),
      has_message_body: Boolean(clean(queue_row?.message_body)),
      has_message_text: Boolean(clean(queue_row?.message_text)),
      has_to_phone_number: Boolean(clean(queue_row?.to_phone_number)),
      has_from_phone_number: Boolean(clean(queue_row?.from_phone_number)),
    },
  };
}

function logMissingQueueRowId(queue_row = null, context = "queue_row_id_required") {
  console.log("QUEUE ROW ID MISSING", {
    context,
    ...buildSafeQueueRowShape(queue_row),
  });
}

function getQueueRowRelationId(queue_row = null, keys = [], fallback = null) {
  for (const key of keys) {
    if (queue_row && Object.prototype.hasOwnProperty.call(queue_row, key)) {
      const value = asPositiveInteger(queue_row[key], null);
      if (value) return value;
    }
  }

  for (const key of keys) {
    const values = getRecordFieldValues(queue_row, key);
    if (!values.length) continue;
    const raw = values[0]?.value?.item_id ?? getPlainValue(values[0]);
    const parsed = asPositiveInteger(raw, null);
    if (parsed) return parsed;
  }

  return fallback;
}

function getConfirmedProviderMessageSid(send_result = {}) {
  return (
    clean(send_result?.sid) ||
    clean(send_result?.message_id) ||
    clean(send_result?.provider_message_id) ||
    null
  );
}

function pickMessageFields(queue_row = {}) {
  return {
    to: normalizePhone(
      getQueueRowValue(queue_row, [
        "to_phone_number",
        "to",
        "phone",
        "recipient_phone",
        "canonical_e164",
        "canonical-e164",
        "phone_hidden",
        "phone-hidden",
      ])
    ),
    from: clean(
      getQueueRowValue(queue_row, [
        "from_phone_number",
        "from",
        "selected_from_number",
        "outbound_number_phone",
      ])
    ),
    body: sanitizeSmsTextValue(
      getQueueRowValue(queue_row, [
        "message_body",
        "body",
        "message_text",
        "rendered_message_text",
      ])
    ),
  };
}

function toFailureResult(queue_row = null, error = null) {
  const queue_row_id = getQueueRowId(queue_row);
  return {
    ok: false,
    sent: false,
    queue_status: "failed",
    final_queue_status: "failed",
    reason: clean(error?.message) || "queue_processing_failed",
    failed_reason: clean(error?.message) || "queue_processing_failed",
    queue_row_id,
    queue_item_id: queue_row_id,
  };
}

function resolveQueueTemplateId(queue_row = null) {
  return clean(
    getQueueRowValue(queue_row, [
      "template_id",
      "selected_template_id",
      "template",
      "template-2",
    ]) ||
      queue_row?.metadata?.selected_template_id ||
      queue_row?.metadata?.template_id ||
      queue_row?.metadata?.template?.id ||
      queue_row?.metadata?.selected_template?.id
  );
}

function resolveQueueAutomationEventType(result = {}) {
  const final_status = lower(result.final_queue_status || result.queue_status || result.status);
  if (result.sent === true || final_status === "sent" || final_status === "delivered") {
    return "queue_item_sent";
  }
  if (
    result.ok === false &&
    !result.skipped &&
    !["cancelled", "blocked_by_health_guard", "duplicate_blocked"].includes(final_status)
  ) {
    return "queue_item_failed";
  }
  if (["failed", "failed_transport", "invalid_number", "carrier_blocked"].includes(final_status)) {
    return "queue_item_failed";
  }
  return null;
}

async function emitQueueAutomationEvent(queue_row = {}, result = {}, deps = {}) {
  const emitter = deps.emitAutomationEvent || emitAutomationEvent;
  const event_type = resolveQueueAutomationEventType(result);
  if (!event_type || typeof emitter !== "function") return null;

  const queue_row_id = getQueueRowId(queue_row) || result.queue_row_id || result.queue_item_id || null;
  const payload = {
    provider: "textgrid",
    queue_row_id,
    queue_item_id: queue_row_id,
    queue_key: clean(queue_row?.queue_key || queue_row?.queue_id) || null,
    queue_status: result.final_queue_status || result.queue_status || null,
    from_phone_number:
      clean(result.from_phone_number || queue_row?.from_phone_number || queue_row?.from) || null,
    to_phone_number:
      clean(result.to_phone_number || queue_row?.to_phone_number || queue_row?.to) || null,
    provider_message_sid:
      clean(result.provider_message_id || result.provider_message_sid || result.message_id) || null,
    failed_reason: clean(result.failed_reason || result.reason || result.error) || null,
    template_id: resolveQueueTemplateId(queue_row) || null,
    routing_tier: resolveQueueRoutingTier(queue_row) || null,
    raw_result: result,
  };

  try {
    return await emitter({
      event_type,
      source: "send_queue_processor",
      dedupe_key: `send-queue:${event_type}:${queue_row_id || "unknown"}:${payload.provider_message_sid || payload.queue_status || "unknown"}`,
      conversation_thread_id: clean(queue_row?.thread_key || queue_row?.canonical_thread_key) || null,
      property_id: clean(queue_row?.property_id) || null,
      prospect_id: clean(queue_row?.prospect_id) || null,
      master_owner_id: clean(queue_row?.master_owner_id || queue_row?.owner_id) || null,
      phone_number_id: clean(queue_row?.phone_number_id || queue_row?.phone_id) || null,
      queue_item_id: queue_row_id,
      payload,
    }, {
      supabaseClient: deps.supabaseClient || deps.supabase,
      logger: deps.logger,
    });
  } catch (error) {
    logAutomationConsole(AUTOMATION_LOG_TAGS.emit_failed_non_blocking, {
      source: "send_queue_processor",
      queue_row_id,
      event_type,
      error: error?.message || "automation_emit_failed",
    });
    warn("queue.automation_emit_failed", {
      queue_row_id,
      event_type,
      error: error?.message || "automation_emit_failed",
    });
    return null;
  }
}

function resolveQueueRoutingTier(queue_row = null) {
  return clean(
    queue_row?.routing_tier ||
      queue_row?.selected_textgrid_routing_tier ||
      queue_row?.metadata?.routing_tier ||
      queue_row?.metadata?.selected_sender_diagnostics?.routing_tier ||
      queue_row?.metadata?.candidate_snapshot?.routing_tier
  );
}

function isQueueFirstTouch(queue_row = null) {
  if (typeof queue_row?.is_first_touch === "boolean") return queue_row.is_first_touch;
  if (typeof queue_row?.metadata?.is_first_touch === "boolean") return queue_row.metadata.is_first_touch;
  const touch_number = asNonNegativeInteger(
    queue_row?.touch_number ??
      queue_row?.metadata?.touch_number ??
      queue_row?.metadata?.candidate_snapshot?.touch_number,
    0
  );
  return touch_number === 1;
}

async function loadSmsHealthGuardSystemControl(deps = {}) {
  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);

  return {
    sms_blocked_sender_numbers: await get_system_value("sms_blocked_sender_numbers"),
    sms_blocked_template_ids: await get_system_value("sms_blocked_template_ids"),
    require_local_routing: await get_system_value("require_local_routing"),
    allow_regional_fallback_for_first_touch: await get_system_value("allow_regional_fallback_for_first_touch"),
  };
}

async function blockQueueRowBySmsHealthGuard(queue_row = {}, guard = {}, deps = {}) {
  const queue_row_id = getQueueRowId(queue_row);
  const now = deps.now || nowIso();
  const payload = {
    queue_status: "blocked_by_health_guard",
    guard_status: "blocked",
    guard_reason: guard.reason || "sms_health_guard_blocked",
    failed_reason: guard.reason || "sms_health_guard_blocked",
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: now,
    metadata: {
      ...(queue_row.metadata ?? {}),
      skip_reason: guard.reason || "sms_health_guard_blocked",
      block_class: guard.block_class || null,
      sms_health_guard: guard,
      final_queue_status: "blocked_by_health_guard",
      blocked_by: "sms_health_guard",
      blocked_at: now,
      finalized_at: now,
    },
  };

  await updateQueueRow(queue_row_id, payload, deps);

  return {
    ok: true,
    skipped: true,
    sent: false,
    reason: guard.reason || "sms_health_guard_blocked",
    queue_status: "blocked_by_health_guard",
    final_queue_status: "blocked_by_health_guard",
    queue_row_id,
    queue_item_id: queue_row_id,
    diagnostics: guard.diagnostics || null,
  };
}

async function updateQueueRow(queue_row_id, payload, deps = {}) {
  if (!queue_row_id) {
    throw new Error("missing_queue_row_id");
  }

  if (typeof deps.updateQueueRow === "function") {
    return deps.updateQueueRow(queue_row_id, payload);
  }

  if (typeof deps.updateItem === "function") {
    return deps.updateItem(queue_row_id, payload);
  }

  const { error } = await getSupabase(deps)
    .from(QUEUE_TABLE)
    .update(payload)
    .eq("id", queue_row_id);

  if (error) throw error;

  return {
    ok: true,
    id: queue_row_id,
    payload,
  };
}

export async function loadQueueRowById(queue_row_id, deps = {}) {
  const resolved_id = normalizeQueueRowId(queue_row_id, null);
  if (!resolved_id) return null;

  if (typeof deps.loadQueueRowById === "function") {
    return deps.loadQueueRowById(resolved_id);
  }

  const { data, error } = await getSupabase(deps)
    .from(QUEUE_TABLE)
    .select("*")
    .eq("id", resolved_id)
    .maybeSingle();

  if (error) throw error;

  if (!data) return null;

  return isSupabaseQueueRow(data) ? normalizeSendQueueRow(data) : data;
}

async function markQueueRowSending(queue_row = {}, deps = {}) {
  const queue_row_id = getQueueRowId(queue_row);
  const retry_count = asNonNegativeInteger(queue_row?.retry_count, 0);

  await updateQueueRow(
    queue_row_id,
    {
      queue_status: "sending",
      retry_count: retry_count + 1,
    },
    deps
  );

  return {
    ok: true,
    queue_row_id,
    retry_count: retry_count + 1,
  };
}

export async function failQueueItem(queue_row_or_id, error_or_options = {}, deps = {}) {
  const provided_queue_row =
    typeof queue_row_or_id === "object" && queue_row_or_id
      ? queue_row_or_id
      : { id: queue_row_or_id };
  const queue_row_id = getQueueRowId(provided_queue_row);
  const retry_count = asNonNegativeInteger(
    provided_queue_row?.retry_count ?? error_or_options?.retry_count,
    0
  );
  const failed_reason =
    typeof error_or_options === "string"
      ? error_or_options
      : clean(error_or_options?.failed_reason || error_or_options?.message);

  const failure_message = failed_reason || "queue_processing_failed";
  const lock_token = clean(
    deps.lock_token || provided_queue_row?.lock_token || error_or_options?.lock_token
  );

  if (queue_row_id && (isSupabaseQueueRow(provided_queue_row) || lock_token)) {
    const queue_row =
      isSupabaseQueueRow(provided_queue_row)
        ? normalizeSendQueueRow(provided_queue_row)
        : await loadQueueRowById(queue_row_id, deps);

    if (queue_row) {
      const failure_error =
        error_or_options instanceof Error
          ? error_or_options
          : new Error(failure_message);

      try {
        const failed_row = lock_token
          ? await finalizeSendQueueFailure(queue_row, lock_token, failure_error, {
              ...deps,
              now: deps.now || nowIso(),
            })
          : await updateQueueRow(
              queue_row_id,
              {
                queue_status: "failed",
                failed_reason: failure_message,
                retry_count,
                is_locked: false,
                locked_at: null,
                lock_token: null,
                updated_at: deps.now || nowIso(),
              },
              deps
            );

        try {
          await writeOutboundFailureMessageEvent(queue_row, failure_error, {
            ...deps,
            now: deps.now || nowIso(),
            send_result:
              typeof error_or_options === "object" ? error_or_options : null,
          });
        } catch (message_event_error) {
          warn("queue.failure_message_event_write_failed", {
            queue_row_id,
            message: message_event_error?.message || "Unknown message event error",
          });
        }

        return {
          ok: false,
          sent: false,
          queue_status: failed_row?.queue_status || "failed",
          final_queue_status: failed_row?.queue_status || "failed",
          failed_reason: failure_message,
          queue_row_id,
          queue_item_id: queue_row_id,
        };
      } catch (supabase_failure_error) {
        warn("queue.supabase_fail_update_failed", {
          queue_row_id,
          message: supabase_failure_error?.message || "Unknown queue failure update error",
        });
      }
    }
  }

  await updateQueueRow(
    queue_row_id,
    {
      queue_status: "failed",
      failed_reason: failure_message,
      retry_count,
    },
    deps
  );

  return {
    ok: false,
    sent: false,
    queue_status: "failed",
    final_queue_status: "failed",
    failed_reason: failure_message,
    queue_row_id,
    queue_item_id: queue_row_id,
  };
}

export function validateQueuedOutboundNumberItem(outbound_number_item = null, now = new Date()) {
  const status = getCategoryLike(outbound_number_item, TEXTGRID_NUMBER_FIELDS.status, null);
  const hard_pause = getCategoryLike(
    outbound_number_item,
    TEXTGRID_NUMBER_FIELDS.hard_pause,
    null
  );
  const pause_until = getDateLike(
    outbound_number_item,
    TEXTGRID_NUMBER_FIELDS.pause_until,
    null
  );
  const normalized_from = normalizePhone(
    getTextLike(outbound_number_item, "phone-number", "") ||
      getTextLike(outbound_number_item, TEXTGRID_NUMBER_FIELDS.title, "")
  );

  if (!outbound_number_item?.item_id) {
    return {
      ok: false,
      reason: "outbound_number_item_missing",
      normalized_from,
      status,
      hard_pause,
      pause_until,
    };
  }

  if (!normalized_from) {
    return {
      ok: false,
      reason: "outbound_number_phone_invalid",
      normalized_from,
      status,
      hard_pause,
      pause_until,
    };
  }

  if (status && isNegativeCategory(status)) {
    return {
      ok: false,
      reason: `outbound_number_inactive:${lower(status)}`,
      normalized_from,
      status,
      hard_pause,
      pause_until,
    };
  }

  if (hard_pause && isPositiveCategory(hard_pause)) {
    return {
      ok: false,
      reason: "outbound_number_hard_paused",
      normalized_from,
      status,
      hard_pause,
      pause_until,
    };
  }

  if (pause_until) {
    const pause_until_ts = new Date(pause_until).getTime();
    if (!Number.isNaN(pause_until_ts) && pause_until_ts > now.getTime()) {
      return {
        ok: false,
        reason: "outbound_number_paused_until",
        normalized_from,
        status,
        hard_pause,
        pause_until,
      };
    }
  }

  return {
    ok: true,
    reason: null,
    normalized_from,
    status,
    hard_pause,
    pause_until,
  };
}

export function buildFailedOutboundMessageEventFields({
  brain_item = null,
  conversation_item_id = null,
  queue_item_id,
  master_owner_id,
  prospect_id,
  property_id,
  market_id,
  phone_item_id,
  outbound_number_item_id,
  sms_agent_id = null,
  template_id,
  property_address = null,
  message_body,
  message_variant = null,
  latency_ms = null,
  selected_use_case = null,
  template_use_case = null,
  next_expected_stage = null,
  selected_variant_group = null,
  selected_tone = null,
  send_result = {},
  retry_count = 0,
  max_retries = 3,
  client_reference_id = null,
  prior_message_id = null,
  response_to_message_id = null,
} = {}) {
  const provider_message_id = getConfirmedProviderMessageSid(send_result);
  const ai_route = getCategoryLike(brain_item, "ai-route", null);
  const stage_before = getCategoryLike(brain_item, "conversation-stage", null);

  return buildBaseSellerMessageEventFields({
    message_event_key: buildFailedMessageEventKey({
      queue_item_id,
      client_reference_id,
      provider_message_id,
    }),
    provider_message_id,
    timestamp: nowPodioDateTimeCentral(),
    direction: "Outbound",
    type: "outbound",
    event_type: "Send Failure",
    message_body,
    delivery_status: "Failed",
    provider_delivery_status: send_result?.status || "failed",
    raw_carrier_status: String(send_result?.error_status || send_result?.status || ""),
    message_variant,
    latency_ms,
    property_address,
    ai_route,
    processed_by: "Queue Runner",
    source_app: "Send Queue",
    trigger_name:
      queue_item_id ? buildQueueSendFailedTriggerName(queue_item_id) : "queue-send-failed",
    failure_bucket: mapTextgridFailureBucket(send_result) || "Other",
    is_final_failure:
      asNonNegativeInteger(retry_count, 0) + 1 >= asNonNegativeInteger(max_retries, 3),
    prior_message_id,
    response_to_message_id,
    stage_before,
    stage_after: clean(next_expected_stage) || null,
    relationship_ids: {
      master_owner_id,
      prospect_id,
      property_id,
      market_id,
      phone_item_id,
      textgrid_number_item_id: outbound_number_item_id,
      sms_agent_id,
      conversation_item_id,
      template_id,
    },
    metadata: buildQueueMessageEventMetadata({
      queue_item_id,
      client_reference_id,
      provider_message_id,
      message_event_key: buildFailedMessageEventKey({
        queue_item_id,
        client_reference_id,
        provider_message_id,
      }),
      event_kind: "outbound_send_failed",
      message_variant,
      master_owner_id,
      prospect_id,
      property_id,
      market_id,
      phone_item_id,
      outbound_number_item_id,
      sms_agent_id,
      conversation_item_id,
      template_id,
      selected_use_case: clean(selected_use_case) || null,
      template_use_case: clean(template_use_case) || null,
      next_expected_stage: clean(next_expected_stage) || null,
      selected_variant_group: clean(selected_variant_group) || null,
      selected_tone: clean(selected_tone) || null,
    }),
  });
}

export async function finalizeSuccessfulQueueSend(
  {
    queue_row = null,
    queue_item_id = null,
    phone_item = null,
    phone_item_id = null,
    brain_id = null,
    brain_item = null,
    conversation_item_id = null,
    master_owner_id = null,
    prospect_id = null,
    property_id = null,
    market_id = null,
    outbound_number_item_id = null,
    sms_agent_id = null,
    property_address = null,
    template_id = null,
    message_body = "",
    message_variant = null,
    latency_ms = null,
    selected_use_case = null,
    template_use_case = null,
    next_expected_stage = null,
    selected_variant_group = null,
    selected_tone = null,
    send_result = {},
    current_total_messages_sent = 0,
    client_reference_id = null,
    now = nowIso(),
    prior_message_id = null,
    response_to_message_id = null,
  } = {},
  deps = {}
) {
  const resolved_queue_row_id = normalizeQueueRowId(
    queue_item_id || getQueueRowId(queue_row),
    null
  );
  const resolved_phone_item_id =
    asPositiveInteger(phone_item_id, null) ||
    getQueueRowRelationId(queue_row, ["phone_item_id", "phone_id"], null);
  const resolved_brain_id =
    asPositiveInteger(brain_id, null) ||
    asPositiveInteger(conversation_item_id, null) ||
    getQueueRowRelationId(queue_row, ["brain_id", "conversation_item_id"], null);
  const resolved_master_owner_id =
    asPositiveInteger(master_owner_id, null) ||
    getQueueRowRelationId(queue_row, ["master_owner_id"], null);
  const resolved_prospect_id =
    asPositiveInteger(prospect_id, null) ||
    getQueueRowRelationId(queue_row, ["prospect_id"], null);
  const resolved_property_id =
    asPositiveInteger(property_id, null) ||
    getQueueRowRelationId(queue_row, ["property_id"], null);
  const resolved_market_id =
    asPositiveInteger(market_id, null) ||
    getQueueRowRelationId(queue_row, ["market_id"], null);
  const resolved_outbound_number_item_id =
    asPositiveInteger(outbound_number_item_id, null) ||
    getQueueRowRelationId(queue_row, [
      "outbound_number_item_id",
      "textgrid_number_item_id",
      "from_number_item_id",
    ]);
  const resolved_template_id =
    asPositiveInteger(template_id, null) ||
    getQueueRowRelationId(queue_row, ["template_id", "selected_template_id"], null);
  const resolved_client_reference_id =
    clean(client_reference_id) ||
    clean(
      getQueueRowValue(queue_row, [
        "client_reference_id",
        "queue_id",
        "queue_id_2",
      ])
    ) ||
    (resolved_queue_row_id ? `queue-${resolved_queue_row_id}` : null);
  const provider_message_sid = getConfirmedProviderMessageSid(send_result);

  if (!provider_message_sid) {
    throw new Error("SEND FAILED - NO SID");
  }

  const queue_sent_update =
    deps.updateItem ||
    deps.updateQueueRow ||
    (async (item_id, payload) => updateQueueRow(item_id, payload, deps));
  const log_outbound_message_event =
    deps.logOutboundMessageEvent || logOutboundMessageEvent;
  const update_brain_after_send =
    deps.updateBrainAfterSend || updateBrainAfterSend;
  const update_master_owner_after_send =
    deps.updateMasterOwnerAfterSend || updateMasterOwnerAfterSend;

  const sent_at_central = nowPodioDateTimeCentral(now);
  const bookkeeping_errors = [];
  let outbound_event = null;

  info("queue.sent_at_timezone_conversion", {
    queue_item_id: resolved_queue_row_id,
    sent_at_utc: now,
    sent_at_central,
    timezone: "America/Chicago",
  });

  try {
    await queue_sent_update(resolved_queue_row_id, {
      queue_status: "sent",
      sent_at: now,
      provider_message_id: provider_message_sid,
    });
  } catch (error) {
    bookkeeping_errors.push(
      `queue_sent_update_failed:${error?.message || "unknown_error"}`
    );
  }

  try {
    outbound_event = await log_outbound_message_event({
      brain_item,
      conversation_item_id: resolved_brain_id,
      master_owner_id: resolved_master_owner_id,
      prospect_id: resolved_prospect_id,
      property_id: resolved_property_id,
      market_id: resolved_market_id,
      phone_item_id: resolved_phone_item_id,
      outbound_number_item_id: resolved_outbound_number_item_id,
      sms_agent_id,
      property_address,
      message_body,
      provider_message_id: provider_message_sid,
      queue_item_id: resolved_queue_row_id,
      client_reference_id: resolved_client_reference_id,
      template_id: resolved_template_id,
      message_variant,
      latency_ms,
      send_result,
      selected_use_case,
      template_use_case,
      next_expected_stage,
      selected_variant_group,
      selected_tone,
      prior_message_id,
      response_to_message_id,
      sent_at: sent_at_central,
    });
  } catch (error) {
    bookkeeping_errors.push(
      `outbound_event_log_failed:${error?.message || "unknown_error"}`
    );
  }

  try {
    await update_brain_after_send({
      brain_id: resolved_brain_id,
      phone_item_id: resolved_phone_item_id,
      message_body,
      template_id: resolved_template_id,
      current_total_messages_sent,
      now,
      master_owner_id: resolved_master_owner_id,
      prospect_id: resolved_prospect_id,
      property_id: resolved_property_id,
      sms_agent_id,
      message_event_id: outbound_event?.item_id || null,
    });
  } catch (error) {
    bookkeeping_errors.push(
      `brain_update_after_send_failed:${error?.message || "unknown_error"}`
    );
  }

  try {
    if (resolved_master_owner_id) {
      await update_master_owner_after_send({
        master_owner_id: resolved_master_owner_id,
        sent_at: now,
        selected_use_case,
      });
    }
  } catch (error) {
    bookkeeping_errors.push(
      `master_owner_update_after_send_failed:${error?.message || "unknown_error"}`
    );
  }

  return {
    ok: bookkeeping_errors.length === 0,
    partial: bookkeeping_errors.length > 0,
    sent: true,
    queue_item_id: resolved_queue_row_id,
    queue_row_id: resolved_queue_row_id,
    queue_status: "sent",
    provider_message_id: provider_message_sid,
    message_id: provider_message_sid,
    sid: provider_message_sid,
    bookkeeping_errors,
    outbound_event,
    phone_item,
  };
}

async function processLegacyQueueItem(resolved_queue_row, deps = {}) {
  const queue_row_id = getQueueRowId(resolved_queue_row);
  const retry_count = asNonNegativeInteger(resolved_queue_row?.retry_count, 0);
  const message_fields = pickMessageFields(resolved_queue_row);
  const started_at = Date.now();
  const send_textgrid_sms = deps.sendTextgridSMS || sendTextgridSMS;

  if (!queue_row_id) {
    logMissingQueueRowId(resolved_queue_row, "processLegacyQueueItem");
    return {
      ok: false,
      sent: false,
      reason: "missing_queue_row_id",
    };
  }

  if (!message_fields.to) {
    try {
      await failQueueItem(
        {
          ...resolved_queue_row,
          retry_count: retry_count + 1,
        },
        {
          failed_reason: "invalid_phone_number",
          retry_count: retry_count + 1,
        },
        deps
      );
    } catch (update_error) {
      warn("queue.send.invalid_phone_fail_update_failed", {
        queue_row_id,
        message: update_error?.message || "Unknown queue failure update error",
      });
    }

    return {
      ok: false,
      sent: false,
      queue_status: "failed",
      reason: "invalid_phone_number",
      failed_reason: "invalid_phone_number",
      queue_row_id,
      queue_item_id: queue_row_id,
    };
  }

  try {
    await markQueueRowSending(resolved_queue_row, deps);

    console.log("ABOUT TO SEND MESSAGE");
    console.log("SENDING SMS", {
      to: message_fields.to,
      from: message_fields.from,
    });

    const send_result = await send_textgrid_sms({
      to: message_fields.to,
      from: message_fields.from,
      body: message_fields.body,
    });

    console.log("TEXTGRID RAW RESPONSE", send_result?.raw ?? null);
    console.log("SEND RESULT", send_result);
    console.log("MESSAGE SEND COMPLETE");

    const provider_message_sid = getConfirmedProviderMessageSid(send_result);
    if (!provider_message_sid) {
      throw new Error("SEND FAILED - NO SID");
    }

    const finalized = await finalizeSuccessfulQueueSend(
      {
        queue_row: resolved_queue_row,
        queue_item_id: queue_row_id,
        phone_item_id: getQueueRowRelationId(resolved_queue_row, [
          "phone_item_id",
          "phone_id",
        ]),
        brain_id: getQueueRowRelationId(resolved_queue_row, [
          "brain_id",
          "conversation_item_id",
        ]),
        conversation_item_id: getQueueRowRelationId(resolved_queue_row, [
          "conversation_item_id",
          "brain_id",
        ]),
        master_owner_id: getQueueRowRelationId(resolved_queue_row, ["master_owner_id"]),
        prospect_id: getQueueRowRelationId(resolved_queue_row, ["prospect_id"]),
        property_id: getQueueRowRelationId(resolved_queue_row, ["property_id"]),
        market_id: getQueueRowRelationId(resolved_queue_row, ["market_id"]),
        outbound_number_item_id: getQueueRowRelationId(resolved_queue_row, [
          "outbound_number_item_id",
          "textgrid_number_item_id",
          "from_number_item_id",
        ]),
        sms_agent_id: getQueueRowRelationId(resolved_queue_row, ["sms_agent_id"]),
        property_address: clean(
          getQueueRowValue(resolved_queue_row, ["property_address"])
        ) || null,
        template_id: getQueueRowRelationId(resolved_queue_row, [
          "template_id",
          "selected_template_id",
        ]),
        message_body: message_fields.body,
        message_variant: getQueueRowValue(
          resolved_queue_row,
          ["message_variant"],
          null
        ),
        latency_ms: Date.now() - started_at,
        selected_use_case: clean(
          getQueueRowValue(resolved_queue_row, ["selected_use_case"])
        ) || null,
        template_use_case: clean(
          getQueueRowValue(resolved_queue_row, ["template_use_case"])
        ) || null,
        next_expected_stage: clean(
          getQueueRowValue(resolved_queue_row, ["next_expected_stage"])
        ) || null,
        selected_variant_group: clean(
          getQueueRowValue(resolved_queue_row, ["selected_variant_group"])
        ) || null,
        selected_tone: clean(
          getQueueRowValue(resolved_queue_row, ["selected_tone"])
        ) || null,
        send_result,
        current_total_messages_sent: asNonNegativeInteger(
          getQueueRowValue(resolved_queue_row, [
            "current_total_messages_sent",
            "total_messages_sent",
          ]),
          0
        ),
        client_reference_id:
          clean(
            getQueueRowValue(resolved_queue_row, [
              "client_reference_id",
              "queue_id",
              "queue_id_2",
            ])
          ) || `queue-${queue_row_id}`,
        now: nowIso(),
        prior_message_id: clean(
          getQueueRowValue(resolved_queue_row, ["prior_message_id"])
        ) || null,
        response_to_message_id: clean(
          getQueueRowValue(resolved_queue_row, ["response_to_message_id"])
        ) || null,
      },
      deps
    );

    return {
      ...finalized,
      ok: finalized.ok !== false,
      sent: true,
      queue_status: "sent",
      queue_row_id,
      queue_item_id: queue_row_id,
      provider_message_id: provider_message_sid,
      message_id: provider_message_sid,
      sid: provider_message_sid,
    };
  } catch (error) {
    console.log("TEXTGRID RAW RESPONSE", error?.data || error?.raw_text || null);
    console.log("SEND ERROR:", error?.message || "Unknown error");

    try {
      await failQueueItem(
        {
          ...resolved_queue_row,
          retry_count: retry_count + 1,
        },
        {
          failed_reason: error?.message || "queue_processing_failed",
          retry_count: retry_count + 1,
        },
        deps
      );
    } catch (update_error) {
      warn("queue.send.fail_update_failed", {
        queue_row_id,
        message: update_error?.message || "Unknown queue failure update error",
      });
    }

    return toFailureResult(resolved_queue_row, error);
  }
}

async function processSupabaseQueueItem(resolved_queue_row, deps = {}) {
  const send_textgrid_sms = deps.sendTextgridSMS || sendTextgridSMS;
  const evaluate_contact_window = deps.evaluateContactWindow || evaluateContactWindow;
  const started_at = Date.now();
  const now = deps.now || nowIso();
  let queue_row = normalizeSendQueueRow(resolved_queue_row);
  const queue_row_id = getQueueRowId(queue_row);
  const manual_inbox_send = isManualInboxSend(queue_row);
  let lock_token = clean(deps.claimedLockToken || queue_row?.lock_token) || null;

  if (!queue_row_id) {
    logMissingQueueRowId(queue_row, "processSupabaseQueueItem");
    return {
      ok: false,
      sent: false,
      reason: "missing_queue_row_id",
    };
  }

  if (
    asBoolean(queue_row.metadata?.no_send, false) ||
    asBoolean(queue_row.metadata?.proof_no_send, false) ||
    lower(queue_row.metadata?.proof_mode) === "no_send" ||
    queue_row.sms_eligible === false ||
    queue_row.routing_allowed === false
  ) {
    return {
      ok: true,
      skipped: true,
      sent: false,
      reason: asBoolean(queue_row.metadata?.no_send, false) ? "no_send_queue_row" : "queue_row_not_sendable",
      queue_status: queue_row.queue_status,
      final_queue_status: queue_row.queue_status,
      queue_row_id,
      queue_item_id: queue_row_id,
    };
  }

  try {
    if (!lock_token) {
      const claim = await claimSendQueueRow(queue_row, {
        ...deps,
        now,
      });

      if (!claim?.claimed) {
        return {
          ok: true,
          skipped: true,
          reason: claim?.reason || "queue_item_claim_conflict",
          queue_status: queue_row.queue_status,
          queue_row_id,
          queue_item_id: queue_row_id,
        };
      }

      queue_row = normalizeSendQueueRow(claim.row || queue_row);
      lock_token = claim.lock_token || lock_token;
    }

    // ── Debug queue key cancellation: never send to TextGrid ─────────────
    const queue_key_for_debug = clean(queue_row?.queue_key || queue_row?.queue_id || "");
    if (clean(queue_key_for_debug).startsWith("debug:")) {
      const now = deps.now || nowIso();

      const cancelled_payload = {
        queue_status: "cancelled",
        is_locked: false,
        locked_at: null,
        lock_token: null,
        updated_at: now,
        metadata: {
          ...(queue_row.metadata ?? {}),
          skip_reason: "debug_queue_key_ignored",
          final_queue_status: "cancelled",
          cancelled_by: "queue_runner_debug_key",
          cancelled_at: now,
        },
      };

      // Use the existing updateQueueRow helper so test harnesses can DI updateQueueRow.
      await updateQueueRow(queue_row_id, cancelled_payload, deps);

      info("queue.run_debug_queue_ignored", {
        queue_row_id,
        queue_key: queue_key_for_debug,
        message_type: queue_row.message_type || null,
        use_case_template: queue_row.use_case_template || null,
      });

      return {
        ok: true,
        skipped: true,
        reason: "debug_queue_key_ignored",
        queue_status: "cancelled",
        final_queue_status: "cancelled",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    const contact_window = evaluate_contact_window(queue_row, {
      ...deps,
      now,
    });

    console.log("CONTACT WINDOW CHECK", {
      row_id: queue_row_id,
      allowed: contact_window.allowed,
      manual_inbox_send,
      reason: contact_window.reason,
      timezone: contact_window.timezone,
      valid_window: contact_window.valid_window,
    });

    if (!contact_window.allowed && !manual_inbox_send) {
      await releaseSkippedQueueRow(queue_row, lock_token, contact_window.reason, {
        ...deps,
        now,
      });

      return {
        ok: true,
        skipped: true,
        reason: "outside_contact_window",
        queue_status: "queued",
        final_queue_status: "queued",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    const destination = resolveQueueDestinationPhone(queue_row);
    if (!destination.phone) {
      throw new Error("invalid_phone_number");
    }

    queue_row = normalizeSendQueueRow({
      ...queue_row,
      to_phone_number: destination.phone,
    });

    const number_selection = await selectAvailableTextgridNumber(queue_row, deps);
    if (!number_selection?.ok) {
      throw new Error(number_selection?.reason || "missing_from_phone_number");
    }

    if (
      clean(number_selection.from_phone_number) &&
      clean(number_selection.from_phone_number) !== clean(queue_row.from_phone_number)
    ) {
      queue_row = normalizeSendQueueRow(
        await reserveFromPhoneNumber(queue_row, lock_token, number_selection, {
          ...deps,
          now,
        })
      );
    }

    const message_fields = {
      to: destination.phone,
      from: normalizePhone(
        queue_row.from_phone_number || number_selection.from_phone_number
      ),
      body: sanitizeSmsTextValue(queue_row.message_body || queue_row.message_text),
    };

    if (!message_fields.to) throw new Error("invalid_phone_number");
    if (!message_fields.from) throw new Error("missing_from_phone_number");
    if (!message_fields.body) throw new Error("missing_message_body");

    // ── Seller name guard ────────────────────────────────────────────────
    const seller_first_name = clean(resolveQueueSellerFirstName(queue_row)) || null;

    if (seller_first_name && seller_first_name !== queue_row.seller_first_name) {
      queue_row = normalizeSendQueueRow({
        ...queue_row,
        seller_first_name,
      });
    }

    if (!manual_inbox_send && !seller_first_name) {
      // Mark row as blocked — do not send.
      const supabase_client = getSupabase(deps);
      await supabase_client
        .from(QUEUE_TABLE)
        .update({
          queue_status: "paused_name_missing",
          guard_status: "blocked",
          guard_reason: "missing_seller_first_name",
          last_guard_checked_at: now,
          paused_reason: "missing_seller_first_name",
          is_locked: false,
          locked_at: null,
          lock_token: null,
          updated_at: now,
          metadata: {
            ...(queue_row.metadata ?? {}),
            skip_reason: "missing_seller_first_name",
            final_queue_status: "paused_name_missing",
            finalized_at: now,
          },
        })
        .eq("id", queue_row_id);

      info("send.blocked_missing_name", {
        queue_row_id,
        master_owner_id: queue_row.master_owner_id,
        property_id: queue_row.property_id,
        reason: "missing_seller_first_name",
      });

      return {
        ok: false,
        skipped: true,
        reason: "missing_seller_first_name",
        queue_status: "paused_name_missing",
        final_queue_status: "paused_name_missing",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    info("queue.textgrid_send_attempt", {
      queue_row_id,
      queue_key: queue_row.queue_key || null,
      message_type: queue_row.message_type || null,
      use_case_template: queue_row.use_case_template || null,
      to: message_fields.to,
      from: message_fields.from,
      manual_inbox_send: Boolean(manual_inbox_send),
    });

    // ── Hard Idempotency Lock ───────────────────────────────────────────
    // Prevent duplicate sends if the same content was sent to the same number recently (24h).
    // This protects against loops caused by database update failures or crashes.
    const supabase_client = getSupabase(deps);
    const normalized_body = clean(message_fields.body);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1. Check if the row itself already has evidence of a previous send attempt
    const evidence_sid = clean(queue_row.provider_message_id || queue_row.textgrid_message_id || queue_row.metadata?.provider_message_sid);
    if (evidence_sid) {
      warn("queue.idempotency_blocked_sid_exists", {
        queue_row_id,
        provider_message_id: evidence_sid,
        to: message_fields.to,
      });

      // Mark as sent and return success to move the row out of the runnable pool.
      // We don't re-send because we already have a SID.
      return {
        ok: true,
        sent: true,
        skipped: false,
        reason: "idempotency_blocked_sid_exists",
        queue_status: "sent",
        final_queue_status: "sent",
        queue_row_id,
        queue_item_id: queue_row_id,
        provider_message_id: evidence_sid,
      };
    }

    // 2. Check message_events for any identical outbound message to this number in the last 24h.
    const { data: recent_sends, error: send_check_err } = await supabase_client
      .from("message_events")
      .select("id, created_at, provider_message_sid, message_body")
      .eq("to_phone_number", message_fields.to)
      .eq("direction", "outbound")
      .gte("created_at", twentyFourHoursAgo)
      .limit(10); // Check multiple in case of high volume

    if (send_check_err) {
      warn("queue.idempotency_check_failed", {
        queue_row_id,
        error: send_check_err.message,
      });
    } else {
      const duplicate_event = recent_sends?.find(event => clean(event.message_body) === normalized_body);
      
      if (duplicate_event) {
        warn("queue.idempotency_blocked_recent_duplicate", {
          queue_row_id,
          matched_event_id: duplicate_event.id,
          to: message_fields.to,
          body_preview: normalized_body.slice(0, 50),
        });

        // Terminal Block: Mark row as duplicate_blocked
        await supabase_client
          .from(QUEUE_TABLE)
          .update({
            queue_status: "duplicate_blocked",
            is_locked: false,
            locked_at: null,
            lock_token: null,
            updated_at: now,
            metadata: {
              ...(queue_row.metadata ?? {}),
              skip_reason: "hard_idempotency_blocked_24h",
              matched_event_id: duplicate_event.id,
              matched_sid: duplicate_event.provider_message_sid,
              finalized_at: now,
            },
          })
          .eq("id", queue_row_id);

        return {
          ok: true,
          skipped: true,
          reason: "hard_idempotency_blocked_24h",
          queue_status: "duplicate_blocked",
          final_queue_status: "duplicate_blocked",
          queue_row_id,
          queue_item_id: queue_row_id,
        };
      }
    }

    console.log("ABOUT TO SEND MESSAGE");
    console.log("SENDING SMS", {
      to: message_fields.to,
      from: message_fields.from,
    });

    // ── Blank greeting guard ─────────────────────────────────────────────
    // Block any row where the rendered body starts with a blank greeting.
    // This is a belt-and-suspenders guard for rows that bypassed feeder checks.
    const BLANK_GREETING_GUARD_RE = /^(hi|hey|hello|hola|ola|marhaba)\s*,/i;
    const BLANK_GREETING_INLINE_RE = /(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/;
    if (
      !manual_inbox_send &&
      (BLANK_GREETING_GUARD_RE.test(message_fields.body) ||
        BLANK_GREETING_INLINE_RE.test(message_fields.body))
    ) {
      const supabase_client = getSupabase(deps);
      await supabase_client
        .from(QUEUE_TABLE)
        .update({
          queue_status: "paused_name_missing",
          guard_status: "blocked",
          guard_reason: "blank_greeting_before_send",
          paused_reason: "blank_greeting_before_send",
          is_locked: false,
          locked_at: null,
          lock_token: null,
          updated_at: now,
          metadata: {
            ...(queue_row.metadata ?? {}),
            skip_reason: "blank_greeting_before_send",
            final_queue_status: "paused_name_missing",
            paused_reason: "blocked_blank_greeting_before_send",
            blocked_by: "process_send_queue_guard",
            finalized_at: now,
            blocked_at: now,
          },
        })
        .eq("id", queue_row_id);

      info("send.blocked_blank_greeting", {
        queue_row_id,
        master_owner_id: queue_row.master_owner_id,
        property_id: queue_row.property_id,
        reason: "blank_greeting_before_send",
        body_preview: String(message_fields.body || "").slice(0, 60),
      });

      return {
        ok: false,
        skipped: true,
        reason: "blank_greeting_before_send",
        queue_status: "paused_name_missing",
        final_queue_status: "paused_name_missing",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    const sms_health_guard = evaluateSmsHealthGuard({
      from_phone_number: message_fields.from,
      template_id: resolveQueueTemplateId(queue_row),
      routing_tier: resolveQueueRoutingTier(queue_row),
      first_touch: isQueueFirstTouch(queue_row),
      metadata: queue_row.metadata || {},
      system_control: await loadSmsHealthGuardSystemControl(deps),
      now,
    });

    if (!sms_health_guard.allowed) {
      warn("queue.sms_health_guard_blocked", {
        queue_row_id,
        queue_key: queue_row.queue_key || null,
        reason: sms_health_guard.reason,
        block_class: sms_health_guard.block_class,
        from: message_fields.from,
        template_id: resolveQueueTemplateId(queue_row) || null,
        routing_tier: resolveQueueRoutingTier(queue_row) || null,
        first_touch: isQueueFirstTouch(queue_row),
      });

      return blockQueueRowBySmsHealthGuard(queue_row, sms_health_guard, deps);
    }

    captureSystemEvent("sms_send_started", {
      queue_row_id: queue_row_id,
      queue_key: queue_row.queue_key || null,
      master_owner_id: queue_row.master_owner_id || null,
      template_id: queue_row.template_id || null,
      touch_number: queue_row.touch_number ?? null,
      character_count: queue_row.character_count ?? message_fields.body.length,
      campaign_id: queue_row.metadata?.campaign_id ?? null,
    });

    const send_result = await send_textgrid_sms({
      to: message_fields.to,
      from: message_fields.from,
      body: message_fields.body,
      seller_first_name,
    });

    console.log("TEXTGRID RAW RESPONSE", send_result?.raw ?? null);
    console.log("SEND RESULT", send_result);
    console.log("MESSAGE SEND COMPLETE");

    const provider_message_sid = getConfirmedProviderMessageSid(send_result);
    if (!provider_message_sid) {
      throw new Error("SEND FAILED - NO SID");
    }

    info("queue.textgrid_send_success", {
      queue_row_id,
      queue_key: queue_row.queue_key || null,
      provider_message_id: provider_message_sid,
      to: message_fields.to,
      from: message_fields.from,
    });

    queue_row = normalizeSendQueueRow({
      ...queue_row,
      from_phone_number: message_fields.from,
      textgrid_number_id:
        queue_row.textgrid_number_id || number_selection?.selected?.id || null,
      character_count: message_fields.body.length,
      message_body: message_fields.body,
      message_text: message_fields.body,
    });

    const finalized_row = await finalizeSendQueueSuccess(
      queue_row,
      lock_token,
      send_result,
      {
        ...deps,
        now,
      }
    );

    const bookkeeping_errors = [];
    let outbound_event = null;

    try {
      outbound_event = await writeOutboundSuccessMessageEvent(
        finalized_row,
        send_result,
        {
          ...deps,
          now,
          latency_ms: Date.now() - started_at,
        }
      );
      console.log("MESSAGE EVENT WRITTEN", {
        type: "success",
        row_id: queue_row_id,
        provider_message_sid,
      });
    } catch (message_event_error) {
      const me_err_msg = message_event_error?.message || "unknown_error";
      const me_err_code = message_event_error?.code || null;
      bookkeeping_errors.push(
        `message_event_write_failed:${me_err_msg}`
      );
      warn("queue.success_message_event_write_failed", {
        queue_row_id,
        error_code: me_err_code,
        error_message: me_err_msg,
        hint: me_err_code === "PGRST204"
          ? "schema drift: payload column missing from message_events table"
          : null,
      });
      console.error("MESSAGE EVENT WRITE FAILED", {
        queue_row_id,
        error_code: me_err_code,
        error_message: me_err_msg,
      });
    }

    try {
      if (number_selection?.selected?.id) {
        await incrementTextgridNumberUsage(number_selection, {
          ...deps,
          now,
        });
      }
    } catch (number_usage_error) {
      bookkeeping_errors.push(
        `textgrid_number_usage_update_failed:${number_usage_error?.message || "unknown_error"}`
      );
      warn("queue.textgrid_number_usage_update_failed", {
        queue_row_id,
        textgrid_number_id: number_selection?.selected?.id || null,
        message: number_usage_error?.message || "Unknown number usage update error",
      });
    }

    // Offer record sync — non-blocking bookkeeping step.
    // syncOfferRecord decides whether to skip (Stage 1, underwriting routes,
    // or messages that do not contain an actual snapshot-backed offer amount).
    // It never throws and must never block the send pipeline.
    try {
      const sync_offer = deps.syncOfferRecord ?? syncOfferRecord;
      const offer_sync = await sync_offer({
        queue_row,
        outbound_event_id: outbound_event?.item_id ?? null,
        now,
      });
      if (offer_sync && !offer_sync.ok && !offer_sync.skipped) {
        bookkeeping_errors.push(
          `offer_record_sync_failed:${offer_sync.error || "unknown"}`
        );
      }
    } catch (offer_sync_error) {
      bookkeeping_errors.push(
        `offer_record_sync_failed:${offer_sync_error?.message || "unknown_error"}`
      );
      warn("queue.offer_record_sync_failed", {
        queue_row_id,
        message: offer_sync_error?.message || "Unknown offer sync error",
      });
    }

    console.log("SEND SUCCESS", {
      row_id: queue_row_id,
      provider_message_sid,
    });

    return {
      ok: bookkeeping_errors.length === 0,
      partial: bookkeeping_errors.length > 0,
      sent: true,
      queue_status: "sent",
      final_queue_status: "sent",
      queue_row_id,
      queue_item_id: queue_row_id,
      provider_message_id: provider_message_sid,
      message_id: provider_message_sid,
      sid: provider_message_sid,
      bookkeeping_errors,
      outbound_event,
    };
  } catch (error) {
    console.log("TEXTGRID RAW RESPONSE", error?.data || error?.raw_text || null);
    console.log("SEND ERROR:", error?.message || "Unknown error");

    warn("queue.textgrid_send_failure", {
      queue_row_id,
      queue_key: clean(queue_row?.queue_key || queue_row?.queue_id || ""),
      message: error?.message || "Unknown error",
      manual_inbox_send: Boolean(manual_inbox_send),
    });

    // ── Duplicate Block Detection ────────────────────────────────────────
    // If the provider specifically returns a duplicate error, treat as terminal.
    const error_msg_lower = String(error?.message || "").toLowerCase();
    const is_duplicate_error = error_msg_lower.includes("duplicate message") || 
                              error_msg_lower.includes("already sent") ||
                              (error?.data?.error && String(error.data.error).toLowerCase().includes("duplicate"));
    
    if (is_duplicate_error) {
      warn("queue.provider_duplicate_detected", { queue_row_id, to: queue_row.to_phone_number });
      try {
        const supabase_client = getSupabase(deps);
        await supabase_client
          .from(QUEUE_TABLE)
          .update({
            queue_status: "duplicate_blocked",
            is_locked: false,
            locked_at: null,
            lock_token: null,
            updated_at: now,
            failed_reason: "provider_duplicate_message",
            metadata: {
              ...(queue_row.metadata ?? {}),
              final_queue_status: "duplicate_blocked",
              provider_error: error?.message,
              finalized_at: now,
            },
          })
          .eq("id", queue_row_id);
      } catch (_dup_err) {
        warn("queue.duplicate_mark_failed", { queue_row_id });
      }
      return {
        ok: true, // It's "ok" because we handled it as a terminal state
        skipped: true,
        reason: "provider_duplicate_message",
        queue_status: "duplicate_blocked",
        final_queue_status: "duplicate_blocked",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    // Blank greeting errors from TextGrid guard should pause as name_missing not failed.
    const is_blank_greeting_error = /blank.*(greeting|name)|missing.*seller_first_name/i.test(error?.message || "");
    const is_blacklist_error = /21610|blacklist/i.test(error?.message || "");
    
    if (is_blank_greeting_error) {
      try {
        const supabase_client = getSupabase(deps);
        await supabase_client
          .from(QUEUE_TABLE)
          .update({
            queue_status: "paused_name_missing",
            guard_status: "blocked",
            guard_reason: "blank_greeting_textgrid_guard",
            paused_reason: "blank_greeting_textgrid_guard",
            is_locked: false,
            locked_at: null,
            lock_token: null,
            updated_at: now,
            metadata: {
              ...(queue_row.metadata ?? {}),
              skip_reason: "blank_greeting_textgrid_guard",
              final_queue_status: "paused_name_missing",
              paused_reason: "blocked_blank_greeting_before_send",
              blocked_by: "textgrid_send_guard",
              finalized_at: now,
              blocked_at: now,
            },
          })
          .eq("id", queue_row_id);
      } catch (_pause_err) {
        warn("queue.blank_greeting_pause_failed", { queue_row_id });
      }
      return {
        ok: false,
        skipped: true,
        reason: "blank_greeting_textgrid_guard",
        queue_status: "paused_name_missing",
        final_queue_status: "paused_name_missing",
        queue_row_id,
        queue_item_id: queue_row_id,
      };
    }

    if (is_blacklist_error) {
        addSentryBreadcrumb("queue_failure", "provider_blacklist_21610_terminal", { queue_row_id, error: error?.message });
        // Cancel all pending rows for this recipient — a 21610 means the number is
        // blacklisted/opted-out. Future sends to this phone must never be attempted.
        cancelBlacklistedPhoneQueueRows(
          { to_phone_number: queue_row.to_phone_number, skip_queue_id: queue_row_id },
          deps
        ).catch((cancel_err) => {
          warn("queue.blacklist_cancel_future_rows_failed", {
            queue_row_id,
            to_phone_number: queue_row.to_phone_number,
            message: cancel_err?.message,
          });
        });
    }

    try {
      const failed_row = lock_token
        ? await finalizeSendQueueFailure(queue_row, lock_token, error, {
            ...deps,
            now,
          })
        : null;

      try {
        await writeOutboundFailureMessageEvent(queue_row, error, {
          ...deps,
          now,
          send_result: error?.data
            ? {
                ok: false,
                error_message: error?.message,
                error_status: error?.status || null,
                raw: error?.data,
              }
            : null,
        });
        console.log("MESSAGE EVENT WRITTEN", {
          type: "failure",
          row_id: queue_row_id,
        });
      } catch (message_event_error) {
        warn("queue.failure_message_event_write_failed", {
          queue_row_id,
          message: message_event_error?.message || "Unknown message event error",
        });
      }

      return {
        ...toFailureResult(queue_row, error),
        queue_status: failed_row?.queue_status || "failed",
        final_queue_status: failed_row?.queue_status || "failed",
      };
    } catch (update_error) {
      warn("queue.send.fail_update_failed", {
        queue_row_id,
        message: update_error?.message || "Unknown queue failure update error",
      });
      return toFailureResult(queue_row, error);
    }
  }
}

export async function processSendQueueItem(queue_row, deps = {}) {
  const looks_like_queue_row =
    queue_row &&
    typeof queue_row === "object" &&
    !Array.isArray(queue_row) &&
    Object.keys(queue_row).some(
      (key) =>
        [
          "fields",
          "queue_status",
          "message_body",
          "message_text",
          "to_phone_number",
          "from_phone_number",
          "scheduled_for",
          "scheduled_for_utc",
          "scheduled_for_local",
          "metadata",
          "retry_count",
          "max_retries",
          "queue_key",
          "queue_id",
        ].includes(key)
    );
  const queue_row_id =
    queue_row && typeof queue_row === "object" && !Array.isArray(queue_row)
      ? getQueueRowId(queue_row)
      : normalizeQueueRowId(queue_row, null);
  const resolved_queue_row = looks_like_queue_row
    ? queue_row
    : await loadQueueRowById(queue_row_id, deps);

  if (!resolved_queue_row) {
    return {
      ok: false,
      sent: false,
      reason: "missing_queue_row",
    };
  }

  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const runtime_brake = evaluateQueueSendRuntimeBrakes(
    {
      queue_processor_mode: await get_system_value("queue_processor_mode"),
      queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
    },
    { action: "processSendQueueItem", failClosed: false }
  );
  if (!runtime_brake.ok) {
    return {
      ok: false,
      status: 423,
      sent: false,
      skipped: true,
      reason: runtime_brake.reason,
      error: runtime_brake.error,
      message: runtime_brake.message,
      diagnostics: runtime_brake.diagnostics,
      queue_row_id: getQueueRowId(resolved_queue_row),
      queue_item_id: getQueueRowId(resolved_queue_row),
    };
  }

  const acquisitionOperation = acquisitionQueueOperation(resolved_queue_row);
  if (acquisitionOperation) {
    const acquisitionRuntime = await getAcquisitionRuntimeControl(
      acquisitionOperation,
      deps
    );
    if (!acquisitionRuntime.enabled) {
      return {
        ...acquisitionRuntimeDisabled(acquisitionRuntime),
        sent: false,
        queue_row_id: getQueueRowId(resolved_queue_row),
        queue_item_id: getQueueRowId(resolved_queue_row),
      };
    }
  }

  const result = isSupabaseQueueRow(resolved_queue_row)
    ? await processSupabaseQueueItem(resolved_queue_row, deps)
    : await processLegacyQueueItem(resolved_queue_row, deps);

  await emitQueueAutomationEvent(resolved_queue_row, result, deps);
  return result;
}

export async function processSendQueue(input = {}, deps = {}) {
  const queue_row =
    input?.queue_row ||
    input?.row ||
    (input &&
    typeof input === "object" &&
    (input.id || input.queue_row_id || input.queue_item_id || input.item_id)
      ? input
      : null);

  if (queue_row) {
    return processSendQueueItem(queue_row, deps);
  }

  const queue_item_id = normalizeQueueRowId(
    input?.queue_row_id || input?.id || input?.queue_item_id || input,
    null
  );
  if (!queue_item_id) {
    return {
      ok: false,
      sent: false,
      reason: "missing_queue_row",
    };
  }

  const loaded = await loadQueueRowById(queue_item_id, deps);
  return processSendQueueItem(loaded, deps);
}

export default processSendQueueItem;

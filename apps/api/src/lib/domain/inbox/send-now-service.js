// ─── send-now-service.js ────────────────────────────────────────────────────
// Inbox manual "Send Now" payload validation and queue insertion.
// Validates required fields, resolves from_phone_number, and creates
// properly structured send_queue rows.

import crypto from "node:crypto";

import { child } from "@/lib/logging/logger.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { isUuid } from "@/lib/utils/is-uuid.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { evaluateQueueCreationRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import { sendTextgridSMS } from "@/lib/providers/textgrid.js";
import { getSystemValue } from "@/lib/system-control.js";
import {
  insertSupabaseSendQueueRow,
  checkBlacklistPriorFailure,
  normalizeSendQueueRow,
  finalizeSendQueueSuccess,
  finalizeSendQueueFailure,
  writeOutboundSuccessMessageEvent,
  writeOutboundFailureMessageEvent,
} from "@/lib/supabase/sms-engine.js";
import { validateOutboundSmsPayload } from "@/lib/domain/messaging/MessageValidationService.js";
import { detectEntityOwner } from "@/lib/identity/ownerProspectAlignment.js";

// Final safety rail before provider dispatch: never let an SMS go out addressed to
// an entity/LLC/trust name (e.g. "Hey West 7th Apartments LLC,"). Checks only the
// greeting-name slot, not the whole message body.
const GREETING_NAME_PATTERN = /^\s*(?:hi|hey|hello|hola|ola|marhaba)\s+([^,]+),/i;

function hasEntityNameInGreeting(message_body) {
  const match = String(message_body || "").trim().match(GREETING_NAME_PATTERN);
  if (!match) return false;
  return detectEntityOwner(match[1]);
}

const logger = child({ module: "domain.inbox.send_now_service" });

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function objectMetadata(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeBodyForFingerprint(value = "") {
  return clean(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTransportFingerprint({ to_phone_number, message_body, now = Date.now() }) {
  const window_ms = 5 * 60 * 1000;
  const window_bucket = Math.floor(now / window_ms);
  const seed = `${clean(to_phone_number)}|${normalizeBodyForFingerprint(message_body)}|${window_bucket}`;
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function quotePostgrestValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`;
}

function isTransportFailureReason(reason = "") {
  const r = clean(reason).toLowerCase();
  if (!r) return false;
  if (
    r.includes("content filter") ||
    r.includes("invalid") ||
    r.includes("duplicate") ||
    r.includes("opted_out") ||
    r.includes("opt out") ||
    r.includes("stop")
  ) {
    return false;
  }
  return (
    r.includes("network") ||
    r.includes("timeout") ||
    r.includes("gateway") ||
    r.includes("transport") ||
    r.includes("outage") ||
    r.includes("unavailable") ||
    r.includes("carrier")
  );
}

// ════════════════════════════════════════════════════════════════════════════
// OUTBOUND SEND GATE
// ════════════════════════════════════════════════════════════════════════════

function isManualOperatorSend(input = {}) {
  const input_metadata = objectMetadata(input.metadata);
  return (
    asBoolean(input.manual_operator_send, false) ||
    clean(input.source) === "manual_inbox" ||
    clean(input.send_source) === "manual_inbox" ||
    clean(input.source) === "map_command" ||
    clean(input.send_source) === "map_command" ||
    clean(input_metadata.source) === "manual_inbox" ||
    clean(input_metadata.send_source) === "manual_inbox" ||
    clean(input_metadata.source) === "map_command" ||
    clean(input_metadata.send_source) === "map_command" ||
    clean(input.action) === "send_now" ||
    clean(input_metadata.action) === "send_now" ||
    clean(input.action) === "send_ownership_check" ||
    clean(input_metadata.action) === "send_ownership_check"
  );
}

export async function canSend(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const thread_key = clean(input.thread_key) || normalizePhone(input.to_phone_number);
  const manual_operator_send = isManualOperatorSend(input);

  const validation = validateOutboundSmsPayload(input);
  if (!validation.ok) return validation;

  if (!manual_operator_send && thread_key) {
    try {
      const { data: thread_state } = await supabase
        .from("inbox_thread_state")
        .select("status,metadata")
        .eq("thread_key", thread_key)
        .maybeSingle();

      if (thread_state?.status === "paused_review") {
        return { ok: false, reason: "thread_paused_review" };
      }
      if (thread_state?.metadata?.incident_quarantine === true) {
        return { ok: false, reason: "thread_quarantined" };
      }
    } catch {
      // non-fatal; suppression check remains authoritative
    }
  }

  const normalized_to = normalizePhone(input.to_phone_number);
  if (!normalized_to) {
    return { ok: true, reason: null };
  }

  const phone_filter = [
    `phone_number.eq.${quotePostgrestValue(normalized_to)}`,
    `phone_e164.eq.${quotePostgrestValue(normalized_to)}`,
  ].join(",");

  try {
    const base_query = supabase.from("sms_suppression_list").select("id");
    let count = 0;

    if (typeof base_query.eq === "function") {
      const scoped = base_query.eq("is_active", true);
      if (typeof scoped.or === "function") {
        const filtered = scoped.or(phone_filter);
        const terminal =
          typeof filtered.eq === "function" ? filtered.eq("is_active", true) : filtered;
        const result = await Promise.resolve(terminal);
        count = Number(result?.count ?? 0);
      }
    }

    if (count === 0 && typeof base_query.or === "function") {
      const filtered = base_query.or(phone_filter);
      const terminal =
        typeof filtered.eq === "function" ? filtered.eq("is_active", true) : filtered;
      const result = await Promise.resolve(terminal);
      count = Number(result?.count ?? 0);
    }

    if (count > 0) {
      return { ok: false, reason: "phone_suppressed" };
    }
  } catch {
    return { ok: false, reason: "suppression_check_unavailable" };
  }

  return { ok: true, reason: null };
}

// ════════════════════════════════════════════════════════════════════════════
// FROM-PHONE-NUMBER RESOLUTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve from_phone_number (our sending number) for a thread.
 *
 * Priority chain:
 * 1. inbox_thread_state.our_number (via metadata)
 * 2. Latest outbound send_queue row's from_phone_number for same thread
 * 3. Latest outbound message_events row's from_phone_number for same thread
 * 4. textgrid_numbers by market
 * 5. null — fail with "Missing sending number"
 */
export async function resolveFromPhoneNumber({
  thread_key,
  to_phone_number = null,
  textgrid_number_id = null,
  market = null,
  supabase = defaultSupabase,
} = {}) {
  if (!thread_key) return null;
  const normalized_to = normalizePhone(to_phone_number);
  const isRecipientPhone = (value) => {
    const normalized = normalizePhone(value);
    return Boolean(normalized && normalized_to && normalized === normalized_to);
  };

  // Priority 0: direct textgrid number assignment
  if (textgrid_number_id) {
    try {
      const { data: textgridRow } = await supabase
        .from("textgrid_numbers")
        .select("phone_number")
        .eq("id", textgrid_number_id)
        .eq("status", "active")
        .maybeSingle();

      if (textgridRow?.phone_number) {
        const normalized = normalizePhone(textgridRow.phone_number);
        if (normalized && !isRecipientPhone(normalized)) return normalized;
      }
    } catch {
      // Non-fatal, continue to next priority
    }
  }

  // Priority 1: inbox_thread_state.our_number
  try {
    const { data: threadState } = await supabase
      .from("inbox_thread_state")
      .select("thread_key, our_number")
      .eq("thread_key", thread_key)
      .maybeSingle();

    if (threadState?.our_number) {
      const normalized = normalizePhone(threadState.our_number);
      if (normalized && !isRecipientPhone(normalized)) return normalized;
    }
  } catch {
    // Non-fatal, continue to next priority
  }

  // Priority 1b: legacy deal_thread_state.our_number
  try {
    const { data: legacyThreadState } = await supabase
      .from("deal_thread_state")
      .select("thread_key, our_number")
      .eq("thread_key", thread_key)
      .maybeSingle();

    if (legacyThreadState?.our_number) {
      const normalized = normalizePhone(legacyThreadState.our_number);
      if (normalized && !isRecipientPhone(normalized)) return normalized;
    }
  } catch {
    // Non-fatal, continue to next priority
  }

  // Priority 2: Latest outbound in send_queue for same thread
  try {
    const { data: latestOutbound } = await supabase
      .from("send_queue")
      .select("from_phone_number")
      .eq("thread_key", thread_key)
      .eq("type", "outbound")
      .not("from_phone_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestOutbound?.from_phone_number) {
      const normalized = normalizePhone(latestOutbound.from_phone_number);
      if (normalized && !isRecipientPhone(normalized)) return normalized;
    }
  } catch {
    // Non-fatal
  }

  // Priority 2b: Latest outbound in send_queue for same recipient phone
  if (normalized_to) {
    try {
      const { data: latestOutboundByPhone } = await supabase
        .from("send_queue")
        .select("from_phone_number")
        .eq("to_phone_number", normalized_to)
        .eq("type", "outbound")
        .not("from_phone_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestOutboundByPhone?.from_phone_number) {
        const normalized = normalizePhone(latestOutboundByPhone.from_phone_number);
        if (normalized && !isRecipientPhone(normalized)) return normalized;
      }
    } catch {
      // Non-fatal
    }
  }

  // Priority 3: Latest outbound in message_events for same thread
  try {
    const { data: latestEvent } = await supabase
      .from("message_events")
      .select("from_phone_number")
      .eq("thread_key", thread_key)
      .eq("direction", "outbound")
      .not("from_phone_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestEvent?.from_phone_number) {
      const normalized = normalizePhone(latestEvent.from_phone_number);
      if (normalized && !isRecipientPhone(normalized)) return normalized;
    }
  } catch {
    // Non-fatal
  }

  // Priority 3a: latest message_events row by recipient phone
  if (normalized_to) {
    try {
      const { data: outboundEventByPhone } = await supabase
        .from("message_events")
        .select("from_phone_number")
        .eq("to_phone_number", normalized_to)
        .eq("direction", "outbound")
        .not("from_phone_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (outboundEventByPhone?.from_phone_number) {
        const normalized = normalizePhone(outboundEventByPhone.from_phone_number);
        if (normalized && !isRecipientPhone(normalized)) return normalized;
      }
    } catch {
      // Non-fatal
    }

    try {
      const { data: inboundEventByPhone } = await supabase
        .from("message_events")
        .select("to_phone_number")
        .eq("from_phone_number", normalized_to)
        .eq("direction", "inbound")
        .not("to_phone_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (inboundEventByPhone?.to_phone_number) {
        const normalized = normalizePhone(inboundEventByPhone.to_phone_number);
        if (normalized && !isRecipientPhone(normalized)) return normalized;
      }
    } catch {
      // Non-fatal
    }
  }

  // Priority 3b: latest message_events row of any direction for same thread
  try {
    const { data: recentEvents } = await supabase
      .from("message_events")
      .select("direction,from_phone_number,to_phone_number")
      .eq("thread_key", thread_key)
      .order("created_at", { ascending: false })
      .limit(10);

    const rows = Array.isArray(recentEvents) ? recentEvents : [];
    for (const event of rows) {
      const direction = clean(event?.direction).toLowerCase();
      const candidate =
        direction === "inbound"
          ? normalizePhone(event?.to_phone_number)
          : direction === "outbound"
            ? normalizePhone(event?.from_phone_number)
            : normalizePhone(event?.from_phone_number) || normalizePhone(event?.to_phone_number);

      if (candidate && !isRecipientPhone(candidate)) return candidate;
    }
  } catch {
    // Non-fatal
  }

  // Priority 4: textgrid_numbers by market
  if (market) {
    try {
      const { data: numbers } = await supabase
        .from("textgrid_numbers")
        .select("phone_number")
        .eq("market", market)
        .eq("status", "active")
        .limit(5);

      if (numbers && numbers.length > 0) {
        const firstNumber = numbers[0];
        if (firstNumber?.phone_number) {
          const normalized = normalizePhone(firstNumber.phone_number);
          if (normalized && !isRecipientPhone(normalized)) return normalized;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate an inbox manual send-now payload.
 *
 * Returns a result object:
 *   { ok: true, normalized: { ... } }
 *   { ok: false, status: 400, error: "message" }
 *
 * Validation rules:
 * - thread_key required
 * - to_phone_number required
 * - from_phone_number required
 * - message_body required
 * - manual message length >= 2
 * - auto_reply message length >= 10
 */
function pickProvenanceField(input = {}, metadata = {}, key = "") {
  return clean(input[key]) || clean(metadata[key]) || null;
}

function buildSendNowMetadata(input = {}, normalized = {}) {
  const input_metadata = objectMetadata(input.metadata);
  const merged = {
    ...input_metadata,
    source: normalized.source,
    send_source: normalized.send_source || normalized.source,
    action: normalized.action,
    created_from: normalized.created_from,
    canonical_phone_id: normalized.phone_id || input_metadata.canonical_phone_id || null,
    manual_operator_send: normalized.manual_operator_send === true,
    seller_first_name: normalized.seller_first_name || input_metadata.seller_first_name || null,
    seller_display_name: normalized.seller_display_name || input_metadata.seller_display_name || null,
    agent_name: normalized.agent_name || input_metadata.agent_name || null,
    agent_first_name: normalized.agent_first_name || input_metadata.agent_first_name || null,
    template_id: normalized.template_id || input_metadata.template_id || null,
    selected_template_id:
      normalized.selected_template_id || input_metadata.selected_template_id || null,
    template_key: normalized.template_key || input_metadata.template_key || null,
    template_source: normalized.template_source || input_metadata.template_source || null,
    template_language: normalized.language || input_metadata.template_language || null,
    template_selection_reason:
      input_metadata.template_selection_reason || null,
    rendered_message: normalized.rendered_message || input_metadata.rendered_message || null,
    property_address: normalized.property_address || input_metadata.property_address || null,
    origin_surface:
      input_metadata.origin_surface ||
      (normalized.source === "map_command" ? "command_map" : null),
    message_events_source_app:
      input_metadata.message_events_source_app ||
      (normalized.source === "map_command" ? "LeadCommand Map" : null),
  };
  if (normalized.sms_agent_id) merged.sms_agent_id = normalized.sms_agent_id;
  if (normalized.selected_agent_id) merged.selected_agent_id = normalized.selected_agent_id;
  return merged;
}

export function validateInboxSendNowPayload(input = {}, resolvedFrom = null) {
  const thread_key = clean(input.thread_key);
  const to_phone_number = normalizePhone(clean(input.to_phone_number));
  const from_phone_number = resolvedFrom || normalizePhone(clean(input.from_phone_number));
  const message_body = clean(input.message_body);
  const message_text = clean(input.message_text) || message_body;
  const input_metadata = objectMetadata(input.metadata);
  const action = clean(input.action) || clean(input_metadata.action) || "send_now";
  const source =
    clean(input.source) ||
    clean(input.send_source) ||
    clean(input_metadata.source) ||
    clean(input_metadata.send_source) ||
    (action === "send_ownership_check" ? "map_command" : action === "send_now" ? "manual_inbox" : "inbox");
  const send_source = clean(input.send_source) || clean(input_metadata.send_source) || source;
  const created_from =
    clean(input.created_from) ||
    clean(input_metadata.created_from) ||
    (source === "map_command" ? "leadcommand_map" : "leadcommand_inbox");
  const message_type =
    clean(input.message_type) ||
    (source === "map_command" || action === "send_ownership_check" ? "ownership_check" : "manual_reply");
  const use_case_template =
    clean(input.use_case_template) ||
    (source === "map_command" || action === "send_ownership_check" ? "ownership_check" : "manual_reply");
  const type = clean(input.type) || "outbound";
  const queue_key = clean(input.queue_key) || `inbox:send_now:${crypto.randomUUID()}`;

  if (!thread_key) {
    return { ok: false, status: 400, error: "missing_thread_key" };
  }
  if (!to_phone_number) {
    return { ok: false, status: 400, error: "missing_to_phone_number" };
  }
  if (!from_phone_number) {
    return { ok: false, status: 400, error: "missing_from_phone_number" };
  }
  if (to_phone_number === from_phone_number) {
    return { ok: false, status: 400, error: "SAME_FROM_TO_NUMBER" };
  }
  if (!message_body) {
    return { ok: false, status: 400, error: "missing_message_body" };
  }

  const is_manual = message_type === "manual_reply" || use_case_template === "manual_reply";
  const min_length = is_manual ? 2 : 10;

  if (message_body.length < min_length) {
    return { ok: false, status: 400, error: "message_too_short" };
  }

  if (hasEntityNameInGreeting(message_body)) {
    return { ok: false, status: 422, error: "entity_name_in_greeting" };
  }

  const raw_phone_number_id = pickProvenanceField(input, input_metadata, "phone_number_id");
  const raw_phone_id = pickProvenanceField(input, input_metadata, "phone_id");
  // Canonical phones.phone_id is ph_-prefixed TEXT; phone_number_id is a UUID column.
  // Never coerce ph_ text into phone_number_id — preserve it as phone_id, and rescue a
  // mis-placed non-UUID value that arrived in phone_number_id.
  const resolved_phone_id =
    raw_phone_id || (isUuid(raw_phone_number_id) ? null : raw_phone_number_id);
  const resolved_phone_number_id = isUuid(raw_phone_number_id) ? raw_phone_number_id : null;

  const normalized = {
    queue_key,
    thread_key,
    to_phone_number,
    from_phone_number,
    message_body,
    message_text,
    message_type,
    use_case_template,
    type,
    master_owner_id: pickProvenanceField(input, input_metadata, "master_owner_id"),
    property_id: pickProvenanceField(input, input_metadata, "property_id"),
    prospect_id: pickProvenanceField(input, input_metadata, "prospect_id"),
    phone_id: resolved_phone_id,
    phone_number_id: resolved_phone_number_id,
    market_id: pickProvenanceField(input, input_metadata, "market_id"),
    textgrid_number_id: pickProvenanceField(input, input_metadata, "textgrid_number_id"),
    source,
    send_source,
    action,
    created_from,
    seller_first_name: pickProvenanceField(input, input_metadata, "seller_first_name"),
    seller_display_name: pickProvenanceField(input, input_metadata, "seller_display_name"),
    agent_name: pickProvenanceField(input, input_metadata, "agent_name"),
    agent_first_name: pickProvenanceField(input, input_metadata, "agent_first_name"),
    sms_agent_id: pickProvenanceField(input, input_metadata, "sms_agent_id"),
    selected_agent_id: pickProvenanceField(input, input_metadata, "selected_agent_id"),
    template_id: pickProvenanceField(input, input_metadata, "template_id"),
    selected_template_id:
      pickProvenanceField(input, input_metadata, "selected_template_id") ||
      pickProvenanceField(input, input_metadata, "template_id"),
    template_key: pickProvenanceField(input, input_metadata, "template_key"),
    template_source: pickProvenanceField(input, input_metadata, "template_source"),
    language: pickProvenanceField(input, input_metadata, "language"),
    rendered_message:
      pickProvenanceField(input, input_metadata, "rendered_message") || message_body,
    property_address: pickProvenanceField(input, input_metadata, "property_address"),
    metadata: buildSendNowMetadata(input, {
      source,
      send_source,
      action,
      created_from,
      phone_id: resolved_phone_id,
      seller_first_name: pickProvenanceField(input, input_metadata, "seller_first_name"),
      seller_display_name: pickProvenanceField(input, input_metadata, "seller_display_name"),
      agent_name: pickProvenanceField(input, input_metadata, "agent_name"),
      agent_first_name: pickProvenanceField(input, input_metadata, "agent_first_name"),
      sms_agent_id: pickProvenanceField(input, input_metadata, "sms_agent_id"),
      selected_agent_id: pickProvenanceField(input, input_metadata, "selected_agent_id"),
      template_id: pickProvenanceField(input, input_metadata, "template_id"),
      selected_template_id:
        pickProvenanceField(input, input_metadata, "selected_template_id") ||
        pickProvenanceField(input, input_metadata, "template_id"),
      template_key: pickProvenanceField(input, input_metadata, "template_key"),
      template_source: pickProvenanceField(input, input_metadata, "template_source"),
      language: pickProvenanceField(input, input_metadata, "language"),
      rendered_message:
        pickProvenanceField(input, input_metadata, "rendered_message") || message_body,
      property_address: pickProvenanceField(input, input_metadata, "property_address"),
      manual_operator_send:
        source === "manual_inbox" ||
        source === "map_command" ||
        action === "send_now" ||
        action === "send_ownership_check" ||
        asBoolean(input.manual_operator_send, false),
    }),
    manual_operator_send:
      source === "manual_inbox" ||
      source === "map_command" ||
      action === "send_now" ||
      action === "send_ownership_check" ||
      asBoolean(input.manual_operator_send, false),
    operator_override: asBoolean(input.operator_override, false),
    force: asBoolean(input.force, false),
  };

  return { ok: true, normalized };
}

function mapValidationErrorToReason(validation_error = "") {
  return validation_error === "missing_from_phone_number"
    ? "missing_routing"
    : "invalid_payload";
}

function buildManualSendProof({
  input = {},
  normalized = null,
  queue_inserted = false,
  queue_row_id = null,
  queue_status = null,
  detail_reason = null,
  warning_codes = [],
} = {}) {
  const request_payload = {
    thread_key: clean(normalized?.thread_key || input.thread_key) || null,
    to_phone_number: normalizePhone(clean(normalized?.to_phone_number || input.to_phone_number)) || null,
    from_phone_number: normalizePhone(clean(normalized?.from_phone_number || input.from_phone_number)) || null,
    textgrid_number_id: clean(normalized?.textgrid_number_id || input.textgrid_number_id) || null,
    message_body: clean(normalized?.message_body || input.message_body) || "",
    message_body_length: clean(normalized?.message_body || input.message_body).length,
    action: clean(normalized?.action || input.action) || "send_now",
    operator_override:
      normalized?.operator_override === true ||
      normalized?.force === true ||
      asBoolean(input.operator_override, false) ||
      asBoolean(input.force, false),
  };

  return {
    request_payload,
    queue_inserted,
    queue_row_id: clean(queue_row_id) || null,
    queue_status: clean(queue_status) || null,
    detail_reason: clean(detail_reason) || null,
    warning_codes: Array.isArray(warning_codes) ? warning_codes.filter(Boolean) : [],
  };
}

async function isHardComplianceBlocked({
  thread_key,
  to_phone_number,
  supabase,
} = {}) {
  const blocked_intents = new Set([
    "stop",
    "opt_out",
    "dnc",
    "do_not_contact",
    "legal_threat",
    "hostile_legal",
    "wrong_number",
  ]);

  try {
    const { data: thread_state } = await supabase
      .from("deal_thread_state")
      .select("thread_key,universal_status,inbox_bucket,primary_intent,universal_stage,opt_out")
      .eq("thread_key", thread_key)
      .maybeSingle();

    const thread_intent = clean(thread_state?.primary_intent).toLowerCase();
    const status_bucket = clean(thread_state?.inbox_bucket).toLowerCase();
    const stage = clean(thread_state?.universal_stage).toLowerCase();
    
    if (
      thread_state?.opt_out === true ||
      thread_state?.universal_status === "suppressed" ||
      status_bucket === "suppressed" ||
      blocked_intents.has(thread_intent) ||
      blocked_intents.has(stage)
    ) {
      return { blocked: true, reason: "compliance_suppressed_thread" };
    }
  } catch {
    // non-fatal, continue to message-level compliance checks
  }

  try {
    const { data: event_rows } = await supabase
      .from("message_events")
      .select("id,is_opt_out,opt_out_keyword,detected_intent,message_body,created_at")
      .eq("thread_key", thread_key)
      .order("created_at", { ascending: false })
      .limit(50);

    const rows = Array.isArray(event_rows) ? event_rows : [];
    const has_opt_out = rows.some((row) => row?.is_opt_out === true);
    if (has_opt_out) return { blocked: true, reason: "compliance_opt_out_event" };

    const has_hard_intent = rows.some((row) =>
      blocked_intents.has(clean(row?.detected_intent).toLowerCase())
    );
    if (has_hard_intent) return { blocked: true, reason: "compliance_hard_intent" };

    const has_stop_language = rows.some((row) => {
      const keyword = clean(row?.opt_out_keyword).toLowerCase();
      const body = clean(row?.message_body).toLowerCase();
      return keyword === "stop" || body === "stop";
    });
    if (has_stop_language) return { blocked: true, reason: "compliance_stop" };
  } catch {
    // non-fatal
  }

  try {
    const normalized_to = normalizePhone(to_phone_number);
    const suppression_phone_filter = [
      normalized_to ? `phone_number.eq.${quotePostgrestValue(normalized_to)}` : null,
      normalized_to ? `phone_e164.eq.${quotePostgrestValue(normalized_to)}` : null,
    ].filter(Boolean).join(",");

    if (!suppression_phone_filter) {
      return { blocked: false, reason: null };
    }

    const { data: suppression_rows, error } = await supabase
      .from("sms_suppression_list")
      .select("id,phone_number,phone_e164,reason,suppression_reason,suppression_type,is_active,suppressed_at")
      .or(suppression_phone_filter)
      .eq("is_active", true)
      .limit(1);
    if (!error && Array.isArray(suppression_rows) && suppression_rows.length > 0) {
      return { blocked: true, reason: "compliance_suppression_list" };
    }
    if (error) {
      logger.warn("inbox_send_suppression_lookup_degraded", {
        reason: "sms_suppression_list_query_failed",
        code: error.code || null,
        message: error.message || "unknown_error",
      });
      return {
        blocked: false,
        reason: null,
        degraded: true,
        degradation_reason: "sms_suppression_list_query_failed",
      };
    }
  } catch (error) {
    logger.warn("inbox_send_suppression_lookup_degraded", {
      reason: "sms_suppression_list_exception",
      message: error?.message || "unknown_error",
    });
    return {
      blocked: false,
      reason: null,
      degraded: true,
      degradation_reason: "sms_suppression_list_exception",
    };
  }

  return { blocked: false, reason: null };
}

async function shouldSuppressRecentDeliveryFailuresReconciled({
  thread_key,
  to_phone_number,
  from_phone_number,
  supabase,
  now = nowIso(),
} = {}) {
  const since_24h = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since_7d = new Date(new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: failed_rows, error: failed_error } = await supabase
    .from("send_queue")
    .select("id,thread_key,to_phone_number,from_phone_number,queue_status,failed_reason,provider_message_id,textgrid_message_id,created_at,updated_at")
    .eq("to_phone_number", to_phone_number)
    .eq("queue_status", "failed")
    .eq("failed_reason", "delivery_failed")
    .gte("updated_at", since_7d)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (failed_error) throw failed_error;
  const rows = Array.isArray(failed_rows) ? failed_rows : [];
  if (!rows.length) return { suppress: false, reason: null };

  const candidate_rows = rows.filter((row) => {
    if (!from_phone_number) return true;
    return clean(row?.from_phone_number) === clean(from_phone_number);
  });

  const evaluate_row = async (row) => {
    const reason_text = `${clean(row?.failed_reason)} ${clean(row?.metadata?.provider_error?.message)}`.trim();
    if (!isTransportFailureReason(reason_text)) {
      return { suppressible: false, reason: "non_transport_failure_reason" };
    }
    if (clean(row?.provider_message_id) || clean(row?.textgrid_message_id)) {
      return { suppressible: false, reason: "provider_sid_present" };
    }

    const row_thread_key = clean(row?.thread_key) || thread_key;
    const row_created_at = clean(row?.created_at) || clean(row?.updated_at) || now;

    const [send_event, delivered_event, inbound_after] = await Promise.all([
      supabase
        .from("message_events")
        .select("id")
        .eq("thread_key", row_thread_key)
        .eq("direction", "outbound")
        .eq("event_type", "outbound_send")
        .limit(1)
        .maybeSingle(),
      supabase
        .from("message_events")
        .select("id,sent_at,delivered_at,delivery_status")
        .eq("thread_key", row_thread_key)
        .eq("direction", "outbound")
        .or("delivery_status.eq.delivered,delivered_at.not.is.null")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("message_events")
        .select("id,created_at")
        .eq("thread_key", row_thread_key)
        .eq("direction", "inbound")
        .gt("created_at", row_created_at)
        .limit(1)
        .maybeSingle(),
    ]);

    const has_outbound_send = Boolean(send_event.data?.id);
    const has_delivered = Boolean(delivered_event.data?.id);
    const has_later_inbound_reply = Boolean(inbound_after.data?.id);
    if (has_outbound_send || has_delivered || has_later_inbound_reply) {
      return {
        suppressible: false,
        reason: has_later_inbound_reply
          ? "later_inbound_reply_exists"
          : has_delivered
            ? "delivered_event_exists"
            : "outbound_send_exists",
      };
    }

    return { suppressible: true, reason: "terminal_failure_without_success_evidence" };
  };

  let pair_count = 0;
  let recipient_count = 0;
  for (const row of rows) {
    const verdict = await evaluate_row(row);
    if (!verdict.suppressible) continue;
    const updated = clean(row?.updated_at) || now;
    if (new Date(updated).getTime() >= new Date(since_7d).getTime()) recipient_count += 1;
    if (
      clean(row?.from_phone_number) === clean(from_phone_number) &&
      new Date(updated).getTime() >= new Date(since_24h).getTime()
    ) {
      pair_count += 1;
    }
  }

  if (pair_count >= 2) {
    return {
      suppress: true,
      reason: "repeated_delivery_failed_same_pair",
      pair_count,
      window: "24h",
      suppression_source: "reconciled",
    };
  }

  if (recipient_count >= 3) {
    return {
      suppress: true,
      reason: "repeated_delivery_failed_recipient",
      recipient_count,
      window: "7d",
      suppression_source: "reconciled",
    };
  }

  return { suppress: false, reason: null, suppression_source: "reconciled" };
}


// ════════════════════════════════════════════════════════════════════════════
// CREATE QUEUE ROW
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a send_queue row for a manual inbox send-now action.
 *
 * Performs validation first. Returns 400 on invalid input.
 * Never creates a row with queue_status='queued' on validation failure.
 */
export async function createInboxSendNowQueueRow(input = {}, deps = {}) {
  const {
    insertImpl = insertSupabaseSendQueueRow,
    resolveFromImpl = resolveFromPhoneNumber,
    hardComplianceCheckImpl = isHardComplianceBlocked,
    checkBlacklistPriorFailureImpl = checkBlacklistPriorFailure,
    recentDeliveryFailuresImpl = shouldSuppressRecentDeliveryFailuresReconciled,
    supabase = defaultSupabase,
  } = deps;
  const insert_deps = { supabase, ...deps };

  const input_metadata = objectMetadata(input.metadata);
  const bypassed_queue_emergency_stop =
    asBoolean(input.bypassed_queue_emergency_stop, false) ||
    asBoolean(input_metadata.bypassed_queue_emergency_stop, false);
  const metadata_source = clean(input.source) || clean(input_metadata.source) || "manual_inbox";

  // ── Step 1: Resolve from_phone_number ──────────────────────────────
  const normalized_to = normalizePhone(clean(input.to_phone_number));
  let resolved_from = normalizePhone(clean(input.from_phone_number));
  if (!resolved_from || (normalized_to && resolved_from === normalized_to)) {
    resolved_from = await resolveFromImpl({
      thread_key: clean(input.thread_key),
      to_phone_number: normalized_to,
      textgrid_number_id: clean(input.textgrid_number_id) || null,
      market: clean(input.market) || null,
      supabase,
    });
  }

  const request_log = {
    thread_key: clean(input.thread_key) || null,
    to_phone_number: normalizePhone(clean(input.to_phone_number)) || null,
    from_phone_number: resolved_from || null,
    message_body_length: clean(input.message_body).length,
    action: clean(input.action) || "send_now",
    operator_override: asBoolean(input.operator_override, false) || asBoolean(input.force, false),
  };

  logger.info("inbox_send_now.requested", request_log);

  // ── Step 2: Validate ────────────────────────────────────────────────
  const validation = validateInboxSendNowPayload(input, resolved_from);
  if (!validation.ok) {
    // Insert audit row with paused_invalid_queue_row status
    // but NEVER queue_status='queued'
    let audit_insert = null;
    try {
      audit_insert = await insertImpl(
        {
          queue_key: `inbox:send_now:failed:${clean(input.thread_key) || "unknown"}:${Date.now()}`,
          queue_status: "paused_invalid_queue_row",
          scheduled_for: nowIso(),
          message_body: clean(input.message_body) || "",
          to_phone_number: normalizePhone(clean(input.to_phone_number)) || null,
          from_phone_number: resolved_from || null,
          thread_key: clean(input.thread_key) || null,
          metadata: {
            source: metadata_source,
            send_source: metadata_source,
            action: "send_now",
            created_from: "leadcommand_inbox",
            ...(clean(input.action).toLowerCase() === "send_now" || !clean(input.action) ? { manual_operator_send: true } : {}),
            ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
            validation_error: validation.error,
            input_preview: {
              thread_key: clean(input.thread_key)?.slice(0, 40) || null,
              message_body_length: clean(input.message_body)?.length || 0,
            },
          },
        },
        insert_deps
      ).catch(() => null);
    } catch {
      // Non-critical - audit row best-effort
    }

    const queue_row_id =
      audit_insert?.queue_row_id ||
      audit_insert?.queue_item_id ||
      audit_insert?.item_id ||
      null;
    const queue_inserted = Boolean(queue_row_id);
    const validation_error = clean(validation.error) || "invalid_payload";
    const validation_reason =
      validation_error === "SAME_FROM_TO_NUMBER"
        ? "SAME_FROM_TO_NUMBER"
        : mapValidationErrorToReason(validation_error);

    const proof = buildManualSendProof({
      input,
      queue_inserted,
      queue_row_id,
      queue_status: queue_inserted ? "paused_invalid_queue_row" : null,
      detail_reason: validation_error,
    });

    logger.warn("inbox_send_now.early_exit", {
      ...request_log,
      reason: validation_reason,
      detail_reason: validation_error,
      queue_inserted,
      queue_row_id,
      queue_status: queue_inserted ? "paused_invalid_queue_row" : null,
    });

    return {
      ok: false,
      status: 400,
      error: validation_reason,
      reason: validation_reason,
      detail_reason: validation_error,
      queue_created: false,
      queue_inserted,
      queue_row_id,
      queue_id: queue_row_id,
      queue_status: queue_inserted ? "paused_invalid_queue_row" : null,
      proof,
    };
  }

  const { normalized } = validation;
  const operator_override = normalized.operator_override || normalized.force;
  const is_manual_send_now =
    normalized.manual_operator_send === true ||
    clean(normalized.action).toLowerCase() === "send_now" ||
    clean(normalized.action).toLowerCase() === "send_ownership_check" ||
    normalized.source === "map_command";
  const warning_codes = [];

  // ── Step 3a: non-bypassable compliance guard ───────────────────────
  const compliance_block = await hardComplianceCheckImpl({
    thread_key: normalized.thread_key,
    to_phone_number: normalized.to_phone_number,
    supabase,
  });
  if (compliance_block.degraded) {
    warning_codes.push(compliance_block.degradation_reason || "suppression_lookup_degraded");
  }
  if (compliance_block.blocked) {
    const proof = buildManualSendProof({
      input,
      normalized,
      queue_inserted: false,
      detail_reason: compliance_block.reason,
      warning_codes,
    });
    logger.warn("inbox_send_now.early_exit", {
      ...request_log,
      reason: "compliance_blocked",
      detail_reason: compliance_block.reason,
      queue_inserted: false,
    });
    return {
      ok: false,
      status: 423,
      error: "compliance_blocked",
      reason: "compliance_blocked",
      detail_reason: compliance_block.reason,
      queue_created: false,
      queue_inserted: false,
      proof,
    };
  }

  const can_send_impl = deps.canSendImpl || deps.canSend || canSend;
  const send_gate = await can_send_impl(normalized, { supabase });
  if (!send_gate.ok) {
    const gate_status =
      ["phone_suppressed", "thread_paused_review", "thread_quarantined", "suppression_check_unavailable"].includes(
        send_gate.reason
      )
        ? 423
        : 400;
    const proof = buildManualSendProof({
      input,
      normalized,
      queue_inserted: false,
      detail_reason: send_gate.reason,
      warning_codes,
    });
    logger.warn("inbox_send_now.early_exit", {
      ...request_log,
      reason: send_gate.reason,
      queue_inserted: false,
    });
    return {
      ok: false,
      status: gate_status,
      error: send_gate.reason,
      reason: send_gate.reason,
      queue_created: false,
      queue_inserted: false,
      proof,
    };
  }

  // ── Step 3b: Delivery-failure safety guard (reconciled) ────────────
  // Block sends to numbers that have recently hit 21610 blacklist or repeated
  // delivery_failed thresholds. Non-fatal: guard errors never block the send.
  try {
    const blacklist_check = await checkBlacklistPriorFailureImpl(
      {
        to_phone_number: normalized.to_phone_number,
        from_phone_number: normalized.from_phone_number,
      },
      { supabase }
    );
    if (blacklist_check.blocked) {
      logger.warn("inbox_send_blocked", {
        reason: "provider_blacklist_pair",
        from_phone_number: normalized.from_phone_number,
        to_phone_number: normalized.to_phone_number,
        prior_blacklist_count: blacklist_check.count,
      });
      warning_codes.push("provider_blacklist_pair");
    }

    const suppression_check = await recentDeliveryFailuresImpl({
      thread_key: normalized.thread_key,
      to_phone_number: normalized.to_phone_number,
      from_phone_number: normalized.from_phone_number,
      supabase,
    });
    if (suppression_check.suppress) {
      warning_codes.push("recent_delivery_failures");
      logger.warn(
        operator_override || is_manual_send_now
          ? "inbox_send_override"
          : "inbox_send_blocked",
        {
          reason: operator_override || is_manual_send_now
            ? "recent_delivery_failures_bypassed"
            : "recent_delivery_failures",
          thread_key: normalized.thread_key,
          from_phone_number: normalized.from_phone_number,
          to_phone_number: normalized.to_phone_number,
          recent_failure_count: suppression_check.pair_count ?? suppression_check.recipient_count,
          suppression_window: suppression_check.window,
          suppression_reason: suppression_check.reason,
        }
      );
      if (!operator_override && !is_manual_send_now) {
        const proof = buildManualSendProof({
          input,
          normalized,
          queue_inserted: false,
          detail_reason: suppression_check.reason,
          warning_codes,
        });
        return {
          ok: false,
          status: 423,
          error: "recent_delivery_failures",
          reason: "recent_delivery_failures",
          detail_reason: suppression_check.reason,
          queue_created: false,
          queue_inserted: false,
          proof,
        };
      }
    }
  } catch (guard_err) {
    // Non-fatal: log and continue — never silently lose a send due to guard failure
    logger.warn("inbox_send_guard_check_failed", {
      message: guard_err?.message || "unknown_error",
      to_phone_number: normalized.to_phone_number,
    });
  }

  // ── Step 4: Insert queue row ────────────────────────────────────────
  const now = nowIso();
  const queue_id = clean(input.queue_id) || normalized.queue_key;
  const transport_fingerprint = buildTransportFingerprint({
    to_phone_number: normalized.to_phone_number,
    message_body: normalized.message_body,
    now: Date.now(),
  });

  try {
    const { count: duplicate_count } = await supabase
      .from("send_queue")
      .select("id", { count: "exact", head: true })
      .eq("to_phone_number", normalized.to_phone_number)
      .in("queue_status", ["queued", "pending", "approval", "scheduled", "processing", "sent", "delivered"])
      .contains("metadata", { transport_fingerprint })
      .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

    if ((duplicate_count ?? 0) > 0) {
      const proof = buildManualSendProof({
        input,
        normalized,
        queue_inserted: false,
        detail_reason: "transport_fingerprint_duplicate_in_cooldown_window",
        warning_codes,
      });
      logger.warn("inbox_send_now.early_exit", {
        ...request_log,
        reason: "duplicate_blocked",
        detail_reason: "transport_fingerprint_duplicate_in_cooldown_window",
        queue_inserted: false,
      });
      return {
        ok: false,
        status: 423,
        error: "duplicate_blocked",
        queue_created: false,
        reason: "duplicate_blocked",
        detail_reason: "transport_fingerprint_duplicate_in_cooldown_window",
        queue_inserted: false,
        proof,
      };
    }
  } catch {
    // non-fatal; proceed if duplicate guard query is unavailable
  }

  let queue_result;
  try {
    queue_result = await insertImpl(
      {
        queue_key: normalized.queue_key,
        queue_id,
        queue_status: "queued",
        scheduled_for: clean(input.scheduled_for) || now,
        scheduled_for_utc: now,
        scheduled_for_local: now,
        timezone: clean(input.timezone) || "America/Chicago",
        send_priority: 10,
        is_locked: false,
        retry_count: 0,
        max_retries: 3,
        message_body: normalized.message_body,
        message_text: normalized.message_text || normalized.message_body,
        to_phone_number: normalized.to_phone_number,
        from_phone_number: normalized.from_phone_number,
        thread_key: normalized.thread_key,
        type: normalized.type,
        message_type: normalized.message_type,
        use_case_template: normalized.use_case_template,
        master_owner_id: normalized.master_owner_id,
        property_id: normalized.property_id,
        prospect_id: normalized.prospect_id,
        phone_id: normalized.phone_id,
        phone_number_id: normalized.phone_number_id,
        textgrid_number_id: normalized.textgrid_number_id,
        market_id: normalized.market_id,
        character_count: normalized.message_body.length,
        touch_number: 1,
        dnc_check: "✅ Cleared",
        delivery_confirmed: "⏳ Pending",
        seller_first_name: normalized.seller_first_name,
        seller_display_name: normalized.seller_display_name,
        agent_name: normalized.agent_name,
        sms_agent_id: normalized.sms_agent_id,
        selected_agent_id: normalized.selected_agent_id,
        template_id: normalized.template_id,
        selected_template_id: normalized.selected_template_id,
        template_key: normalized.template_key,
        template_source: normalized.template_source,
        language: normalized.language,
        rendered_message: normalized.rendered_message,
        property_address: normalized.property_address,
        source: normalized.source,
        send_source: normalized.send_source,
        created_from: normalized.created_from,
        metadata: {
          ...normalized.metadata,
          transport_fingerprint,
          manual_send_warning_codes: warning_codes,
          client_send_id: clean(input.client_send_id || input.metadata?.client_send_id) || null,
          operator_override: operator_override ? true : false,
          ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
        },
      },
      insert_deps
    );
  } catch (insert_error) {
    const proof = buildManualSendProof({
      input,
      normalized,
      queue_inserted: false,
      detail_reason: insert_error?.message || "unknown_error",
      warning_codes,
    });
    logger.error("inbox_send_now.early_exit", {
      ...request_log,
      reason: "queue_insert_failure",
      detail_reason: insert_error?.message || "unknown_error",
      queue_inserted: false,
    });
    return {
      ok: false,
      status: 500,
      error: "queue_insert_failure",
      reason: "queue_insert_failure",
      detail_reason: insert_error?.message || "unknown_error",
      message: insert_error?.message || "unknown_error",
      queue_created: false,
      queue_inserted: false,
      proof,
    };
  }

  const queue_row_id =
    queue_result?.queue_row_id ||
    queue_result?.queue_item_id ||
    queue_result?.item_id ||
    null;

  if (queue_result?.ok === false) {
    const reason = clean(queue_result?.reason) === "duplicate_blocked"
      ? "duplicate_blocked"
      : "queue_insert_failure";
    const detail_reason = clean(queue_result?.reason) || null;
    const proof = buildManualSendProof({
      input,
      normalized,
      queue_inserted: false,
      queue_row_id,
      queue_status: clean(queue_result?.raw?.queue_status) || null,
      detail_reason,
      warning_codes,
    });
    logger.warn("inbox_send_now.early_exit", {
      ...request_log,
      reason,
      detail_reason,
      queue_inserted: false,
      queue_row_id,
      queue_status: clean(queue_result?.raw?.queue_status) || null,
    });
    return {
      ok: false,
      status: reason === "duplicate_blocked" ? 423 : 500,
      error: reason,
      reason,
      detail_reason,
      queue_created: false,
      queue_inserted: false,
      queue_row_id,
      queue_id: queue_result?.queue_id || queue_row_id,
      queue_key: normalized.queue_key,
      queue_status: clean(queue_result?.raw?.queue_status) || null,
      proof,
      result: queue_result,
    };
  }

  const proof = buildManualSendProof({
    input,
    normalized,
    queue_inserted: true,
    queue_row_id,
    queue_status: "queued",
    warning_codes,
  });
  logger.info("inbox_send_now.inserted", {
    ...request_log,
    queue_inserted: true,
    queue_row_id,
    queue_id: queue_result?.queue_id || queue_id,
    queue_key: normalized.queue_key,
    queue_status: "queued",
    warning_codes,
  });

  return {
    ok: queue_result?.ok !== false,
    status: queue_result?.ok !== false ? 200 : 400,
    error: queue_result?.ok !== false
      ? null
      : (queue_result?.reason || "queue_insert_failed"),
    reason: null,
    queue_created: queue_result?.ok !== false,
    queue_inserted: queue_result?.ok !== false,
    queue_row_id,
    queue_id: queue_result?.queue_id || queue_id,
    queue_key: normalized.queue_key,
    queue_status: "queued",
    warning_codes,
    proof,
    result: queue_result,
  };
}

function isManualSendHardBlockReason(reason = "") {
  return new Set([
    "compliance_blocked",
    "duplicate_blocked",
    "missing_routing",
    "invalid_payload",
    "invalid_number",
    "provider_configuration_missing",
    "outbound_sms_disabled",
  ]).has(clean(reason).toLowerCase());
}

function isManualSendOperatorOverrideAllowed(reason = "") {
  return new Set([
    "recent_delivery_failures",
    "content_blocked",
  ]).has(clean(reason).toLowerCase());
}

function mapProcessedManualSendFailure(reason = "", error_message = "") {
  const normalized_reason = clean(reason).toLowerCase();
  const normalized_error = clean(error_message).toLowerCase();
  const combined = `${normalized_reason} ${normalized_error}`.trim();

  if (
    normalized_reason === "hard_idempotency_blocked_24h" ||
    normalized_reason === "provider_duplicate_message" ||
    combined.includes("duplicate")
  ) {
    return {
      reason: "duplicate_blocked",
      detail_reason: normalized_reason || normalized_error || "duplicate_recent_message",
      hard_block: true,
      operator_override_allowed: false,
    };
  }

  if (combined.includes("invalid_phone_number") || combined.includes("invalid 'to' number")) {
    return {
      reason: "invalid_number",
      detail_reason: normalized_reason || normalized_error || "invalid_phone_number",
      hard_block: true,
      operator_override_allowed: false,
    };
  }

  if (combined.includes("missing_from_phone_number") || combined.includes("invalid 'from' number")) {
    return {
      reason: "missing_routing",
      detail_reason: normalized_reason || normalized_error || "missing_from_phone_number",
      hard_block: true,
      operator_override_allowed: false,
    };
  }

  if (
    combined.includes("blank_seller_greeting") ||
    combined.includes("unresolved placeholder") ||
    combined.includes("seller_first_name is blank") ||
    combined.includes("blank_greeting") ||
    combined.includes("placeholder")
  ) {
    return {
      reason: "content_blocked",
      detail_reason: normalized_reason || normalized_error || "content_guard_blocked",
      hard_block: false,
      operator_override_allowed: true,
    };
  }

  if (
    combined.includes("provider_configuration_missing") ||
    combined.includes("sms provider is not configured") ||
    combined.includes("missing required env vars")
  ) {
    return {
      reason: "provider_configuration_missing",
      detail_reason: "SMS provider is not configured on the server.",
      hard_block: true,
      operator_override_allowed: false,
    };
  }

  if (combined.includes("outbound_sms_enabled flag is false")) {
    return {
      reason: "outbound_sms_disabled",
      detail_reason: "Outbound SMS is currently disabled.",
      hard_block: true,
      operator_override_allowed: false,
    };
  }

  return {
    reason: "send_failed",
    detail_reason: normalized_reason || normalized_error || "send_failed",
    hard_block: false,
    operator_override_allowed: false,
  };
}

export async function executeManualInboxSendNow(input = {}, deps = {}) {
  const {
    createQueueRowImpl = createInboxSendNowQueueRow,
    sendTextgridImpl = sendTextgridSMS,
    finalizeSendQueueSuccessImpl = finalizeSendQueueSuccess,
    writeOutboundSuccessMessageEventImpl = writeOutboundSuccessMessageEvent,
    writeOutboundFailureMessageEventImpl = writeOutboundFailureMessageEvent,
    finalizeSendQueueFailureImpl = finalizeSendQueueFailure,
    supabase = defaultSupabase,
  } = deps;

  const operator_override_requested =
    asBoolean(input.operator_override, false) ||
    asBoolean(input.force, false);

  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const runtime_settings = {
    campaign_mode: await get_system_value("campaign_mode"),
    queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
  };
  const runtime_brake = evaluateQueueCreationRuntimeBrakes(
    runtime_settings,
    { action: "manual_inbox_send_now_queue_create", failClosed: false }
  );
  const bypassed_runtime_brake = runtime_brake.ok === false;
  const bypassed_queue_emergency_stop =
    bypassed_runtime_brake && runtime_brake.reason === "queue_emergency_stop_active";

  const input_metadata = objectMetadata(input.metadata);
  const resolved_source =
    clean(input.source) ||
    clean(input.send_source) ||
    clean(input_metadata.source) ||
    clean(input_metadata.send_source) ||
    "manual_inbox";
  const resolved_action =
    clean(input.action) ||
    clean(input_metadata.action) ||
    (resolved_source === "map_command" ? "send_ownership_check" : "send_now");
  const resolved_created_from =
    clean(input.created_from) ||
    clean(input_metadata.created_from) ||
    (resolved_source === "map_command" ? "leadcommand_map" : "leadcommand_inbox");
  // Canonical ph_ text phone id preserved through claim + message-event metadata.
  // Never derived from a genuine UUID phone_number_id (that stays in its own column).
  const resolved_canonical_phone_id =
    clean(input.phone_id) ||
    clean(input_metadata.canonical_phone_id) ||
    (isUuid(clean(input.phone_number_id)) ? null : clean(input.phone_number_id)) ||
    null;

  const manual_input = {
    ...input,
    source: resolved_source,
    send_source: clean(input.send_source) || resolved_source,
    action: resolved_action,
    created_from: resolved_created_from,
    manual_operator_send: true,
    ...(bypassed_runtime_brake
      ? {
          bypassed_runtime_brake: true,
          bypassed_runtime_brake_reason: runtime_brake.reason,
        }
      : {}),
    ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
    metadata: {
      ...input_metadata,
      source: resolved_source,
      send_source: clean(input.send_source) || clean(input_metadata.send_source) || resolved_source,
      action: resolved_action,
      created_from: resolved_created_from,
      canonical_phone_id: resolved_canonical_phone_id,
      manual_operator_send: true,
      ...(bypassed_runtime_brake
        ? {
            bypassed_runtime_brake: true,
            bypassed_runtime_brake_reason: runtime_brake.reason,
          }
        : {}),
      ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
    },
  };

  // 1. Create the audit row (validation + compliance check happens inside)
  // This row starts as 'queued' but we will claim it immediately.
  const audit_result = await createQueueRowImpl(manual_input, {
    ...deps,
    supabase,
  });

  const queue_row_id =
    audit_result?.queue_row_id ||
    audit_result?.queue_item_id ||
    audit_result?.queue_id ||
    null;

  if (!audit_result.ok) {
    return {
      ...audit_result,
      message_event_id: null,
      queue_audit_id: queue_row_id,
      provider_message_id: null,
      provider_message_sid: null,
      delivery_status_display: null,
      hard_block: isManualSendHardBlockReason(audit_result.reason),
      operator_override_allowed: isManualSendOperatorOverrideAllowed(audit_result.reason),
    };
  }

  // 2. Authority Claim
  // We claim the row IMMEDIATELY to prevent the background runner from touching it.
  const now = nowIso();
  const manual_lock_token = `manual_send:${crypto.randomUUID()}`;
  
  const { data: claimed_row, error: claim_error } = await supabase
    .from("send_queue")
    .update({
      queue_status: "processing",
      is_locked: true,
      locked_at: now,
      lock_token: manual_lock_token,
      updated_at: now,
      metadata: {
        ...(audit_result.result?.raw?.metadata ?? objectMetadata(manual_input.metadata)),
        source: resolved_source,
        send_source: clean(manual_input.send_source) || resolved_source,
        action: resolved_action,
        created_from: resolved_created_from,
        canonical_phone_id:
          audit_result.result?.raw?.metadata?.canonical_phone_id || resolved_canonical_phone_id,
        ...(resolved_source === "map_command"
          ? {
              origin_surface: "command_map",
              message_events_source_app: "LeadCommand Map",
            }
          : {}),
        ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
        manual_send_attempted_at: now,
        manual_lock_token,
      }
    })
    .eq("id", queue_row_id)
    .in("queue_status", ["queued", "scheduled", "pending", "ready"])
    .select()
    .maybeSingle();

  if (claim_error || !claimed_row) {
    logger.warn("inbox_send_now.claim_failed_early_exit", {
      queue_row_id,
      error: claim_error?.message || "already_processed_or_locked",
    });
    return {
      ok: false,
      status: 409,
      error: "provider_not_attempted",
      reason: "queue_item_claim_conflict",
      detail_reason: "row_already_processed_or_locked",
      queue_row_id,
    };
  }

  const normalized_row = normalizeSendQueueRow(claimed_row);
  const message_body = clean(normalized_row.message_body || normalized_row.message_text);
  const to_phone = normalizePhone(normalized_row.to_phone_number);
  const from_phone = normalizePhone(normalized_row.from_phone_number);

  logger.info("inbox_send_now.dispatching_to_provider", {
    queue_row_id,
    thread_key: clean(normalized_row.thread_key) || clean(manual_input.thread_key) || null,
    property_id: clean(normalized_row.property_id) || null,
    master_owner_id: clean(normalized_row.master_owner_id) || null,
    message_intent_id: clean(normalized_row.idempotency_key || normalized_row.queue_key) || null,
    provider: "textgrid",
    to: to_phone,
    from: from_phone,
    textgrid_number_id: clean(normalized_row.textgrid_number_id) || null,
  });

  let send_result = null;
  let provider_error = null;

  // 3. Provider Dispatch
  try {
    send_result = await sendTextgridImpl({
      to: to_phone,
      from: from_phone,
      body: message_body,
      client_reference_id: clean(queue_row_id) || clean(audit_result?.queue_key) || null,
      bypass_system_control: true,
      bypass_reason: "manual_operator_send",
      bypass_content_guards: operator_override_requested,
      source: resolved_source,
      send_source: clean(manual_input.send_source) || resolved_source,
      manual_operator_send: true,
      metadata: {
        source: resolved_source,
        send_source: clean(manual_input.send_source) || resolved_source,
        manual_operator_send: true,
        ...(bypassed_queue_emergency_stop ? { bypassed_queue_emergency_stop: true } : {}),
      },
    });
  } catch (error) {
    provider_error = error;
    logger.error("inbox_send_now.dispatch_failed", {
      queue_row_id,
      thread_key: clean(normalized_row.thread_key) || clean(manual_input.thread_key) || null,
      property_id: clean(normalized_row.property_id) || null,
      master_owner_id: clean(normalized_row.master_owner_id) || null,
      message_intent_id: clean(normalized_row.idempotency_key || normalized_row.queue_key) || null,
      provider: "textgrid",
      failure_category:
        clean(error?.data?.code) ||
        (String(error?.message || "").toLowerCase().includes("provider is not configured")
          ? "provider_configuration_missing"
          : "provider_send_failed"),
      message: error.message,
    });
  }

  // 4. Bookkeeping (Success or Failure)
  // We use the authority of the claimed row and our manual lock token.
  let bookkeeping_result = null;
  const bookkeeping_deps = {
    ...deps,
    supabase,
    supabaseClient: supabase,
    now,
  };

  if (send_result?.ok) {
    // Success path
    try {
      // a. Update send_queue row to terminal 'sent'
      const finalized_row = await finalizeSendQueueSuccessImpl(
        normalized_row,
        manual_lock_token,
        send_result,
        bookkeeping_deps
      );

      // b. Log message_events, update thread state, outreach, etc.
      const outbound_event = await writeOutboundSuccessMessageEventImpl(
        finalized_row,
        send_result,
        bookkeeping_deps
      );

      bookkeeping_result = {
        sent: true,
        final_queue_status: "sent",
        outbound_event,
        provider_message_id: send_result.sid,
      };
    } catch (bk_error) {
      logger.error("inbox_send_now.bookkeeping_success_failed", {
        queue_row_id,
        message: bk_error.message,
      });
      // We still return ok: true to the user because the SMS WAS sent.
      bookkeeping_result = {
        sent: true,
        final_queue_status: "sent",
        bookkeeping_error: bk_error.message,
        provider_message_id: send_result?.sid,
      };
    }
  } else {
    // Failure path
    try {
      const failure_error = provider_error || new Error("provider_dispatch_failed");
      
      // a. Update send_queue row to 'failed'
      const failed_row = await finalizeSendQueueFailureImpl(
        normalized_row,
        manual_lock_token,
        failure_error,
        bookkeeping_deps
      );

      // b. Log failure event
      await writeOutboundFailureMessageEventImpl(
        normalized_row,
        failure_error,
        { ...bookkeeping_deps, send_result }
      );

      bookkeeping_result = {
        sent: false,
        final_queue_status: failed_row?.queue_status || "failed",
        reason: failure_error.message,
      };
    } catch (bk_error) {
      logger.error("inbox_send_now.bookkeeping_failure_failed", {
        queue_row_id,
        message: bk_error.message,
      });
      bookkeeping_result = {
        sent: false,
        final_queue_status: "failed",
        bookkeeping_error: bk_error.message,
      };
    }
  }

  // 5. Build Final Response
  const provider_message_id =
    clean(
      bookkeeping_result?.provider_message_id ||
      send_result?.sid
    ) || null;
  
  const message_event_id =
    clean(
      bookkeeping_result?.outbound_event?.id ||
      bookkeeping_result?.outbound_event?.item_id
    ) || null;

  if (bookkeeping_result?.sent) {
    return {
      ok: true,
      status: 200,
      action: "send-now",
      queue_created: true,
      queue_inserted: true,
      queue_row_id: queue_row_id,
      queue_audit_id: queue_row_id,
      queue_id: audit_result?.queue_id || queue_row_id,
      queue_key: audit_result?.queue_key || null,
      queue_status: bookkeeping_result.final_queue_status,
      message_event_id,
      provider_message_id,
      provider_message_sid: provider_message_id,
      delivery_status_display: "sent",
      warning_codes: audit_result?.warning_codes || [],
      proof: audit_result?.proof || null,
      diagnostics: {
        bookkeeping_result,
        bookkeeping_error: bookkeeping_result.bookkeeping_error || null,
      },
    };
  }

  const mapped_failure = mapProcessedManualSendFailure(
    bookkeeping_result?.reason || "failed",
    provider_error?.message || bookkeeping_result?.reason || ""
  );

  return {
    ok: false,
    status: mapped_failure.hard_block ? 423 : 500,
    action: "send-now",
    error: mapped_failure.reason,
    reason: mapped_failure.reason,
    detail_reason: mapped_failure.detail_reason,
    queue_created: true,
    queue_inserted: true,
    queue_row_id,
    queue_audit_id: queue_row_id,
    queue_id: audit_result?.queue_id || queue_row_id,
    queue_key: audit_result?.queue_key || null,
    queue_status: bookkeeping_result?.final_queue_status || "failed",
    message_event_id,
    provider_message_id,
    provider_message_sid: provider_message_id,
    delivery_status_display: "failed",
    hard_block: mapped_failure.hard_block,
    operator_override_allowed: mapped_failure.operator_override_allowed && !operator_override_requested,
    warning_codes: audit_result?.warning_codes || [],
    proof: audit_result?.proof || null,
    diagnostics: {
      bookkeeping_result,
      provider_error: provider_error?.message,
    },
  };
}

export default createInboxSendNowQueueRow;

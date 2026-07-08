/**
 * delivery-triggered-followup.js
 *
 * Delivery-confirmed follow-up trigger for the automation control plane.
 *
 * Follow-up scheduling for an outbound touch happens ONLY after the provider
 * confirms delivery — never on queue insert, send attempt, provider-accepted,
 * failed, blocked, undelivered, content-filtered, or missing-provider-ID
 * outcomes. This module is a trigger + safety gate only: cadence rules and
 * queue writes stay in the existing seller-followup-scheduler (which also
 * dedupes and enforces 21610 suppression through the canonical queue writer).
 */

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { scheduleFollowUp } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { getSystemValue } from "@/lib/system-control.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";

const DELIVERED_STATUSES = new Set(["delivered", "delivery_confirmed", "confirmed"]);
const BLOCKED_CONTACTABILITY = new Set(["opted_out", "wrong_number", "do_not_text"]);
const TERMINAL_STAGES = new Set(["closed", "dead", "closed_lost", "archived"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

// ── Explicit follow-up activation gate ─────────────────────────────────────
// Deploying this code must never activate delivery-triggered follow-ups on
// its own: scheduling requires an explicit follow-up automation mode. The
// mode comes from system_control (followup_automation_mode), an explicit
// request, or FOLLOWUP_AUTOMATION_MODE — never from legacy live flags — and
// anything missing/blank/invalid fails closed to disabled.

export const FOLLOW_UP_AUTOMATION_MODES = Object.freeze([
  "disabled",
  "dry_run",
  "internal_only",
  "canary_market",
  "canary_sender",
  "canary_stage",
  "live_limited",
  "full_live",
]);

const FOLLOW_UP_MODE_SET = new Set(FOLLOW_UP_AUTOMATION_MODES);
const FOLLOW_UP_SCHEDULING_MODES = new Set([
  "internal_only",
  "canary_market",
  "canary_sender",
  "canary_stage",
  "live_limited",
  "full_live",
]);

export const FOLLOW_UP_AUTOMATION_MODE_KEY = "followup_automation_mode";

export function normalizeFollowUpAutomationMode(value, fallback = null) {
  const normalized = lower(value).replace(/[-\s]+/g, "_");
  if (FOLLOW_UP_MODE_SET.has(normalized)) return normalized;
  return fallback;
}

export function resolveFollowUpAutomationMode({
  requestedMode = null,
  systemMode = null,
  env = process.env,
  legacyLiveEnabled = false,
} = {}) {
  const system_mode = normalizeFollowUpAutomationMode(systemMode, null);
  if (system_mode) return { mode: system_mode, source: "system_control" };

  const explicit = normalizeFollowUpAutomationMode(requestedMode, null);
  if (explicit) return { mode: explicit, source: "request" };

  const env_mode = normalizeFollowUpAutomationMode(env?.FOLLOWUP_AUTOMATION_MODE, null);
  if (env_mode) return { mode: env_mode, source: "env" };

  // auto_reply_live_enabled (and every other legacy flag) is diagnostics
  // only: it must never activate follow-up scheduling by itself.
  if (legacyLiveEnabled) {
    return {
      mode: "disabled",
      source: "legacy_live_flags_blocked",
      legacy_live_fallthrough_blocked: true,
      audit_reason: "followup_automation_mode_missing_or_invalid",
    };
  }

  return { mode: "disabled", source: "default_disabled" };
}

/**
 * Pure eligibility gate. Every reason is explicit so proof runs can assert
 * exactly why a follow-up was or was not scheduled.
 */
export function resolveDeliveryFollowUpDecision({
  final_delivery_status = null,
  provider_message_id = null,
  followup_intent = null,
  has_inbound_after_outbound = false,
  has_newer_outbound = false,
  pending_followup_exists = false,
  contactability_status = null,
  lifecycle_stage = null,
} = {}) {
  if (!clean(provider_message_id)) {
    return { eligible: false, reason: "missing_provider_message_id" };
  }
  if (!DELIVERED_STATUSES.has(lower(final_delivery_status))) {
    return { eligible: false, reason: `not_provider_confirmed_delivered:${lower(final_delivery_status) || "unknown"}` };
  }
  if (!clean(followup_intent)) {
    return { eligible: false, reason: "no_declared_followup_plan" };
  }
  if (has_inbound_after_outbound) {
    return { eligible: false, reason: "inbound_reply_received" };
  }
  if (has_newer_outbound) {
    return { eligible: false, reason: "newer_outbound_exists" };
  }
  if (pending_followup_exists) {
    return { eligible: false, reason: "duplicate_pending_followup" };
  }
  if (BLOCKED_CONTACTABILITY.has(lower(contactability_status))) {
    return { eligible: false, reason: `contact_blocked:${lower(contactability_status)}` };
  }
  if (TERMINAL_STAGES.has(lower(lifecycle_stage))) {
    return { eligible: false, reason: `terminal_stage:${lower(lifecycle_stage)}` };
  }
  return { eligible: true, reason: "delivered_followup_eligible" };
}

async function loadOutboundEvent(supabase, provider_message_sid) {
  const { data, error } = await supabase
    .from("message_events")
    .select("id,thread_key,queue_id,sent_at,event_timestamp,master_owner_id,property_id,to_phone_number,metadata")
    .eq("provider_message_sid", provider_message_sid)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function threadHasEventAfter(supabase, { thread_key, direction, after_iso, exclude_event_id }) {
  let query = supabase
    .from("message_events")
    .select("id")
    .eq("thread_key", thread_key)
    .eq("direction", direction)
    .gt("event_timestamp", after_iso)
    .limit(1);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).filter((row) => row.id !== exclude_event_id);
  return rows.length > 0;
}

async function pendingFollowupExists(supabase, thread_key) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id")
    .eq("thread_key", thread_key)
    .in("queue_status", ["scheduled", "queued"])
    .in("type", ["followup"])
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

async function loadLeadStateGuards(supabase, thread_key) {
  try {
    const { data } = await supabase
      .from("inbox_thread_state")
      .select("contactability_status,lifecycle_stage")
      .eq("thread_key", thread_key)
      .maybeSingle();
    return {
      contactability_status: data?.contactability_status || null,
      lifecycle_stage: data?.lifecycle_stage || null,
    };
  } catch {
    // Fail closed on unknown lead state: treat as blocked for automation.
    return { contactability_status: "do_not_text", lifecycle_stage: null };
  }
}

async function resolveEffectiveFollowUpMode({
  followUpMode = null,
  legacyLiveEnabled = false,
  getSystemValueImpl = getSystemValue,
} = {}) {
  let system_mode = null;
  try {
    system_mode = await getSystemValueImpl(FOLLOW_UP_AUTOMATION_MODE_KEY);
  } catch {
    system_mode = null; // unreadable control ⇒ fail closed to disabled
  }
  return resolveFollowUpAutomationMode({
    requestedMode: followUpMode,
    systemMode: system_mode,
    legacyLiveEnabled,
  });
}

/**
 * Trigger the existing follow-up scheduler after a provider-confirmed
 * delivery. Never throws into the webhook path.
 *
 * Requires an explicit follow-up automation mode: a delivered receipt alone
 * is never enough authority to create a send_queue row.
 */
export async function maybeScheduleFollowUpAfterDelivery({
  provider_message_sid = null,
  final_delivery_status = null,
  supabase = defaultSupabase,
  scheduleFollowUpImpl = scheduleFollowUp,
  followUpMode = null,
  legacyLiveEnabled = false,
  getSystemValueImpl = getSystemValue,
  isInternalTestPhoneImpl = isInternalTestPhone,
} = {}) {
  try {
    const mode_resolution = await resolveEffectiveFollowUpMode({
      followUpMode,
      legacyLiveEnabled,
      getSystemValueImpl,
    });
    const mode = mode_resolution.mode;

    if (mode === "disabled") {
      return {
        ok: true,
        scheduled: false,
        reason: "followup_automation_disabled",
        mode,
        mode_source: mode_resolution.source,
      };
    }

    const sid = clean(provider_message_sid);
    const status_gate = resolveDeliveryFollowUpDecision({
      final_delivery_status,
      provider_message_id: sid,
      followup_intent: "status_gate_only",
    });
    if (!status_gate.eligible) {
      return { ok: true, scheduled: false, reason: status_gate.reason };
    }

    const outbound = await loadOutboundEvent(supabase, sid);
    if (!outbound?.thread_key) {
      return { ok: true, scheduled: false, reason: "outbound_event_not_found" };
    }

    const event_metadata =
      outbound.metadata && typeof outbound.metadata === "object" ? outbound.metadata : {};
    const provenance = event_metadata.automation_provenance || {};
    const followup_intent =
      clean(provenance.followup_intent) || clean(event_metadata.followup_intent) || null;

    const sent_at = outbound.sent_at || outbound.event_timestamp;
    const [inbound_after, outbound_after, pending, lead_state] = await Promise.all([
      threadHasEventAfter(supabase, {
        thread_key: outbound.thread_key,
        direction: "inbound",
        after_iso: sent_at,
        exclude_event_id: outbound.id,
      }),
      threadHasEventAfter(supabase, {
        thread_key: outbound.thread_key,
        direction: "outbound",
        after_iso: sent_at,
        exclude_event_id: outbound.id,
      }),
      pendingFollowupExists(supabase, outbound.thread_key),
      loadLeadStateGuards(supabase, outbound.thread_key),
    ]);

    const decision = resolveDeliveryFollowUpDecision({
      final_delivery_status,
      provider_message_id: sid,
      followup_intent,
      has_inbound_after_outbound: inbound_after,
      has_newer_outbound: outbound_after,
      pending_followup_exists: pending,
      contactability_status: lead_state.contactability_status,
      lifecycle_stage: lead_state.lifecycle_stage,
    });

    if (!decision.eligible) {
      return { ok: true, scheduled: false, reason: decision.reason, mode };
    }

    // Explicit activation gate — evaluated only after every delivery guard
    // passed, so dry-run telemetry reflects what live mode would have done.
    if (mode === "dry_run") {
      return {
        ok: true,
        scheduled: false,
        reason: "followup_dry_run",
        mode,
        would_schedule: true,
        gate_reason: decision.reason,
        thread_key: outbound.thread_key,
      };
    }

    if (mode === "internal_only" && !isInternalTestPhoneImpl(outbound.thread_key)) {
      return {
        ok: true,
        scheduled: false,
        reason: "followup_internal_only_blocked",
        mode,
        thread_key: outbound.thread_key,
      };
    }

    if (!FOLLOW_UP_SCHEDULING_MODES.has(mode)) {
      return { ok: true, scheduled: false, reason: "followup_automation_disabled", mode };
    }

    const result = await scheduleFollowUpImpl(
      followup_intent,
      outbound.thread_key,
      {
        source: "delivery_triggered_followup",
        delivered_provider_message_sid: sid,
        outbound_message_event_id: outbound.id,
        master_owner_id: outbound.master_owner_id || null,
        property_id: outbound.property_id || null,
      },
      supabase
    );

    return {
      ok: true,
      scheduled: Boolean(result?.followup_created),
      reason: result?.reason || decision.reason,
      mode,
      scheduled_for: result?.scheduled_for || null,
      queue_row_id: result?.queue_row_id || null,
      thread_key: outbound.thread_key,
    };
  } catch (error) {
    return {
      ok: false,
      scheduled: false,
      reason: error?.message || "delivery_followup_failed",
    };
  }
}

export default maybeScheduleFollowUpAfterDelivery;

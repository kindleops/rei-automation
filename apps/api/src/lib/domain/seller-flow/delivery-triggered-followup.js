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

import { supabase as defaultSupabase, hasSupabaseConfig } from "@/lib/supabase/client.js";
import {
  scheduleFollowUp,
  STAGE_NO_REPLY_FOLLOWUP_INTENT,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { getSystemValue, setSystemValues } from "@/lib/system-control.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { BLOCKING_CONTACTABILITY } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { resolveFollowUpPolicyForStage } from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { warn } from "@/lib/logging/logger.js";
import {
  NO_RESPONSE_CONFIG_KEY,
  NO_RESPONSE_MODE_KEY,
  NO_RESPONSE_ENABLED_AT_KEY,
  NO_RESPONSE_CANARY_CAP_KEY,
  resolveNoResponseEnabledAt,
  resolveCanaryDailyCap,
  buildNoResponseScheduleContext,
  buildObservedOfferQuote,
  classifyNoResponseAnchor,
  evaluateNoResponseCandidate,
  loadAnchorQueueRow,
  loadNoResponseThreadFacts,
  normalizeNoResponseMode,
  resolveNoResponseConfig,
} from "@/lib/domain/seller-flow/no-response-followup.js";

const DELIVERED_STATUSES = new Set(["delivered", "delivery_confirmed", "confirmed"]);
// Registry blocking codes (opted_out/dnc/provider_blacklisted/invalid_number/
// do_not_text) plus the legacy "wrong_number" string some historical rows
// carry. The old local set missed invalid_number — the code the wrong-number
// intent actually writes — as well as dnc and provider_blacklisted.
const BLOCKED_CONTACTABILITY = new Set([...BLOCKING_CONTACTABILITY, "wrong_number"]);
// 'archived' is deliberately absent: archive is a visibility flag, never a
// terminal lifecycle (owner, 2026-10-08 — archive must never stop nurture).
const TERMINAL_STAGES = new Set(["closed", "dead", "closed_lost"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
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

async function loadPendingFollowups(supabase, thread_key) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,use_case_template,metadata")
    .eq("thread_key", thread_key)
    .in("queue_status", ["scheduled", "queued"])
    .in("type", ["followup"])
    .limit(10);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function followupRowUseCase(row = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return lower(row?.use_case_template || meta.followup_use_case || "");
}

// Pure stage-aware supersession decision (Phase 6 Gap 1). Given the pending
// follow-up rows on a thread and the use case of the just-delivered outbound,
// classify each pending row:
//   - DIFFERENT, classifiable use case  -> stale prior-stage (supersede/cancel)
//   - SAME use case                     -> duplicate (blocks scheduling)
//   - unclassifiable (no use case)      -> fails safe: blocks scheduling
// Returns { stale_prior_stage, pending, target_use_case }. `pending` is true
// when any non-stale pending row remains — i.e. the caller must not schedule a
// duplicate. With no target use case (unknown current stage) nothing is
// superseded and any pending row blocks, matching the prior conservative gate.
export function resolvePendingFollowupSupersession({
  pending_rows = [],
  outbound_use_case = null,
} = {}) {
  const rows = Array.isArray(pending_rows) ? pending_rows : [];
  const target = lower(outbound_use_case);
  const stale_prior_stage = target
    ? rows.filter((r) => {
        const uc = followupRowUseCase(r);
        return uc && uc !== target;
      })
    : [];
  const superseded_ids = new Set(stale_prior_stage.map((r) => r.id));
  const pending = rows.some((r) => !superseded_ids.has(r.id));
  return { stale_prior_stage, pending, target_use_case: target || null };
}

// Cancel prior-stage pending follow-ups that a stage advance has made stale.
// A plain queue_status flip to "cancelled" (with an audit stamp on metadata)
// on the specific stale row ids — never the whole thread, so a legitimate
// same-stage pending follow-up is left intact. Best-effort: a supersession
// failure must not block the current stage's follow-up from scheduling.
export async function supersedePriorStageFollowups(
  supabase,
  { rows = [], thread_key = null, superseded_by_use_case = null } = {}
) {
  const superseded_at = nowIso();
  for (const row of rows) {
    const id = clean(row?.id);
    if (!id) continue;
    try {
      const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const { error } = await supabase
        .from("send_queue")
        .update({
          queue_status: "cancelled",
          updated_at: superseded_at,
          metadata: {
            ...meta,
            superseded_by_stage_advance: true,
            superseded_at,
            superseded_by_use_case,
            superseded_from_use_case: followupRowUseCase(row) || null,
          },
        })
        .eq("id", id)
        .in("queue_status", ["scheduled", "queued"])
        .in("type", ["followup"]);
      if (error) throw error;
    } catch (error) {
      warn("[FOLLOWUP_SUPERSEDE_FAILED]", {
        thread_key,
        queue_row_id: id,
        error: error?.message || "supersede_failed",
      });
    }
  }
}

// A transport-FAILED follow-up never reached the seller, so it must not burn an
// automated-attempt from the lifetime cap (a failed send is not a successful
// follow-up attempt). Count only rows that reached, or are in-flight to, the
// seller (scheduled/queued/sent/delivered). Cancelled and terminal
// never-delivered statuses do not consume the cap. (Phase 8 rotates a
// content-filter block in place to 'queued', so it stays a single attempt.)
const NON_ATTEMPT_FOLLOWUP_STATUSES = new Set([
  "cancelled",
  "failed",
  "failed_transport",
  "undelivered",
  "invalid_number",
  "carrier_blocked",
  "blocked",
]);

export async function countAutomatedFollowUps(supabase, thread_key) {
  // Lifetime cap input: every automated follow-up row that actually counts as an
  // attempt (see NON_ATTEMPT_FOLLOWUP_STATUSES). Fetches a bounded page and
  // filters locally — the caps are single digits, so 50 rows is far past any
  // policy ceiling.
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status")
    .eq("thread_key", thread_key)
    .in("type", ["followup"])
    .limit(50);
  if (error) throw error;
  return (data || []).filter(
    (row) => !NON_ATTEMPT_FOLLOWUP_STATUSES.has(lower(row?.queue_status))
  ).length;
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
  // The default system-control reader needs real Supabase config; without it
  // (e.g. network-guarded tests) skip the read and fail closed to disabled.
  const can_read_system = getSystemValueImpl !== getSystemValue || hasSupabaseConfig();
  try {
    system_mode = can_read_system
      ? await getSystemValueImpl(FOLLOW_UP_AUTOMATION_MODE_KEY)
      : null;
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
 * Canary budget: no-response follow-up rows written since 00:00 UTC (any
 * status — a cancelled row still spent the day's budget). null = unreadable
 * (the caller fails closed).
 */
export async function countNoResponseFollowUpsToday(supabase, now = new Date()) {
  const day = new Date(now instanceof Date ? now.getTime() : Date.parse(now));
  day.setUTCHours(0, 0, 0, 0);
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id,metadata")
      .eq("type", "followup")
      .gte("created_at", day.toISOString())
      .limit(500);
    if (error) return null;
    return (data || []).filter((r) => r?.metadata?.source === "no_response_followup").length;
  } catch {
    return null;
  }
}

/**
 * NO-RESPONSE FOLLOW-UPS (S2 interest question / offer — no-response-followup.js).
 * Runs only when system_control.followup_no_response_mode is dry_run|live;
 * disabled/missing/unreadable ⇒ { handled:false } and the generic path below
 * behaves exactly as before. Returns { handled, result }.
 */
export async function maybeScheduleNoResponseFollowUp({
  supabase,
  outbound,
  sid,
  mode,
  sent_at,
  inbound_after = false,
  outbound_after = false,
  pending_rows = [],
  lead_state = {},
  getSystemValueImpl = getSystemValue,
  scheduleFollowUpImpl = scheduleFollowUp,
  isInternalTestPhoneImpl = isInternalTestPhone,
  now = new Date(),
} = {}) {
  const can_read_system = getSystemValueImpl !== getSystemValue || hasSupabaseConfig();
  let nr_mode = "disabled";
  let config_raw = null;
  let enabled_at = null;
  let canary_cap = null;
  try {
    nr_mode = can_read_system ? normalizeNoResponseMode(await getSystemValueImpl(NO_RESPONSE_MODE_KEY)) : "disabled";
    if (nr_mode !== "disabled") {
      config_raw = await getSystemValueImpl(NO_RESPONSE_CONFIG_KEY);
      enabled_at = resolveNoResponseEnabledAt(await getSystemValueImpl(NO_RESPONSE_ENABLED_AT_KEY));
      canary_cap = nr_mode === "canary" ? resolveCanaryDailyCap(await getSystemValueImpl(NO_RESPONSE_CANARY_CAP_KEY)) : null;
    }
  } catch {
    nr_mode = "disabled";
  }
  if (nr_mode === "disabled") return { handled: false };

  const anchor = await loadAnchorQueueRow(supabase, outbound.queue_id);
  if (!anchor) return { handled: false };
  const config = resolveNoResponseConfig(config_raw);
  if (!classifyNoResponseAnchor(anchor, config).kind) return { handled: false };

  const thread_key = outbound.thread_key;
  // PROSPECTIVE ONLY (owner 2026-10-10): a sending mode without an explicit
  // enable instant fails closed — it can never sweep the historical backlog.
  if ((nr_mode === "canary" || nr_mode === "live") && !enabled_at) {
    return {
      handled: true,
      result: { ok: true, scheduled: false, mode, no_response_mode: nr_mode, thread_key: outbound.thread_key, reason: "no_response_enabled_at_missing" },
    };
  }
  const facts = await loadNoResponseThreadFacts(supabase, {
    thread_key,
    anchor_sent_at: sent_at,
    anchor_message_event_id: outbound.id,
  });
  const evaluation = evaluateNoResponseCandidate(
    {
      ...facts,
      anchor,
      anchor_sent_at: sent_at,
      anchor_message_event_id: outbound.id,
      thread_key,
      enabled_at,
      has_inbound_after_anchor: Boolean(inbound_after || facts.has_inbound_after_anchor),
      has_newer_outbound: Boolean(outbound_after),
      thread_state: {
        ...facts.thread_state,
        contactability_status: facts.thread_state?.contactability_status ?? lead_state.contactability_status ?? null,
        lifecycle_stage: facts.thread_state?.lifecycle_stage ?? lead_state.lifecycle_stage ?? null,
      },
    },
    { config, now }
  );
  const base = { ok: true, scheduled: false, mode, no_response_mode: nr_mode, thread_key };
  if (!evaluation.eligible) return { handled: true, result: { ...base, reason: evaluation.reason } };
  if ((pending_rows || []).length > 0) {
    return { handled: true, result: { ...base, reason: "duplicate_pending_followup" } };
  }
  const plan = evaluation.plan;
  if (nr_mode === "dry_run" || mode === "dry_run") {
    return { handled: true, result: { ...base, reason: "no_response_followup_dry_run", would_schedule: true, plan } };
  }
  if (mode === "internal_only" && !isInternalTestPhoneImpl(thread_key)) {
    return { handled: true, result: { ...base, reason: "followup_internal_only_blocked" } };
  }
  if (!FOLLOW_UP_SCHEDULING_MODES.has(mode)) {
    return { handled: true, result: { ...base, reason: "followup_automation_disabled" } };
  }
  if (nr_mode === "canary") {
    const used = await countNoResponseFollowUpsToday(supabase, now);
    if (used === null) return { handled: true, result: { ...base, reason: "canary_cap_unreadable" } };
    if (used >= canary_cap) {
      return { handled: true, result: { ...base, reason: `canary_daily_cap_reached:${used}/${canary_cap}` } };
    }
  }
  const context = buildNoResponseScheduleContext(plan, {
    thread_key,
    anchor,
    anchor_message_event_id: outbound.id,
    delivered_provider_message_sid: sid,
  });
  if (nr_mode === "canary") {
    context.no_response_canary = true;
    context.no_response_enabled_at = enabled_at;
  }
  const result = await scheduleFollowUpImpl(STAGE_NO_REPLY_FOLLOWUP_INTENT, thread_key, context, supabase);
  // Track the offer we follow up on like an automated quote (best-effort:
  // the PROPOSED table may not exist yet; the follow-up never depends on it).
  let observed_offer = null;
  if (plan.kind === "offer" && plan.step === 0) {
    const quote = buildObservedOfferQuote({
      thread_key,
      message_event_id: outbound.id,
      offer: plan.offer,
      anchor,
      language: plan.language,
      quoted_at: sent_at,
    });
    if (quote) {
      try {
        const { recordNegotiationQuote } = await import("@/lib/domain/seller-flow/negotiation-quotes.js");
        observed_offer = await recordNegotiationQuote(supabase, quote);
      } catch (error) {
        observed_offer = { ok: false, reason: error?.message || "observed_offer_write_failed" };
      }
    }
  }
  return {
    handled: true,
    result: {
      ...base,
      scheduled: Boolean(result?.followup_created),
      reason: result?.reason || evaluation.reason,
      scheduled_for: result?.scheduled_for || null,
      queue_row_id: result?.queue_row_id || null,
      no_response_kind: plan.kind,
      no_response_step: plan.step_label,
      use_case: plan.use_case,
      observed_offer_recorded: observed_offer ? Boolean(observed_offer.ok) : null,
    },
  };
}

/**
 * Trigger the existing follow-up scheduler after a provider-confirmed
 * delivery. Never throws into the webhook path.
 *
 * Requires an explicit follow-up automation mode: a delivered receipt alone
 * is never enough authority to create a send_queue row.
 */
// ── Scheduler heartbeat (owner 2026-10-10: restored + visible) ─────────────
// Every run of this leg (each provider-confirmed delivery receipt) stamps
// system_control so Operations can see the follow-up scheduler is alive:
//   followup_no_response_heartbeat_at   this leg ran
//   follow_up_scheduler_heartbeat_at    the legacy key the dashboards read
//                                       (frozen at 2026-09-17 when the Vercel
//                                       lane was retired)
//   followup_no_response_last_result    {mode, reason, scheduled} of the run
// Throttled per process (default 60 s) so a receipt burst is one write;
// best-effort — a heartbeat failure never touches the webhook path.
export const FOLLOWUP_HEARTBEAT_KEY = "followup_no_response_heartbeat_at";
export const LEGACY_FOLLOWUP_HEARTBEAT_KEY = "follow_up_scheduler_heartbeat_at";
export const FOLLOWUP_LAST_RESULT_KEY = "followup_no_response_last_result";
let last_heartbeat_ms = 0;

export async function recordFollowUpHeartbeat(
  result = {},
  { setSystemValuesImpl = setSystemValues, now = new Date(), throttleMs = 60_000 } = {}
) {
  const at = now instanceof Date ? now : new Date(now);
  if (throttleMs > 0 && at.getTime() - last_heartbeat_ms < throttleMs) return { written: false, reason: "throttled" };
  last_heartbeat_ms = at.getTime();
  const iso = at.toISOString();
  try {
    await setSystemValuesImpl({
      [FOLLOWUP_HEARTBEAT_KEY]: iso,
      [LEGACY_FOLLOWUP_HEARTBEAT_KEY]: iso,
      [FOLLOWUP_LAST_RESULT_KEY]: JSON.stringify({
        at: iso,
        mode: result?.mode ?? null,
        no_response_mode: result?.no_response_mode ?? null,
        scheduled: Boolean(result?.scheduled),
        reason: result?.reason ?? null,
      }),
    });
    return { written: true, at: iso };
  } catch (error) {
    return { written: false, reason: error?.message || "heartbeat_write_failed" };
  }
}

export async function maybeScheduleFollowUpAfterDelivery(args = {}) {
  const result = await scheduleFollowUpAfterDeliveryRun(args);
  const can_write = typeof args.setSystemValuesImpl === "function" || hasSupabaseConfig();
  if (can_write) {
    await recordFollowUpHeartbeat(result, {
      ...(typeof args.setSystemValuesImpl === "function" ? { setSystemValuesImpl: args.setSystemValuesImpl } : {}),
      ...(args.heartbeatThrottleMs !== undefined ? { throttleMs: args.heartbeatThrottleMs } : {}),
    });
  }
  return result;
}

async function scheduleFollowUpAfterDeliveryRun({
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
    const declared_followup_intent =
      clean(provenance.followup_intent) || clean(event_metadata.followup_intent) || null;

    const sent_at = outbound.sent_at || outbound.event_timestamp;
    const [inbound_after, outbound_after, pending_rows, lead_state] = await Promise.all([
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
      loadPendingFollowups(supabase, outbound.thread_key),
      loadLeadStateGuards(supabase, outbound.thread_key),
    ]);

    // No-response follow-ups (S2 question / offer) own their anchors when
    // their gate is on; otherwise this is a no-op and the generic path runs.
    const no_response = await maybeScheduleNoResponseFollowUp({
      supabase,
      outbound,
      sid,
      mode,
      sent_at,
      inbound_after,
      outbound_after,
      pending_rows,
      lead_state,
      getSystemValueImpl,
      scheduleFollowUpImpl,
      isInternalTestPhoneImpl,
    });
    if (no_response.handled) return no_response.result;

    // Stage follow-up policy (one registry, no scattered timers): the
    // thread's CURRENT lifecycle stage must allow automated follow-ups, and
    // the lifetime automated-touch cap for that stage must not be exhausted.
    const stage_policy = resolveFollowUpPolicyForStage(lead_state.lifecycle_stage);

    // Canonical follow-up plan resolution. An explicitly declared intent (a
    // disengaging reply's nurture plan) keeps the intent layer. Otherwise a
    // delivered STAGE QUESTION (e.g. the S1 ownership check) follows the
    // stage registry's no-reply cadence — the plan is derived from outbound
    // purpose (template use case + lifecycle stage + policy), never from a
    // fabricated seller intent: the seller has said nothing yet.
    const outbound_use_case =
      clean(provenance.template_use_case) || clean(event_metadata.template_use_case) || null;

    // Stage-aware supersession (Phase 6 Gap 1). A pending follow-up scheduled
    // for a PRIOR lifecycle stage must not block — nor outlive — the current
    // stage's follow-up. The pure resolver flags any pending follow-up whose
    // use case differs from this delivered outbound's as stale (the thread has
    // advanced); those are cancelled here and NOT counted as a duplicate that
    // blocks scheduling. A pending follow-up for the SAME use case still blocks
    // (no duplicate same-stage follow-up), and any row we cannot classify fails
    // safe by still blocking. This only fires on real stage advance and never
    // touches the inbound turn's own fresh same-stage follow-up.
    const { stale_prior_stage, pending, target_use_case } =
      resolvePendingFollowupSupersession({ pending_rows, outbound_use_case });
    if (stale_prior_stage.length > 0) {
      await supersedePriorStageFollowups(supabase, {
        rows: stale_prior_stage,
        thread_key: outbound.thread_key,
        superseded_by_use_case: target_use_case,
      });
    }

    const stage_no_reply_days = Number(stage_policy.policy.no_reply_delay_days);
    const stage_plan_available = Boolean(
      stage_policy.policy.enabled &&
        Number.isFinite(stage_no_reply_days) &&
        stage_no_reply_days > 0 &&
        outbound_use_case
    );
    const followup_intent =
      declared_followup_intent ||
      (stage_plan_available ? STAGE_NO_REPLY_FOLLOWUP_INTENT : null);

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

    if (!stage_policy.policy.enabled) {
      return {
        ok: true,
        scheduled: false,
        reason: `followup_policy_disabled_for_stage:${stage_policy.stage}`,
        mode,
        thread_key: outbound.thread_key,
      };
    }
    const prior_followups = await countAutomatedFollowUps(supabase, outbound.thread_key);
    if (prior_followups >= stage_policy.policy.max_automated_followups) {
      return {
        ok: true,
        scheduled: false,
        reason: `followup_max_attempts_reached:${prior_followups}/${stage_policy.policy.max_automated_followups}`,
        mode,
        thread_key: outbound.thread_key,
      };
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
        // Stage-layer plan authority: cadence from the stage registry and
        // attribution to the outbound's real use case (see scheduler).
        stage: stage_policy.stage,
        stage_no_reply_days: stage_plan_available ? stage_no_reply_days : null,
        followup_use_case: outbound_use_case,
        agent_name:
          clean(event_metadata.agent_name) || clean(event_metadata.agent_first_name) || null,
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

// Missed-call auto-text — the decision + the call log.
//
// One entry point, processCallOutcome(), is called by the voice webhook when a
// call to one of our TextGrid numbers ends. It:
//   1. claims the call by CallSid (message_events.message_event_key is UNIQUE,
//      so a redelivered webhook can never log or text twice);
//   2. for an ANSWERED forward, logs the call and stops (no text);
//   3. for a MISSED call, runs every gate, then queues ONE text through the
//      canonical queue writer — never the provider — from the SAME number the
//      caller dialled, inside the caller's 8 AM–9 PM window;
//   4. finalizes the thread event so the operator sees
//      "Missed call · 0:00 · auto-text queued/skipped (reason)".
//
// The queue processor still re-checks suppression, opt-out, wrong-number, the
// emergency stop, queue_processor_mode and the contact window at dispatch. The
// checks here exist so a skip is recorded honestly in the thread, not as a
// substitute for the dispatch gates.

import crypto from "node:crypto";
import { child } from "@/lib/logging/logger.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { enqueueCanonicalOutboundSms } from "@/lib/domain/queue/canonical-queue-writer.js";
import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import {
  evaluateCanonicalContactability,
  CONTACT_CHECK_MODES,
} from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import {
  loadPropertyGeography,
  resolveRecipientTimezone,
} from "@/lib/domain/queue/recipient-timezone.js";
import { normalizeCanonicalLanguage } from "@/lib/domain/templates/template-metadata-normalization.js";
import {
  MISSED_CALL_USE_CASE,
  MISSED_CALL_DEFAULT_PERSONA,
  MISSED_CALL_DEFAULT_LANGUAGE,
  isMissedCallAutotextSwitchOn,
} from "@/lib/domain/calls/missed-call-config.js";
import { planMissedCallSendTime, formatLocalTime } from "@/lib/domain/calls/missed-call-window.js";

const logger = child({ module: "domain.calls.process_missed_call" });

export const CALL_OUTCOMES = Object.freeze({
  ANSWERED: "answered",
  NO_ANSWER: "no_answer",
  BUSY: "busy",
  FAILED: "failed",
  CANCELED: "canceled",
  NOT_FORWARDED: "not_forwarded",
});

const MISSED_OUTCOMES = new Set([
  CALL_OUTCOMES.NO_ANSWER,
  CALL_OUTCOMES.BUSY,
  CALL_OUTCOMES.FAILED,
  CALL_OUTCOMES.CANCELED,
  CALL_OUTCOMES.NOT_FORWARDED,
]);

const PENDING_QUEUE_STATUSES = new Set([
  "queued", "scheduled", "pending", "approval", "approved", "ready", "processing", "sending",
]);
const CONSUMED_QUEUE_STATUSES = new Set(["sent", "delivered", "accepted"]);

// Human copy for the thread line. Never claims a send that has not happened.
export const SKIP_REASON_LABELS = Object.freeze({
  autotext_disabled: "auto-text is off",
  caller_id_unavailable: "no caller ID",
  caller_is_our_number: "internal call",
  sending_paused: "sending is paused",
  suppressed: "number is suppressed",
  opted_out: "caller opted out",
  wrong_number: "marked wrong number",
  do_not_contact: "do not contact",
  thread_paused: "thread is paused",
  missed_call_text_within_window: "already texted for a missed call in the last 24h",
  pending_outbound: "a text to this caller is already scheduled",
  recent_outbound: "we texted them recently",
  active_conversation: "conversation is active",
  template_missing: "no approved missed-call template",
  lookup_failed: "safety lookup failed",
  queue_rejected: "queue rejected the text",
  window_unresolved: "contact window unresolved",
});

function clean(value) {
  return String(value ?? "").trim();
}

function minutesAgoIso(now, minutes) {
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString();
}

function ms(value) {
  const t = Date.parse(clean(value));
  return Number.isFinite(t) ? t : null;
}

export function formatCallDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// iMessage/Android reactions are not language evidence (owner rule 10-05).
const REACTION_RE =
  /^(liked|loved|disliked|laughed at|emphasi[sz]ed|questioned|reacted|le gustó|le encantó)\b/i;

export function isSubstantiveReply(body) {
  const text = clean(body);
  if (!text || REACTION_RE.test(text)) return false;
  return (text.match(/\p{L}/gu) || []).length >= 3;
}

/**
 * Caller language: their latest SUBSTANTIVE reply's language, then their most
 * recent identifiable language, then the language we opened in, then English.
 * Only languages we hold a template for are returned by the caller of this.
 */
export function resolveCallerLanguage({ events = [], thread_state = null } = {}) {
  const inbound = events.filter((e) => clean(e.direction).toLowerCase() === "inbound");
  for (const e of inbound) {
    const lang = normalizeCanonicalLanguage(e.language || e.metadata?.language);
    if (lang && isSubstantiveReply(e.message_body)) return { language: lang, basis: "latest_substantive_reply" };
  }
  for (const e of inbound) {
    const lang = normalizeCanonicalLanguage(e.language || e.metadata?.language);
    if (lang) return { language: lang, basis: "latest_identifiable_reply" };
  }
  const threadLang = normalizeCanonicalLanguage(
    thread_state?.metadata?.language || thread_state?.metadata?.best_language,
  );
  if (threadLang) return { language: threadLang, basis: "thread_language" };
  for (const e of events) {
    if (clean(e.direction).toLowerCase() !== "outbound") continue;
    const lang = normalizeCanonicalLanguage(e.language || e.metadata?.language);
    if (lang) return { language: lang, basis: "opener_language" };
  }
  return { language: MISSED_CALL_DEFAULT_LANGUAGE, basis: "default_unknown_caller" };
}

/** Deterministic rotation across active variants of one language. */
export function pickTemplate(templates = [], call_sid = "") {
  const usable = templates
    .filter((t) => t && t.is_active === true && clean(t.template_body) && clean(t.template_id))
    .filter((t) => !t.quarantine_state || t.quarantine_state === "active")
    .sort((a, b) => (a.fallback_rank ?? 0) - (b.fallback_rank ?? 0) || clean(a.template_id).localeCompare(clean(b.template_id)));
  if (!usable.length) return null;
  const h = crypto.createHash("sha256").update(clean(call_sid)).digest();
  return usable[h.readUInt32BE(0) % usable.length];
}

export function renderMissedCallTemplate(template, { agent_name } = {}) {
  const name = clean(agent_name) || clean(template?.agent_persona) || MISSED_CALL_DEFAULT_PERSONA;
  const body = clean(template?.template_body).replace(/\{\{\s*agent_name\s*\}\}/g, name);
  // Any placeholder we cannot fill means the copy is not sendable as written.
  if (!body || /\{\{[^}]*\}\}/.test(body)) return null;
  return body;
}

function mapContactabilityReason(result = {}) {
  const r = clean(result.detail_reason || result.reason).toLowerCase();
  if (r.includes("wrong")) return "wrong_number";
  if (r.includes("opt") || r.includes("stop")) return "opted_out";
  if (r.includes("dnc") || r.includes("do_not_contact")) return "do_not_contact";
  if (r.includes("unavailable") || r.includes("lookup")) return "lookup_failed";
  return "suppressed";
}

export function buildCallLogBody({ outcome, duration_seconds = 0, text = null }) {
  const dur = formatCallDuration(duration_seconds);
  if (outcome === CALL_OUTCOMES.ANSWERED) return `Call answered · ${dur} · forwarded to owner`;
  let tail = "auto-text pending";
  if (text?.status === "queued") tail = text.scheduled_label ? `auto-text queued for ${text.scheduled_label}` : "auto-text queued";
  else if (text?.status === "skipped") tail = `auto-text skipped (${SKIP_REASON_LABELS[text.reason] || text.reason})`;
  return `Missed call · ${dur} · ${tail}`;
}

const defaultDeps = {
  enqueueImpl: enqueueCanonicalOutboundSms,
  insertQueueImpl: insertSupabaseSendQueueRow,
  contactabilityImpl: evaluateCanonicalContactability,
  loadPropertyGeographyImpl: loadPropertyGeography,
  recordAlertImpl: async (alert) => {
    const { recordSystemAlert } = await import("@/lib/domain/alerts/system-alerts.js");
    return recordSystemAlert(alert);
  },
};

async function claimCallLog(supabase, row) {
  const { error } = await supabase.from("message_events").insert(row);
  if (!error) return { claimed: true };
  if (clean(error.code) === "23505" || /duplicate key/i.test(clean(error.message))) return { claimed: false, duplicate: true };
  throw error;
}

async function finalizeCallLog(supabase, key, patch) {
  try {
    const { error } = await supabase.from("message_events").update(patch).eq("message_event_key", key);
    if (error) throw error;
    return true;
  } catch (err) {
    logger.error("missed_call.call_log_finalize_failed", { message_event_key: key, error: err?.message });
    return false;
  }
}

async function loadCallerContext(supabase, caller, now, cfg) {
  const since = minutesAgoIso(now, cfg.per_caller_hours * 60);
  const [stateRes, eventsRes, queueRes] = await Promise.all([
    supabase
      .from("inbox_thread_state")
      .select("thread_key,is_suppressed,paused_reason,last_inbound_at,last_outbound_at,property_id,master_owner_id,prospect_id,metadata")
      .eq("thread_key", caller)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("message_events")
      .select("id,direction,event_type,message_body,language,metadata,received_at,event_timestamp,created_at,master_owner_id,property_id,prospect_id")
      .eq("thread_key", caller)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("send_queue")
      .select("id,queue_status,use_case_template,created_at,sent_at,metadata")
      .eq("to_phone_number", caller)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  for (const res of [stateRes, eventsRes, queueRes]) {
    if (res?.error) throw res.error;
  }
  return {
    thread_state: stateRes?.data || null,
    events: Array.isArray(eventsRes?.data) ? eventsRes.data : [],
    queue_rows: Array.isArray(queueRes?.data) ? queueRes.data : [],
  };
}

/** Rate limit + conversation-activity gates. Pure; exported for tests. */
export function evaluateCadenceGates({ thread_state, events, queue_rows, now, cfg, call_sid }) {
  const nowMs = now.getTime();
  const rows = (queue_rows || []).filter((r) => clean(r?.metadata?.missed_call?.call_sid) !== clean(call_sid));

  if (rows.some((r) => clean(r.use_case_template).toLowerCase() === MISSED_CALL_USE_CASE)) {
    return { ok: false, reason: "missed_call_text_within_window" };
  }
  if (rows.some((r) => PENDING_QUEUE_STATUSES.has(clean(r.queue_status).toLowerCase()))) {
    return { ok: false, reason: "pending_outbound" };
  }
  const outboundCutoff = nowMs - cfg.recent_outbound_minutes * 60 * 1000;
  const recentConsumed = rows.some((r) => {
    if (!CONSUMED_QUEUE_STATUSES.has(clean(r.queue_status).toLowerCase())) return false;
    const t = ms(r.sent_at) ?? ms(r.created_at);
    return t !== null && t >= outboundCutoff;
  });
  const lastOutboundMs = ms(thread_state?.last_outbound_at);
  if (recentConsumed || (lastOutboundMs !== null && lastOutboundMs >= outboundCutoff)) {
    return { ok: false, reason: "recent_outbound" };
  }
  const activeCutoff = nowMs - cfg.active_conversation_minutes * 60 * 1000;
  const lastInboundMs = ms(thread_state?.last_inbound_at);
  const recentEvent = (events || []).some((e) => {
    const dir = clean(e.direction).toLowerCase();
    if (dir !== "inbound" && dir !== "outbound") return false; // call logs are not conversation
    const t = ms(e.event_timestamp) ?? ms(e.received_at) ?? ms(e.created_at);
    return t !== null && t >= activeCutoff;
  });
  if (recentEvent || (lastInboundMs !== null && lastInboundMs >= activeCutoff)) {
    return { ok: false, reason: "active_conversation" };
  }
  return { ok: true };
}

/**
 * @param {object} input
 * @param {string} input.call_sid
 * @param {string} input.caller        E.164 of the person who called
 * @param {string} input.called        our TextGrid number they dialled
 * @param {string} input.outcome       one of CALL_OUTCOMES
 * @param {number} [input.duration_seconds]
 * @param {object} [input.call_meta]   provider fields worth keeping (no secrets)
 * @param {object} deps  { supabase, getSystemValue, cfg, now, ...impl overrides }
 */
export async function processCallOutcome(input = {}, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const supabase = d.supabase;
  const cfg = d.cfg;
  const now = d.now ? new Date(d.now) : new Date();
  const call_sid = clean(input.call_sid);
  const caller = normalizePhone(input.caller);
  const called = normalizePhone(input.called);
  const outcome = clean(input.outcome);
  const duration_seconds = Math.max(0, Number(input.duration_seconds) || 0);

  if (!supabase?.from || !cfg) return { ok: false, reason: "missing_dependencies" };
  if (!call_sid) return { ok: false, reason: "missing_call_sid" };
  if (!called) return { ok: false, reason: "missing_called_number" };

  // Withheld / anonymous caller ID: there is no thread and no one to text.
  if (!caller) {
    logger.info("missed_call.no_caller_id", { call_sid, outcome });
    return { ok: true, logged: false, text: { status: "skipped", reason: "caller_id_unavailable" } };
  }

  const message_event_key = `call_${call_sid}`;
  const is_missed = MISSED_OUTCOMES.has(outcome);
  const nowIso = now.toISOString();
  const base_meta = {
    source: "textgrid_voice_webhook",
    call: {
      call_sid,
      caller,
      called,
      outcome,
      duration_seconds,
      ...(input.call_meta && typeof input.call_meta === "object" ? input.call_meta : {}),
    },
  };

  // 1. CLAIM. The unique key is the idempotency boundary for log AND text.
  // System rows use outbound orientation (from = our line, to = caller) so
  // every thread-identity fallback resolves to the caller; the true call
  // direction lives in metadata.call.
  const claim = await claimCallLog(supabase, {
    message_event_key,
    direction: "system",
    event_type: is_missed ? "missed_call" : "answered_call",
    message_body: buildCallLogBody({ outcome, duration_seconds }),
    from_phone_number: called,
    to_phone_number: caller,
    thread_key: caller,
    received_at: nowIso,
    event_timestamp: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
    metadata: { ...base_meta, missed_call_autotext: is_missed ? { status: "processing" } : null },
  });
  if (!claim.claimed) {
    return { ok: true, duplicate: true, message_event_key };
  }

  if (!is_missed) {
    return { ok: true, logged: true, message_event_key, text: null };
  }

  const text = await decideAndQueueText({ call_sid, caller, called, now, cfg, d, supabase });

  const { context = null, ...text_public } = text;
  const patch = {
    message_body: buildCallLogBody({ outcome, duration_seconds, text: text_public }),
    updated_at: new Date().toISOString(),
    metadata: { ...base_meta, missed_call_autotext: text_public },
    ...(context?.master_owner_id ? { master_owner_id: context.master_owner_id } : {}),
    ...(context?.property_id ? { property_id: context.property_id } : {}),
    ...(context?.prospect_id ? { prospect_id: context.prospect_id } : {}),
  };
  await finalizeCallLog(supabase, message_event_key, patch);

  return { ok: true, logged: true, message_event_key, text: text_public };
}

async function decideAndQueueText({ call_sid, caller, called, now, cfg, d, supabase }) {
  const skip = (reason, extra = {}) => ({ status: "skipped", reason, decided_at: now.toISOString(), ...extra });

  if (caller === called) return skip("caller_is_our_number");

  // Operator switch (env ceiling was checked by the route).
  if (!(await isMissedCallAutotextSwitchOn(d.getSystemValue))) return skip("autotext_disabled");

  // Runtime brakes: emergency stop + queue_processor_mode, fail-closed.
  let settings;
  try {
    settings = {
      queue_processor_mode: await d.getSystemValue("queue_processor_mode"),
      queue_emergency_stop_at: await d.getSystemValue("queue_emergency_stop_at"),
    };
  } catch {
    return skip("lookup_failed");
  }
  const brakes = evaluateQueueSendRuntimeBrakes(settings, { action: "missed_call_autotext", failClosed: true });
  if (!brakes.ok) return skip("sending_paused", { brake: brakes.reason });

  // Context (thread state, recent events, recent queue rows). Fail closed.
  let ctx;
  try {
    ctx = await loadCallerContext(supabase, caller, now, cfg);
  } catch (err) {
    logger.warn("missed_call.context_lookup_failed", { call_sid, error: err?.message });
    return skip("lookup_failed");
  }
  const latest = ctx.events.find((e) => e.master_owner_id || e.property_id || e.prospect_id) || {};
  const context = {
    master_owner_id: ctx.thread_state?.master_owner_id || latest.master_owner_id || null,
    property_id: ctx.thread_state?.property_id || latest.property_id || null,
    prospect_id: ctx.thread_state?.prospect_id || latest.prospect_id || null,
  };

  if (ctx.thread_state?.is_suppressed === true) return skip("suppressed", { context });
  if (clean(ctx.thread_state?.paused_reason)) return skip("thread_paused", { context });

  // Suppression / opt-out / wrong-number / own DNC — the canonical evaluator.
  let contact;
  try {
    contact = await d.contactabilityImpl(
      {
        thread_key: caller,
        to_phone_number: caller,
        from_phone_number: called,
        master_owner_id: context.master_owner_id,
        prospect_id: context.prospect_id,
        fail_closed_for_automated: true,
        contact_check_mode: CONTACT_CHECK_MODES.ENQUEUE,
      },
      { supabase },
    );
  } catch {
    return skip("lookup_failed", { context });
  }
  if (contact?.blocked) return skip(mapContactabilityReason(contact), { context, contactability: contact.reason || null });

  const cadence = evaluateCadenceGates({ ...ctx, now, cfg, call_sid });
  if (!cadence.ok) return skip(cadence.reason, { context });

  // Language + template.
  const { language, basis: language_basis } = resolveCallerLanguage(ctx);
  let templates = [];
  try {
    const { data, error } = await supabase
      .from("sms_templates")
      .select("template_id,template_body,language,agent_persona,is_active,quarantine_state,fallback_rank,use_case")
      .eq("use_case", MISSED_CALL_USE_CASE)
      .eq("language", language)
      .eq("is_active", true);
    if (error) throw error;
    templates = Array.isArray(data) ? data : [];
  } catch {
    return skip("lookup_failed", { context, language, language_basis });
  }
  const template = pickTemplate(templates, call_sid);
  const body = template ? renderMissedCallTemplate(template) : null;
  if (!template || !body) {
    try {
      await d.recordAlertImpl({
        subsystem: "missed_call_autotext",
        code: "missed_call_template_missing",
        severity: "warning",
        summary: `No active, renderable missed_call template for ${language}; the missed-call text was not sent.`,
        dedupe_key: `missed_call_template_missing:${language}`,
        metadata: { language, call_sid },
      });
    } catch {
      // Alerting must never turn a skip into a send or a 5xx.
    }
    return skip("template_missing", { context, language, language_basis });
  }

  // Window in the CALLER's zone.
  let timezone = null;
  let timezone_basis = "unknown";
  if (context.property_id) {
    try {
      const geo = await d.loadPropertyGeographyImpl(supabase, [context.property_id]);
      const tz = resolveRecipientTimezone({}, { propertyGeography: geo.get(clean(context.property_id)) || null });
      if (tz.ok) {
        timezone = tz.iana;
        timezone_basis = tz.basis;
      }
    } catch {
      // Unknown zone falls through to the all-US intersection below.
    }
  }
  const plan = planMissedCallSendTime({ now, timezone });
  if (!plan.scheduled_for) return skip("window_unresolved", { context, language });
  // The row's zone is what the dispatcher re-checks. For an unplaced caller we
  // store Los Angeles: the plan already put the send inside every US zone's
  // window, and Pacific is the zone that opens last.
  const row_timezone = timezone || "America/Los_Angeles";
  const scheduled_label = plan.send_now ? null : formatLocalTime(plan.scheduled_for, timezone || "America/New_York");

  const template_id = clean(template.template_id);
  const enq = await d.enqueueImpl(
    {
      thread_key: caller,
      to_phone_number: caller,
      from_phone_number: called, // the SAME line they called
      message_body: body,
      source_event_id: `call:${call_sid}`,
      stage: "missed_call",
      template_id,
      use_case: MISSED_CALL_USE_CASE,
      language,
      require_language: true,
      idempotency_key: `missed_call:${call_sid}`,
      dedupe_key: `missed_call:${call_sid}`,
      queue_key: `missed_call:${call_sid}`,
      queue_status: "queued",
      message_type: "missed_call_autotext",
      action_type: "missed_call_autotext",
      scheduled_for: plan.scheduled_for,
      timezone: row_timezone,
      contact_window_start_hour: 8,
      contact_window_end_hour: 21,
      master_owner_id: context.master_owner_id,
      property_id: context.property_id,
      metadata: {
        template_source: "sms_templates",
        agent_persona: clean(template.agent_persona) || MISSED_CALL_DEFAULT_PERSONA,
        language_basis,
        timezone_basis: timezone ? timezone_basis : plan.basis,
        missed_call: { call_sid, caller, called },
      },
    },
    {
      supabase,
      getSystemValue: d.getSystemValue,
      // Additive wrapper: the canonical writer keeps template_id in metadata
      // only; KPIs join on the send_queue.template_id COLUMN, so stamp it.
      insertQueueImpl: (payload, deps2) =>
        d.insertQueueImpl({ ...payload, template_id, prospect_id: context.prospect_id || null }, deps2),
    },
  );

  if (!enq?.ok) {
    return skip(enq?.reason === "idempotency_blocked" ? "pending_outbound" : "queue_rejected", {
      context,
      queue_reason: enq?.reason || null,
      language,
      template_id,
    });
  }

  return {
    status: "queued",
    reason: plan.send_now ? "inside_window" : "deferred_to_window_open",
    decided_at: now.toISOString(),
    queue_row_id: enq.queue_row_id || null,
    scheduled_for: enq.scheduled_for || plan.scheduled_for,
    scheduled_label,
    timezone: row_timezone,
    timezone_basis: timezone ? timezone_basis : plan.basis,
    template_id,
    language,
    language_basis,
    context,
  };
}

export default { processCallOutcome, CALL_OUTCOMES };

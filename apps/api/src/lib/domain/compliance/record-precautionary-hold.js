// ─── record-precautionary-hold.js ───────────────────────────────────────────
// P0 2026-10-19 FAIL-SAFE writer. An inbound that MAY be an opt-out (a stop /
// remove / contact-negation family token in a non-English message, with no
// confident family; classify.js PRECAUTIONARY_HOLD_DECISION) blocks ALL
// outbound to that phone until a person decides. The block is the existing
// suppression-permission mechanism: an active automation_suppressions row,
// suppression_type precautionary_no_contact, no expiry. Every reader already
// honours it:
//   send-time contact guard (send-time-contact-guard.js — any active type),
//   block-send-at-compliance / evaluate-canonical-contactability,
//   campaign enqueue (enqueue-campaign-target-one.js) and the campaign graph
//     (they read expires_at only — so a RELEASE must set expires_at, see below),
//   the follow-up loader (no-response-followup.js precautionary_hold).
//
// One row per inbound event (dedupe_key precautionary_no_contact:<phone>:<event>),
// so a replayed webhook is idempotent and every uncertain message is audited.
// source_event_id is NOT set: that column references automation_events(id),
// and an inbound message_events id is not one — it rides in payload instead.
//
// FAIL CLOSED: the insert is retried; when every attempt fails a critical
// compliance alert is raised and ok:false is returned (the caller already held
// every pending send for the thread, so nothing goes out on this turn).
//
// Operator release (after reading the thread): set status = 'released' AND
// expires_at = now() on the row (both — enqueue and the graph read expires_at).
// An explicit opt-out found on review goes through record-phone-suppression.js.

import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";

export const PRECAUTIONARY_HOLD_TYPE = "precautionary_no_contact";
export const PRECAUTIONARY_HOLD_REASON = "possible_opt_out_unconfirmed";
export const PRECAUTIONARY_HOLD_MAX_ATTEMPTS = 3;

const clean = (v) => String(v ?? "").trim();

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultAlert(payload) {
  try {
    const { emitNotificationFromBusinessEvent } = await import("@/lib/domain/notifications/notification-emitter.js");
    return await emitNotificationFromBusinessEvent({
      eventType: "compliance_suppression_write_failed",
      participantId: payload.thread_key || payload.phone_e164,
      sourceEntityType: "thread",
      sourceEntityId: payload.thread_key || payload.phone_e164,
      titleVars: { thread_key: payload.thread_key || payload.phone_e164 },
      description: `Precautionary no-contact hold for ${payload.phone_e164} (possible opt-out, operator review) could not be written: ${payload.error}. Pending sends for the thread were held; a person must review the thread now.`,
      metrics: payload,
    });
  } catch (error) {
    return { ok: false, reason: error?.message || "alert_failed" };
  }
}

async function runInsert(query) {
  const selected = typeof query?.select === "function" ? query.select("id") : query;
  const result = typeof selected?.maybeSingle === "function" ? await selected.maybeSingle() : await selected;
  if (result?.error) throw result.error;
  return result;
}

/**
 * @param {object} args
 * @param {object} args.supabase
 * @param {string} args.phone           any US phone form; stored as +1E.164
 * @param {string} [args.threadKey]
 * @param {string} [args.inboundEventId]
 * @param {object} [args.evidence]      { rule_id, language, token, version } from classify possible_opt_out
 * @param {object} [deps]               { sleep, alert, maxAttempts, now }
 */
export async function recordPrecautionaryNoContactHold(
  { supabase, phone, threadKey = null, inboundEventId = null, evidence = null } = {},
  deps = {},
) {
  const phone_e164 = normalizeUsPhoneToE164(phone) || clean(phone);
  if (!supabase || !phone_e164) return { ok: false, fail_closed: true, reason: "missing_supabase_or_phone", phone_number: phone_e164 || null };
  const sleep = deps.sleep || defaultSleep;
  const alert = deps.alert || defaultAlert;
  const maxAttempts = Math.max(1, Number(deps.maxAttempts) || PRECAUTIONARY_HOLD_MAX_ATTEMPTS);
  const event_key = clean(inboundEventId) || clean(deps.now) || new Date().toISOString();
  const row = {
    action_type: "suppress_phone",
    status: "active",
    suppression_type: PRECAUTIONARY_HOLD_TYPE,
    suppression_reason: PRECAUTIONARY_HOLD_REASON,
    dedupe_key: `${PRECAUTIONARY_HOLD_TYPE}:${phone_e164}:${event_key}`,
    conversation_thread_id: clean(threadKey) || phone_e164,
    phone_e164,
    expires_at: null,
    payload: {
      source: "inbound_possible_opt_out",
      requires_operator_review: true,
      inbound_event_id: clean(inboundEventId) || null,
      rule_id: evidence?.rule_id || null,
      language: evidence?.language || null,
      token: evidence?.token || null,
      detector_version: evidence?.version || null,
    },
  };
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runInsert(supabase.from("automation_suppressions").insert(row));
      return { ok: true, held: true, phone_number: phone_e164, dedupe_key: row.dedupe_key, attempts: attempt };
    } catch (error) {
      // the same inbound already wrote its hold (webhook replay): held
      if (/duplicate|unique|23505/i.test(String(error?.message || error?.code || error || ""))) {
        return { ok: true, held: true, duplicate: true, phone_number: phone_e164, dedupe_key: row.dedupe_key, attempts: attempt };
      }
      lastError = error;
      if (attempt < maxAttempts) await sleep(150 * attempt);
    }
  }
  const errorMessage = lastError?.message || String(lastError || "precautionary_hold_write_failed");
  const alert_result = await alert({ phone_e164, thread_key: clean(threadKey) || null, reason: PRECAUTIONARY_HOLD_REASON, error: errorMessage, evidence });
  return { ok: false, fail_closed: true, held: false, reason: "precautionary_hold_failed", error: errorMessage, phone_number: phone_e164, attempts: maxAttempts, alerted: Boolean(alert_result?.ok) };
}

export default recordPrecautionaryNoContactHold;

// ─── record-phone-suppression.js ─────────────────────────────────────────────
// THE one writer of a phone-level opt-out into sms_suppression_list — the list
// campaign eligibility (enqueue-campaign-target-one.js "Compliance"), the
// campaign target graph and the send-time guard (query-active-suppression.js)
// all read. FAIL CLOSED.
//
// Why (2026-10-06 audit, read-only): of 72 inbound opt-outs since 09-25, two
// ("Please don't bother" +12146297434, "Stop" +18133409070) left NO list row.
// Both threads emitted AUTOMATION_BLOCKED but no SUPPRESSION_APPLIED, i.e.
// applyInboundSuppression's upsert returned an error that was caught, logged
// with warn() and dropped: no retry, no alert, nothing blocking the number.
// Every other opt-out writer was worse — they could NEVER succeed:
//   unknown-inbound-router  upsert named columns the table does not have
//                           (opt_out_keyword, metadata, updated_at), omitted the
//                           NOT NULL suppression_type, and used onConflict
//                           "phone_e164" with no matching unique index;
//   discord opt-out/suppress insert omitted both NOT NULL columns (phone_e164,
//                           suppression_type); the opt-out one also swallowed the
//                           error with .catch(() => null).
// Prod has zero list rows from either source.
//
// Contract:
//   1. upsert the phone-scoped row (sender_phone_e164 NULL — every sender; the
//      unique index is NULLS NOT DISTINCT, so it is idempotent), retrying;
//   2. if every attempt fails: write a durable fallback block to
//      automation_suppressions (no expiry). Enqueue, the graph and the send-time
//      guard all read it, so the number is blocked even though the list write
//      failed;
//   3. raise a CRITICAL compliance alert (compliance_suppression_write_failed);
//   4. return ok:false, fail_closed:true — the caller must not report success.

import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";

function clean(value) {
  return String(value ?? "").trim();
}

export const SUPPRESSION_WRITE_MAX_ATTEMPTS = 3;
export const SUPPRESSION_FALLBACK_REASON = "sms_suppression_list_write_failed";

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultAlert(payload) {
  try {
    const { emitNotificationFromBusinessEvent } = await import(
      "@/lib/domain/notifications/notification-emitter.js"
    );
    return await emitNotificationFromBusinessEvent({
      eventType: "compliance_suppression_write_failed",
      participantId: payload.thread_key || payload.phone_e164,
      sourceEntityType: "thread",
      sourceEntityId: payload.thread_key || payload.phone_e164,
      titleVars: { thread_key: payload.thread_key || payload.phone_e164 },
      description: `Opt-out for ${payload.phone_e164} could not be written to sms_suppression_list: ${payload.error}. Fallback block: ${payload.fallback_block ? "written" : "FAILED"}.`,
      metrics: payload,
    });
  } catch (error) {
    return { ok: false, reason: error?.message || "alert_failed" };
  }
}

async function runWrite(query) {
  // PostgREST reports failures by RETURN VALUE; a thrown error is also a failure.
  const selected = typeof query?.select === "function" ? query.select("id") : query;
  const result = typeof selected?.maybeSingle === "function" ? await selected.maybeSingle() : await selected;
  if (result?.error) throw result.error;
  return result;
}

/**
 * @param {object} args
 * @param {object} args.supabase
 * @param {string} args.phone        any US phone form; stored as +1E.164
 * @param {string} [args.reason]     suppression_type / reason ("opt_out" default)
 * @param {string} [args.source]     who recorded it (inbound_opt_out, discord_…)
 * @param {string} [args.threadKey]
 * @param {string} [args.sourceEventId]
 * @param {object} [args.extra]      extra REAL columns (e.g. suppressed_by_discord_user_id)
 * @param {object} [deps]            { sleep, alert, maxAttempts, now }
 */
export async function recordPhoneSuppression(
  { supabase, phone, reason = "opt_out", source = "inbound_opt_out", threadKey = null, sourceEventId = null, extra = {} } = {},
  deps = {},
) {
  const phone_e164 = normalizeUsPhoneToE164(phone) || clean(phone);
  if (!supabase || !phone_e164) {
    return { ok: false, fail_closed: true, reason: "missing_supabase_or_phone", phone_number: phone_e164 || null };
  }
  const sleep = deps.sleep || defaultSleep;
  const alert = deps.alert || defaultAlert;
  const maxAttempts = Math.max(1, Number(deps.maxAttempts) || SUPPRESSION_WRITE_MAX_ATTEMPTS);
  const nowIso = deps.now || new Date().toISOString();
  const type = clean(reason) || "opt_out";

  const row = {
    ...extra,
    phone_e164,
    sender_phone_e164: null,
    phone_number: phone_e164,
    suppression_type: type,
    suppression_reason: type,
    reason: type,
    is_active: true,
    suppressed_at: nowIso,
    source: clean(source) || "inbound_opt_out",
  };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runWrite(
        supabase
          .from("sms_suppression_list")
          .upsert(row, { onConflict: "phone_e164,sender_phone_e164", ignoreDuplicates: false }),
      );
      return { ok: true, reason: type, phone_number: phone_e164, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(150 * attempt);
    }
  }

  // ── fail closed ───────────────────────────────────────────────────────────
  const errorMessage = lastError?.message || String(lastError || "suppression_write_failed");
  let fallback_block = false;
  let fallback_error = null;
  try {
    await runWrite(
      supabase.from("automation_suppressions").insert({
        action_type: "suppress_phone",
        status: "active",
        suppression_type: type,
        suppression_reason: SUPPRESSION_FALLBACK_REASON,
        dedupe_key: `${SUPPRESSION_FALLBACK_REASON}:${phone_e164}`,
        conversation_thread_id: clean(threadKey) || phone_e164,
        phone_e164,
        source_event_id: clean(sourceEventId) || null,
        expires_at: null,
        error_message: errorMessage.slice(0, 500),
        payload: { source: row.source, reason: type, attempts: maxAttempts },
      }),
    );
    fallback_block = true;
  } catch (error) {
    // A duplicate dedupe key means an earlier failure already blocked the number.
    const message = String(error?.message || error || "");
    if (/duplicate|unique/i.test(message)) fallback_block = true;
    else fallback_error = message || "fallback_block_failed";
  }

  const alert_result = await alert({
    phone_e164,
    thread_key: clean(threadKey) || null,
    reason: type,
    source: row.source,
    error: errorMessage,
    fallback_block,
    fallback_error,
  });

  return {
    ok: false,
    fail_closed: true,
    reason: "suppression_failed",
    error: errorMessage,
    phone_number: phone_e164,
    attempts: maxAttempts,
    fallback_block,
    fallback_error,
    alerted: Boolean(alert_result?.ok),
  };
}

export default recordPhoneSuppression;

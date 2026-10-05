// TextGrid (Twilio-compatible) voice webhook — transport-agnostic handler.
//
// One URL, three phases (the phase rides in the query string, which is part of
// the signed URL, so it cannot be altered in flight):
//   (none) / incoming   Voice URL on the number. Forward to the owner, or play
//                       a short prompt and treat the call as missed.
//   dial_complete       <Dial action>. DialCallStatus tells us whether the
//                       owner picked up.
//   status              Call status callback. Safety net only: a terminal
//                       non-answer status that never reached dial_complete is
//                       processed here; everything else is acknowledged.
//
// AUTH FAILS CLOSED. Only a request whose signature VERIFIES is acted on. The
// shared verifier's softer outcomes — no secrets configured, observe mode, mode
// off — are all treated as unauthenticated here, because this route can cause
// an outbound text.

import { child } from "@/lib/logging/logger.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import {
  verifyTextgridWebhookRequest,
  buildCanonicalWebhookUrl,
} from "@/lib/webhooks/textgrid-verify-webhook.js";
import { readMissedCallEnv } from "@/lib/domain/calls/missed-call-config.js";
import {
  twimlReject,
  twimlHangup,
  twimlSayThenHangup,
  twimlDialForward,
  twimlEmpty,
} from "@/lib/domain/calls/voice-twiml.js";
import { processCallOutcome, CALL_OUTCOMES } from "@/lib/domain/calls/process-missed-call.js";

const logger = child({ module: "domain.calls.voice_webhook" });

export const VOICE_PHASES = Object.freeze({
  INCOMING: "incoming",
  DIAL_COMPLETE: "dial_complete",
  STATUS: "status",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function parseFormBody(raw_body = "") {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(raw_body ?? ""))) out[k] = v;
  return out;
}

export function signatureFromHeaders(headers) {
  const get = (name) => clean(headers?.get?.(name));
  const textgrid = get("x-textgrid-signature");
  const twilio = get("x-twilio-signature");
  const generic = get("x-signature");
  if (textgrid) return { signature: textgrid, header: "x-textgrid-signature" };
  if (twilio) return { signature: twilio, header: "x-twilio-signature" };
  if (generic) return { signature: generic, header: "x-signature" };
  return { signature: "", header: null };
}

/** Maps a Dial / call status to our outcome vocabulary. */
export function outcomeFromDialStatus(status, duration_seconds = 0) {
  const s = lower(status);
  if (s === "completed" || s === "answered") {
    return Number(duration_seconds) > 0 || s === "answered" ? CALL_OUTCOMES.ANSWERED : CALL_OUTCOMES.NO_ANSWER;
  }
  if (s === "busy") return CALL_OUTCOMES.BUSY;
  if (s === "failed") return CALL_OUTCOMES.FAILED;
  if (s === "canceled" || s === "cancelled") return CALL_OUTCOMES.CANCELED;
  return CALL_OUTCOMES.NO_ANSWER; // "no-answer" and anything unrecognised
}

function withPhase(canonical_url, phase) {
  try {
    const u = new URL(canonical_url);
    u.search = "";
    u.searchParams.set("phase", phase);
    return u.toString();
  } catch {
    return null;
  }
}

function xml(status, body) {
  return { status, kind: "twiml", body };
}

/**
 * @param {object} req  { url, raw_body, content_type, headers }
 * @param {object} deps { env, supabase, getSystemValue, now, verifyImpl, processImpl, ...processCallOutcome deps }
 * @returns {Promise<{status:number, kind:'twiml'|'text', body:string, result?:object}>}
 */
export async function handleVoiceWebhook(req = {}, deps = {}) {
  const env = deps.env || process.env;
  const cfg = readMissedCallEnv(env);
  const verifyImpl = deps.verifyImpl || verifyTextgridWebhookRequest;
  const processImpl = deps.processImpl || processCallOutcome;

  const content_type = lower(req.content_type);
  const raw_body = String(req.raw_body ?? "");
  const form = content_type.includes("application/x-www-form-urlencoded") ? parseFormBody(raw_body) : null;
  const { signature, header } = signatureFromHeaders(req.headers);

  // 1. AUTH — fail closed on anything short of a verified signature.
  let verification;
  try {
    verification = verifyImpl({
      request_url: req.url,
      raw_body,
      form_params: form,
      content_type,
      signature,
      signature_header_name: header,
    });
  } catch {
    verification = { verified: false, reason: "verifier_error" };
  }
  if (verification?.verified !== true) {
    logger.warn("voice_webhook.unauthenticated", { reason: verification?.reason || "unverified", header });
    return { status: 401, kind: "text", body: "unauthorized" };
  }
  if (!form) {
    return { status: 415, kind: "text", body: "unsupported_media_type" };
  }

  // 2. ENV CEILING — off means busy and zero side effects.
  if (!cfg.enabled) {
    return xml(200, twimlReject("busy"));
  }

  const phase = lower(new URL(req.url, "https://placeholder.invalid").searchParams.get("phase")) || VOICE_PHASES.INCOMING;
  const call_sid = clean(form.CallSid);
  const caller = normalizePhone(form.From || form.Caller);
  const called = normalizePhone(form.To || form.Called);
  if (!call_sid || !called) {
    return xml(200, twimlHangup());
  }

  const runOutcome = (outcome, duration_seconds, call_meta) =>
    processImpl(
      { call_sid, caller, called, outcome, duration_seconds, call_meta },
      {
        supabase: deps.supabase,
        getSystemValue: deps.getSystemValue,
        cfg,
        now: deps.now,
        ...(deps.processDeps || {}),
      },
    ).catch((err) => {
      // Never fail the call over our bookkeeping; the claim row makes a retry safe.
      logger.error("voice_webhook.process_failed", { call_sid, error: err?.message });
      return { ok: false, reason: "process_error" };
    });

  if (phase === VOICE_PHASES.DIAL_COMPLETE) {
    const dial_status = clean(form.DialCallStatus);
    const duration = Number(form.DialCallDuration) || 0;
    const outcome = outcomeFromDialStatus(dial_status, duration);
    const result = await runOutcome(outcome, outcome === CALL_OUTCOMES.ANSWERED ? duration : 0, {
      phase,
      dial_status: dial_status || null,
      forwarded: true,
    });
    if (outcome === CALL_OUTCOMES.ANSWERED) return { ...xml(200, twimlHangup()), result };
    return { ...xml(200, twimlSayThenHangup()), result };
  }

  if (phase === VOICE_PHASES.STATUS) {
    const call_status = lower(form.CallStatus);
    if (["no-answer", "busy", "failed", "canceled"].includes(call_status)) {
      const result = await runOutcome(outcomeFromDialStatus(call_status), 0, { phase, call_status, forwarded: false });
      return { ...xml(200, twimlEmpty()), result };
    }
    return xml(200, twimlEmpty());
  }

  // INCOMING.
  if (cfg.forward_number && cfg.forward_number !== caller && cfg.forward_number !== called) {
    const action_url = withPhase(buildCanonicalWebhookUrl(req.url), VOICE_PHASES.DIAL_COMPLETE);
    if (action_url) {
      return xml(
        200,
        twimlDialForward({
          forward_number: cfg.forward_number,
          timeout_seconds: cfg.forward_timeout_seconds,
          action_url,
          caller_id: called,
        }),
      );
    }
  }
  if (cfg.forward_number_invalid) {
    logger.warn("voice_webhook.forward_number_invalid", { call_sid });
  }
  // No forward: polite prompt, hang up, and treat the call as missed.
  const result = await runOutcome(CALL_OUTCOMES.NOT_FORWARDED, 0, { phase, forwarded: false });
  return { ...xml(200, twimlSayThenHangup()), result };
}

export default { handleVoiceWebhook, VOICE_PHASES };

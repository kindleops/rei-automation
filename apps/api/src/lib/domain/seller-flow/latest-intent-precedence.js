// ─── latest-intent-precedence.js ─────────────────────────────────────────────
// Latest-clear-intent precedence: the newest unambiguous seller intent may
// supersede stale historical state ("Not interested." … months later …
// "Are you still interested in buying?"). This module decides, deterministically
// and with evidence, when a new inbound REOPENS a conversation:
//
//   * re-engagement is detected from the classification and/or explicit
//     re-engagement text patterns (the current classifier has no re_engagement
//     label — the patterns here are the live detector);
//   * supersession requires BOTH a positive "latest" signal AND stale negative
//     prior state — a first-touch positive reply is normal flow, not
//     supersession;
//   * only SOFT suppression may ever be cleared. A legally binding opt-out
//     (stop/unsubscribe), wrong number, DNC, or provider blacklist is never
//     cleared by inbound text — a positive message after a binding opt-out is
//     routed to human review (seller_initiated_after_stop).
//
// Pure decision logic + one explicitly-bounded side effect helper
// (releaseSoftSuppressions). Version every decision for audit.

import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";

export const LATEST_INTENT_PRECEDENCE_VERSION = "latest_intent_precedence_v1";

// Suppression reasons that inbound re-engagement may clear.
export const SOFT_SUPPRESSION_REASONS = Object.freeze(
  new Set(["not_interested", "no_response", "need_time", "stale", "nurture", "soft_close"])
);

// Suppression reasons that only an operator may ever clear.
//
// THE canonical set. seller-flow-decision-contract.js imports this rather than
// keeping its own copy: the two lists had drifted apart in BOTH directions, so
// a reason could be binding for release purposes but produce no contactability
// at all when the decision was built (or the reverse).
export const BINDING_SUPPRESSION_REASONS = Object.freeze(
  new Set([
    "opt_out",
    "stop",
    "unsubscribe",
    "dnc",
    "do_not_contact",
    "do_not_text",
    "wrong_number",
    "wrong_person",
    "invalid_number",
    "provider_blacklisted",
    "hostile_or_legal",
    "legal_threat",
    "compliance",
    // Merged in from the decision contract's former private duplicate. These
    // are execution-layer synonyms for the same binding conditions; treating
    // them as binding only ever makes a release MORE conservative.
    "legal",
    "legal_prohibition",
    "compliance_prohibition",
    "manual_operator_suppression",
    "suppression_list",
  ])
);

const POSITIVE_INTENTS = Object.freeze(
  new Set([
    "seller_interested",
    "asks_offer",
    "asking_price_provided",
    "latent_interest",
    "callback_requested",
  ])
);

const HOT_INTENTS = Object.freeze(new Set(["asks_offer", "asking_price_provided"]));

const NEGATIVE_PRIOR_DISPOSITIONS = Object.freeze(
  new Set(["not_interested", "no_response", "unqualified"])
);

// Explicit re-engagement phrasings — English and Spanish. These are the
// detector for the ontology's re_engagement / changed_mind /
// asks_buyer_still_interested intents until classify.js grows native labels.
const RE_ENGAGEMENT_PATTERNS = Object.freeze([
  /\bstill\s+(interested|buying|buy|want|looking|offering)\b/i,
  /\b(are|r)\s*(you|u)\s+still\b/i,
  /\bchanged?\s+(my|our)\s+mind\b/i,
  /\b(offer|deal|price)\s+still\s+(good|stand|stands|on|available)\b/i,
  /\bstill\s+on\s+the\s+table\b/i,
  /\breconsider(ing|ed)?\b/i,
  /\b(might|may|ready\s+to|thinking\s+(about|of))\s+sell(ing)?\b/i,
  /\bis\s+(the\s+)?(offer|deal)\s+still\b/i,
  /\b(circumstances|things|situation)\s+(have|has)?\s*changed\b/i,
  /\bwhat\s+(could|would|can)\s+you\s+(pay|offer|give)\b/i,
  /\btodav[ií]a\s+(le\s+)?interesa\b/i,
  /\bsigue[sn]?\s+(interesad|comprando)\w*/i,
  /\bcambi[eé]\s+de\s+opini[oó]n\b/i,
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function matchReEngagementPatterns(message_body = "") {
  const body = clean(message_body);
  if (!body) return { matched: false, evidence: null };
  for (const pattern of RE_ENGAGEMENT_PATTERNS) {
    const match = body.match(pattern);
    if (match) return { matched: true, evidence: match[0] };
  }
  return { matched: false, evidence: null };
}

// Full subscriber numbers are PII: log a masked form (country code + area
// code prefix) only.
function maskPhoneForLog(value = "") {
  const normalized = clean(value);
  return normalized.length >= 5 ? `${normalized.slice(0, 5)}***` : "***";
}

function classifySuppressionReason(reason) {
  const normalized = lower(reason);
  if (!normalized) return "unknown";
  if (BINDING_SUPPRESSION_REASONS.has(normalized)) return "binding";
  if (SOFT_SUPPRESSION_REASONS.has(normalized)) return "soft";
  return "unknown";
}

/**
 * Resolve prior thread state for precedence evaluation — the ONE extraction
 * every call site must share. The live inbound path passes the loaded thread
 * context object whose prior state lives under `.summary`
 * (process-seller-inbound-message.js passes `latestThreadContext: context`);
 * `context.summary` covers callers that only pass `context`; a FLAT
 * latestThreadContext (replay engine, older harnesses) is the compatibility
 * fallback. The send-time staleness comparison is centralized here so a
 * delayed/replayed message is judged identically everywhere.
 */
export function resolvePriorThreadState({
  latestThreadContext = null,
  context = null,
  inboundReceivedAt = null,
} = {}) {
  const summary =
    latestThreadContext?.summary || context?.summary || latestThreadContext || {};
  const prior_inbound_ts = Date.parse(summary.last_inbound_at || "");
  const message_ts = Date.parse(inboundReceivedAt || "");
  return {
    prior_state: {
      disposition: summary.disposition,
      last_intent: summary.last_intent,
      automation_paused:
        lower(summary.automation_status || summary.automation_state) === "paused",
      last_inbound_at: summary.last_inbound_at || null,
    },
    message_is_stale:
      Number.isFinite(prior_inbound_ts) &&
      Number.isFinite(message_ts) &&
      message_ts < prior_inbound_ts,
  };
}

/**
 * Decide whether the newest inbound supersedes stale prior state.
 *
 * @param {object} input
 * @param {object} input.classification classify() result for the new message
 * @param {string} input.message_body raw newest inbound text
 * @param {object} input.prior_state { disposition, operational_status,
 *   lead_temperature, automation_paused, last_intent }
 * @param {Array}  input.active_suppressions [{ suppression_reason }] currently
 *   active for this phone/thread (empty when none)
 */
export function resolveLatestIntentPrecedence({
  classification = {},
  message_body = "",
  prior_state = {},
  active_suppressions = [],
  message_is_stale = false,
} = {}) {
  const decision = {
    version: LATEST_INTENT_PRECEDENCE_VERSION,
    re_engagement_detected: false,
    supersedes_prior_state: false,
    clear_soft_suppression: false,
    blocked_by_binding_suppression: false,
    human_review_required: false,
    // Chronology verdict, exposed explicitly (not only as a reason code) so the
    // single-writer merge can suppress a reopen INDEPENDENT of classifier
    // confidence. Staleness answers "may this message supersede the current
    // state?", which is separate from confidence ("how sure are we what it
    // means?"). A stale high-confidence positive stays stale.
    message_is_stale: message_is_stale === true,
    reason_codes: [],
    evidence: null,
    confidence: 0,
    state_patch: null,
  };

  const primary_intent = lower(classification.primary_intent || classification.detected_intent);
  const secondary = Array.isArray(classification.secondary)
    ? classification.secondary.map(lower)
    : Array.isArray(classification.secondary_intents)
      ? classification.secondary_intents.map(lower)
      : [];
  const confidence = Number(classification.confidence) || 0;
  const pattern = matchReEngagementPatterns(message_body);

  // Precedence is by SEND time, not arrival order. A message known to predate
  // the thread's newest recorded inbound (delayed provider delivery, replayed
  // webhook) can never supersede the newer state it arrives after.
  if (message_is_stale === true) {
    decision.reason_codes.push("stale_message_cannot_supersede");
    decision.re_engagement_detected = pattern.matched;
    decision.evidence = pattern.evidence;
    return decision;
  }

  // A new binding-negative message never re-engages, whatever the history —
  // with two carve-outs that stay locked shut on the automation side:
  //   * opt-out text that ALSO carries re-engagement phrasing ("I said stop
  //     but we're ready to sell") is a mixed signal: flagged as detected for
  //     the audit trail, but only a human may act on it;
  //   * a clear decline over a PRIOR POSITIVE state is a reversal — the
  //     newest intent supersedes the stale positive (latest-intent-wins runs
  //     in both directions), with automation pausing, never resuming.
  if (["opt_out", "wrong_number", "hostile_or_legal", "not_interested"].includes(primary_intent)) {
    if (primary_intent === "opt_out" && pattern.matched) {
      decision.re_engagement_detected = true;
      decision.human_review_required = true;
      decision.blocked_by_binding_suppression = true;
      decision.evidence = pattern.evidence;
      decision.confidence = confidence;
      decision.reason_codes.push("mixed_optout_reengagement_signal");
      return decision;
    }
    if (primary_intent === "not_interested") {
      const prior_positive =
        lower(prior_state.disposition) === "interested" ||
        POSITIVE_INTENTS.has(lower(prior_state.last_intent));
      if (prior_positive) {
        decision.supersedes_prior_state = true;
        decision.evidence = "reversal_over_prior_positive";
        decision.confidence = confidence;
        decision.reason_codes.push("reversal_supersedes_prior_positive");
        decision.state_patch = {
          disposition: "not_interested",
          operational_status: "paused",
          lead_temperature: "cold",
          automation: "pause",
          reopen_conversation: false,
          reversal: true,
        };
        return decision;
      }
    }
    decision.reason_codes.push(`latest_intent_${primary_intent || "unknown"}`);
    return decision;
  }

  const classifier_positive =
    POSITIVE_INTENTS.has(primary_intent) || secondary.some((s) => POSITIVE_INTENTS.has(s));

  if (!classifier_positive && !pattern.matched) {
    decision.reason_codes.push("no_positive_latest_signal");
    return decision;
  }

  decision.re_engagement_detected = pattern.matched || classifier_positive;
  decision.evidence = pattern.evidence || primary_intent || null;
  decision.confidence = Math.max(confidence, pattern.matched ? 0.7 : 0);
  decision.reason_codes.push(
    pattern.matched ? "re_engagement_pattern_matched" : "positive_classifier_intent"
  );

  // Suppression triage before any supersession claim.
  const suppression_classes = (active_suppressions || []).map((row) =>
    classifySuppressionReason(row?.suppression_reason ?? row?.reason ?? row)
  );
  const has_binding = suppression_classes.includes("binding");
  const has_unknown = suppression_classes.includes("unknown");
  const has_soft = suppression_classes.includes("soft");

  if (has_binding || has_unknown) {
    // Positive text after a binding (or unrecognized — fail closed) opt-out:
    // never auto-resume, never clear, always a human.
    decision.blocked_by_binding_suppression = true;
    decision.human_review_required = true;
    decision.supersedes_prior_state = false;
    decision.reason_codes.push(
      has_binding ? "binding_suppression_present" : "unknown_suppression_fail_closed"
    );
    return decision;
  }

  const prior_disposition = lower(prior_state.disposition);
  const prior_intent = lower(prior_state.last_intent);
  const stale_negative_prior =
    NEGATIVE_PRIOR_DISPOSITIONS.has(prior_disposition) ||
    prior_state.automation_paused === true ||
    prior_intent === "not_interested" ||
    // need_time is a seller-requested pause; an explicit positive follow-
    // through supersedes it and resumes the conversation.
    prior_intent === "need_time" ||
    has_soft;

  if (!stale_negative_prior) {
    // Positive message with no negative history: normal flow, nothing to
    // supersede.
    decision.reason_codes.push("no_stale_negative_prior_state");
    return decision;
  }

  decision.supersedes_prior_state = true;
  decision.clear_soft_suppression = has_soft;
  decision.reason_codes.push("stale_prior_state_superseded");

  const hot = HOT_INTENTS.has(primary_intent) || secondary.some((s) => HOT_INTENTS.has(s));
  decision.state_patch = {
    disposition: "interested",
    operational_status: "new_reply",
    lead_temperature: hot ? "hot" : "warm",
    automation: "continue",
    reopen_conversation: true,
    // A reopened thread must be answered in context (address what the seller
    // actually asked), never with a mechanical restart of the opener.
    contextual_reply_required: true,
  };

  return decision;
}

/**
 * Deactivate SOFT suppressions for a phone after a supersession decision.
 * Binding rows are never touched: the filter is allow-listed on the soft
 * reasons, not deny-listed on the binding ones.
 */
export async function releaseSoftSuppressions(
  { supabase, phone_number, decision, thread_key = null, message_event_id = null },
  logger = {}
) {
  // Lookups must match the writers byte-for-byte: applyInboundSuppression and
  // findActiveSmsSuppression both store/search normalizeUsPhoneToE164(phone)
  // with clean() only as the non-US fallback. A formatted inbound number
  // ("555-123-4567") must still hit the stored "+15551234567" row.
  const phone = normalizeUsPhoneToE164(phone_number) || clean(phone_number);
  if (!supabase || !phone) return { ok: false, reason: "missing_supabase_or_phone", released: 0 };
  if (decision?.clear_soft_suppression !== true || decision?.supersedes_prior_state !== true) {
    return { ok: true, released: 0, reason: "not_applicable" };
  }

  try {
    const { data, error } = await supabase
      .from("sms_suppression_list")
      .update({ is_active: false })
      .eq("phone_number", phone)
      .eq("is_active", true)
      .in("suppression_reason", [...SOFT_SUPPRESSION_REASONS])
      .select("id,suppression_reason");
    if (error) throw error;

    const released = data?.length || 0;
    if (released === 0) {
      // The decision claimed an active soft suppression exists (that is the
      // only path into a release), so updating zero rows means it was NOT
      // deactivated — format drift, a race, or a non-soft reason. Fail
      // closed: the caller must not reopen on an unreleased suppression.
      logger.warn?.("[LATEST_INTENT_SOFT_SUPPRESSION_RELEASE_MISSED]", {
        phone_number: maskPhoneForLog(phone),
        thread_key,
        message_event_id,
        version: decision.version,
      });
      return { ok: false, reason: "no_active_soft_suppression_released", released: 0 };
    }

    logger.info?.("[LATEST_INTENT_SOFT_SUPPRESSION_RELEASED]", {
      phone_number: maskPhoneForLog(phone),
      thread_key,
      message_event_id,
      released,
      reasons: data.map((row) => row.suppression_reason),
      version: decision.version,
    });
    return { ok: true, released };
  } catch (error) {
    logger.warn?.("[LATEST_INTENT_SOFT_SUPPRESSION_RELEASE_FAILED]", {
      phone_number: maskPhoneForLog(phone),
      error: error?.message || "release_failed",
    });
    // Fail safe: suppression stays in force.
    return { ok: false, reason: "release_failed", released: 0 };
  }
}

export default resolveLatestIntentPrecedence;

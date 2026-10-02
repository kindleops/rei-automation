/**
 * NEW REPLIES CLEANUP 7.2 — the pure planner behind the preview and the repair.
 *
 * Input: one thread currently in New Replies, its message history (oldest
 * first), and read-only facts around it (opportunity, contact candidates).
 * Output: a PLAN -- category, corrected classification, proposed state, the
 * follow-up and next-contact decisions, and why. Nothing here reads or writes
 * a database; the script (scripts/repairs/20261001_new_replies_cleanup.mjs)
 * does the I/O and, only with --apply after owner approval, executes a plan
 * through the canonical authorities.
 *
 * The classification is the LIVE one: classify() with heuristicOnly and a
 * conversation context rebuilt from OUR previous outbound, exactly as the
 * webhook builds it (build-conversation-context.js), so the preview shows what
 * production will do once this code ships, not a parallel opinion.
 */

import { classify, CLASSIFY_VERSION } from "@/lib/domain/classification/classify.js";
import { CONTEXT_VERSION } from "@/lib/domain/classification/conversation-context.js";
import { deriveUseCaseFromBody } from "@/lib/domain/classification/build-conversation-context.js";
import { describeLastQuestion } from "@/lib/domain/classification/last-question.js";
import {
  extractAddresseeName,
  extractSenderName,
  detectMessageLanguage,
  foldReplyText,
} from "@/lib/domain/classification/reply-disposition-signals.js";
import {
  linkReactionTarget,
  parsePlatformReaction,
  collapseReactionDuplicates,
  extractEmojis,
} from "@/lib/domain/classification/emoji-interpretation.js";
import {
  resolveNextContactAction,
  RESOLUTION_ACTION,
  normalizePhoneKey,
} from "@/lib/domain/seller-flow/contact-resolution-waterfall.js";

export const CLEANUP_SOURCE = "classifier_cleanup_20261001";
export const CLEANUP_VERSION = "new_replies_cleanup_v1";

/** Summary categories, in report order (7.2 brief + the extras the data needs). */
export const CLEANUP_CATEGORY = Object.freeze({
  KEEP: "KEEP AS GENUINE NEW REPLY",
  WRONG_PERSON: "WRONG PERSON",
  SOLD: "SOLD",
  NOT_INTERESTED: "NOT INTERESTED",
  NOT_FOR_SALE: "NOT FOR SALE",
  HOSTILE: "HOSTILE",
  EMOJI_CLARIFY: "EMOJI NEEDS CLARIFICATION",
  EMOJI_ACK: "EMOJI ACKNOWLEDGMENT",
  AUTO_REPLY: "AUTO-REPLY",
  CALL_REQUEST: "CALL REQUEST",
  LANGUAGE: "LANGUAGE",
  OTHER_AMBIGUOUS: "OTHER AMBIGUOUS",
  // Not in the brief's list but present in the data -- never hidden.
  OPT_OUT: "OPT-OUT (compliance)",
  TEXT_ACK: "ACKNOWLEDGMENT (text)",
  NOISE: "STRAY CHARACTER",
});

export const CATEGORY_ORDER = Object.freeze(Object.values(CLEANUP_CATEGORY));

const ENGAGEMENT_INTENTS = new Set([
  "who_is_this", "asks_offer", "seller_interested", "ownership_confirmed", "asking_price_provided",
  "asking_price_absent", "contract_requested", "condition_disclosed", "tenant_occupied", "info_request",
  "latent_interest", "voicemail_call_request", "requests_email", "going_to_market", "property_correction",
  "title_issue", "lien_tax_issue", "bankruptcy_disclosed", "trust_ownership", "llc_corporation",
]);

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();
const ts = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : 0;
};
// The EARLIEST of the row's timestamps. The July-01 backfill rewrote
// received_at / event_timestamp to the import time (2026-07-01) while
// created_at kept the real receipt time (late April / early May): ordering by
// received_at put a seller's answer two months after our question, made every
// such context stale, and could even put an answer AFTER a later question of
// ours. A live webhook row has received_at <= created_at, so it is unchanged.
const eventAt = (e) => {
  let best = null;
  for (const v of [e?.received_at, e?.sent_at, e?.created_at]) {
    const t = Date.parse(v || "");
    if (Number.isFinite(t) && (best === null || t < best.t)) best = { t, v };
  }
  return best ? best.v : null;
};

// ─── Redaction (the report never carries a phone, an email or a name) ────────

export function maskPhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : digits ? "•••" : null;
}

export function maskEmail(value) {
  const email = clean(value).toLowerCase();
  const at = email.indexOf("@");
  if (at < 1) return email ? "•••" : null;
  return `${email[0]}•••@${email.slice(at + 1).replace(/^[^.]+/, (d) => `${d[0]}•••`)}`;
}

// ─── Context: rebuilt from OUR previous outbound (message_events) ────────────

/**
 * Same contract the webhook builds (conversation_context_v1), from the
 * thread's message_events instead of send_queue, because the July backfill
 * rows have no send_queue history.
 */
export function buildThreadConversationContext({ thread = {}, events = [] } = {}) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((a, b) => ts(eventAt(a)) - ts(eventAt(b)));
  const inbounds = ordered.filter((e) => lower(e.direction) === "inbound");
  const latest_inbound = inbounds[inbounds.length - 1] || null;
  const latestAt = latest_inbound ? ts(eventAt(latest_inbound)) : ts(thread.last_inbound_at);
  const priorOutbounds = ordered.filter((e) => lower(e.direction) === "outbound" && ts(eventAt(e)) <= latestAt);
  const last_outbound = priorOutbounds[priorOutbounds.length - 1] || null;
  if (!last_outbound) return { context: null, last_outbound: null, latest_inbound, ordered };

  const use_case = deriveUseCaseFromBody(last_outbound.message_body);
  const outAt = eventAt(last_outbound);
  // Inbounds between our question and this message answered it already.
  const answered = inbounds.filter((e) => e !== latest_inbound && ts(eventAt(e)) > ts(outAt) && ts(eventAt(e)) < latestAt).length;
  const thread_key = clean(thread.thread_key);
  const context = use_case && /^\+[1-9]\d{7,14}$/.test(thread_key)
    ? {
        context_version: CONTEXT_VERSION,
        canonical_thread: thread_key,
        inbound_thread: thread_key,
        canonical_stage: clean(thread.lifecycle_stage || thread.seller_stage || thread.stage) || null,
        last_outbound_message_id: String(last_outbound.id || "outbound"),
        last_outbound_use_case: use_case,
        last_outbound_delivered_at: new Date(ts(outAt) || Date.now()).toISOString(),
        current_inbound_received_at: new Date(latestAt || Date.now()).toISOString(),
        intervening_outbound_count: 0,
        intervening_inbound_count: answered,
        unanswered_question: answered === 0,
        last_outbound_addressee: extractAddresseeName(last_outbound.message_body),
        last_outbound_language: detectMessageLanguage(last_outbound.message_body),
        last_outbound_agent: extractSenderName(last_outbound.message_body),
        last_outbound_question: describeLastQuestion(last_outbound.message_body),
      }
    : null;
  return { context, last_outbound, latest_inbound, ordered };
}

/** Reclassify the latest inbound exactly as the live webhook would. */
export async function reclassifyThread({ thread = {}, events = [], classifyImpl = classify } = {}) {
  const built = buildThreadConversationContext({ thread, events });
  // The seller's whole unanswered BURST is the reply (the live path merges a
  // burst the same way): "Esto" / "Aque biene pesto?" is one question, and
  // reading only the last fragment ("Esto") lost it.
  const outAt = built.last_outbound ? ts(eventAt(built.last_outbound)) : null;
  const latestAt = built.latest_inbound ? ts(eventAt(built.latest_inbound)) : null;
  const burst = outAt != null && latestAt != null
    ? built.ordered.filter((e) => lower(e.direction) === "inbound" && ts(eventAt(e)) > outAt && ts(eventAt(e)) <= latestAt)
    : [];
  const body = burst.length > 1
    ? burst.map((e) => clean(e.message_body)).filter(Boolean).join("\n")
    : clean(built.latest_inbound?.message_body ?? thread.latest_message_body);
  // In TRUE order (earliest timestamp), did WE write after the seller's last
  // message? The July-01 import made such threads look unanswered.
  const we_replied_last = latestAt != null && built.ordered.some(
    (e) => lower(e.direction) === "outbound" && ts(eventAt(e)) > latestAt
  );
  // Context timestamps are real; a stale (>7 day) question is ignored by the
  // validator exactly as in production.
  const classification = await classifyImpl(body, null, {
    heuristicOnly: true,
    conversation_context: built.context,
  });
  return { ...built, body, classification, burst_size: Math.max(1, burst.length), we_replied_last };
}

// ─── Categorization ──────────────────────────────────────────────────────────

// Substring, not word-bounded: "not forSale" folds to "forsale".
const SALE_PHRASING_RE = /(?:sale|sell|sold|venta|vend|keeping|plans?\b)/;

/** Earlier inbounds since our last outbound that are still unanswered engagement. */
export function hasOpenEarlierEngagement({ ordered = [], last_outbound = null, latest_inbound = null, classifyFn = null } = {}) {
  if (!latest_inbound || !classifyFn) return false;
  const after = ts(eventAt(last_outbound));
  return ordered.some((e) =>
    e !== latest_inbound &&
    lower(e.direction) === "inbound" &&
    ts(eventAt(e)) > after &&
    ENGAGEMENT_INTENTS.has(lower(classifyFn(e))));
}

export function categorizeReply({ classification = {}, body = "", open_engagement = false } = {}) {
  const intent = lower(classification.primary_intent);
  const rules = (classification.matched_rule_ids || []).map(lower);
  const emoji = classification.emoji_interpretation || null;
  const emojiTurn = Boolean(emoji && (emoji.emoji_only || emoji.reaction_type === "platform_reaction"));

  if (intent === "opt_out") return CLEANUP_CATEGORY.OPT_OUT;
  // "Tengo otra propiedad de venta": whatever they said about THIS property,
  // a different property is for sale. A person answers it (never nurtured or
  // archived away).
  if (rules.includes("other_property_for_sale")) return CLEANUP_CATEGORY.KEEP;
  if (intent === "wrong_number") return CLEANUP_CATEGORY.WRONG_PERSON;
  if (intent === "sold_property") return CLEANUP_CATEGORY.SOLD;
  if (intent === "hostile_or_legal") return CLEANUP_CATEGORY.HOSTILE;
  if (emojiTurn) {
    if (emoji.semantic_signal === "acknowledgement" && !emoji.needs_review) {
      return open_engagement ? CLEANUP_CATEGORY.KEEP : CLEANUP_CATEGORY.EMOJI_ACK;
    }
    return CLEANUP_CATEGORY.EMOJI_CLARIFY;
  }
  if (intent === "reaction_only") {
    if (rules.some((r) => r.startsWith("noise_"))) return open_engagement ? CLEANUP_CATEGORY.KEEP : CLEANUP_CATEGORY.NOISE;
    return open_engagement ? CLEANUP_CATEGORY.KEEP : CLEANUP_CATEGORY.AUTO_REPLY;
  }
  if (intent === "acknowledgement") return open_engagement ? CLEANUP_CATEGORY.KEEP : CLEANUP_CATEGORY.TEXT_ACK;
  if (intent === "callback_requested") return CLEANUP_CATEGORY.CALL_REQUEST;
  if (intent === "language_switch") return CLEANUP_CATEGORY.LANGUAGE;
  if (intent === "not_interested" || intent === "need_time") {
    if (rules.includes("competitor_investor")) return CLEANUP_CATEGORY.NOT_INTERESTED;
    return SALE_PHRASING_RE.test(foldReplyText(body)) ? CLEANUP_CATEGORY.NOT_FOR_SALE : CLEANUP_CATEGORY.NOT_INTERESTED;
  }
  if (ENGAGEMENT_INTENTS.has(intent)) return CLEANUP_CATEGORY.KEEP;
  return CLEANUP_CATEGORY.OTHER_AMBIGUOUS;
}

// ─── Next contact (preview only — nobody is contacted by the cleanup) ────────

/**
 * Rank the owner's other contacts with the EXISTING waterfall
 * (contact-resolution-waterfall.js: owner-best flag, score, rank, recency;
 * then email). Candidates arrive pre-loaded by the script with their
 * suppression facts; this only decides and explains.
 */
// A government / military / state work address is the owner's EMPLOYER's
// mailbox. It is never proposed for seller outreach; a person decides.
const WORK_GOVERNMENT_EMAIL_RE = /@(?:[^@\s]+\.)?(?:gov|mil)$|@(?:[^@\s]+\.)?state\.[a-z]{2}\.us$/i;

export function planNextContact({
  thread = {},
  phones = [],
  emails = [],
  suppressed_phones = [],
  active_thread_phones = [],
  rejected_phones = [],
  suppressed_emails = [],
} = {}) {
  const heldEmails = [];
  const usableEmails = [];
  for (const e of Array.isArray(emails) ? emails : []) {
    const address = clean(e?.email ?? e).toLowerCase();
    if (WORK_GOVERNMENT_EMAIL_RE.test(address)) heldEmails.push(address);
    else usableEmails.push(e);
  }
  const decision = resolveNextContactAction({
    outcome: "not_owner",
    property_id: clean(thread.property_id) || null,
    current_phone: thread.thread_key,
    phones,
    emails: usableEmails,
    suppressed_phones,
    active_thread_phones,
    rejected_phones,
    suppressed_emails,
    entities: { master_owner_id: thread.master_owner_id || null, prospect_id: thread.prospect_id || null },
  });
  const considered = (decision.considered || []).map((c) => ({
    phone: maskPhone(c.phone_e164),
    eligible: c.eligible,
    reason: c.reason,
  }));
  const email_considered = [
    ...(decision.email_considered || []).map((c) => ({
      email: maskEmail(c.email),
      eligible: c.eligible,
      reason: c.reason,
    })),
    ...heldEmails.map((address) => ({ email: maskEmail(address), eligible: false, reason: "work_or_government_address_held" })),
  ];
  if (decision.action === RESOLUTION_ACTION.START_NEXT_PHONE) {
    const chosen = phones.find((p) => normalizePhoneKey(p.phone_e164) === decision.next_contact.phone_e164) || {};
    return {
      channel: "phone",
      candidate: maskPhone(decision.next_contact.phone_e164),
      contact_type: chosen.phone_type || null,
      source: chosen.source || "contact_graph",
      eligibility: "eligible (waterfall)",
      suppression_state: "clear: not on sms_suppression_list / automation_suppressions, no wrong-number history, no prior contact",
      would_send: "S1 ownership check, sms_templates ownership_check pool in the thread language, through the campaign queue (contact window, sender health, template governance, caps, DNC re-checked at send time)",
      why: "first eligible phone by the existing waterfall ranking (best-phone flag, score, rank, recency)",
      considered,
      email_considered,
    };
  }
  if (decision.action === RESOLUTION_ACTION.EMAIL_FALLBACK) {
    return {
      channel: "email",
      candidate: maskEmail(decision.next_contact.email),
      contact_type: "email",
      source: "contact_graph",
      eligibility: "eligible, held: email sending is OFF (Brevo not configured)",
      suppression_state: "not on email_suppression",
      would_send: "nothing now: recorded as pending-email; an email ownership check needs an approved email template and email sending switched on",
      why: "no eligible phone remains; email is the next channel in the waterfall",
      considered,
      email_considered,
    };
  }
  return {
    channel: "none",
    candidate: null,
    contact_type: null,
    source: null,
    eligibility: "no eligible contact",
    suppression_state: considered.length || email_considered.length ? "every candidate refused (see considered)" : "no other contact on file",
    would_send: "nothing: no further contact",
    why: considered.length || email_considered.length
      ? "every other phone/email failed an eligibility rule"
      : "the owner has no other phone or email on file",
    considered,
    email_considered,
  };
}

// ─── The plan for one thread ─────────────────────────────────────────────────

function currentState(thread = {}) {
  return {
    bucket: lower(thread.inbox_bucket) || "(derived)",
    last_intent: lower(thread.last_intent) || null,
    disposition: lower(thread.disposition) || null,
    operational_status: lower(thread.operational_status || thread.status) || null,
    archived: thread.is_archived === true,
    suppressed: thread.is_suppressed === true,
    in_new_replies: thread.in_new_replies !== false,
  };
}

/**
 * @returns {object} one preview row. `apply` is the instruction list the repair
 * executes after approval -- canonical authorities only, never raw SQL.
 */
export function planThreadCleanup({
  thread = {},
  classification = {},
  category = CLEANUP_CATEGORY.OTHER_AMBIGUOUS,
  context = null,
  last_outbound = null,
  latest_inbound = null,
  opportunity = null,
  next_contact = null,
  reaction_target = null,
} = {}) {
  const intent = lower(classification.primary_intent);
  const now = currentState(thread);
  const staleDecline = now.disposition === "not_interested";
  const base = {
    thread_id: thread.id || null,
    property_id: thread.property_id || null,
    master_owner_id: thread.master_owner_id || null,
    prospect_id: thread.prospect_id || null,
    phone: maskPhone(thread.thread_key),
    stage: thread.lifecycle_stage || thread.seller_stage || thread.stage || null,
    category,
    current_classification: now.last_intent || "(none)",
    correct_classification: intent || "unclear",
    rule_ids: classification.matched_rule_ids || [],
    confidence: typeof classification.confidence === "number" ? Number(classification.confidence.toFixed(2)) : null,
    factual_commitment: classification.factual_commitment || null,
    language: classification.language_preference || null,
    emoji: classification.emoji_interpretation
      ? {
          family: classification.emoji_interpretation.family,
          only: Boolean(classification.emoji_interpretation.emoji_only || classification.emoji_interpretation.reaction_type === "platform_reaction"),
          signal: classification.emoji_interpretation.semantic_signal,
          reaction: classification.emoji_interpretation.reaction_type,
          target_kind: classification.emoji_interpretation.reaction?.target_kind || null,
          target_message_id: reaction_target?.message_event_id || null,
          clarification_use_case: classification.emoji_interpretation.clarification?.template_use_case || null,
        }
      : null,
    call_request: classification.call_request || null,
    context_use_case: context?.last_outbound_use_case || null,
    current_state: now,
    provenance: {
      source: CLEANUP_SOURCE,
      classifier_version: classification.classifier_version || CLASSIFY_VERSION,
      cleanup_version: CLEANUP_VERSION,
      old_classifier_result: { last_intent: now.last_intent, disposition: now.disposition, bucket: now.bucket },
    },
  };

  const row = (fields) => ({ ...base, ...fields });
  switch (category) {
    case CLEANUP_CATEGORY.OPT_OUT:
      return row({
        proposed_state: { bucket: "suppressed", disposition: "not_interested", contactability: "opted_out", archived: false },
        new_replies: "remove",
        follow_up: "none",
        next_contact: { channel: "none", why: "an opt-out is a compliance stop for this number; no other contact is started from it" },
        proposed_send: "no",
        why: "explicit opt-out wording; compliance wins over every other reading",
        apply: ["suppress_opt_out", "write_reclassification"],
      });
    case CLEANUP_CATEGORY.WRONG_PERSON:
      return row({
        proposed_state: { bucket: "dead", disposition: "wrong_person", archived: true, archive_reason: "wrong_person", relationship: "owner<->phone invalid (this property only)" },
        new_replies: "remove",
        follow_up: "none",
        next_contact: next_contact || { channel: "none", why: "next contact not evaluated" },
        // The cleanup never contacts a new person: the next contact is recorded only.
        proposed_send: "no (next contact recorded only; contacting them is a separate campaign action)",
        why: "the reply says we reached someone other than the owner; the number is invalid for this owner only, never globally",
        apply: ["write_reclassification", "mark_relationship_not_owner", "archive_thread", "record_next_contact_plan"],
      });
    case CLEANUP_CATEGORY.SOLD:
      return row({
        proposed_state: {
          bucket: "dead",
          disposition: "sold",
          archived: true,
          archive_reason: "sold",
          opportunity: opportunity ? `${opportunity.acquisition_stage}/${opportunity.opportunity_status} -> closed/lost (property sold)` : "no opportunity row",
        },
        new_replies: "remove",
        follow_up: "none",
        next_contact: { channel: "none", why: "the property changed hands; no further texting about it" },
        proposed_send: "no",
        why: "seller reports the property is sold",
        apply: ["write_reclassification", "cancel_pending_followups", "archive_thread", "close_opportunity_lost"],
      });
    case CLEANUP_CATEGORY.NOT_INTERESTED:
    case CLEANUP_CATEGORY.NOT_FOR_SALE: {
      // The 2026-07-01 backfill cohort is the same owner decision as the
      // nurture repair's LEGACY_JUL01 set: a re-touch months after the "no".
      const julyCohort = ts(thread.last_inbound_at) > 0 && ts(thread.last_inbound_at) < Date.parse("2026-08-01T00:00:00Z");
      return row({
        proposed_state: { bucket: "follow_up", disposition: "not_interested", operational_status: "follow_up_due", archived: false, nurture: "30-day", ...(julyCohort ? { cohort: "2026-07-01 backfill" } : {}) },
        new_replies: "remove",
        follow_up: "30-day",
        next_contact: { channel: "none", why: "same seller stays in nurture; never suppressed" },
        proposed_send: "yes (one 30-day nurture follow-up via scheduleFollowUp: normal queue, send-time guards, vendor-DNC hold)",
        why: intent === "need_time" ? "a not-now answer: 30-day nurture" : "a decline is a 30-day follow-up (owner rule), never a suppression",
        apply: ["write_reclassification", "set_not_interested_nurture", "schedule_nurture_followup"],
      });
    }
    case CLEANUP_CATEGORY.HOSTILE:
      return row({
        proposed_state: { bucket: "dead", disposition: "unqualified", archived: true, archive_reason: "hostile_no_opt_out" },
        new_replies: "remove",
        follow_up: "none",
        next_contact: { channel: "none", why: "no hostile re-engagement in this pass" },
        proposed_send: "no",
        why: "hostile without opt-out language: archive/cool, no automatic nurture, no DNC (owner decision 2026-10-01)",
        apply: ["write_reclassification", "cancel_pending_followups", "archive_thread"],
      });
    case CLEANUP_CATEGORY.AUTO_REPLY:
    case CLEANUP_CATEGORY.NOISE:
    case CLEANUP_CATEGORY.TEXT_ACK:
    case CLEANUP_CATEGORY.EMOJI_ACK:
      return row({
        proposed_state: { bucket: "cold", disposition: now.disposition, archived: false, note: "back to the state before this message (Waiting inside 24h of our send, else Cold)" },
        new_replies: "remove",
        follow_up: "none",
        next_contact: { channel: "none", why: "same contact; nothing was answered" },
        proposed_send: "no",
        why: category === CLEANUP_CATEGORY.AUTO_REPLY
          ? "an automatic reply, not the seller; the event is kept"
          : category === CLEANUP_CATEGORY.NOISE
            ? "a stray character with nothing to answer; the event is kept"
            : "an acknowledgement that leaves nothing open; the event is kept",
        apply: ["write_reclassification"],
      });
    case CLEANUP_CATEGORY.EMOJI_CLARIFY: {
      const useCase = classification.emoji_interpretation?.clarification?.template_use_case || null;
      return row({
        proposed_state: { bucket: "new_replies", disposition: null, archived: false, note: useCase ? `clarify: ${useCase}` : "needs a person" },
        new_replies: "keep",
        follow_up: useCase ? "clarify" : "other",
        next_contact: { channel: "none", why: "same contact" },
        // Not sent by the cleanup (deploy runbook, 2026-10-02): a confirmation
        // question about a months-old emoji would read as a fake continuation.
        // The thread stays in New Replies; the live path still clarifies NEW
        // emoji with the emoji_confirm_* rows.
        proposed_send: "no (stays in New Replies for an operator; not sent by the cleanup)",
        why: useCase
          ? "an emoji/reaction to our question is LIKELY an answer, never a fact: one confirmation question, same stage"
          : "an emoji/reaction whose meaning needs a person (confusion, laughter, or no known question)",
        apply: ["write_reclassification", ...(staleDecline ? ["clear_stale_decline"] : [])],
      });
    }
    case CLEANUP_CATEGORY.CALL_REQUEST:
      return row({
        proposed_state: {
          bucket: "new_replies",
          disposition: null,
          archived: false,
          call: classification.call_request?.requested_time_text
            ? `call requested · ${classification.call_request.requested_time_text} (not on the calendar)`
            : "call requested · unscheduled",
        },
        new_replies: "keep",
        follow_up: "call",
        next_contact: { channel: "none", why: "same contact" },
        proposed_send: "no (a person calls)",
        why: staleDecline ? "a call request is engagement; the stored not_interested is stale and is cleared" : "a call request is engagement",
        apply: ["write_reclassification", ...(staleDecline ? ["clear_stale_decline"] : [])],
      });
    case CLEANUP_CATEGORY.LANGUAGE: {
      const lang = classification.language_preference || {};
      return row({
        proposed_state: {
          bucket: "new_replies",
          archived: false,
          language: {
            detected: lang.detected_language || null,
            preferred: lang.preferred_language || null,
            avoid: lang.avoid_language || null,
            confidence: lang.preference_confidence || null,
          },
        },
        new_replies: "keep",
        follow_up: "other",
        next_contact: { channel: "none", why: "same contact" },
        // Not resent by the cleanup (deploy runbook, 2026-10-02): the language
        // is recorded; the reply is an approved late-reply row where one applies
        // (the 27-deal reply plan), otherwise an operator answers.
        proposed_send: `no (language recorded${lang.avoid_language ? `; stop ${lang.avoid_language}` : ""}; not resent by the cleanup)`,
        why: lang.preferred_language
          ? `explicit request for ${lang.preferred_language}`
          : `the seller cannot read ${lang.avoid_language || "our language"}; that does not by itself name the language to use`,
        apply: ["write_reclassification", "record_language_preference"],
      });
    }
    case CLEANUP_CATEGORY.KEEP:
      return row({
        proposed_state: { bucket: "new_replies", disposition: staleDecline ? null : now.disposition, archived: false },
        new_replies: "keep",
        follow_up: "none",
        next_contact: { channel: "none", why: "same contact" },
        proposed_send: "no (answered by a person or the autopilot)",
        why: intent === "who_is_this" ? "an identity question is engagement that needs an answer" : "genuine engagement awaiting a response",
        apply: ["write_reclassification", ...(staleDecline ? ["clear_stale_decline"] : [])],
      });
    default:
      return row({
        proposed_state: { bucket: "new_replies", disposition: now.disposition, archived: false },
        new_replies: "keep",
        follow_up: "other",
        next_contact: { channel: "none", why: "same contact" },
        proposed_send: "no (review)",
        why: "not confidently classifiable: kept for a person rather than given an invented disposition",
        apply: ["write_reclassification"],
      });
  }
}

// ─── Run the whole set ───────────────────────────────────────────────────────

/**
 * Plan every thread. `loadNextContact(thread)` is injected (read-only I/O in
 * the script, a fixture in tests) and only called for wrong-person rows.
 */
export async function planNewRepliesCleanup(threads = [], { classifyImpl = classify, loadNextContact = null } = {}) {
  const plans = [];
  for (const item of threads) {
    const thread = item.thread || item;
    const events = collapseReactionDuplicates(item.message_events || item.events || []);
    const re = await reclassifyThread({ thread, events, classifyImpl });
    const classifyEarlier = (e) => {
      // Deterministic sync read of an earlier inbound: the label the live
      // classifier gave it at the time (message_events.detected_intent).
      return e.detected_intent || "unclear";
    };
    const open_engagement = hasOpenEarlierEngagement({
      ordered: re.ordered,
      last_outbound: re.last_outbound,
      latest_inbound: re.latest_inbound,
      classifyFn: classifyEarlier,
    });
    const category = categorizeReply({ classification: re.classification, body: re.body, open_engagement });
    const opportunity = (item.opportunities || [])[0] || null;
    const reaction_target = parsePlatformReaction(re.body)
      ? linkReactionTarget(re.body, re.ordered, { before: eventAt(re.latest_inbound) })
      : null;
    const next_contact = category === CLEANUP_CATEGORY.WRONG_PERSON && typeof loadNextContact === "function"
      ? await loadNextContact({ thread, item })
      : null;
    plans.push({
      ...planThreadCleanup({
        thread: { ...thread, in_new_replies: true },
        classification: re.classification,
        category,
        context: re.context,
        last_outbound: re.last_outbound,
        latest_inbound: re.latest_inbound,
        opportunity,
        next_contact,
        reaction_target,
      }),
      burst_size: re.burst_size,
      // True order says we already answered: the row is reported, never
      // silently dropped (the operator checks our answer was a real one).
      we_replied_last: re.we_replied_last === true,
      // Kept OUTSIDE the de-identified preview columns; the script redacts.
      _texts: { previous_outbound: re.last_outbound?.message_body || null, reply: re.body },
    });
  }
  return plans;
}

export function summarizeCleanup(plans = []) {
  const counts = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  for (const p of plans) counts[p.category] = (counts[p.category] || 0) + 1;
  const keep = plans.filter((p) => p.new_replies === "keep").length;
  return {
    total: plans.length,
    counts,
    who_is_this: plans.filter((p) => p.correct_classification === "who_is_this").length,
    remain_in_new_replies: keep,
    leave_new_replies: plans.length - keep,
    proposed_sends_after_approval: plans.filter((p) => String(p.proposed_send).startsWith("yes")).length,
    we_replied_last_in_true_order: plans.filter((p) => p.we_replied_last === true).length,
    next_contact: {
      phone: plans.filter((p) => p.next_contact?.channel === "phone").length,
      email: plans.filter((p) => p.next_contact?.channel === "email").length,
      none: plans.filter((p) => p.category === CLEANUP_CATEGORY.WRONG_PERSON && p.next_contact?.channel === "none").length,
    },
  };
}

// ─── De-identification for the repo corpus / evaluation export ───────────────

const NAME_TOKEN_RE = /\b[A-Z][a-z]{1,15}\b/g;
const ADDRESS_RE = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.'-]*){0,4}\s+(?:Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Hwy|Cv|Cove|Trl|Trail)\b\.?(?:\s+(?:[NSEW]{1,2}|Unit\s+\w+|#\s*\w+))?/g;
const PHONE_RE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/**
 * Replace names, addresses, phones and emails with stable placeholders.
 * `names` are the person names known for the thread (greeted owner, agent
 * persona); any other capitalized token that appears in BOTH texts is
 * treated as a name too. Placeholders keep the shape ("Not <NAME_1>").
 */
export function deidentifyPair({ previous_outbound = "", reply = "", names = [] } = {}) {
  const map = new Map();
  let n = 0;
  const known = new Set(names.filter(Boolean).map((x) => x.toLowerCase()));
  const outTokens = new Set((String(previous_outbound).match(NAME_TOKEN_RE) || []).map((x) => x.toLowerCase()));
  for (const t of String(reply).match(NAME_TOKEN_RE) || []) {
    if (outTokens.has(t.toLowerCase())) known.add(t.toLowerCase());
  }
  const sub = (text) => String(text || "")
    .replace(EMAIL_RE, "<EMAIL>")
    .replace(PHONE_RE, "<PHONE>")
    .replace(ADDRESS_RE, "<ADDRESS>")
    .replace(/\b([A-Za-z][a-z'-]{1,15})\b/g, (m) => {
      const key = m.toLowerCase();
      if (!known.has(key)) return m;
      if (!map.has(key)) map.set(key, `<NAME_${++n}>`);
      return map.get(key);
    });
  return { previous_outbound: sub(previous_outbound), reply: sub(reply) };
}

/**
 * Deterministic evaluation export for Intelligence Core: one JSON object per
 * thread, sorted by thread id, de-identified.
 */
export function buildEvaluationExport(plans = [], { namesFor = () => [] } = {}) {
  return [...plans]
    .sort((a, b) => String(a.thread_id).localeCompare(String(b.thread_id)))
    .map((p) => {
      const texts = deidentifyPair({ ...(p._texts || {}), names: namesFor(p) });
      const emojis = extractEmojis(p._texts?.reply || "");
      return {
        example_id: `nr20261001-${String(p.thread_id).slice(0, 8)}`,
        previous_message: texts.previous_outbound,
        reply: texts.reply,
        stage: p.stage || null,
        language: p.language?.detected_language || null,
        emoji_features: {
          emojis,
          emoji_only: Boolean(p.emoji && p.emoji.reaction !== "platform_reaction" && emojis.length && !/[\p{L}\p{N}]/u.test(texts.reply.replace(/<[A-Z_0-9]+>/g, ""))),
          platform_reaction: p.emoji?.reaction === "platform_reaction",
          family: p.emoji?.family || null,
          signal: p.emoji?.signal || null,
        },
        old_classifier_result: p.current_classification,
        correct_label: p.correct_classification,
        category: p.category,
        required_action: p.apply,
        follow_up: p.follow_up,
        new_replies: p.new_replies,
        factual_commitment: p.factual_commitment,
        classifier_version: p.provenance?.classifier_version,
      };
    });
}

export default planNewRepliesCleanup;

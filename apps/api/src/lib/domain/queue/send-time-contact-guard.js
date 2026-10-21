// ─── send-time-contact-guard.js ──────────────────────────────────────────────
// P0 OUTBOUND SAFETY (owner, 2026-10-08): the contact-history + suppression
// checks that Composer / Build / enqueue run must ALSO run at FINAL DISPATCH,
// immediately before transport, on fresh reads. INTENDED call site:
// evaluateAndBlockSendAtCompliance (block-send-at-compliance.js), after the
// canonical contactability check passes, for every AUTOMATED send. NOT WIRED
// in this commit — the send-path edit needs owner approval (see the commit).
//
// Re-checked at send time, matching BOTH phone shapes (10-digit / E.164 /
// 1+10 / formatted — the a372ae53 defect: campaign_targets store 10 digits,
// the ledgers store E.164, so exact-string lookups never matched):
//   1. sms_suppression_list active (global, or a pair row for this sender)
//   2. automation_suppressions active — ANY suppression_type (incl.
//      precautionary_no_contact); a row past expires_at, or released, is not
//   3. inbox_thread_state suppressed / opted out (is_suppressed, disposition,
//      last_intent, contactability)
//   4. wrong number (thread, phones row, an inbound wrong-number reply)
//   5. prior_reply_not_owner for this person × property (property-scoped
//      not-owner claim; a wrong-number claim is phone-scoped)
//   6. FIRST-TOUCH OPENERS ONLY: already contacted — the four truths (the
//      contact-history-truths.js definitions, self-contained here because
//      that module is not on the RC): the exact person×phone pair, the phone,
//      the person (any of the person's phones in public.phones), the property
//      (any phone). Follow-ups / nurture / replies are exempt from 6, never
//      from 1–5.
// FAIL CLOSED: any read error -> blocked, reason send_time_guard_read_failed.
//
// Concurrency: a sibling row only counts as a prior touch when it went out
// (sent_at / sent / delivered) or is IN FLIGHT and was created before this row
// (ties broken by id) — two workers dispatching two openers to the same phone
// in parallel let exactly one through. Queued / scheduled siblings are not
// touches (each is checked at its own dispatch). A cancelled / failed row with
// no sent_at is provably unsent and never a touch (requeues are safe).

import { readStop } from "@/lib/domain/conversation-ai/stop-reading.js";
import { SEND_TIME_BLOCK_REASONS } from "@/lib/domain/compliance/canonical-no-contact-states.js";
import { evaluateOwnershipRecontact } from "@/lib/domain/queue/ownership-recontact-guard.js";
import { checkAutomationHoldPort } from "@/lib/domain/holds-port/automation-hold-port.js";
import { resolveOutboundQuestionKind, isValidRepeatAskOverride, QUESTION_KIND_ASKING_PRICE } from "@/lib/domain/queue/outbound-question-kind.js";
import { buildFactLedger } from "@/lib/domain/conversation-ai/facts.js";

export const SEND_TIME_CONTACT_GUARD_VERSION = "send_time_contact_guard.v1.2026-10-08";

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();

/** Last 10 digits: the one key every stored phone shape shares. */
export function phoneKey(value) {
  const digits = clean(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** E.164, 1+10 and bare 10-digit forms (plus the raw value) for `.in()` lookups. */
export function phoneVariants(values = []) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const raw = clean(value);
    if (!raw) continue;
    out.add(raw);
    const key = phoneKey(raw);
    if (key) {
      out.add(key);
      out.add(`1${key}`);
      out.add(`+1${key}`);
    }
  }
  return [...out];
}

export const SEND_TIME_GUARD_REASONS = Object.freeze({
  READ_FAILED: "send_time_guard_read_failed",
  SUPPRESSION_LIST: "sms_suppression_list_active",
  AUTOMATION_SUPPRESSION: "automation_suppression_active",
  THREAD_SUPPRESSED: "thread_suppressed",
  THREAD_OPTED_OUT: "thread_opted_out",
  OPT_OUT_REPLY: "opt_out_reply",
  WRONG_NUMBER: "wrong_number",
  PRIOR_REPLY_NOT_OWNER: "prior_reply_not_owner",
  // rc-8.5.21: the authoritative automation-hold registry (holds-port) says held, or could not answer
  AUTOMATION_HOLD: "automation_hold_active",
  // OWNER RULES 2026-10-17: an ownership denial whose property is not reliably identified, or ownership
  // evidence that conflicts (a newer, less confident label against explicit text), HOLDS the thread for
  // operator resolution — deferred like an automation hold, never a terminal denial of every property
  OWNERSHIP_UNRESOLVED_HOLD: "ownership_denial_property_unresolved",
  // OWNER DECISION 2026-10-17: a polite decline to the ownership question — ownership UNVERIFIED; a
  // property × contact hold (deferred, never terminal, never a denial)
  OWNERSHIP_DECLINED_HOLD: "ownership_declined_unverified_hold",
  // rc-8.5.21 (Pittsburgh 8d03a7c4): the seller already STATED a price — a price question is never sent
  ASKING_PRICE_ALREADY_STATED: "blocked_repeat_asking_price_already_stated",
  ALREADY_CONTACTED_PAIR: "already_contacted_person_phone",
  ALREADY_CONTACTED_PHONE: "already_contacted_phone",
  ALREADY_CONTACTED_PERSON: "already_contacted_person",
  ALREADY_CONTACTED_PROPERTY: "already_contacted_property",
  // rc-8.5.21 v3 (owner rule 2026-10-19): hostile language alone is not a formal opt-out, but an
  // UNSOLICITED follow-up / nurture never continues on a hostile thread (replies to the seller are not
  // nurture and are judged by the reply path)
  HOSTILE_THREAD_NO_NURTURE: "hostile_thread_no_nurture",
  // rc-8.5.21 v3: "take me off that one" about an identified property = a PROPERTY-SCOPED do-not-contact
  PROPERTY_DO_NOT_CONTACT: "property_do_not_contact",
  // rc-8.5.21 v4 (S2, INDEPENDENT final-dispatch enforcement): the thread's LATEST inbound reads as a stop /
  // possible stop (the combined stop reading), whatever any writer, label or suppression row says
  LATEST_INBOUND_STOP_LIKE: "latest_inbound_stop_like",
});
const R = SEND_TIME_GUARD_REASONS;

const REASON_CODE = Object.freeze({
  [R.READ_FAILED]: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
  [R.SUPPRESSION_LIST]: SEND_TIME_BLOCK_REASONS.SUPPRESSED,
  [R.AUTOMATION_SUPPRESSION]: SEND_TIME_BLOCK_REASONS.SUPPRESSED,
  [R.THREAD_SUPPRESSED]: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
  [R.THREAD_OPTED_OUT]: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
  [R.OPT_OUT_REPLY]: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
  [R.WRONG_NUMBER]: SEND_TIME_BLOCK_REASONS.WRONG_NUMBER,
  [R.PRIOR_REPLY_NOT_OWNER]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.AUTOMATION_HOLD]: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
  [R.OWNERSHIP_UNRESOLVED_HOLD]: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
  [R.OWNERSHIP_DECLINED_HOLD]: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
  [R.ASKING_PRICE_ALREADY_STATED]: "blocked_repeat_asking_price_already_stated",
  [R.ALREADY_CONTACTED_PAIR]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PHONE]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PERSON]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PROPERTY]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.HOSTILE_THREAD_NO_NURTURE]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.PROPERTY_DO_NOT_CONTACT]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.LATEST_INBOUND_STOP_LIKE]: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
});

/**
 * rc-8.5.21 v4: the thread's latest inbound, if its text reads as a stop or a POSSIBLE stop and no operator
 * released that reading (a precautionary_no_contact row for THAT inbound set to released). Pure.
 */
export function latestInboundStopLike(messages = [], automationSuppressions = []) {
  const at = (m) => Date.parse(m?.event_timestamp || m?.created_at || "") || 0;
  const latest = (messages || []).filter((m) => lower(m?.direction).startsWith("in")).sort((a, b) => at(b) - at(a))[0];
  if (!latest || !clean(latest.message_body)) return null;
  const r = readStop({ text: latest.message_body, deterministic: OPT_OUT_SIGNALS.has(lower(latest.detected_intent)) ? { intent: "opt_out", compliance_flag: "stop_texting" } : null });
  if (!r.confirmed && !r.uncertain) return null;
  const released = !r.confirmed && (automationSuppressions || []).some((s) => lower(s.suppression_type) === "precautionary_no_contact" && INACTIVE_SUPPRESSION_STATUSES.has(lower(s.status)) && clean(s.payload?.inbound_event_id) === clean(latest.id));
  if (released) return null;
  return { message_id: clean(latest.id) || null, confirmed: r.confirmed, sources: r.sources.slice(0, 4) };
}

/** Same sets as opener-reply-exclusion.js (a372ae53). Change both or neither. */
export const PROPERTY_SCOPED_NOT_OWNER = Object.freeze(new Set([
  "property_specific_non_owner", "former_owner_respondent", "sold_property", "sold",
  "tenant_respondent", "non_owner_referral", "not_owner",
]));
export const PHONE_SCOPED_NOT_OWNER = Object.freeze(new Set(["wrong_number", "wrong_person"]));
/** OWNER DECISION 2026-10-17 — same set as opener-reply-exclusion.js PROPERTY_SCOPED_DECLINED. */
export const PROPERTY_SCOPED_DECLINED = Object.freeze(new Set(["ownership_declined_unverified", "declined_unverified"]));
const OPT_OUT_SIGNALS = new Set(["opt_out", "opted_out", "stop", "dnc", "do_not_contact", "suppressed", "unsubscribed"]);
const BLOCKING_CONTACTABILITY = new Set(["opt_out", "opted_out", "suppressed", "do_not_contact", "dnc", "invalid", "blocked"]);
export const SEND_TIME_REPLY_INTENTS = Object.freeze([...PROPERTY_SCOPED_NOT_OWNER, ...PHONE_SCOPED_NOT_OWNER, ...PROPERTY_SCOPED_DECLINED, ...OPT_OUT_SIGNALS]);

/** automation_suppressions statuses that mean the hold no longer applies. */
const INACTIVE_SUPPRESSION_STATUSES = new Set(["released", "inactive", "lifted", "cleared", "expired", "revoked", "resolved", "cancelled", "canceled", "superseded"]);

/** Sends that are not openers: never subject to the already-contacted rule. */
const NON_OPENER_KINDS = new Set([
  "followup", "follow_up", "nurture", "auto_reply", "autopilot", "reply", "manual_reply", "manual",
  "inbox_reply", "send_now", "clarifier", "missed_call_autotext", "buyer_disposition", "buyer",
]);

const asInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** A FIRST-TOUCH campaign opener (the queue processor's isQueueFirstTouch + the kind). */
export function isOpenerRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const kinds = [row.type, row.message_type, meta.type, meta.message_type, meta.send_kind].map(lower).filter(Boolean);
  if (kinds.some((k) => NON_OPENER_KINDS.has(k) || k.includes("follow") || k.includes("reply") || k.includes("nurture"))) return false;
  if (lower(meta.followup_reason)) return false;
  if (typeof row.is_first_touch === "boolean") return row.is_first_touch;
  if (typeof meta.is_first_touch === "boolean") return meta.is_first_touch;
  const touch = asInt(row.touch_number ?? meta.touch_number ?? meta.candidate_snapshot?.touch_number);
  return touch === 1;
}

const SENT_STATUSES = new Set(["sent", "delivered", "delivered_confirmed", "accepted", "provider_accepted"]);
const IN_FLIGHT_STATUSES = new Set(["sending", "processing", "claimed", "dispatching"]);

function precedes(other = {}, row = {}) {
  const a = Date.parse(other.created_at || "");
  const b = Date.parse(row.created_at || "");
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b;
  return clean(other.id) < clean(row.id);
}

/** A ledger row that reached (or may now be reaching) a person. */
export function isPriorTouch(other = {}, row = {}) {
  if (clean(other.id) && clean(other.id) === clean(row.id)) return false;
  const direction = lower(other.direction);
  if (direction) {
    if (!direction.startsWith("out")) return false;
    if (other.is_final_failure === true || /fail/.test(lower(other.event_type)) || /fail/.test(lower(other.delivery_status))) return false;
    if (clean(other.queue_id) && clean(other.queue_id) === clean(row.id)) return false;
    return true;
  }
  if (clean(other.sent_at)) return true;
  const status = lower(other.queue_status);
  if (SENT_STATUSES.has(status)) return true;
  if (IN_FLIGHT_STATUSES.has(status)) return precedes(other, row);
  return false;
}

const PRICE_STATED_INTENTS = new Set(["asking_price_provided", "price_and_condition", "asking_price_stated", "counter_or_negotiation"]);
/** The seller's own stated asking price on the thread (classifier label or the fact extractor), or null. */
export function statedAskingPrice(messages = []) {
  const inbound = (messages || []).filter((m) => lower(m.direction).startsWith("in"));
  const labelled = inbound.find((m) => PRICE_STATED_INTENTS.has(lower(m.detected_intent)));
  if (labelled) return { source: `label:${lower(labelled.detected_intent)}`, message_id: String(labelled.id) };
  try {
    const ledger = buildFactLedger({ inbound: inbound.map((m) => ({ id: String(m.id), body: m.message_body ?? m.body ?? "", at: m.created_at || m.event_timestamp || null })) });
    const cur = ledger.asking_price?.current;
    if (cur?.value?.amount > 0) return { source: "fact_extractor", message_id: String(cur.source_message_id) };
  } catch { /* the label check above already ran */ }
  return null;
}

/** Hostile / insult labels (never an opt-out on their own; owner 2026-10-06 + 2026-10-19). */
export const HOSTILE_LABELS = Object.freeze(new Set(["hostile_or_troll", "hostile_or_legal", "hostile", "hostile_insult_no_opt_out", "hostile_profanity", "emoji_hostile"]));
const RE_ENGAGEMENT_LABELS = new Set(["asking_price_provided", "asks_offer", "seller_interested", "interested", "callback_requested", "seller_callback", "counter_offer", "price_and_condition", "ownership_confirmed", "latent_interest"]);
const FOLLOW_UP_KIND_RE = /follow|nurture|no_response|stage_silence|re_?engage|drip/;

/**
 * An UNSOLICITED automated follow-up (nurture, no-response chain, stage silence, re-engagement drip):
 * not a reply to the seller, not a manual operator send, not a first-touch opener.
 */
export function isUnsolicitedFollowUpRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (meta.manual_operator_send === true) return false;
  const kinds = [row.type, row.message_type, meta.type, meta.message_type, meta.send_kind, meta.followup_kind, row.use_case_template, meta.source].map(lower).filter(Boolean);
  if (kinds.some((k) => k.includes("reply") || k === "manual" || k === "send_now")) return false;
  if (lower(meta.followup_kind) === "seller_requested_callback") return false;
  if (clean(meta.followup_intent_id) || clean(meta.followup_reason) || clean(meta.followup_kind)) return true;
  return kinds.some((k) => FOLLOW_UP_KIND_RE.test(k));
}

/**
 * The thread's latest hostile inbound that no LATER seller re-engagement superseded, or null (pure).
 * @param {Array<{ id?: string, direction?: string, detected_intent?: string, created_at?: string, event_timestamp?: string }>} messages
 */
export function unresolvedHostileInbound(messages = []) {
  const at = (m) => Date.parse(m?.event_timestamp || m?.created_at || "") || 0;
  const inbound = (messages || []).filter((m) => lower(m?.direction).startsWith("in")).sort((a, b) => at(a) - at(b));
  let hostile = null;
  for (const m of inbound) {
    const label = lower(m.detected_intent);
    if (HOSTILE_LABELS.has(label)) hostile = m;
    else if (hostile && RE_ENGAGEMENT_LABELS.has(label)) hostile = null;
  }
  return hostile;
}

function block(reason, detail = {}) {
  return { blocked: true, reason, reason_code: REASON_CODE[reason] || SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL, detail, version: SEND_TIME_CONTACT_GUARD_VERSION };
}
const PASS = Object.freeze({ blocked: false, reason: null, version: SEND_TIME_CONTACT_GUARD_VERSION });

const isActiveAutomationSuppression = (r, now_ms) => {
  if (INACTIVE_SUPPRESSION_STATUSES.has(lower(r.status))) return false;
  if (clean(r.expires_at)) {
    const t = Date.parse(r.expires_at);
    if (Number.isFinite(t) && t <= now_ms) return false;
  }
  return true;
};

/**
 * Pure. facts = { suppressions, automation_suppressions, threads, phones,
 * inbound_replies, prior_sends, prior_outbound_events, person_phones }.
 */
export function evaluateSendTimeContactGuard(row = {}, facts = {}, { now = Date.now(), restrictionsOnly = false } = {}) {
  const key = phoneKey(row.to_phone_number || row.thread_key);
  if (!key) return block(R.WRONG_NUMBER, { why: "recipient_phone_unparseable" });
  const from_key = phoneKey(row.from_phone_number);
  const same = (v) => phoneKey(v) === key;
  const now_ms = typeof now === "number" ? now : Date.parse(now);
  const property_id = clean(row.property_id);
  // rc-8.5.21 recontact guard over the thread's OWN messages + the resolution store (owner rules 1-3)
  const has_thread_facts = (Array.isArray(facts.thread_messages) && facts.thread_messages.length) || (Array.isArray(facts.contact_property_resolution) && facts.contact_property_resolution.length);
  const rc = has_thread_facts ? evaluateOwnershipRecontact(row, facts.thread_messages || [], { resolutions: facts.contact_property_resolution || [] }) : null;
  const text_confirmed = Boolean(rc && !rc.blocked && rc.detail?.resolved?.state === "confirmed");
  // rc-8.5.21 v3 (MUL-04, owner rule 3): the thread's own evidence for THIS property resolved — by recency
  // AND confidence, over every thread message including the labelled ones — to an EXPLICIT confirmation
  // (or a direct answer). A stale low-confidence not-owner LABEL (rank 1) can never defeat it: the label is
  // already one of the items the recontact guard weighed. Holds and restrictions still apply.
  const strong_confirmation = text_confirmed && Number(rc.detail?.resolved?.rank) >= 3;
  const thread_message_ids = new Set((facts.thread_messages || []).map((m) => clean(m.id)).filter(Boolean));
  // A property-scoped not-owner LABEL (thread state / an inbound's detected_intent: low confidence):
  //   its property or the row's property unknown → thread HOLD (owner rule 2), never every property;
  //   another property → not this row; the thread text CONFIRMS this property → conflict HOLD (rule 3);
  //   otherwise the property-scoped terminal block.
  const propertyLabelBlock = (signal, pid, source, weighed = false) => {
    if (!clean(pid) || !property_id) return block(R.OWNERSHIP_UNRESOLVED_HOLD, { scope: "thread_hold", signal, source, action: "operator_review" });
    if (clean(pid) !== property_id) return null;
    // only a label the recontact guard already WEIGHED (an inbound in the thread with its time); a thread-state
    // label carries no time, so against text it stays the conflict hold (owner rule 3)
    if (strong_confirmation && weighed) return null;
    if (text_confirmed) return block(R.OWNERSHIP_UNRESOLVED_HOLD, { scope: "thread_hold", conflict: true, signal, source, action: "operator_review" });
    if (PROPERTY_SCOPED_DECLINED.has(signal)) return block(R.OWNERSHIP_DECLINED_HOLD, { scope: "person_property", ownership: "unverified", signal, source });
    return block(R.PRIOR_REPLY_NOT_OWNER, { scope: "person_property", signal, source });
  };

  // 0. rc-8.5.21: the automation-hold registry (fail closed: a lookup error is a hold). Only
  //    evaluated when the loader provided it (pure callers without the fact are unchanged).
  if (facts.automation_hold && facts.automation_hold.held === true) {
    return block(R.AUTOMATION_HOLD, { hold_type: facts.automation_hold.hold_type || null, hold_reason: facts.automation_hold.reason || null, hold_id: facts.automation_hold.hold_id || null });
  }

  // 1. sms_suppression_list
  for (const s of facts.suppressions || []) {
    if (s.is_active === false) continue;
    if (!same(s.phone_e164) && !same(s.phone_number)) continue;
    if (clean(s.sender_phone_e164) && from_key && phoneKey(s.sender_phone_e164) !== from_key) continue;
    return block(R.SUPPRESSION_LIST, { suppression_type: s.suppression_type || null });
  }
  // 2. automation_suppressions (any type)
  for (const s of facts.automation_suppressions || []) {
    if (!same(s.phone_e164)) continue;
    if (!isActiveAutomationSuppression(s, now_ms)) continue;
    return block(R.AUTOMATION_SUPPRESSION, { suppression_type: s.suppression_type || null });
  }
  // 2b. rc-8.5.21 v4 INDEPENDENT final-dispatch enforcement: the latest inbound's own text. A stop / possible
  //     stop is never answered by any automated row, even if every writer missed it (an operator-composed
  //     manual send is judged by the written suppression / hold rows above)
  if (Array.isArray(facts.thread_messages) && facts.thread_messages.length && !(row?.metadata && row.metadata.manual_operator_send === true)) {
    const stopLike = latestInboundStopLike(facts.thread_messages, facts.precautionary_releases || facts.automation_suppressions || []);
    if (stopLike) return block(R.LATEST_INBOUND_STOP_LIKE, { ...stopLike, scope: "contact", action: stopLike.confirmed ? "suppress" : "precautionary_hold_operator_review" });
  }
  // 3 / 4 / 5. thread state
  for (const t of facts.threads || []) {
    if (!same(t.thread_key) && !same(t.canonical_e164)) continue;
    if (t.is_suppressed === true) return block(R.THREAD_SUPPRESSED);
    const signals = [t.disposition, t.last_intent, t.stage, t.lifecycle_stage, t.contactability_status].map(lower).filter(Boolean);
    if (signals.some((s) => OPT_OUT_SIGNALS.has(s)) || BLOCKING_CONTACTABILITY.has(lower(t.contactability_status))) {
      return block(R.THREAD_OPTED_OUT, { signal: signals.find((s) => OPT_OUT_SIGNALS.has(s) || BLOCKING_CONTACTABILITY.has(s)) || null });
    }
    if (signals.some((s) => PHONE_SCOPED_NOT_OWNER.has(s))) return block(R.WRONG_NUMBER, { source: "thread_state" });
    const prop_signal = signals.find((s) => PROPERTY_SCOPED_NOT_OWNER.has(s) || PROPERTY_SCOPED_DECLINED.has(s));
    if (prop_signal) {
      const b = propertyLabelBlock(prop_signal, t.property_id, "thread_state");
      if (b) return b;
    }
  }
  // 4. public.phones wrong-number evidence
  for (const p of facts.phones || []) {
    if (!same(p.canonical_e164) && !same(p.phone) && !same(p.phone_raw) && !(clean(row.phone_id) && clean(p.phone_id) === clean(row.phone_id))) continue;
    if (lower(p.phone_contact_status) === "wrong_number" || clean(p.wrong_number_at)) return block(R.WRONG_NUMBER, { source: "phones" });
  }
  // 3 / 4 / 5. inbound replies from this phone
  for (const m of facts.inbound_replies || []) {
    if (!same(m.from_phone_number)) continue;
    const intent = lower(m.detected_intent);
    if (m.is_opt_out === true || OPT_OUT_SIGNALS.has(intent)) return block(R.OPT_OUT_REPLY);
    if (PHONE_SCOPED_NOT_OWNER.has(intent)) return block(R.WRONG_NUMBER, { source: "inbound_reply" });
    if (PROPERTY_SCOPED_NOT_OWNER.has(intent) || PROPERTY_SCOPED_DECLINED.has(intent)) {
      const b = propertyLabelBlock(intent, m.property_id, "inbound_reply", Boolean(clean(m.id) && thread_message_ids.has(clean(m.id))));
      if (b) return b;
    }
  }

  // 5b. rc-8.5.21 RECONTACT GUARD: the thread's OWN messages, not labels — an ownership denial
  //     for this property (bare "No" to our ownership question, an explicit denial, a not-owner
  //     label) blocks every outbound about it until new valid ownership evidence; a manual send
  //     may cross it only with an audited override (ownership-recontact-guard.js).
  if (rc?.blocked) {
    if (rc.detail?.scope === "phone") return block(R.THREAD_OPTED_OUT, { ...rc.detail, guard: rc.version });
    if (rc.reason === R.PROPERTY_DO_NOT_CONTACT) return block(R.PROPERTY_DO_NOT_CONTACT, { ...rc.detail, guard: rc.version });
    if (rc.hold) return block(R.OWNERSHIP_UNRESOLVED_HOLD, { ...rc.detail, guard: rc.version });
    if (rc.reason === "ownership_declined_unverified_hold") return block(R.OWNERSHIP_DECLINED_HOLD, { ...rc.detail, guard: rc.version });
    return block(R.PRIOR_REPLY_NOT_OWNER, { source: "message_text", ...rc.detail, guard: rc.version });
  }

  // 5b'. rc-8.5.21 v3 (owner 2026-10-19): no unsolicited follow-up / nurture on a hostile thread.
  if (isUnsolicitedFollowUpRow(row)) {
    const hostileThread = (facts.threads || []).find((t) => (same(t.thread_key) || same(t.canonical_e164)) && HOSTILE_LABELS.has(lower(t.last_intent)));
    const hostileMsg = unresolvedHostileInbound(facts.thread_messages || []);
    if (hostileMsg || hostileThread) return block(R.HOSTILE_THREAD_NO_NURTURE, { scope: "thread", source: hostileMsg ? "message_text" : "thread_state", hostile_message_id: hostileMsg?.id ? String(hostileMsg.id) : null, action: "cancel_nurture" });
  }

  // the canonical queue writer (enqueue) judges the RESTRICTIONS only: contact-history (already
  // contacted) and content checks stay with the dispatcher
  if (restrictionsOnly) return { ...PASS, restrictions_only: true };

  // 5c. rc-8.5.21 (owner 2026-10-13 + Pittsburgh 8d03a7c4): an asking-price question after the
  //     seller already STATED a price ("460 k not a penny less") is never sent, whoever writes it
  //     (the DB trigger only knows prior ASKS). A manual send may cross it with the audited
  //     repeat-ask override (outbound-question-kind.js), never an automated path.
  if (Array.isArray(facts.thread_messages) && facts.thread_messages.length) {
    const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const kind = resolveOutboundQuestionKind({ message_body: row.message_body || row.message_text || "", use_case_template: row.use_case_template, metadata: meta });
    if (kind.question_kind === QUESTION_KIND_ASKING_PRICE && !(meta.manual_operator_send === true && isValidRepeatAskOverride(meta.repeat_ask_override))) {
      const stated = statedAskingPrice(facts.thread_messages);
      if (stated) return block(R.ASKING_PRICE_ALREADY_STATED, { source: stated.source, price_message_id: stated.message_id });
    }
  }

  // 6. already contacted — first-touch openers only.
  if (!isOpenerRow(row)) return { ...PASS, opener: false };
  const person = clean(row.prospect_id);
  const person_keys = new Set([key, ...(facts.person_phones || []).map(phoneKey).filter(Boolean)]);
  const touches = [...(facts.prior_sends || []), ...(facts.prior_outbound_events || [])].filter((o) => isPriorTouch(o, row));
  const toPhone = touches.filter((o) => phoneKey(o.to_phone_number) === key);
  const pair = toPhone.filter((o) => !person || !clean(o.prospect_id) || clean(o.prospect_id) === person);
  if (pair.length) return block(R.ALREADY_CONTACTED_PAIR, { touches: pair.length });
  if (toPhone.length) return block(R.ALREADY_CONTACTED_PHONE, { touches: toPhone.length });
  const toPerson = person
    ? touches.filter((o) => clean(o.prospect_id) === person || person_keys.has(phoneKey(o.to_phone_number)))
    : touches.filter((o) => person_keys.has(phoneKey(o.to_phone_number)));
  if (toPerson.length) return block(R.ALREADY_CONTACTED_PERSON, { touches: toPerson.length, other_property: toPerson.some((o) => clean(o.property_id) !== property_id) });
  const aboutProperty = property_id ? touches.filter((o) => clean(o.property_id) === property_id) : [];
  if (aboutProperty.length) return block(R.ALREADY_CONTACTED_PROPERTY, { touches: aboutProperty.length });
  return { ...PASS, opener: true };
}

async function read(query) {
  const result = await query;
  if (result?.error) throw result.error;
  return Array.isArray(result?.data) ? result.data : [];
}

/** Fresh reads for one row. Throws on any read error (the caller fails closed). */
export async function loadSendTimeContactFacts(supabase, row = {}, opts = {}) {
  if (!supabase?.from) throw new Error("send_time_guard_no_client");
  const variants = phoneVariants([row.to_phone_number, row.thread_key]);
  if (!variants.length) return {};
  const property_id = clean(row.property_id);
  const opener = isOpenerRow(row);
  const [suppressions, suppressions_by_number, automation_suppressions, threads_by_key, threads_by_e164, phones, inbound_replies] = await Promise.all([
    read(supabase.from("sms_suppression_list").select("phone_e164,phone_number,sender_phone_e164,is_active,suppression_type").in("phone_e164", variants).limit(50)),
    read(supabase.from("sms_suppression_list").select("phone_e164,phone_number,sender_phone_e164,is_active,suppression_type").in("phone_number", variants).limit(50)),
    read(supabase.from("automation_suppressions").select("phone_e164,status,suppression_type,expires_at").in("phone_e164", variants).limit(50)),
    read(supabase.from("inbox_thread_state").select("thread_key,canonical_e164,property_id,is_suppressed,disposition,last_intent,stage,lifecycle_stage,contactability_status").in("thread_key", variants).limit(50)),
    read(supabase.from("inbox_thread_state").select("thread_key,canonical_e164,property_id,is_suppressed,disposition,last_intent,stage,lifecycle_stage,contactability_status").in("canonical_e164", variants).limit(50)),
    read(supabase.from("phones").select("phone_id,canonical_e164,phone,phone_raw,phone_contact_status,wrong_number_at,primary_prospect_id,canonical_prospect_id").in("canonical_e164", variants).limit(20)),
    read(supabase.from("message_events").select("id,from_phone_number,property_id,detected_intent,is_opt_out").eq("direction", "inbound").in("from_phone_number", variants).in("detected_intent", SEND_TIME_REPLY_INTENTS).limit(200)),
  ]);
  // rc-8.5.21: the thread's own messages (recontact guard) and the automation-hold registry
  const contact_property_resolution = await read(supabase.from("contact_property_resolution").select("property_id,contact_phone_e164,contact_property_role,suppression_scope,rejected_at,rejection_reason,updated_at").in("contact_phone_e164", variants).limit(50));
  const thread_messages = await read(supabase.from("message_events").select("id,direction,message_body,created_at,event_timestamp,property_id,detected_intent").in("thread_key", variants).order("created_at", { ascending: false }).limit(60));
  // rc-8.5.21 v4: operator RELEASES of a precautionary hold (best effort: unreadable ⇒ none known ⇒ the stop-like
  // latest inbound stays blocked — fail closed)
  let precautionary_releases = [];
  try {
    precautionary_releases = await read(supabase.from("automation_suppressions").select("phone_e164,status,suppression_type,payload").in("phone_e164", variants).eq("suppression_type", "precautionary_no_contact").limit(50));
  } catch { precautionary_releases = []; }
  const automation_hold = await checkAutomationHoldPort({ threadKey: clean(row.thread_key) || clean(row.to_phone_number), propertyId: property_id || null, masterOwnerId: clean(row.master_owner_id) || null, capability: "send_time_dispatch" }, { checker: opts.automationHoldChecker || null });
  const facts = {
    precautionary_releases,
    suppressions: [...suppressions, ...suppressions_by_number],
    automation_suppressions,
    threads: [...threads_by_key, ...threads_by_e164],
    phones,
    inbound_replies,
    prior_sends: [],
    prior_outbound_events: [],
    person_phones: [],
    thread_messages,
    contact_property_resolution,
    automation_hold,
  };
  if (!opener || opts.restrictionsOnly === true) return facts;

  const person = clean(row.prospect_id);
  const person_phones = person
    ? [
        ...(await read(supabase.from("phones").select("canonical_e164").eq("primary_prospect_id", person).limit(20))),
        ...(await read(supabase.from("phones").select("canonical_e164").eq("canonical_prospect_id", person).limit(20))),
      ].map((p) => p.canonical_e164).filter(Boolean)
    : [];
  const reach = phoneVariants([...variants, ...person_phones]);
  const SEND_COLS = "id,to_phone_number,property_id,prospect_id,queue_status,sent_at,created_at";
  const EVENT_COLS = "id,direction,to_phone_number,property_id,prospect_id,event_type,delivery_status,is_final_failure,queue_id";
  const [by_phone, by_property, ev_phone, ev_property] = await Promise.all([
    read(supabase.from("send_queue").select(SEND_COLS).in("to_phone_number", reach).limit(500)),
    property_id ? read(supabase.from("send_queue").select(SEND_COLS).eq("property_id", property_id).limit(500)) : [],
    read(supabase.from("message_events").select(EVENT_COLS).eq("direction", "outbound").in("to_phone_number", reach).limit(300)),
    property_id ? read(supabase.from("message_events").select(EVENT_COLS).eq("direction", "outbound").eq("property_id", property_id).limit(300)) : [],
  ]);
  facts.person_phones = person_phones;
  facts.prior_sends = [...by_phone, ...by_property];
  facts.prior_outbound_events = [...ev_phone, ...ev_property];
  return facts;
}

/** Load + evaluate. Never throws: a read error is a fail-closed block. */
export async function runSendTimeContactGuard(row = {}, { supabase, now = Date.now(), loadFacts = loadSendTimeContactFacts } = {}) {
  let facts;
  try {
    facts = await loadFacts(supabase, row);
  } catch (error) {
    return block(R.READ_FAILED, { error: clean(error?.message || error).slice(0, 200) || "read_failed" });
  }
  return evaluateSendTimeContactGuard(row, facts, { now });
}

export default runSendTimeContactGuard;

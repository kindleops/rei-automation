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

import { SEND_TIME_BLOCK_REASONS } from "@/lib/domain/compliance/canonical-no-contact-states.js";

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
  ALREADY_CONTACTED_PAIR: "already_contacted_person_phone",
  ALREADY_CONTACTED_PHONE: "already_contacted_phone",
  ALREADY_CONTACTED_PERSON: "already_contacted_person",
  ALREADY_CONTACTED_PROPERTY: "already_contacted_property",
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
  [R.ALREADY_CONTACTED_PAIR]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PHONE]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PERSON]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
  [R.ALREADY_CONTACTED_PROPERTY]: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
});

/** Same sets as opener-reply-exclusion.js (a372ae53). Change both or neither. */
export const PROPERTY_SCOPED_NOT_OWNER = Object.freeze(new Set([
  "property_specific_non_owner", "former_owner_respondent", "sold_property", "sold",
  "tenant_respondent", "non_owner_referral", "not_owner",
]));
export const PHONE_SCOPED_NOT_OWNER = Object.freeze(new Set(["wrong_number", "wrong_person"]));
const OPT_OUT_SIGNALS = new Set(["opt_out", "opted_out", "stop", "dnc", "do_not_contact", "suppressed", "unsubscribed"]);
const BLOCKING_CONTACTABILITY = new Set(["opt_out", "opted_out", "suppressed", "do_not_contact", "dnc", "invalid", "blocked"]);
export const SEND_TIME_REPLY_INTENTS = Object.freeze([...PROPERTY_SCOPED_NOT_OWNER, ...PHONE_SCOPED_NOT_OWNER, ...OPT_OUT_SIGNALS]);

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
export function evaluateSendTimeContactGuard(row = {}, facts = {}, { now = Date.now() } = {}) {
  const key = phoneKey(row.to_phone_number || row.thread_key);
  if (!key) return block(R.WRONG_NUMBER, { why: "recipient_phone_unparseable" });
  const from_key = phoneKey(row.from_phone_number);
  const same = (v) => phoneKey(v) === key;
  const now_ms = typeof now === "number" ? now : Date.parse(now);
  const property_id = clean(row.property_id);
  const sameProperty = (pid) => !clean(pid) || !property_id || clean(pid) === property_id;

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
  // 3 / 4 / 5. thread state
  for (const t of facts.threads || []) {
    if (!same(t.thread_key) && !same(t.canonical_e164)) continue;
    if (t.is_suppressed === true) return block(R.THREAD_SUPPRESSED);
    const signals = [t.disposition, t.last_intent, t.stage, t.lifecycle_stage, t.contactability_status].map(lower).filter(Boolean);
    if (signals.some((s) => OPT_OUT_SIGNALS.has(s)) || BLOCKING_CONTACTABILITY.has(lower(t.contactability_status))) {
      return block(R.THREAD_OPTED_OUT, { signal: signals.find((s) => OPT_OUT_SIGNALS.has(s) || BLOCKING_CONTACTABILITY.has(s)) || null });
    }
    if (signals.some((s) => PHONE_SCOPED_NOT_OWNER.has(s))) return block(R.WRONG_NUMBER, { source: "thread_state" });
    const prop_signal = signals.find((s) => PROPERTY_SCOPED_NOT_OWNER.has(s));
    if (prop_signal && sameProperty(t.property_id)) return block(R.PRIOR_REPLY_NOT_OWNER, { scope: "person_property", signal: prop_signal, source: "thread_state" });
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
    if (PROPERTY_SCOPED_NOT_OWNER.has(intent) && sameProperty(m.property_id)) {
      return block(R.PRIOR_REPLY_NOT_OWNER, { scope: "person_property", signal: intent, source: "inbound_reply" });
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
export async function loadSendTimeContactFacts(supabase, row = {}) {
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
    read(supabase.from("message_events").select("from_phone_number,property_id,detected_intent,is_opt_out").eq("direction", "inbound").in("from_phone_number", variants).in("detected_intent", SEND_TIME_REPLY_INTENTS).limit(200)),
  ]);
  const facts = {
    suppressions: [...suppressions, ...suppressions_by_number],
    automation_suppressions,
    threads: [...threads_by_key, ...threads_by_e164],
    phones,
    inbound_replies,
    prior_sends: [],
    prior_outbound_events: [],
    person_phones: [],
  };
  if (!opener) return facts;

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

/**
 * term-conditions.js
 *
 * "I'LL DO 185 IF YOU CLOSE BEFORE THE 20TH" IS ONE FACT, NOT TWO.
 *
 * Flattening it to `seller price = 185000` is the single most expensive
 * normalization mistake available in this phase, because the number survives
 * and the condition does not. Weeks later somebody offers 185 with a 45-day
 * close and cannot understand why the seller is angry. The seller told us. We
 * dropped half the sentence.
 *
 * So a condition is not metadata hanging off a price. It is part of the price,
 * it travels with the assertion, and reconciliation treats a conditional term
 * and an unconditional one as different terms.
 *
 *   190 as-is.                      condition: as_is
 *   200 if you cover the taxes.     condition: buyer_pays_taxes
 *   180 once the tenant is out.     condition: after_tenant_vacancy  (NO DATE)
 *   185 if you close before the 20th. condition: close_before <date>
 *
 * ── RELATIVE TIME, AND THE DATES WE REFUSE TO INVENT ──────────────────────
 *
 * "Friday", "two weeks", "end of month" and "before the 20th" are all
 * resolvable against the moment the seller wrote them, and all of them are
 * resolved here -- against the COMMUNICATION timestamp, never against now(),
 * because a message processed three days late would otherwise land three days
 * wrong.
 *
 * "After the tenant leaves" is not resolvable and must not be resolved. There
 * is no date in it. Inventing one -- a guess at 30 days, the end of a lease we
 * have not seen -- produces a deadline the seller never agreed to, and it will
 * be wrong in the direction of chasing them too early. The condition stays
 * event-driven until a move-out date arrives from somewhere that actually knows
 * one.
 *
 * ── ALWAYS KEEPS THE ORIGINAL PHRASE ──────────────────────────────────────
 *
 * Every normalization stores what the seller actually wrote beside the value it
 * produced. When a normalization is wrong -- and over enough sellers it will
 * be -- the original is what lets somebody see that it was.
 */

import { asObject } from "@/lib/hostile-input.js";

export const TERM_CONDITIONS_POLICY_VERSION = "term_conditions_v1";

export const CONDITION_KIND = Object.freeze({
  CLOSE_BEFORE: "close_before",
  CLOSE_AFTER: "close_after",
  CLOSE_WITHIN: "close_within",
  AS_IS: "as_is",
  BUYER_PAYS_TAXES: "buyer_pays_taxes",
  BUYER_PAYS_CLOSING_COSTS: "buyer_pays_closing_costs",
  BUYER_PAYS_REPAIRS: "buyer_pays_repairs",
  CASH_ONLY: "cash_only",
  AFTER_TENANT_VACANCY: "after_tenant_vacancy",
  AFTER_PROBATE: "after_probate",
  REQUIRES_CO_OWNER_APPROVAL: "requires_co_owner_approval",
  LEASEBACK: "leaseback",
  OTHER: "other_condition",
});

/**
 * Conditions that depend on an EVENT rather than a date. These never carry a
 * resolved date, however much a downstream consumer would like one.
 */
export const EVENT_DRIVEN_CONDITIONS = Object.freeze(new Set([
  CONDITION_KIND.AFTER_TENANT_VACANCY,
  CONDITION_KIND.AFTER_PROBATE,
  CONDITION_KIND.REQUIRES_CO_OWNER_APPROVAL,
]));

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * A guard for patterns whose subject may be elided after a conjunction. The
 * match only counts when the sentence actually addresses US somewhere -- "you"
 * or "buyer" -- so a seller describing what THEY will do is never recorded as a
 * term we have to meet.
 */
const SECOND_PERSON_REQUIRED = (text, match) => {
  if (!/^and\b/i.test(match.trim())) return true;
  const before = text.slice(0, text.toLowerCase().indexOf(match.toLowerCase()));
  if (/\b(?:i|we)\s+(?:will|'ll|can|could|would|am|are)?\s*\w*\s*$/i.test(before)) return false;
  return /\b(?:you|buyer)\b/i.test(before);
};

const CONDITION_PATTERNS = [
  [/\bas[-\s]?is\b/i, CONDITION_KIND.AS_IS],
  [/\bcash\s+only\b|\ball\s+cash\b/i, CONDITION_KIND.CASH_ONLY],
  // WHO PAYS is the whole meaning of these three, so the subject matters more
  // than the verb. The subject is also routinely ELIDED after a conjunction --
  // "if you close before the 20th and cover the taxes" -- so `and` is accepted
  // as a stand-in, guarded by requiring a second-person subject earlier in the
  // sentence. Without that guard, "I'll close and cover the taxes" would be
  // recorded as the BUYER paying, which inverts the term.
  [/\b(?:you|buyer|and)\s+(?:can\s+|will\s+|could\s+|would\s+)?(?:cover|pay|pays|paying|covers)\s+(?:the\s+)?(?:back\s+)?taxes\b/i, CONDITION_KIND.BUYER_PAYS_TAXES, SECOND_PERSON_REQUIRED],
  [/\b(?:you|buyer|and)\s+(?:can\s+|will\s+|could\s+|would\s+)?(?:cover|pay|pays|paying|covers)\s+(?:the\s+)?closing\s+costs?\b/i, CONDITION_KIND.BUYER_PAYS_CLOSING_COSTS, SECOND_PERSON_REQUIRED],
  [/\b(?:you|buyer|and)\s+(?:can\s+|will\s+|could\s+|would\s+)?(?:cover|pay|pays|paying|covers|do|fix|handle)\s+(?:the\s+)?repairs?\b/i, CONDITION_KIND.BUYER_PAYS_REPAIRS, SECOND_PERSON_REQUIRED],
  [/\b(?:once|after|when)\s+(?:the\s+)?tenants?\s+(?:is|are|has|have)?\s*(?:out|move[sd]?\s*out|left|leaves?|vacat\w+|gone)\b/i, CONDITION_KIND.AFTER_TENANT_VACANCY],
  [/\b(?:once|after|when)\s+(?:the\s+)?(?:probate|estate)\s+(?:is\s+)?(?:clears?|closed?|settled?|done|complete[d]?)\b/i, CONDITION_KIND.AFTER_PROBATE],
  [/\b(?:my|our)\s+(?:sister|brother|wife|husband|spouse|partner|son|daughter|family)\s+(?:has\s+to|needs?\s+to|must)\s+(?:agree|approve|sign\s*off)\b/i, CONDITION_KIND.REQUIRES_CO_OWNER_APPROVAL],
  [/\b(?:rent\s*back|lease\s*back|stay\s+(?:on|in)\s+(?:for|until))\b/i, CONDITION_KIND.LEASEBACK],
];

const WEEKDAYS = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
});

/**
 * Resolve a relative time phrase against WHEN THE SELLER WROTE IT.
 *
 * @param {string} phrase
 * @param {string} reference_iso  the communication timestamp, not now()
 * @returns {{ok:true, kind, date?:string, days?:number, phrase}|{ok:false, reason, phrase}}
 */
export function normalizeRelativeTime(phrase, reference_iso) {
  const text = clean(phrase).toLowerCase();
  const reference = new Date(clean(reference_iso));
  if (!text) return { ok: false, reason: "empty_phrase", phrase: clean(phrase) };
  if (!Number.isFinite(reference.getTime())) {
    // Without the moment the seller wrote it, "Friday" has no meaning. Falling
    // back to now() would silently shift every date by the processing delay.
    return { ok: false, reason: "no_reference_timestamp", phrase: clean(phrase) };
  }

  const iso = (date) => date.toISOString().slice(0, 10);
  const shift = (days) => {
    const next = new Date(reference.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  };

  if (/\btomorrow\b/.test(text)) return { ok: true, kind: "date", date: iso(shift(1)), phrase: text };
  if (/\btoday\b/.test(text)) return { ok: true, kind: "date", date: iso(reference), phrase: text };

  const in_days = /\b(?:in|within|give me)\s+(?:about\s+)?(\d{1,3})\s*(day|days|week|weeks|month|months)\b/.exec(text)
    || /\b(\d{1,3})\s*(day|days|week|weeks|month|months)\b/.exec(text);
  if (in_days) {
    const amount = Number(in_days[1]);
    const unit = in_days[2];
    const days = unit.startsWith("week") ? amount * 7 : unit.startsWith("month") ? amount * 30 : amount;
    return { ok: true, kind: "window", days, date: iso(shift(days)), phrase: text };
  }

  const worded = /\b(?:a\s+couple\s+of|a\s+few|two|three|four)\s+(week|weeks|month|months|day|days)\b/.exec(text);
  if (worded) {
    const amount = /two|a\s+couple/.test(worded[0]) ? 2 : /three/.test(worded[0]) ? 3 : /four/.test(worded[0]) ? 4 : 3;
    const unit = worded[1];
    const days = unit.startsWith("week") ? amount * 7 : unit.startsWith("month") ? amount * 30 : amount;
    return { ok: true, kind: "window", days, date: iso(shift(days)), phrase: text };
  }

  if (/\bend\s+of\s+(?:the\s+)?month\b/.test(text)) {
    const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0));
    return { ok: true, kind: "date", date: iso(end), phrase: text };
  }

  // Accepts a bare "the 20th" as well as "before the 20th": the caller passes
  // the captured phrase, and the capture deliberately excludes the preposition
  // it already encoded as the condition KIND.
  const before_day = /\b(?:before\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (before_day) {
    const day = Number(before_day[1]);
    if (day >= 1 && day <= 31) {
      // The NEXT occurrence of that day-of-month. A seller writing "before the
      // 20th" on the 25th means next month's 20th, not one five days past.
      let target = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), day));
      if (target.getTime() <= reference.getTime()) {
        target = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, day));
      }
      return { ok: true, kind: "date", date: iso(target), phrase: text };
    }
  }

  const weekday = /\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
  if (weekday) {
    const target_dow = WEEKDAYS[weekday[1]];
    const is_next = /\bnext\s/.test(weekday[0]);
    let delta = (target_dow - reference.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (is_next) delta += 7;
    return { ok: true, kind: "date", date: iso(shift(delta)), phrase: text, weekday_assumed: true };
  }

  // "After Christmas", "after the holidays", "when things settle down": real
  // intent, no computable date. Reported as unresolved rather than guessed.
  return { ok: false, reason: "not_deterministically_resolvable", phrase: text };
}

/**
 * Find the conditions a seller attached to a term.
 *
 * @param {string} text
 * @param {{reference_iso?:string}} [options]
 * @returns {Array<{kind, phrase, date?:string, days?:number, event_driven:boolean}>}
 */
export function extractConditions(raw_text, options = {}) {
  const text = clean(typeof raw_text === "string" ? raw_text : asObject(raw_text).text);
  if (!text) return [];

  const reference_iso = clean(asObject(options).reference_iso);
  const conditions = [];
  const seen = new Set();

  const push = (condition) => {
    const signature = `${condition.kind}:${condition.date || condition.days || ""}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    conditions.push(condition);
  };

  for (const [pattern, kind, guard] of CONDITION_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (typeof guard === "function" && !guard(text, match[0])) continue;
    push({
      kind,
      phrase: match[0].trim(),
      event_driven: EVENT_DRIVEN_CONDITIONS.has(kind),
      // Event-driven conditions NEVER carry a date, even when the sentence
      // happens to contain one elsewhere.
      date: null,
    });
  }

  // ── closing timing ───────────────────────────────────────────────────────
  // The capture STOPS at a conjunction. Running greedily to the end of the
  // clause swallowed the next condition whole: "close before the 20th and cover
  // the taxes" captured "the 20th and cover the taxes" as one date phrase,
  // which resolved to nothing AND hid the taxes condition.
  const UNTIL_CONJUNCTION = "((?:(?!\\b(?:and|but|or|if|though|although)\\b)[^.,;!?]){2,40})";
  const close_before = new RegExp(`\\bclos\\w*\\s+(?:by|before|no later than)\\s+${UNTIL_CONJUNCTION}`, "i").exec(text);
  const close_within = new RegExp(`\\bclos\\w*\\s+(?:in|within)\\s+${UNTIL_CONJUNCTION}`, "i").exec(text);
  const close_after = new RegExp(`\\bclos\\w*\\s+(?:after|once)\\s+${UNTIL_CONJUNCTION}`, "i").exec(text);

  for (const [match, kind] of [
    [close_before, CONDITION_KIND.CLOSE_BEFORE],
    [close_within, CONDITION_KIND.CLOSE_WITHIN],
    [close_after, CONDITION_KIND.CLOSE_AFTER],
  ]) {
    if (!match) continue;
    const phrase = match[1].trim();
    const resolved = reference_iso ? normalizeRelativeTime(phrase, reference_iso) : { ok: false, reason: "no_reference_timestamp" };

    // An "after the tenant is out" close is event-driven regardless of the
    // closing verb that introduced it, so it must not acquire a date here.
    const already_event_driven = conditions.some((c) => c.event_driven);
    push({
      kind,
      phrase,
      event_driven: already_event_driven && kind === CONDITION_KIND.CLOSE_AFTER,
      date: already_event_driven && kind === CONDITION_KIND.CLOSE_AFTER ? null : (resolved.ok ? resolved.date ?? null : null),
      days: resolved.ok ? resolved.days ?? null : null,
      unresolved_reason: resolved.ok ? null : resolved.reason,
    });
  }

  return conditions;
}

/**
 * Does this term carry a condition that materially changes it?
 *
 * The question reconciliation asks before treating a new price as comparable to
 * an old one. "185 if you close Friday" and "185" are not the same term, and
 * quietly replacing one with the other loses the seller's actual position.
 */
export function hasMaterialCondition(conditions) {
  return (Array.isArray(conditions) ? conditions : []).length > 0;
}

export default extractConditions;

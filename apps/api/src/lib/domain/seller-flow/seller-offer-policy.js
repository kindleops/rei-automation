// ─── seller-offer-policy.js ─────────────────────────────────────────────────
// THE single source of the contractual seller-offer terms.
//
// Every literal below appears exactly ONCE in the codebase. Nothing else may
// hardcode a closing window, an EMD amount, or an EMD due period — modules take
// them from SELLER_OFFER_POLICY_V1 (or the resolver) so a policy change is a
// one-line edit here and is versioned onto every offer it produced.
//
// SCOPE BOUNDARY. This module owns the DURABLE CONTRACTUAL values. It does not
// own seller-facing phrasing: negotiation-policy.js resolveClosingTermPolicy
// owns timing LANGUAGE and explicitly prohibits `guaranteed_close_date` /
// `seven_day_close` claims in automated sends. Both can be true at once — the
// offer package carries an exact 14-day window while the SMS still speaks about
// timing naturally rather than promising a calendar date.

function num(value) {
  // NOTE: Number(null) === 0 and Number("") === 0, both finite. Without this
  // guard an absent override would coerce to 0 and then win the `??` against
  // the policy default, silently producing a 0-day window and a $0 EMD.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Authorized business policy. Bump the version when any value changes. */
export const SELLER_OFFER_POLICY_V1 = Object.freeze({
  policy_version: "v1",
  closing_window_days: 14,
  earnest_money_amount: 1000,
  earnest_money_due_business_days: 3,
});

export const ACTIVE_SELLER_OFFER_POLICY = SELLER_OFFER_POLICY_V1;

// Recognized non-business days. Weekends are unambiguous; these are the US
// federal holidays that title/escrow desks observe. Centralized and versioned
// here so the set is auditable and changeable in one place.
const FIXED_HOLIDAYS = Object.freeze([
  [0, 1], // New Year's Day
  [5, 19], // Juneteenth
  [6, 4], // Independence Day
  [10, 11], // Veterans Day
  [11, 25], // Christmas Day
]);

// [month, weekday, nth] — nth = -1 means last weekday of the month.
const FLOATING_HOLIDAYS = Object.freeze([
  [0, 1, 3], // MLK Day: 3rd Monday of January
  [1, 1, 3], // Presidents Day: 3rd Monday of February
  [4, 1, -1], // Memorial Day: last Monday of May
  [8, 1, 1], // Labor Day: 1st Monday of September
  [9, 1, 2], // Columbus Day: 2nd Monday of October
  [10, 4, 4], // Thanksgiving: 4th Thursday of November
]);

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month, day));
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const shift = (last.getUTCDay() - weekday + 7) % 7;
    return utcDate(year, month, last.getUTCDate() - shift);
  }
  const first = utcDate(year, month, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, month, 1 + shift + (nth - 1) * 7);
}

function holidayKeysForYear(year) {
  const keys = new Set();
  const add = (d) => keys.add(d.toISOString().slice(0, 10));

  for (const [month, day] of FIXED_HOLIDAYS) {
    const d = utcDate(year, month, day);
    add(d);
    // Federal observance: Saturday holidays observe Friday, Sunday observe Monday.
    if (d.getUTCDay() === 6) add(utcDate(year, month, day - 1));
    if (d.getUTCDay() === 0) add(utcDate(year, month, day + 1));
  }
  for (const [month, weekday, nth] of FLOATING_HOLIDAYS) {
    add(nthWeekdayOfMonth(year, month, weekday, nth));
  }
  return keys;
}

const holidayCache = new Map();
function holidaysFor(year) {
  if (!holidayCache.has(year)) holidayCache.set(year, holidayKeysForYear(year));
  return holidayCache.get(year);
}

/** A business day is a weekday that is not a recognized holiday. */
export function isBusinessDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidaysFor(d.getUTCFullYear()).has(d.toISOString().slice(0, 10));
}

/** Roll a date forward until it lands on a business day (no-op if already one). */
export function rollForwardToBusinessDay(date) {
  const d = new Date(date instanceof Date ? date.getTime() : new Date(date).getTime());
  if (Number.isNaN(d.getTime())) return null;
  let guard = 0;
  while (!isBusinessDay(d) && guard < 30) {
    d.setUTCDate(d.getUTCDate() + 1);
    guard += 1;
  }
  return d;
}

/** Add N business days to a date (used for the EMD due date). */
export function addBusinessDays(date, businessDays) {
  const d = new Date(date instanceof Date ? date.getTime() : new Date(date).getTime());
  if (Number.isNaN(d.getTime())) return null;
  let remaining = Math.max(0, Number(businessDays) || 0);
  let guard = 0;
  while (remaining > 0 && guard < 400) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d)) remaining -= 1;
    guard += 1;
  }
  return d;
}

/**
 * The contractual terms every NEWLY PROPOSED offer carries before it is sent.
 * Negotiated overrides may replace individual values, but only by creating a
 * NEW offer version — never by mutating an existing one.
 */
export function resolveNewOfferTerms({ overrides = {} } = {}) {
  const p = ACTIVE_SELLER_OFFER_POLICY;
  const closing_window_days = num(overrides.closing_window_days) ?? p.closing_window_days;
  const earnest_money = num(overrides.earnest_money) ?? p.earnest_money_amount;
  const emd_due_business_days =
    num(overrides.earnest_money_due_business_days) ?? p.earnest_money_due_business_days;

  return {
    closing_window_days,
    closing_term: `${closing_window_days}_calendar_days_from_acceptance`,
    earnest_money,
    emd_due_business_days,
    emd_term: `${emd_due_business_days}_business_days_from_acceptance`,
    policy_version: p.policy_version,
  };
}

/**
 * scheduled_closing_date = acceptance timestamp + closing_window_days CALENDAR
 * days, rolled forward to the next business day when it lands on a weekend or a
 * recognized holiday. Returns a YYYY-MM-DD string (the column is a DATE).
 */
export function computeScheduledClosingDate({
  accepted_at = null,
  closing_window_days = null,
} = {}) {
  const base = accepted_at ? new Date(accepted_at) : null;
  if (!base || Number.isNaN(base.getTime())) return null;
  const days = num(closing_window_days);
  if (days === null || days < 0) return null;

  const target = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days)
  );
  const rolled = rollForwardToBusinessDay(target);
  return rolled ? rolled.toISOString().slice(0, 10) : null;
}

/** EMD due date = acceptance + emd_due_business_days business days. */
export function computeEmdDueDate({ accepted_at = null, emd_due_business_days = null } = {}) {
  const base = accepted_at ? new Date(accepted_at) : null;
  if (!base || Number.isNaN(base.getTime())) return null;
  const days = num(emd_due_business_days);
  if (days === null || days < 0) return null;
  const start = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())
  );
  const due = addBusinessDays(start, days);
  return due ? due.toISOString().slice(0, 10) : null;
}

// Every term a contract must carry. A closing case refuses creation when any of
// these is missing — nothing is defaulted at contract time.
export const CONTRACT_BEARING_TERMS = Object.freeze([
  "offer_id",
  "offer_version",
  "opportunity_id",
  "thread_key",
  "purchase_price",
  "closing_window_days",
  "closing_date",
  // Canonical column name on seller_offers is emd_amount (not earnest_money).
  "emd_amount",
  "emd_due_business_days",
  "terms_hash",
  "acceptance_event_id",
  "accepted_at",
]);

/**
 * Validate that an accepted offer is contract-complete.
 * Returns { ok, missing[] }. `0` is a legitimate value for nothing here, so a
 * zero EMD is treated as missing rather than silently inferred.
 */
export function assertContractComplete(offer = {}) {
  const missing = [];
  for (const field of CONTRACT_BEARING_TERMS) {
    const value = offer?.[field];
    if (value === null || value === undefined || value === "") {
      missing.push(field);
      continue;
    }
    if (
      (field === "purchase_price" || field === "emd_amount") &&
      !(Number(value) > 0)
    ) {
      missing.push(field);
    }
  }
  return { ok: missing.length === 0, missing };
}

export default SELLER_OFFER_POLICY_V1;

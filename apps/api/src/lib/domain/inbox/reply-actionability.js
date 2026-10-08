// ─── reply-actionability.js ──────────────────────────────────────────────────
// Inbox Actionability 8.5 (2026-10-06). ONE vocabulary for "can we actually do
// something with this reply?", read by the bucket predicate (SQL view
// v_inbox_thread_state_buckets + its JS mirror resolveInboxBucketFlags), the
// bucket writer, the temperature model and the hot-lead flag.
//
// Owner, 2026-10-06: "Why are 'no, I'm not the owner' replies in my New
// Replies? ... People saying '$5 million', or 'shitstains on the walls', and
// the system takes that as a HOT LEAD. New Replies and Priority are ONLY
// messages we can actually do something with. Junk goes under All messages."
//
// Intent names are the canonical classify.js vocabulary
// (seller-flow/coverage-net/canonical-intent-aliases.js) plus the two legacy
// spellings still stored on old rows (wrong_person, sold_property).
//
// The SQL view carries the same three lists as literals. Change them together:
// tests/inbox-actionability-buckets.test.mjs reads the PROPOSED migration and
// fails when the lists drift.

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * A latest inbound with one of these intents is NOT actionable: it never sits
 * in New Replies or Priority and never makes a lead warm or hot. Where it goes
 * instead is decided elsewhere and is unchanged:
 *   opt_out / hostile_or_legal          -> Suppressed (compliance)
 *   wrong_number, non-owners, sold      -> Dead / All
 *   not_interested / need_time          -> Follow-up (30-day nurture, NOT
 *                                          suppressed, NOT archived)
 *   hostile_or_troll                    -> All (review lane when it needs a human)
 *   asking_price_implausible            -> All (one reality-check reply)
 *   acknowledgement / reaction_only     -> All ("thanks" / 👍 closes nothing)
 */
export const NON_ACTIONABLE_REPLY_INTENTS = Object.freeze([
  "opt_out",
  "hostile_or_legal",
  "hostile_or_troll",
  "wrong_number",
  "wrong_person",
  "property_specific_non_owner",
  "tenant_respondent",
  "former_owner_respondent",
  "sold_property",
  "not_interested",
  "need_time",
  "asking_price_implausible",
  "acknowledgement",
  "reaction_only",
]);

/**
 * Priority = high-value actionable only: a plausible asking price (an
 * implausible one is classified asking_price_implausible), an offer or contract
 * request, strong interest, or a seller asking a human to call — the replies a
 * human should answer inside 15 minutes.
 *
 * ownership_confirmed / latent_interest are New Replies, not Priority: a bare
 * "Yes" and "only for a 1.5 million offer" are answers to work, not hot deals.
 */
export const PRIORITY_REPLY_INTENTS = Object.freeze([
  "asking_price_provided",
  "asks_offer",
  "contract_requested",
  "seller_interested",
  "callback_requested",
  "voicemail_call_request",
]);

/**
 * Warm / hot temperature may only come from a plausible POSITIVE intent on the
 * latest inbound. Everything else (unclear, who-is-this, a referral, a troll, a
 * number inside a joke) is at most cold, whatever earlier turns said.
 */
export const POSITIVE_REPLY_INTENTS = Object.freeze([
  ...PRIORITY_REPLY_INTENTS,
  "ownership_confirmed",
  "latent_interest",
  "condition_disclosed",
]);

/**
 * Round 9 (owner, 2026-10-07: "All the messages in New Replies and Priority
 * really shouldn't even be there"). New Replies is a WHITELIST: only a
 * positive or actionable latest reply -- interest, an asking price, a
 * condition / occupancy fact, an offer ask, a referral or co-owner / heir /
 * agent who can talk, a creative / tax / title disclosure, near-acceptance.
 * Everything else that is not already resolved (unclear, who-is-this, a
 * language switch, a bare "No" waiting on its clarifier, an unread emoji)
 * goes to the non-alerting UNCLEAR lane: shown under All, counted, no badge,
 * no push. The automation answers or closes those deterministically.
 */
export const NEW_REPLY_ACTIONABLE_INTENTS = Object.freeze([
  ...POSITIVE_REPLY_INTENTS,
  "asking_price_absent",
  "tenant_occupied",
  "non_owner_referral",
  "co_owner_respondent",
  "executor_heir_respondent",
  "family_member_respondent",
  "entity_representative_respondent",
  "agent_representative_respondent",
  "property_manager_respondent",
  "lien_tax_issue",
  "title_issue",
  "bankruptcy_disclosed",
  "trust_ownership",
  "llc_corporation",
  "requests_email",
  "property_correction",
  "going_to_market",
]);

const NON_ACTIONABLE = new Set(NON_ACTIONABLE_REPLY_INTENTS);
const NEW_REPLY_ACTIONABLE = new Set(NEW_REPLY_ACTIONABLE_INTENTS);
const PRIORITY = new Set(PRIORITY_REPLY_INTENTS);
const POSITIVE = new Set(POSITIVE_REPLY_INTENTS);

export function isNonActionableReplyIntent(intent) {
  return NON_ACTIONABLE.has(lower(intent));
}

export function isPriorityReplyIntent(intent) {
  return PRIORITY.has(lower(intent));
}

export function isPositiveReplyIntent(intent) {
  return POSITIVE.has(lower(intent));
}

/** A latest reply New Replies may hold (round 9 whitelist). */
export function isNewReplyActionableIntent(intent) {
  return NEW_REPLY_ACTIONABLE.has(lower(intent));
}

/**
 * A reply that re-opens a parked (follow-up / nurture) thread: an actionable
 * reply (round 9: the New Replies whitelist). "unclear" / who-is-this alone do
 * not re-open a nurture — that is usually "so I don't care".
 */
export function isReopeningReplyIntent(intent) {
  const key = lower(intent);
  return Boolean(key) && NEW_REPLY_ACTIONABLE.has(key) && !NON_ACTIONABLE.has(key);
}

const HEAT_RANK = Object.freeze({ unscored: 0, cold: 1, warm: 2, hot: 3 });

function normalizeHeat(value) {
  const key = lower(value);
  return Object.prototype.hasOwnProperty.call(HEAT_RANK, key) ? key : null;
}

function isTerminalRow(row = {}) {
  const bucket = lower(row.inbox_bucket);
  const disposition = lower(row.disposition);
  return row.is_suppressed === true
    || bucket === "suppressed"
    || bucket === "dead"
    || ["wrong_number", "wrong_person", "sold", "unqualified", "suppressed", "opt_out"].includes(disposition);
}

/**
 * The canonical lead heat for a thread: the temperature an operator sees and
 * the HOT LEAD flag. Mirrors f_lead_temperature / f_hot_lead in the view.
 *
 *   - A manual temperature (manual_temperature_lock or temperature_source
 *     'manual') is the operator's call and is shown as recorded.
 *   - Otherwise warm/hot survive only while the thread's latest inbound intent
 *     is a plausible positive one and the thread is not terminal; any other
 *     latest reply shows cold. The recorded value is never rewritten here.
 *   - HOT LEAD = not terminal, latest intent is priority-grade (never an
 *     implausible ask, a troll, profanity, an opt-out or a non-owner), and the
 *     temperature is hot (or the legacy is_hot_lead column says so).
 */
export function resolveCanonicalLeadHeat(row = {}) {
  const recorded = normalizeHeat(row.lead_temperature) || normalizeHeat(row.temperature);
  const intent = lower(row.last_intent ?? row.latest_intent ?? row.detected_intent);
  const manual = row.manual_temperature_lock === true || lower(row.temperature_source) === "manual";
  const terminal = isTerminalRow(row);
  const positive = POSITIVE.has(intent) && !terminal;

  let lead_temperature = recorded;
  let gated = false;
  if (!manual && (recorded === "hot" || recorded === "warm") && !positive) {
    lead_temperature = "cold";
    gated = true;
  }

  const is_hot_lead = !terminal && (
    (manual && recorded === "hot")
    || (!manual && PRIORITY.has(intent) && (recorded === "hot" || row.is_hot_lead === true))
  );

  return {
    lead_temperature,
    recorded_lead_temperature: recorded,
    is_hot_lead,
    temperature_gated: gated,
  };
}

export default {
  NON_ACTIONABLE_REPLY_INTENTS,
  PRIORITY_REPLY_INTENTS,
  POSITIVE_REPLY_INTENTS,
  NEW_REPLY_ACTIONABLE_INTENTS,
  isNonActionableReplyIntent,
  isNewReplyActionableIntent,
  isPriorityReplyIntent,
  isPositiveReplyIntent,
  isReopeningReplyIntent,
  resolveCanonicalLeadHeat,
};

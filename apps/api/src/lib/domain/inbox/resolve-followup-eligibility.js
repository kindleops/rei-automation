// ─── resolve-followup-eligibility.js ─────────────────────────────────────────
// Whether a CONVERSATION-RESTART follow-up ("would you be open to talking
// numbers?") is still a truthful thing to say to this seller.
//
// WHY THIS EXISTS
//   A bulk batch queued that question to ten sellers who had already answered
//   it. Their replies were on file and correctly classified -- "I'm not looking
//   to sell", "Not selling", "It's not for sale", "150k", "430k cash offer" --
//   and the eligibility gate never looked. It checked template availability,
//   sender and schedule, and nothing about whether the message made sense.
//
//   The premise is checked BEFORE the copy is rendered. Rendering first and
//   discovering at send time that the premise is wrong is how a well-formed
//   sentence gets sent to someone who already said no.
//
// DECLINE IS NOT DNC
//   A seller saying "not selling" is not a regulatory opt-out. They keep every
//   right to be contacted about something else; they are simply not a candidate
//   for being asked, again, whether they want to sell. This module returns
//   distinct reasons for the two so no caller can conflate them, and it never
//   writes suppression.

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/** Classifier intents that mean the seller declined to sell. */
export const DECLINE_INTENTS = new Set([
  "not_interested",
  "tenant_respondent",
  "listed_or_unavailable",
  "already_sold",
  "do_not_contact_property",
]);

/** Intents that are regulatory, not merely a decline. Kept SEPARATE. */
export const SUPPRESSION_INTENTS = new Set([
  "stop", "opt_out", "optout", "dnc", "do_not_contact", "legal_threat", "hostile_legal",
]);

export const WRONG_NUMBER_INTENTS = new Set(["wrong_number", "wrong_person"]);

/**
 * Plain-language declines, for when the classifier missed one.
 *
 * Needed because a real Spanish compound decline -- "Si, pero no esta de
 * venta!" -- was classified ownership_confirmed: the "Si" was read as
 * confirmation and the refusal after it was dropped. Text is the backstop for
 * exactly that class of miss.
 */
const DECLINE_PHRASES = [
  "not selling", "not looking to sell", "not for sale", "no longer selling",
  "won't be selling", "will not be selling", "not interested in selling",
  "have great long-term tenants", "have tenants", "not on the market",
  // Spanish
  "no esta de venta", "no está de venta", "no la vendo", "no lo vendo",
  "no estoy vendiendo", "no me interesa vender", "no esta en venta", "no está en venta",
];

/**
 * A price has been NAMED. Deliberately detects PRESENCE, never a value.
 *
 * Parsing amounts is how "$150 mil" once became $150,000,000. Eligibility only
 * needs to know the subject was already covered, so the risky half is skipped
 * entirely. Requires an explicit money marker ($, k, mil) so a ZIP code or a
 * street number cannot read as a price.
 */
const PRICE_PATTERNS = [
  /\$\s?\d[\d,]*/,
  /\b\d{2,4}\s?k\b/i,
  /\b\d{2,4}\s?mil\b/i,
  /\b\d{2,3}[\s,]?\d{3}\s?(dollars|usd)\b/i,
];

export function mentionsPrice(body) {
  const text = clean(body);
  if (!text) return false;
  return PRICE_PATTERNS.some((re) => re.test(text));
}

export function looksLikeDecline(body) {
  const text = lower(body);
  if (!text) return false;
  return DECLINE_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * @param evidence {{
 *   thread_key: string,
 *   is_suppressed?: boolean, opt_out?: boolean, wrong_number?: boolean,
 *   messages?: Array<{direction: string, body: string, at?: string, intent?: string}>,
 *   salutation?: {name: string|null, needs_review?: boolean, reason?: string|null},
 * }}
 */
export function resolveFollowUpEligibility(evidence = {}) {
  const messages = Array.isArray(evidence.messages) ? evidence.messages : [];
  const inbound = messages.filter((m) => lower(m.direction) === "inbound");
  const outbound = messages.filter((m) => lower(m.direction) === "outbound");
  const intents = messages.map((m) => lower(m.intent)).filter(Boolean);

  const deny = (reason, detail) => ({ eligible: false, reason, detail: detail ?? null });

  // 1. Regulatory first. Nothing below may override it.
  if (evidence.is_suppressed === true || evidence.opt_out === true) {
    return deny("dnc_or_opt_out", "thread carries suppression or opt-out state");
  }
  if (intents.some((i) => SUPPRESSION_INTENTS.has(i))) {
    return deny("dnc_or_opt_out", "a message was classified as opt-out or legal");
  }

  // 2. Wrong number / wrong person -- we are not talking to the owner.
  if (evidence.wrong_number === true || intents.some((i) => WRONG_NUMBER_INTENTS.has(i))) {
    return deny("wrong_number", "thread is flagged wrong number or wrong person");
  }

  // 3. Explicit decline. Classifier intent OR the seller's own words: the
  //    intent alone missed a Spanish compound refusal.
  const declineByIntent = messages.find(
    (m) => lower(m.direction) === "inbound" && DECLINE_INTENTS.has(lower(m.intent)),
  );
  if (declineByIntent) {
    return deny("seller_explicit_decline", `intent=${lower(declineByIntent.intent)}`);
  }
  const declineByText = inbound.find((m) => looksLikeDecline(m.body));
  if (declineByText) {
    return deny("seller_explicit_decline", `text="${clean(declineByText.body).slice(0, 60)}"`);
  }

  // 4. The seller already named a price, so "open to talking numbers?" asks a
  //    question they answered. Not a suppression -- a stage error.
  const pricedInbound = inbound.find((m) => mentionsPrice(m.body));
  if (pricedInbound) {
    return deny("asking_price_already_known", `inbound names a price: "${clean(pricedInbound.body).slice(0, 40)}"`);
  }

  // 5. We already put an offer in front of them. A generic restart pretends
  //    that never happened.
  const offeredOutbound = outbound.find((m) => mentionsPrice(m.body));
  if (offeredOutbound) {
    return deny("offer_already_presented", `outbound carried an amount: "${clean(offeredOutbound.body).slice(0, 40)}"`);
  }

  // 6. Identity must resolve to someone we can address, or to deliberate
  //    neutral copy. Never to a guess.
  const salutation = evidence.salutation || {};
  if (salutation.needs_review === true) {
    return deny("contact_identity_unresolved", salutation.reason || "salutation needs review");
  }

  return { eligible: true, reason: null, detail: null };
}

export default { resolveFollowUpEligibility, mentionsPrice, looksLikeDecline, DECLINE_INTENTS };

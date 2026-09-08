/**
 * email-provider-outcome-lattice.js
 *
 * What a Brevo webhook event MEANS, and which way knowledge is allowed to move.
 *
 * THE MONOTONIC GATE IS NOT REIMPLEMENTED HERE.
 *   advanceProviderOutcome(), the rank table and the delivery_possibility
 *   mapping live in domain/communications/provider-outcome-lattice.js and are
 *   provider-agnostic: only the STATUS VOCABULARY was TextGrid-shaped. So this
 *   module supplies an email vocabulary and reuses that gate unchanged. Two
 *   implementations of "may this outcome replace what we believe" would drift,
 *   and the direction they drift in is a delivered message being downgraded.
 *
 * THREE KINDS OF EMAIL EVENT, AND ONLY ONE OF THEM IS A DELIVERY OUTCOME.
 *
 *   DELIVERY      request, delivered, deferred, bounces, blocked
 *                 These move the lattice.
 *   TELEMETRY     opened, clicked, and their unique_* variants
 *                 These are RECORDED and never move the lattice. See below.
 *   PREFERENCE    unsubscribed, spam/complaint
 *                 These are suppression facts, not delivery facts. A seller who
 *                 marks a delivered email as spam has still received it, and a
 *                 seller who unsubscribes tells us nothing about whether the
 *                 message arrived. They drive the suppression list; they do not
 *                 tell the lattice anything it did not already know.
 *
 * WHY OPENS AND CLICKS ARE NOT AUTHORITY -- THE LOAD-BEARING POINT.
 *   An open is inferred from a tracking pixel loading. That happens when a
 *   security scanner prefetches the message, when a corporate gateway rewrites
 *   and fetches links, when an image proxy caches content, and when Apple Mail
 *   Privacy Protection preloads EVERY image for EVERY message regardless of
 *   whether a human ever looked. A click can be a link-safety scanner following
 *   the URL to check it.
 *
 *   So an open proves that something fetched a resource, not that a person read
 *   an email. Treating it as delivery evidence would let a scanner mark a
 *   message delivered; treating it as engagement would let a scanner promote a
 *   seller into a "warm" bucket and trigger outreach nobody asked for. It is
 *   real telemetry and it is worth storing. It is not evidence.
 *
 * A HARD BOUNCE IS delivery_failed_after_acceptance, NOT definitely_not_sent.
 *   Brevo issued a messageId, so the provider ACCEPTED the message; the failure
 *   happened downstream at the receiving server. That is the same reasoning the
 *   SMS lattice applies to a `failed` callback, and it matters for the same
 *   reason: nothing a provider tells us after acceptance can prove the seller
 *   never saw anything, and claiming otherwise would hand back retry authority
 *   for a message that may be sitting in an inbox.
 */

import {
  PROVIDER_OUTCOME,
  advanceProviderOutcome,
  deliveryPossibilityFor,
  isTerminalProviderOutcome,
  PROVIDER_LATTICE_POLICY_VERSION,
} from "@/lib/domain/communications/provider-outcome-lattice.js";

export const EMAIL_PROVIDER_STATUS_POLICY_VERSION = "brevo_event_v1";

/** How an event is allowed to act on the system. */
export const EMAIL_EVENT_KIND = Object.freeze({
  DELIVERY: "delivery",
  TELEMETRY: "telemetry",
  PREFERENCE: "preference",
  UNKNOWN: "unknown",
});

/**
 * What a suppression-bearing event means for the suppression list. Values match
 * the email_suppression.reason CHECK constraint exactly; a value that did not
 * would fail at write time rather than at review time.
 */
export const EMAIL_SUPPRESSION_REASON = Object.freeze({
  UNSUBSCRIBED: "unsubscribed",
  HARD_BOUNCE: "hard_bounce",
  SOFT_BOUNCE: "soft_bounce",
  COMPLAINT: "complaint",
  BLOCKED: "blocked",
  INVALID_ADDRESS: "invalid_address",
});

/**
 * Brevo's transactional webhook vocabulary, lowercased on lookup.
 *
 * Anything not listed is UNKNOWN and changes nothing. An unrecognised event is
 * recorded as evidence and left inert: a provider adding a new event type must
 * not be able to move our state by surprise.
 */
const EVENT_MAP = Object.freeze({
  // ── delivery ──────────────────────────────────────────────────────────────
  request:      { kind: EMAIL_EVENT_KIND.DELIVERY, outcome: PROVIDER_OUTCOME.PROVIDER_ACCEPTED },
  sent:         { kind: EMAIL_EVENT_KIND.DELIVERY, outcome: PROVIDER_OUTCOME.SENT_BY_PROVIDER },
  delivered:    { kind: EMAIL_EVENT_KIND.DELIVERY, outcome: PROVIDER_OUTCOME.DELIVERED },
  // Deferred is a RETRY IN PROGRESS at the receiving server, not a failure. It
  // ranks at accepted so it cannot downgrade a delivered message, and cannot
  // promote an unknown one past what the provider actually confirmed.
  deferred:     { kind: EMAIL_EVENT_KIND.DELIVERY, outcome: PROVIDER_OUTCOME.PROVIDER_ACCEPTED },

  hard_bounce:  {
    kind: EMAIL_EVENT_KIND.DELIVERY,
    outcome: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
    suppression: EMAIL_SUPPRESSION_REASON.HARD_BOUNCE,
  },
  soft_bounce:  {
    kind: EMAIL_EVENT_KIND.DELIVERY,
    outcome: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
    suppression: EMAIL_SUPPRESSION_REASON.SOFT_BOUNCE,
  },
  blocked:      {
    kind: EMAIL_EVENT_KIND.DELIVERY,
    outcome: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
    suppression: EMAIL_SUPPRESSION_REASON.BLOCKED,
  },
  invalid_email: {
    kind: EMAIL_EVENT_KIND.DELIVERY,
    outcome: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
    suppression: EMAIL_SUPPRESSION_REASON.INVALID_ADDRESS,
  },
  error:        { kind: EMAIL_EVENT_KIND.DELIVERY, outcome: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE },

  // ── telemetry: recorded, never authority ─────────────────────────────────
  opened:        { kind: EMAIL_EVENT_KIND.TELEMETRY },
  unique_opened: { kind: EMAIL_EVENT_KIND.TELEMETRY },
  proxy_open:    { kind: EMAIL_EVENT_KIND.TELEMETRY },
  click:         { kind: EMAIL_EVENT_KIND.TELEMETRY },
  clicked:       { kind: EMAIL_EVENT_KIND.TELEMETRY },
  unique_click:  { kind: EMAIL_EVENT_KIND.TELEMETRY },

  // ── preference: suppression facts, not delivery facts ────────────────────
  unsubscribed:      { kind: EMAIL_EVENT_KIND.PREFERENCE, suppression: EMAIL_SUPPRESSION_REASON.UNSUBSCRIBED },
  list_addition:     { kind: EMAIL_EVENT_KIND.PREFERENCE },
  spam:              { kind: EMAIL_EVENT_KIND.PREFERENCE, suppression: EMAIL_SUPPRESSION_REASON.COMPLAINT },
  complaint:         { kind: EMAIL_EVENT_KIND.PREFERENCE, suppression: EMAIL_SUPPRESSION_REASON.COMPLAINT },
});

/** Brevo spells some events differently across API versions and docs. */
const EVENT_ALIASES = Object.freeze({
  delivery: "delivered",
  bounce: "hard_bounce",
  hardbounce: "hard_bounce",
  softbounce: "soft_bounce",
  "hard-bounce": "hard_bounce",
  "soft-bounce": "soft_bounce",
  unsubscribe: "unsubscribed",
  abuse: "complaint",
  open: "opened",
  opens: "opened",
  clicks: "click",
  invalid: "invalid_email",
  invalid_email_address: "invalid_email",
});

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * @returns {{event_type, kind, outcome, rank_bearing, suppression_reason,
 *            recognised, raw, policy_version}}
 */
export function normalizeEmailProviderEvent(rawEvent) {
  const raw = clean(rawEvent);
  const canonical = EVENT_ALIASES[raw] || raw;
  const entry = EVENT_MAP[canonical];

  if (!entry) {
    return {
      event_type: canonical || null,
      kind: EMAIL_EVENT_KIND.UNKNOWN,
      outcome: PROVIDER_OUTCOME.UNKNOWN,
      rank_bearing: false,
      suppression_reason: null,
      recognised: false,
      raw,
      policy_version: EMAIL_PROVIDER_STATUS_POLICY_VERSION,
    };
  }

  return {
    event_type: canonical,
    kind: entry.kind,
    // Telemetry and preference events carry NO outcome, so the shared gate sees
    // UNKNOWN and returns `inert`. That is the whole mechanism by which an open
    // cannot move delivery state -- it is a property of the vocabulary, not a
    // special case somewhere downstream that could be forgotten.
    outcome: entry.outcome || PROVIDER_OUTCOME.UNKNOWN,
    rank_bearing: Boolean(entry.outcome),
    suppression_reason: entry.suppression || null,
    recognised: true,
    raw,
    policy_version: EMAIL_PROVIDER_STATUS_POLICY_VERSION,
  };
}

/**
 * May this outcome replace what we already believe about delivery?
 *
 * Takes OUTCOME STRINGS, exactly like the shared gate it delegates to, rather
 * than an object. An earlier version accepted "a normalized event" and read
 * `.outcome` from it -- which silently returned undefined when handed the
 * webhook-payload normalization, whose field is `provider_outcome`. Two shapes
 * with different names for the same idea made every delivery event look
 * unrecognised. Strings in, verdict out: there is no shape to get wrong.
 */
export function advanceEmailProviderOutcome(current_outcome, incoming_outcome) {
  return advanceProviderOutcome(current_outcome, incoming_outcome);
}

export {
  PROVIDER_OUTCOME,
  deliveryPossibilityFor,
  isTerminalProviderOutcome,
  PROVIDER_LATTICE_POLICY_VERSION,
};

export default normalizeEmailProviderEvent;

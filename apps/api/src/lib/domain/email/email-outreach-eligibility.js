/**
 * email-outreach-eligibility.js
 *
 * MAY WE EMAIL THIS SELLER, AT THIS ADDRESS, RIGHT NOW?
 *
 * WHAT THIS IS NOT.
 *   It is not the send authority. Emergency stop, queue_processor_mode,
 *   queue_execution_mode and the operator brakes are evaluated by
 *   domain/queue/canonical-send-authority.js and are re-evaluated on EVERY
 *   attempt inside the canonical dispatcher. Those answer "is the SYSTEM allowed
 *   to send at all"; this answers "is this RECIPIENT contactable". Two different
 *   questions, deliberately two modules, and both must say yes.
 *
 *   It is also not transport safety. Whether a second attempt would duplicate a
 *   message is decided by the transition authority from durable attempt
 *   evidence, never from a recipient's contact history.
 *
 * PURE BY CONSTRUCTION.
 *   This module performs no IO. It takes facts and returns a verdict, so every
 *   rule is testable without a database and the same verdict can be replayed
 *   later from the facts that produced it. Fetching those facts is the store's
 *   job; deciding is this module's.
 *
 * FAIL CLOSED, AND SAY WHY.
 *   A missing fact is not permission. If the caller cannot say whether the
 *   address is suppressed, the answer is "not eligible, suppression unknown" --
 *   not "probably fine". Every refusal carries a machine-readable reason,
 *   because the operator question this system must always be able to answer is
 *   "why did this seller not get an email", and "eligibility returned false" is
 *   not an answer.
 *
 * REASONS ARE RANKED BY DURABILITY, NOT BY CHECK ORDER.
 *   All blocking reasons are collected and returned, but `reason` is the most
 *   durable one. An address that is both opted out and inside a cooldown window
 *   is opted out; reporting "cooldown" would imply it becomes contactable in an
 *   hour, and someone would eventually wait an hour and send.
 */

import { normalizeEmailAddress } from "@/lib/domain/email/normalize-email-address.js";

export const EMAIL_ELIGIBILITY_POLICY_VERSION = "email_eligibility_v1";

/**
 * Ordered most durable (never contactable again) to least (contactable later).
 * The order is the ranking; do not reorder without deciding you mean to.
 */
export const BLOCKING_REASONS = Object.freeze([
  "address_unparseable",
  "opted_out",
  "hard_bounced",
  "complained",
  "blocked_by_provider",
  "invalid_address",
  "do_not_contact",
  "role_account",
  "disposable_domain",
  "address_marked_ineligible",
  "automation_paused",
  "suppression_window_active",
  "soft_bounce_cooldown",
  "channel_cooldown_active",
  "cross_channel_cooldown_active",
  "max_touches_reached",
  "suppression_state_unknown",
  "contact_state_unknown",
]);

const REASON_RANK = new Map(BLOCKING_REASONS.map((reason, index) => [reason, index]));

/** Suppression reasons that never expire, mapped onto the verdict vocabulary. */
const PERMANENT_SUPPRESSION_REASONS = new Map([
  ["unsubscribed", "opted_out"],
  ["hard_bounce", "hard_bounced"],
  ["complaint", "complained"],
  ["blocked", "blocked_by_provider"],
  ["invalid_address", "invalid_address"],
  ["manual", "do_not_contact"],
]);

export const DEFAULT_EMAIL_ELIGIBILITY_POLICY = Object.freeze({
  /**
   * Hours after ANY outbound contact on ANY channel before an email may go out.
   * This is the duplicate-contact protection the platform has needed and has not
   * had: contact_outreach_state already records last_sms_at and last_email_at,
   * but nothing consulted them correctly.
   */
  cross_channel_cooldown_hours: 24,
  /** Hours between two emails to the same mailbox, independent of channel mixing. */
  email_cooldown_hours: 72,
  /** Outbound touches on a (owner, property) before email outreach stops. */
  max_touches: 8,
  /** Role accounts and throwaway domains are never worth a complaint. */
  allow_role_accounts: false,
  allow_disposable_domains: false,
});

function clean(value) {
  return String(value ?? "").trim();
}

function toTime(value) {
  if (!value) return null;
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function hoursToMs(hours) {
  const parsed = Number(hours);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60 * 60 * 1000 : 0;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function rankOf(reason) {
  const rank = REASON_RANK.get(reason);
  // An unranked reason sorts last rather than first: an unrecognised string must
  // never outrank a known permanent block and hide it from the operator.
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * @param {object} input
 * @param {string} input.email_address              raw address as held
 * @param {object|null|undefined} input.suppression the email_suppression row, or
 *        null for "checked, none found". `undefined` means NOT CHECKED and is a
 *        refusal -- the distinction is the whole point.
 * @param {object|null|undefined} input.contact_state contact_outreach_state row,
 *        null for "no prior contact", undefined for "not checked".
 * @param {object|null} [input.address_record]      the `emails` row, when known
 * @param {string} [input.now]                      ISO instant; defaults to now
 * @param {object} [input.policy]                   overrides on the default policy
 */
export function evaluateEmailOutreachEligibility(input = {}) {
  const policy = { ...DEFAULT_EMAIL_ELIGIBILITY_POLICY, ...(input.policy || {}) };
  const now_ms = toTime(input.now) ?? Date.now();

  const blocking = [];
  const warnings = [];
  /** Earliest instant a currently-temporary block could lift. */
  let next_eligible_ms = null;

  const block = (reason, detail = {}) => blocking.push({ reason, ...detail });
  const deferUntil = (ms) => {
    if (!Number.isFinite(ms)) return;
    next_eligible_ms = next_eligible_ms === null ? ms : Math.max(next_eligible_ms, ms);
  };

  // ── the address itself ───────────────────────────────────────────────────
  const address = normalizeEmailAddress(input.email_address);
  if (!address.ok) {
    // Nothing downstream can be evaluated against an address we cannot name, and
    // no later check could rescue it, so this is the whole verdict.
    return verdict({
      policy_version: EMAIL_ELIGIBILITY_POLICY_VERSION,
      address: null,
      blocking: [{ reason: "address_unparseable", detail: address.reason }],
      warnings,
      next_eligible_at: null,
      evaluated_at: new Date(now_ms).toISOString(),
    });
  }

  if (address.is_role_account && !policy.allow_role_accounts) {
    block("role_account", { detail: address.local_part });
  }
  if (address.is_disposable_domain && !policy.allow_disposable_domains) {
    block("disposable_domain", { detail: address.domain });
  }

  // ── suppression ──────────────────────────────────────────────────────────
  // undefined means the caller did not check. That is not "no suppression".
  if (input.suppression === undefined) {
    block("suppression_state_unknown");
  } else if (input.suppression) {
    const record = input.suppression;
    const reason = clean(record.reason).toLowerCase();
    const active = record.is_active !== false;
    const expires_ms = toTime(record.expires_at);

    if (active && PERMANENT_SUPPRESSION_REASONS.has(reason)) {
      block(PERMANENT_SUPPRESSION_REASONS.get(reason), { detail: reason });
    } else if (active && reason === "soft_bounce") {
      // The one suppression that may lift. No expiry recorded means we do not
      // know when it lifts, and "we do not know" is held, not released.
      if (expires_ms === null) {
        block("soft_bounce_cooldown", { detail: "no_expiry_recorded" });
      } else if (expires_ms > now_ms) {
        block("soft_bounce_cooldown", { detail: record.expires_at });
        deferUntil(expires_ms);
      }
    } else if (active && reason) {
      // An active suppression whose reason this policy does not recognise is
      // still a suppression. Treating an unknown reason as harmless is how an
      // opt-out recorded under a new label starts getting emailed again.
      block("do_not_contact", { detail: `unrecognised_suppression_reason:${reason}` });
    }
  }

  // ── the address record, when we have one ─────────────────────────────────
  if (input.address_record && input.address_record.email_eligible === false) {
    block("address_marked_ineligible", { detail: "emails.email_eligible=false" });
  }

  // ── contact state: pauses, DNC, cooldowns, touch budget ──────────────────
  if (input.contact_state === undefined) {
    block("contact_state_unknown");
  } else if (input.contact_state) {
    const state = input.contact_state;

    if (state.dnc === true) block("do_not_contact", { detail: "contact_outreach_state.dnc" });
    if (state.is_paused === true) {
      block("automation_paused", { detail: clean(state.pause_reason) || "is_paused" });
    }

    const suppression_until = toTime(state.suppression_until);
    if (suppression_until !== null && suppression_until > now_ms) {
      block("suppression_window_active", { detail: clean(state.suppression_reason) || null });
      deferUntil(suppression_until);
    }

    // Explicit per-channel gates already computed upstream take precedence over
    // the derived cooldowns below: if something decided a concrete instant, that
    // decision is the answer, not a recomputation of it.
    const next_email = toTime(state.next_allowed_email_at);
    if (next_email !== null && next_email > now_ms) {
      block("channel_cooldown_active", { detail: state.next_allowed_email_at });
      deferUntil(next_email);
    }

    const next_any = toTime(state.next_allowed_any_contact_at);
    if (next_any !== null && next_any > now_ms) {
      block("cross_channel_cooldown_active", { detail: state.next_allowed_any_contact_at });
      deferUntil(next_any);
    }

    // Derived cooldowns. These are the backstop for rows where nothing has
    // computed an explicit next_allowed_* yet, which today is all of them.
    const cross_channel_ms = hoursToMs(policy.cross_channel_cooldown_hours);
    // last_outbound_at is the canonical "we contacted them" instant. It is
    // deliberately preferred over max(last_sms_at, last_email_at): a channel
    // that starts writing only its own timestamp must not silently shorten the
    // cross-channel window for the other one.
    const last_outbound = toTime(state.last_outbound_at)
      ?? Math.max(toTime(state.last_sms_at) ?? -Infinity, toTime(state.last_email_at) ?? -Infinity);
    if (cross_channel_ms > 0 && Number.isFinite(last_outbound)) {
      const until = last_outbound + cross_channel_ms;
      if (until > now_ms) {
        block("cross_channel_cooldown_active", { detail: isoOrNull(until) });
        deferUntil(until);
      }
    }

    const email_cooldown_ms = hoursToMs(policy.email_cooldown_hours);
    const last_email = toTime(state.last_email_at);
    if (email_cooldown_ms > 0 && last_email !== null) {
      const until = last_email + email_cooldown_ms;
      if (until > now_ms) {
        block("channel_cooldown_active", { detail: isoOrNull(until) });
        deferUntil(until);
      }
    }

    const touch_count = Number(state.touch_count);
    if (Number.isFinite(touch_count) && touch_count >= policy.max_touches) {
      // No deferUntil: a touch budget does not refill with time.
      block("max_touches_reached", { detail: `${touch_count}/${policy.max_touches}` });
    }
  }

  // ── advisory signals: worth recording, never worth blocking on ───────────
  if (input.address_record) {
    const score = Number(input.address_record.email_score_final);
    if (Number.isFinite(score) && score < 50) {
      warnings.push({ reason: "low_confidence_address", detail: String(score) });
    }
  }

  // A deferral is only meaningful if EVERY block is time-based. One permanent
  // block makes "eligible at 14:00" a lie, so the instant is withheld.
  const has_permanent_block = blocking.some((entry) => !isTemporary(entry.reason));

  return verdict({
    policy_version: EMAIL_ELIGIBILITY_POLICY_VERSION,
    address,
    blocking,
    warnings,
    next_eligible_at: has_permanent_block ? null : isoOrNull(next_eligible_ms),
    evaluated_at: new Date(now_ms).toISOString(),
  });
}

const TEMPORARY_REASONS = new Set([
  "automation_paused",
  "suppression_window_active",
  "soft_bounce_cooldown",
  "channel_cooldown_active",
  "cross_channel_cooldown_active",
]);

function isTemporary(reason) {
  return TEMPORARY_REASONS.has(reason);
}

function verdict({ policy_version, address, blocking, warnings, next_eligible_at, evaluated_at }) {
  const ranked = [...blocking].sort((a, b) => rankOf(a.reason) - rankOf(b.reason));
  const eligible = ranked.length === 0;

  return {
    ok: true,
    eligible,
    policy_version,
    reason: eligible ? null : ranked[0].reason,
    reason_detail: eligible ? null : (ranked[0].detail ?? null),
    blocking_reasons: ranked.map((entry) => entry.reason),
    blocking: ranked,
    warnings,
    next_eligible_at,
    evaluated_at,
    normalized_email: address?.normalized ?? null,
    mailbox_identity: address?.mailbox_identity ?? null,
  };
}

export default evaluateEmailOutreachEligibility;

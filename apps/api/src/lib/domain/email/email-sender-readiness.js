/**
 * email-sender-readiness.js
 *
 * MAY THIS SENDER CARRY THIS MESSAGE, RIGHT NOW?
 *
 * Deliverability is a property of the SENDER, not of the recipient or of the
 * system. A domain that is mid-warm-up, a mailbox an operator disabled, or an
 * address that has already used its daily allowance are all reasons to hold a
 * send that is otherwise perfectly authorised. Sending anyway does not just fail
 * once: it damages the reputation of a domain that every later send depends on.
 *
 * THREE SEPARATE AUTHORITIES, DELIBERATELY NOT MERGED.
 *
 *   canonical-send-authority   is the SYSTEM allowed to send at all
 *   email-outreach-eligibility is this RECIPIENT contactable
 *   this file                  is this SENDER fit to carry it
 *
 * All three must say yes, and none of them can substitute for another. A perfect
 * recipient and an unlocked system still cannot rescue a suspended domain.
 *
 * PURE, LIKE THE ELIGIBILITY ENGINE. No IO, so every rule is testable without a
 * database and the verdict can be replayed from the facts that produced it.
 *
 * A MISSING SENDER IS A REFUSAL, NOT A DEFAULT.
 *   The temptation is to fall back to the environment's default from-address
 *   when no sender row matches. That is how a warm-up schedule gets bypassed and
 *   how a suspended domain keeps sending: the fallback has no caps, no status
 *   and no warm-up state, so it is not a sender, it is a hole in the policy.
 */

import { asObject } from "@/lib/hostile-input.js";

export const EMAIL_SENDER_READINESS_POLICY_VERSION = "email_sender_readiness_v1";

/**
 * Ordered most durable (this sender is not usable) to least (it is usable, later).
 */
export const SENDER_BLOCKING_REASONS = Object.freeze([
  "sender_not_found",
  "sender_inactive",
  "sender_suspended",
  "sender_missing_from_address",
  "sender_domain_unverified",
  "sender_warmup_paused",
  "sender_daily_cap_reached",
  "sender_warmup_cap_reached",
]);

const REASON_RANK = new Map(SENDER_BLOCKING_REASONS.map((reason, index) => [reason, index]));

/**
 * Statuses that mean "do not use", from the email_senders.sender_status column.
 * Anything unrecognised is ALSO refused: an unknown status is not a licence to
 * send from an address whose posture we cannot describe.
 */
const USABLE_STATUSES = new Set(["active", "ready", "warming"]);
const SUSPENDED_STATUSES = new Set(["suspended", "disabled", "paused", "blocked", "revoked"]);

/**
 * Warm-up ladder. A domain that has just been stood up cannot send at full
 * volume without being classified as spam, so the effective cap during warm-up
 * is the LOWER of the configured daily limit and the ladder's allowance.
 *
 * The ladder is deliberately conservative and explicit rather than computed from
 * a start date: a formula invites a bug that silently multiplies the allowance,
 * and this is the one number where being wrong is expensive and slow to undo.
 */
export const WARMUP_DAILY_ALLOWANCE = Object.freeze({
  new: 20,
  warming: 100,
  warmed: null,      // no ladder cap; the configured daily_limit governs
  established: null,
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function rankOf(reason) {
  const rank = REASON_RANK.get(reason);
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}

function toInt(value) {
  // Number(null), Number(undefined && "") and Number("") do NOT all agree, and
  // the one that matters is Number(null) === 0. Reading an unconfigured
  // daily_limit as a cap of ZERO would refuse every send from a sender whose
  // operator simply never set a limit -- a silent, total outage that looks like
  // a policy decision.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * @param {object} input
 * @param {object|null|undefined} input.sender  an email_senders row. `null` means
 *        "looked, none found"; `undefined` means NOT LOOKED, which is a refusal.
 * @param {boolean} [input.require_domain_verified=true]
 */
export function evaluateEmailSenderReadiness(raw_input) {
  const input = asObject(raw_input);
  const blocking = [];
  const warnings = [];
  const block = (reason, detail = null) => blocking.push({ reason, detail });

  if (input.sender === undefined) {
    // Same rule as the eligibility engine: a fact we did not check is not a fact
    // in our favour.
    return verdict([{ reason: "sender_not_found", detail: "sender_not_loaded" }], warnings, null);
  }

  const sender = input.sender;
  if (!sender) {
    return verdict([{ reason: "sender_not_found", detail: null }], warnings, null);
  }

  const from_email = lower(sender.from_email);
  if (!from_email) block("sender_missing_from_address");

  if (sender.is_active === false) block("sender_inactive");

  const status = lower(sender.sender_status);
  if (SUSPENDED_STATUSES.has(status)) {
    block("sender_suspended", status);
  } else if (status && !USABLE_STATUSES.has(status)) {
    // An unrecognised status is refused rather than assumed benign. A sender we
    // cannot describe is a sender we cannot vouch for.
    block("sender_suspended", `unrecognised_status:${status}`);
  }

  const warmup = lower(sender.warmup_status);
  if (warmup === "paused" || warmup === "halted") {
    block("sender_warmup_paused", warmup);
  }

  if (input.require_domain_verified !== false && sender.domain_verified === false) {
    // Sending from an unverified domain is the fastest way to burn it. Note the
    // explicit `=== false`: an ABSENT flag is unknown, not unverified, and is
    // reported as a warning rather than treated as a refusal, because most rows
    // predate the column.
    block("sender_domain_unverified", clean(sender.domain) || null);
  } else if (sender.domain_verified === undefined || sender.domain_verified === null) {
    warnings.push({ reason: "sender_domain_verification_unknown", detail: clean(sender.domain) || null });
  }

  // ── volume ───────────────────────────────────────────────────────────────
  const sent_today = toInt(sender.messages_sent_today) ?? 0;
  const daily_limit = toInt(sender.daily_limit);
  const warmup_allowance = Object.prototype.hasOwnProperty.call(WARMUP_DAILY_ALLOWANCE, warmup)
    ? WARMUP_DAILY_ALLOWANCE[warmup]
    : null;

  if (daily_limit !== null && daily_limit >= 0 && sent_today >= daily_limit) {
    block("sender_daily_cap_reached", `${sent_today}/${daily_limit}`);
  }

  if (warmup_allowance !== null && sent_today >= warmup_allowance) {
    // The warm-up ladder binds independently of the configured limit, and the
    // LOWER of the two governs. A daily_limit of 500 on a domain in its first
    // week is an aspiration, not a permission.
    block("sender_warmup_cap_reached", `${sent_today}/${warmup_allowance} (${warmup})`);
  }

  return verdict(blocking, warnings, {
    sender_key: clean(sender.sender_key) || null,
    from_email: from_email || null,
    reply_to_email: lower(sender.reply_to_email) || null,
    sender_name: clean(sender.sender_name) || null,
    domain: clean(sender.domain) || null,
    warmup_status: warmup || null,
    sent_today,
    daily_limit,
    warmup_allowance,
    remaining_today: remainingToday(sent_today, daily_limit, warmup_allowance),
  });
}

function remainingToday(sent_today, daily_limit, warmup_allowance) {
  const caps = [daily_limit, warmup_allowance].filter((cap) => cap !== null && cap >= 0);
  if (!caps.length) return null;
  return Math.max(0, Math.min(...caps) - sent_today);
}

function verdict(blocking, warnings, sender) {
  const ranked = [...blocking].sort((a, b) => rankOf(a.reason) - rankOf(b.reason));
  const ready = ranked.length === 0;
  return {
    ok: true,
    ready,
    policy_version: EMAIL_SENDER_READINESS_POLICY_VERSION,
    reason: ready ? null : ranked[0].reason,
    reason_detail: ready ? null : (ranked[0].detail ?? null),
    blocking_reasons: ranked.map((entry) => entry.reason),
    blocking: ranked,
    warnings,
    sender,
  };
}

export default evaluateEmailSenderReadiness;

/**
 * OPS-1 — CANONICAL SENDER ELIGIBILITY.
 *
 * WHY THIS EXISTS. The live S1 proof sent from +17866052999, a number whose
 * own label reads "MIAMI (cooling - spam-flagged 2026-09-10)". Selection did
 * nothing wrong by its own rules: it filtered `status = 'active'`, and that
 * number is active. `health_score` was 1 for all twelve numbers including the
 * flagged one, so it carried no information, and the ONLY record of the spam
 * flag was a human-readable name string.
 *
 * Two provisioned replacements existed and both were unusable — one in the
 * containment blocklist, one paused — so the degraded number was the last
 * candidate standing. The system routed traffic onto a flagged number while
 * healthy inventory sat idle, and no rule was violated. That is the defect.
 *
 * THE RULE: only ACTIVE_HEALTHY may serve ordinary traffic.
 *
 * UNVERIFIED IS NOT HEALTHY. Absence of evidence is the state most likely to
 * be mistaken for health — it reads as "nothing wrong" — so it is a distinct,
 * ineligible state. Treating "we never checked" as "fine" is precisely how the
 * flagged number was selected.
 *
 * NO SILENT FALLBACK. A market with no healthy sender HOLDS. It does not
 * downgrade to a cooling number and does not borrow another market's number:
 * an unfamiliar area code is a deliverability and trust problem, not a
 * routing convenience.
 */

const clean = (value) => String(value ?? '').trim()

export const SENDER_HEALTH = Object.freeze({
  ACTIVE_HEALTHY: 'active_healthy',
  COOLING: 'cooling',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  DISABLED: 'disabled',
  UNVERIFIED: 'unverified',
})

/** The ONLY state permitted to carry ordinary production traffic. */
const ELIGIBLE_STATES = new Set([SENDER_HEALTH.ACTIVE_HEALTHY])

export const SENDER_INELIGIBLE_REASON = Object.freeze({
  COOLING: 'sender_cooling_or_spam_flagged',
  PAUSED: 'sender_paused',
  BLOCKED: 'sender_blocked_by_control_plane',
  DISABLED: 'sender_disabled',
  UNVERIFIED: 'sender_health_unverified',
  NOT_ACTIVE: 'sender_status_not_active',
  CAP_EXHAUSTED: 'sender_daily_cap_exhausted',
  IS_RECIPIENT: 'sender_is_recipient',
  NO_MARKET: 'sender_market_mismatch',
  NO_HEALTHY_SENDER: 'no_healthy_sender',
})

/**
 * Resolve a number's health.
 *
 * Structured `health_state` wins. When it is absent the verdict is
 * UNVERIFIED — never a guess derived from the label, because parsing an
 * operator's prose for "spam" would make health depend on someone's wording.
 * Cooling is checked before status so an `active` cooling number cannot slip
 * through on status alone, which is exactly what happened.
 */
export function resolveSenderHealth(sender = {}, { blockedSet = null, now = null } = {}) {
  const phone = clean(sender.phone_number ?? sender.phone_e164)
  const current = now ? new Date(now) : new Date()

  if (blockedSet instanceof Set && blockedSet.has(phone)) {
    return { health: SENDER_HEALTH.BLOCKED, reason: SENDER_INELIGIBLE_REASON.BLOCKED }
  }

  const declared = clean(sender.health_state).toLowerCase()

  if (declared === SENDER_HEALTH.COOLING) {
    const until = sender.cooling_until ? new Date(sender.cooling_until) : null
    // A cooling window that has demonstrably elapsed still does not
    // self-promote to healthy: recovery requires positive evidence, recorded
    // deliberately, not merely the passage of time.
    const elapsed = until && Number.isFinite(until.getTime()) && current >= until
    return {
      health: SENDER_HEALTH.COOLING,
      reason: SENDER_INELIGIBLE_REASON.COOLING,
      cooling_window_elapsed: Boolean(elapsed),
      requires_explicit_recovery: true,
    }
  }

  if (sender.spam_flagged_at) {
    return { health: SENDER_HEALTH.COOLING, reason: SENDER_INELIGIBLE_REASON.COOLING }
  }

  if (declared === SENDER_HEALTH.DISABLED) {
    return { health: SENDER_HEALTH.DISABLED, reason: SENDER_INELIGIBLE_REASON.DISABLED }
  }

  const status = clean(sender.status).toLowerCase()
  if (declared === SENDER_HEALTH.PAUSED || status === 'paused') {
    return { health: SENDER_HEALTH.PAUSED, reason: SENDER_INELIGIBLE_REASON.PAUSED }
  }
  if (status && status !== 'active') {
    return { health: SENDER_HEALTH.DISABLED, reason: SENDER_INELIGIBLE_REASON.NOT_ACTIVE }
  }

  if (declared === SENDER_HEALTH.ACTIVE_HEALTHY) {
    return { health: SENDER_HEALTH.ACTIVE_HEALTHY, reason: null }
  }

  // Anything else — including a declared state we do not recognise — is
  // unverified. An unknown value is not a licence.
  return { health: SENDER_HEALTH.UNVERIFIED, reason: SENDER_INELIGIBLE_REASON.UNVERIFIED }
}

export function isSenderEligible(sender = {}, context = {}) {
  const verdict = resolveSenderHealth(sender, context)
  if (!ELIGIBLE_STATES.has(verdict.health)) {
    return { eligible: false, ...verdict }
  }

  const limit = Number(sender.daily_limit)
  const used = Number(sender.messages_sent_today ?? 0)
  if (!Number.isFinite(limit) || limit <= 0 || (Number.isFinite(used) && used >= limit)) {
    return { eligible: false, health: verdict.health, reason: SENDER_INELIGIBLE_REASON.CAP_EXHAUSTED }
  }

  const recipient = clean(context.recipient)
  if (recipient && clean(sender.phone_number) === recipient) {
    return { eligible: false, health: verdict.health, reason: SENDER_INELIGIBLE_REASON.IS_RECIPIENT }
  }

  return { eligible: true, health: verdict.health, reason: null }
}

/**
 * Select a sender for a market, or HOLD.
 *
 * Returns every candidate's verdict, so "why did nothing send?" is answerable
 * from the decision itself rather than by re-deriving it later.
 */
export function selectHealthySender({ market = null, senders = [], blockedSet = null, recipient = null, now = null } = {}) {
  const wanted = clean(market)
  const pool = (Array.isArray(senders) ? senders : []).filter(
    (s) => !wanted || clean(s.market) === wanted
  )

  const considered = []
  const eligible = []
  for (const sender of pool) {
    const verdict = isSenderEligible(sender, { blockedSet, recipient, now })
    considered.push({ phone_number: clean(sender.phone_number), ...verdict })
    if (verdict.eligible) eligible.push(sender)
  }

  if (!eligible.length) {
    return {
      ok: false,
      hold: true,
      reason: SENDER_INELIGIBLE_REASON.NO_HEALTHY_SENDER,
      market: wanted || null,
      selected: null,
      considered,
      // Named explicitly so no caller can read this as permission to widen.
      cross_market_fallback_allowed: false,
      degraded_fallback_allowed: false,
    }
  }

  // Lowest usage first among HEALTHY candidates only. Ranking never runs
  // before the health filter — a better-ranked cooling number must not win.
  eligible.sort((a, b) => Number(a.messages_sent_today ?? 0) - Number(b.messages_sent_today ?? 0))

  return {
    ok: true,
    hold: false,
    reason: null,
    market: wanted || null,
    selected: eligible[0],
    selected_phone: clean(eligible[0].phone_number),
    considered,
    cross_market_fallback_allowed: false,
  }
}

/** What it would take to promote a sender to ACTIVE_HEALTHY. */
export function describeRecoveryRequirements(sender = {}) {
  const verdict = resolveSenderHealth(sender)
  const base = { phone_number: clean(sender.phone_number), current_health: verdict.health }

  switch (verdict.health) {
    case SENDER_HEALTH.COOLING:
      return { ...base, requirements: [
        'cooling_window_elapsed',
        'carrier_or_provider_confirmation_not_spam_flagged',
        'clean_deliverability_sample_after_cooling',
        'explicit_operator_promotion_with_provenance',
      ] }
    case SENDER_HEALTH.PAUSED:
      return { ...base, requirements: ['provider_status_active', 'operator_unpause_with_reason'] }
    case SENDER_HEALTH.BLOCKED:
      return { ...base, requirements: ['removal_from_sms_blocked_sender_numbers', 'containment_posture_permits'] }
    case SENDER_HEALTH.UNVERIFIED:
      return { ...base, requirements: [
        'registration_status_recorded',
        'provider_status_confirmed_active',
        'deliverability_baseline_recorded',
        'health_state_set_with_provenance',
      ] }
    default:
      return { ...base, requirements: [] }
  }
}

export default selectHealthySender

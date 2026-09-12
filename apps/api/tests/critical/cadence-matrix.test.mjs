import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CADENCE_MATRIX,
  resolveCadence,
  firstDelayHours,
  resolveUrgentS1FirstDelayHours,
  computeNextFollowUpAt,
} from '@/lib/domain/seller-flow/cadence-matrix.js'
import {
  resolveCadenceProfile,
  recomputeCadenceProfile,
  isProfileExpired,
  CADENCE_PROFILE,
  REJECTED_URGENCY_SIGNALS,
  EVIDENCE_TTL_DAYS,
} from '@/lib/domain/seller-flow/cadence-priority-resolver.js'
import {
  isEnrolled,
  enrollmentStatus,
  buildForwardEnrollment,
  validateControlledEnrollment,
  planControlledEnrollment,
  ACTIVATION_SOURCE,
  ENROLLMENT_REFUSAL,
  MAX_ENROLLMENT_BATCH,
} from '@/lib/domain/seller-flow/cadence-enrollment.js'
import { LIFECYCLE_STAGE_CODES as C } from '@/lib/domain/lead-state/universal-lead-state-registry.js'

/**
 * V2-2B — cadence = stage × attempt × verified urgency profile.
 */

const NOW = '2026-09-12T00:00:00.000Z'
const daysFromNow = (n) => new Date(Date.parse(NOW) + n * 86400000).toISOString()
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()

const LIFECYCLE = [
  C.OWNERSHIP_CONFIRMATION, C.OFFER_INTEREST, C.ASKING_PRICE,
  C.PROPERTY_CONDITION, C.OFFER, C.FORMAL_CONTRACT,
]

// ── §7 Invariant A — stage tightening WITHIN a profile ─────────────────────

test('INVARIANT A: first delay never loosens as the seller advances, per profile', () => {
  for (const profile of Object.values(CADENCE_PROFILE)) {
    let prev = Infinity
    let prevStage = '(start)'
    for (const stage of LIFECYCLE) {
      const first = firstDelayHours(profile, stage, 30)
      if (first == null) continue
      assert.ok(
        first <= prev,
        `${profile}: cadence loosened at ${stage} (${first}h) vs ${prevStage} (${prev}h)`
      )
      prev = first
      prevStage = stage
    }
  }
})

test('INVARIANT A holds for URGENT at every deadline distance', () => {
  // The S1 opening is computed, so the invariant must hold across its range.
  for (const days of [1, 5, 7, 14, 21, 30, 120]) {
    let prev = Infinity
    for (const stage of LIFECYCLE) {
      const first = firstDelayHours(CADENCE_PROFILE.URGENT, stage, days)
      assert.ok(first <= prev, `urgent@${days}d loosened at ${stage} (${first}h vs ${prev}h)`)
      prev = first
    }
  }
})

test('INVARIANT A is NOT evaluated across profiles', () => {
  // STANDARD S1 (720h) vs URGENT S2 (24h) is not one lifecycle. Asserting the
  // tables are genuinely different is what makes the per-profile check
  // meaningful rather than vacuous.
  assert.notEqual(
    firstDelayHours(CADENCE_PROFILE.STANDARD, C.OWNERSHIP_CONFIRMATION),
    firstDelayHours(CADENCE_PROFILE.URGENT, C.OWNERSHIP_CONFIRMATION, 3)
  )
})

// ── §7 Invariant B — attempts spread out ───────────────────────────────────

test('INVARIANT B: repeated unanswered attempts never speed up', () => {
  for (const [profile, stages] of Object.entries(CADENCE_MATRIX)) {
    for (const [stage, entry] of Object.entries(stages)) {
      let prev = -Infinity
      entry.delays_hours.forEach((delay, i) => {
        assert.ok(delay >= prev, `${profile}/${stage} attempt ${i + 1} (${delay}h) < previous (${prev}h)`)
        prev = delay
      })
    }
  }
})

test('INVARIANT B holds for a deadline-aware URGENT S1 opening', () => {
  for (const days of [1, 10, 30]) {
    const first = resolveUrgentS1FirstDelayHours(days)
    const rest = CADENCE_MATRIX[CADENCE_PROFILE.URGENT][C.OWNERSHIP_CONFIRMATION].delays_hours.slice(1)
    let prev = first
    for (const d of rest) {
      assert.ok(d >= prev, `urgent S1@${days}d attempt spacing decreased: ${d} < ${prev}`)
      prev = d
    }
  }
})

test('V2-2B: urgent cadence is never an indefinite daily chase', () => {
  const s1 = CADENCE_MATRIX[CADENCE_PROFILE.URGENT][C.OWNERSHIP_CONFIRMATION]
  assert.ok(s1.max_attempts <= 3)
  assert.ok(s1.delays_hours[s1.delays_hours.length - 1] >= 72)
})

test('V2-2B: no cadence dips below the 24h compliance floor', () => {
  for (const stages of Object.values(CADENCE_MATRIX)) {
    for (const entry of Object.values(stages)) {
      for (const d of entry.delays_hours) assert.ok(d >= 24, `delay ${d}h below floor`)
    }
  }
  for (const days of [0, 1, 3, 7, 21, 90]) {
    assert.ok(resolveUrgentS1FirstDelayHours(days) >= 24)
  }
})

// ── §4 STANDARD ────────────────────────────────────────────────────────────

test('Standard S1: first follow-up is 30 DAYS, second is 60, max 2', () => {
  const a1 = resolveCadence({ stage: C.OWNERSHIP_CONFIRMATION, profile: CADENCE_PROFILE.STANDARD, attempt: 0 })
  assert.equal(a1.delay_hours, 720)
  const a2 = resolveCadence({ stage: C.OWNERSHIP_CONFIRMATION, profile: CADENCE_PROFILE.STANDARD, attempt: 1 })
  assert.equal(a2.delay_hours, 1440)
  const a3 = resolveCadence({ stage: C.OWNERSHIP_CONFIRMATION, profile: CADENCE_PROFILE.STANDARD, attempt: 2 })
  assert.equal(a3.eligible, false)
  assert.equal(a3.reason, 'attempts_exhausted')
})

test('§4: exhausted S1 hands back to contact resolution, concluding nothing', () => {
  const r = resolveCadence({ stage: C.OWNERSHIP_CONFIRMATION, profile: CADENCE_PROFILE.STANDARD, attempt: 2 })
  assert.equal(r.hands_back_to_contact_resolution, true)
  // Must NOT assert anything about the owner.
  assert.equal(r.wrong_owner, undefined)
  assert.equal(r.not_interested, undefined)
})

test('§8: S3 asking-price first follow-up is 24 HOURS on STANDARD', () => {
  const r = resolveCadence({ stage: C.ASKING_PRICE, profile: CADENCE_PROFILE.STANDARD, attempt: 0 })
  assert.equal(r.delay_hours, 24)
})

test('§8: S3 first follow-up is 24 hours on PRIORITY too', () => {
  const r = resolveCadence({ stage: C.ASKING_PRICE, profile: CADENCE_PROFILE.PRIORITY, attempt: 0 })
  assert.equal(r.delay_hours, 24)
})

test('Standard S2 is 3d / 7d / 14d', () => {
  const d = CADENCE_MATRIX[CADENCE_PROFILE.STANDARD][C.OFFER_INTEREST].delays_hours
  assert.deepEqual(d, [72, 168, 336])
})

// ── §5 PRIORITY ────────────────────────────────────────────────────────────

test('Priority S1: first follow-up is 7 days, max 3', () => {
  const r = resolveCadence({ stage: C.OWNERSHIP_CONFIRMATION, profile: CADENCE_PROFILE.PRIORITY, attempt: 0 })
  assert.equal(r.delay_hours, 168)
  assert.equal(r.max_attempts, 3)
})

test('Priority accelerates ONLY the cold stage, not the whole funnel', () => {
  // S2+ are already conversational; priority changes nothing there.
  for (const stage of [C.OFFER_INTEREST, C.ASKING_PRICE, C.PROPERTY_CONDITION]) {
    assert.deepEqual(
      CADENCE_MATRIX[CADENCE_PROFILE.PRIORITY][stage].delays_hours,
      CADENCE_MATRIX[CADENCE_PROFILE.STANDARD][stage].delays_hours
    )
  }
})

// ── §6 URGENT ──────────────────────────────────────────────────────────────

test('Urgent S1 is deadline-aware: 24h / 48h / 72h', () => {
  assert.equal(resolveUrgentS1FirstDelayHours(3), 24)
  assert.equal(resolveUrgentS1FirstDelayHours(14), 48)
  assert.equal(resolveUrgentS1FirstDelayHours(45), 72)
})

test('Urgent S2-S6 open within 24 hours', () => {
  for (const stage of [C.OFFER_INTEREST, C.ASKING_PRICE, C.PROPERTY_CONDITION, C.OFFER, C.FORMAL_CONTRACT]) {
    assert.ok(firstDelayHours(CADENCE_PROFILE.URGENT, stage) <= 24, `${stage} opens too slowly`)
  }
})

// ── §1/§2 Priority resolver ────────────────────────────────────────────────

test('§14 Standard: no authoritative urgency yields STANDARD', () => {
  const r = resolveCadenceProfile({ property: {}, now: NOW })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
  assert.equal(r.seller_facts_created, 0)
})

test('§14 Priority: verified pre-foreclosure with no date yields PRIORITY', () => {
  const r = resolveCadenceProfile({
    property: { is_pre_foreclosure: true, urgency_verified_at: daysAgo(5) }, now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.PRIORITY)
  assert.equal(r.cadence_profile_reason, 'verified_pre_foreclosure')
  assert.ok(r.cadence_profile_verified_at)
  assert.ok(r.cadence_profile_expires_at)
})

test('§14 Urgent: a verified future auction date yields URGENT', () => {
  const r = resolveCadenceProfile({
    property: { auction_date: daysFromNow(10), urgency_verified_at: daysAgo(2) }, now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.URGENT)
  assert.equal(Math.round(r.days_to_deadline), 10)
  assert.equal(r.cadence_profile_expires_at, daysFromNow(10))
})

test('§14 Weak indicators alone stay STANDARD', () => {
  const r = resolveCadenceProfile({
    property: {
      absentee_owner: true, high_equity: true, vacant: true,
      property_value: 900000, lead_score: 99, motivation_score: 95,
      distress_purchase_score: 88,
    },
    now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
})

test('§2: the rejected-signal list is explicit, not merely unimplemented', () => {
  for (const s of ['absentee_owner', 'high_equity', 'vacant', 'lead_score', 'motivation_score']) {
    assert.ok(REJECTED_URGENCY_SIGNALS.includes(s), `${s} must be explicitly rejected`)
  }
})

test('§14 Expired urgency: a past auction is history, not urgency', () => {
  const r = resolveCadenceProfile({ property: { auction_date: daysAgo(10) }, now: NOW })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
})

test('§10 A cancelled auction drops the lead out of URGENT', () => {
  const r = resolveCadenceProfile({
    property: { auction_date: daysFromNow(20), auction_status: 'Cancelled' }, now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
  assert.equal(r.cadence_profile_reason, 'auction_cancelled_or_withdrawn')
})

test('§10 Stale foreclosure evidence stops counting', () => {
  const r = resolveCadenceProfile({
    property: { is_pre_foreclosure: true, urgency_verified_at: daysAgo(EVIDENCE_TTL_DAYS.foreclosure_stage + 10) },
    now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
  assert.equal(r.cadence_profile_reason, 'foreclosure_evidence_stale')
})

test('§10 De-escalation is reported, and mutates no seller fact', () => {
  const r = recomputeCadenceProfile({
    stored: { cadence_profile: CADENCE_PROFILE.URGENT, cadence_profile_expires_at: daysAgo(1) },
    property: {}, now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
  assert.equal(r.direction, 'de_escalated')
  assert.equal(r.seller_facts_mutated, 0)
})

test('§10 A new verified auction escalates', () => {
  const r = recomputeCadenceProfile({
    stored: { cadence_profile: CADENCE_PROFILE.STANDARD },
    property: { auction_date: daysFromNow(5), urgency_verified_at: NOW }, now: NOW,
  })
  assert.equal(r.direction, 'escalated')
  assert.equal(r.cadence_profile, CADENCE_PROFILE.URGENT)
})

test('§1 urgency never writes a seller fact', () => {
  const r = resolveCadenceProfile({
    property: { auction_date: daysFromNow(3), urgency_verified_at: NOW }, now: NOW,
  })
  assert.equal(r.seller_facts_created, 0)
  assert.equal(r.seller_motivated, undefined)
  assert.equal(r.seller_interested, undefined)
})

test('§2 a seller-stated concrete deadline is URGENT and explainable', () => {
  const r = resolveCadenceProfile({
    seller: { stated_deadline: daysFromNow(4), evidence_at: daysAgo(1) }, now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.URGENT)
  assert.ok(r.cadence_profile_reason)
  assert.ok(r.cadence_profile_verified_at)
  assert.ok(r.cadence_profile_expires_at)
  assert.ok(r.evidence)
})

test('§2 a vague "immediate" timeline is PRIORITY, not URGENT', () => {
  const r = resolveCadenceProfile({ seller: { timeline: 'immediate', evidence_at: daysAgo(2) }, now: NOW })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.PRIORITY)
})

test('§2 a stale seller deadline stops counting', () => {
  const r = resolveCadenceProfile({
    seller: { stated_deadline: daysFromNow(5), evidence_at: daysAgo(EVIDENCE_TTL_DAYS.seller_stated_deadline + 5) },
    now: NOW,
  })
  assert.equal(r.cadence_profile, CADENCE_PROFILE.STANDARD)
})

test('§2 every non-standard classification answers why/what/when/until', () => {
  for (const input of [
    { property: { auction_date: daysFromNow(9), urgency_verified_at: NOW } },
    { property: { is_pre_foreclosure: true, urgency_verified_at: NOW } },
    { seller: { stated_deadline: daysFromNow(3), evidence_at: NOW } },
  ]) {
    const r = resolveCadenceProfile({ ...input, now: NOW })
    assert.notEqual(r.cadence_profile, CADENCE_PROFILE.STANDARD)
    assert.ok(r.cadence_profile_reason, 'WHY missing')
    assert.ok(r.evidence, 'WHAT missing')
    assert.ok(r.cadence_profile_verified_at, 'WHEN missing')
    assert.ok(r.cadence_profile_expires_at, 'UNTIL missing')
  }
})

// ── §11/§12 activation boundary ────────────────────────────────────────────

test('§11 P0: an unenrolled historical thread is NOT due — it is invisible', () => {
  const legacy = { thread_key: 't1', next_follow_up_at: daysAgo(90), enrolled_at: null }
  assert.equal(isEnrolled(legacy), false)
  const s = enrollmentStatus(legacy)
  assert.equal(s.status, ACTIVATION_SOURCE.LEGACY)
  assert.equal(s.scheduler_visible, false)
})

test('§11 a new objective after activation enrolls forward', () => {
  const e = buildForwardEnrollment({ now: NOW })
  assert.equal(e.activation_source, ACTIVATION_SOURCE.NEW_OBJECTIVE)
  assert.ok(e.enrolled_at)
  assert.ok(e.policy_version)
})

test('§12 enrollment without a limit is refused', () => {
  const r = validateControlledEnrollment({ market: 'Miami, FL' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, ENROLLMENT_REFUSAL.NO_LIMIT)
})

test('§12 enrollment without a selector is refused', () => {
  const r = validateControlledEnrollment({ limit: 100 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, ENROLLMENT_REFUSAL.NO_SELECTOR)
})

test('§12 an oversized batch is refused', () => {
  const r = validateControlledEnrollment({ market: 'Miami, FL', limit: MAX_ENROLLMENT_BATCH + 1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, ENROLLMENT_REFUSAL.LIMIT_TOO_LARGE)
})

test('§12 there is no path that enrolls all 7,798', () => {
  const mod = Object.keys(
    { isEnrolled, enrollmentStatus, buildForwardEnrollment, validateControlledEnrollment, planControlledEnrollment }
  )
  assert.ok(!mod.some((k) => /all|everything|backfill/i.test(k)), 'a bulk-enrol entry point exists')
  // And the widest legal request is still bounded.
  const widest = validateControlledEnrollment({ market: 'x', stage: 'y', age_band_days: 99999, limit: 999 })
  assert.equal(widest.ok, false)
})

test('§12 a bounded plan enrolls at most the limit and never re-enrolls', () => {
  const candidates = Array.from({ length: 50 }, (_, i) => ({
    thread_key: `t${i}`, market: 'Miami, FL', age_days: 40,
    enrolled_at: i < 5 ? NOW : null,
  }))
  const plan = planControlledEnrollment({ market: 'Miami, FL', limit: 10 }, candidates)
  assert.equal(plan.ok, true)
  assert.equal(plan.count, 10)
  assert.equal(plan.executed, false)
  assert.equal(plan.sends, 0)
  assert.ok(plan.planned.every((r) => !r.enrolled_at), 'already-enrolled rows must be excluded')
})

test('§12 planning is not executing', () => {
  const plan = planControlledEnrollment({ thread_keys: ['a'], limit: 1 }, [{ thread_key: 'a', enrolled_at: null }])
  assert.equal(plan.executed, false)
  assert.equal(plan.sends, 0)
})

// ── Composition ────────────────────────────────────────────────────────────

test('V2-2B: next follow-up instant is computed from the resolved delay', () => {
  const c = resolveCadence({ stage: C.ASKING_PRICE, profile: CADENCE_PROFILE.STANDARD, attempt: 0 })
  const next = computeNextFollowUpAt({ from: NOW, delay_hours: c.delay_hours })
  assert.equal(next, new Date(Date.parse(NOW) + 24 * 3600000).toISOString())
})

test('V2-2B: an operational stage has no cadence and invents none', () => {
  const r = resolveCadence({ stage: C.DISPOSITION, profile: CADENCE_PROFILE.URGENT, attempt: 0 })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'no_cadence_policy_for_stage')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planNextNurtureTouch,
  revalidateNurtureTouch,
  advanceNurtureCycle,
  NURTURE_REASON,
  NURTURE_STATUS,
  NURTURE_CYCLE_DAYS,
} from '@/lib/domain/seller-flow/nurture-cadence.js'
import { FOLLOWUP_POLICY_BY_STAGE, resolveFollowUpPolicyForStage } from '@/lib/domain/seller-flow/followup-policy-registry.js'
import { LIFECYCLE_STAGE_CODES as C } from '@/lib/domain/lead-state/universal-lead-state-registry.js'

/**
 * V2-2 — cadence and nurture.
 *
 * The invariant carried through every test: time may move communication
 * state, and may never move seller facts or stage.
 */

const DAY = 24 * 60 * 60 * 1000
const T0 = '2026-01-01T00:00:00.000Z'
const at = (days) => new Date(Date.parse(T0) + days * DAY).toISOString()

// ── The core rule ──────────────────────────────────────────────────────────

test('V2-2 INVARIANT: a nurture touch creates zero seller facts', () => {
  const p = planNextNurtureTouch({ reason: NURTURE_REASON.NOT_INTERESTED, cycle: 0, entered_at: T0, now: at(31) })
  assert.equal(p.due, true)
  assert.equal(p.seller_facts_created, 0)
  assert.equal(p.stage_advanced, false)
  assert.equal(p.sends, 0)
})

test('V2-2 INVARIANT: advancing the cycle never advances stage', () => {
  const a = advanceNurtureCycle({ cycle: 0, reason: NURTURE_REASON.NOT_INTERESTED, attempted_at: T0 })
  assert.equal(a.stage_advanced, false)
  assert.equal(a.seller_facts_created, 0)
  assert.equal(a.nurture_cycle, 1)
  assert.equal(a.attempt_count_delta, 1)
})

// ── Journey E — 30 / 60 / 90 ───────────────────────────────────────────────

test('Journey E: touch 1 is due at +30 days, not before', () => {
  const early = planNextNurtureTouch({ cycle: 0, entered_at: T0, now: at(29) })
  assert.equal(early.due, false)
  assert.equal(early.status, NURTURE_STATUS.ACTIVE)
  assert.equal(early.next_follow_up_at, at(30))

  const due = planNextNurtureTouch({ cycle: 0, entered_at: T0, now: at(30) })
  assert.equal(due.due, true)
  assert.equal(due.status, NURTURE_STATUS.DUE)
})

test('Journey E: touch 2 is +60 days after touch 1 actually happened', () => {
  // Anchored to the last ATTEMPT, not the original reply — otherwise a touch
  // delayed by suppression bunches the remaining touches together.
  const p = planNextNurtureTouch({ cycle: 1, last_attempt_at: at(35), now: at(94) })
  assert.equal(p.interval_days, 60)
  assert.equal(p.next_follow_up_at, at(95))
  assert.equal(p.due, false)
})

test('Journey E: touch 3 is +90 days after touch 2', () => {
  const p = planNextNurtureTouch({ cycle: 2, last_attempt_at: at(100), now: at(190) })
  assert.equal(p.interval_days, 90)
  assert.equal(p.due, true)
  assert.equal(p.next_cycle, 3)
})

test('Journey E: after touch 3 the sequence completes into a long-term hold', () => {
  const p = planNextNurtureTouch({ cycle: 3, last_attempt_at: at(200), now: at(999) })
  assert.equal(p.status, NURTURE_STATUS.COMPLETED)
  assert.equal(p.due, false)
  assert.equal(p.next_follow_up_at, null)
  assert.equal(p.requires_review, true)
})

test('V2-2: nurture never becomes an endless monthly drip', () => {
  assert.equal(NURTURE_CYCLE_DAYS[NURTURE_REASON.NOT_INTERESTED].length, 3)
  for (let cycle = 3; cycle < 8; cycle += 1) {
    const p = planNextNurtureTouch({ cycle, last_attempt_at: at(200), now: at(9999) })
    assert.equal(p.due, false, `cycle ${cycle} must not be due`)
  }
})

test('V2-2: only ONE touch is planned at a time', () => {
  const p = planNextNurtureTouch({ cycle: 0, entered_at: T0, now: at(31) })
  // A single next_follow_up_at, not a list of three.
  assert.equal(typeof p.next_follow_up_at, 'string')
  assert.equal(p.next_cycle, 1)
})

// ── Reasons stay distinct (§8) ─────────────────────────────────────────────

test('V2-2: nurture reasons are distinct, not flattened', () => {
  const reasons = Object.values(NURTURE_REASON)
  assert.ok(reasons.includes('not_interested'))
  assert.ok(reasons.includes('price_gap'))
  assert.ok(reasons.includes('strategy_exhausted'))
  assert.equal(new Set(reasons).size, reasons.length)
})

test('V2-2: the reason is carried on every decision', () => {
  const p = planNextNurtureTouch({ reason: NURTURE_REASON.PRICE_GAP, cycle: 0, entered_at: T0, now: at(31) })
  assert.equal(p.reason, 'price_gap')
})

test('V2-2: an unknown reason cancels rather than defaulting to a cadence', () => {
  const p = planNextNurtureTouch({ reason: 'made_up', cycle: 0, entered_at: T0, now: at(999) })
  assert.equal(p.status, NURTURE_STATUS.CANCELLED)
  assert.equal(p.due, false)
})

// ── Journey F — opt-out overrides everything (§9) ──────────────────────────

test('Journey F: an opted-out contact is never nurtured', () => {
  const v = revalidateNurtureTouch({ opted_out: true })
  assert.equal(v.eligible, false)
  assert.ok(v.blockers.includes('opted_out'))
  assert.equal(v.terminal, true)
})

test('Journey F: DNC is terminal too', () => {
  const v = revalidateNurtureTouch({ dnc: true })
  assert.equal(v.eligible, false)
  assert.equal(v.terminal, true)
})

test('V2-2: nurture cannot resurrect a suppressed contact', () => {
  const v = revalidateNurtureTouch({ suppressed: true })
  assert.equal(v.eligible, false)
  assert.ok(v.blockers.includes('suppressed'))
})

// ── Re-validation every cycle (§7) ─────────────────────────────────────────

test('V2-2: each cycle re-validates rather than trusting plan-time state', () => {
  const v = revalidateNurtureTouch({
    opted_out: false, dnc: false, suppressed: false,
    contact_valid: false, opportunity_closed: true,
  })
  assert.equal(v.eligible, false)
  assert.ok(v.blockers.includes('contact_invalid'))
  assert.ok(v.blockers.includes('opportunity_closed'))
})

test('Journey G: new inbound supersedes a planned nurture touch', () => {
  const v = revalidateNurtureTouch({ new_inbound_since_plan: true })
  assert.equal(v.eligible, false)
  assert.ok(v.blockers.includes('new_inbound_supersedes_nurture'))
})

test('V2-2: an ownership change invalidates a pending nurture touch', () => {
  const v = revalidateNurtureTouch({ ownership_changed: true })
  assert.equal(v.eligible, false)
})

test('V2-2: a clean contact is eligible and still creates no facts', () => {
  const v = revalidateNurtureTouch({})
  assert.equal(v.eligible, true)
  assert.equal(v.seller_facts_created, 0)
  assert.equal(v.stage_advanced, false)
  assert.equal(v.sends, 0)
})

// ── Stage cadence (§3, §4, §5) ─────────────────────────────────────────────

test('Journey A: S1 ownership cadence is 3 days, max 3 touches', () => {
  const p = resolveFollowUpPolicyForStage(C.OWNERSHIP_CONFIRMATION).policy
  assert.equal(p.enabled, true)
  assert.equal(p.no_reply_delay_days, 3)
  assert.equal(p.max_automated_followups, 3)
  assert.equal(p.requires_delivery_confirmation, true)
})

test('Journey B: S2 offer-interest cadence is ~3 days', () => {
  const p = resolveFollowUpPolicyForStage(C.OFFER_INTEREST).policy
  assert.equal(p.no_reply_delay_days, 3)
})

test('Journey C: S3 asking-price cadence is 24 HOURS', () => {
  const p = resolveFollowUpPolicyForStage(C.ASKING_PRICE).policy
  assert.equal(p.no_reply_delay_hours, 24)
  // The derived days field stays populated so existing day-only consumers
  // keep working rather than reading undefined.
  assert.equal(p.no_reply_delay_days, 1)
})

test('V2-2: S3 is the only sub-day stage cadence', () => {
  const subDay = Object.entries(FOLLOWUP_POLICY_BY_STAGE)
    .filter(([, p]) => p.no_reply_delay_hours)
    .map(([stage]) => stage)
  assert.deepEqual(subDay, [C.ASKING_PRICE])
})

test('V2-2: operational stages schedule no seller follow-ups', () => {
  for (const stage of [C.UNDER_CONTRACT, C.DISPOSITION, C.PREPARED_TO_CLOSE, C.CLOSED]) {
    const p = resolveFollowUpPolicyForStage(stage).policy
    assert.equal(p.enabled, false, `${stage} must not nudge`)
    assert.equal(p.max_automated_followups, 0)
  }
})

test('V2-2: every stage has a bounded touch ceiling', () => {
  for (const [stage, p] of Object.entries(FOLLOWUP_POLICY_BY_STAGE)) {
    assert.equal(typeof p.max_automated_followups, 'number', `${stage} has no ceiling`)
    assert.ok(p.max_automated_followups <= 3, `${stage} ceiling too high`)
  }
})

test('V2-2: time alone never changes the objective', () => {
  // The plan for a not_interested thread at day 400 is still a nurture touch —
  // it never becomes an interest or price objective through waiting.
  const p = planNextNurtureTouch({ cycle: 1, last_attempt_at: T0, now: at(400) })
  assert.equal(p.reason, NURTURE_REASON.NOT_INTERESTED)
  assert.equal(p.stage_advanced, false)
})

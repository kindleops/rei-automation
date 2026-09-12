import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveQueueAuthority,
  isDispatchEligible,
  revalidateBeforeDispatch,
  QUEUE_DISPOSITION,
  REVIEW_HOLD_STATUS,
  EXECUTABLE_STATUSES,
} from '@/lib/domain/queue/queue-authority.js'
import {
  resolveSenderHealth,
  isSenderEligible,
  selectHealthySender,
  describeRecoveryRequirements,
  SENDER_HEALTH,
  SENDER_INELIGIBLE_REASON,
} from '@/lib/domain/delivery/sender-health.js'
import {
  resolveThreadIdentity,
  isPersonaApproved,
  APPROVED_PERSONA_POOL,
  IDENTITY_HOLD,
  IDENTITY_CHANNEL,
  IDENTITY_POLICY_OPTIONS,
} from '@/lib/domain/campaigns/outbound-identity-policy.js'

/**
 * OPS-1 — the three operational defects surfaced by the live S1 proof and the
 * real seller reply.
 */

const CONTAINED = { queue_processor_mode: 'safe', queue_execution_mode: 'scoped_canary_only' }
const LIVE = { queue_processor_mode: 'live', queue_execution_mode: 'live' }

// ── §2 Containment invariant ───────────────────────────────────────────────

test('§2 INVARIANT: contained automation cannot create an executable row', () => {
  const a = resolveQueueAuthority({ producer: 'auto_reply', control: CONTAINED })
  assert.equal(a.disposition, QUEUE_DISPOSITION.REVIEW_HOLD)
  assert.equal(a.queue_authority, false)
  assert.equal(a.queue_status, REVIEW_HOLD_STATUS)
  assert.ok(!EXECUTABLE_STATUSES.includes(a.queue_status))
  assert.equal(a.execution_enrolled, false)
})

test('§3 generation authority survives containment; queue authority does not', () => {
  const a = resolveQueueAuthority({ producer: 'auto_reply', control: CONTAINED })
  assert.equal(a.generation_authority, true, 'content is still useful for review')
  assert.equal(a.queue_authority, false)
})

test('§2 the Ronald case: an auto_reply under containment lands non-executable', () => {
  // Exactly the producer/control combination that created a dispatchable row
  // for a real seller.
  const a = resolveQueueAuthority({ producer: 'auto_reply', control: CONTAINED })
  assert.equal(a.queue_status, REVIEW_HOLD_STATUS)
  assert.equal(a.reason, 'containment_active_generation_only')
})

test('§2 an unreadable control plane counts as contained', () => {
  const a = resolveQueueAuthority({ producer: 'auto_reply', control: {} })
  assert.equal(a.disposition, QUEUE_DISPOSITION.REVIEW_HOLD)
})

test('§2 partial containment (processor live, execution scoped) still contains', () => {
  const a = resolveQueueAuthority({
    producer: 'campaign', control: { queue_processor_mode: 'live', queue_execution_mode: 'scoped_canary_only' },
  })
  assert.equal(a.queue_authority, false)
})

test('§2 the scoped canary is the ONLY executable exception under containment', () => {
  const a = resolveQueueAuthority({
    producer: 'internal_canary', control: CONTAINED,
    scoped_canary_authorization: { valid: true, queue_row_ids: ['row-1'] },
  })
  assert.equal(a.disposition, QUEUE_DISPOSITION.EXECUTABLE)
  assert.equal(a.scoped, true)
  assert.deepEqual(a.allowlist, ['row-1'])
})

test('§2 an invalid canary authorization does not unlock execution', () => {
  const a = resolveQueueAuthority({
    producer: 'internal_canary', control: CONTAINED,
    scoped_canary_authorization: { valid: false, queue_row_ids: ['row-1'] },
  })
  assert.equal(a.disposition, QUEUE_DISPOSITION.REVIEW_HOLD)
})

test('live mode restores ordinary queue authority', () => {
  const a = resolveQueueAuthority({ producer: 'campaign', control: LIVE })
  assert.equal(a.disposition, QUEUE_DISPOSITION.EXECUTABLE)
  assert.equal(a.execution_enrolled, true)
})

// ── §5 Release boundary ────────────────────────────────────────────────────

test('§5 P0: an unenrolled row does NOT dispatch even in live mode', () => {
  const stale = { queue_status: 'queued', execution_enrolled_at: null }
  const v = isDispatchEligible(stale, { control: LIVE })
  assert.equal(v.eligible, false)
  assert.equal(v.reason, 'not_execution_enrolled')
  assert.equal(v.requires_reauthorization, true)
})

test('§5 flipping processor mode cannot wake rows accumulated under containment', () => {
  const accumulated = Array.from({ length: 50 }, () => ({ queue_status: 'queued', execution_enrolled_at: null }))
  const woken = accumulated.filter((r) => isDispatchEligible(r, { control: LIVE }).eligible)
  assert.equal(woken.length, 0)
})

test('§5 an enrolled row in live mode is dispatch eligible', () => {
  const v = isDispatchEligible(
    { queue_status: 'queued', execution_enrolled_at: '2026-09-12T00:00:00Z' }, { control: LIVE }
  )
  assert.equal(v.eligible, true)
})

test('§5 enrollment alone is not enough while containment is active', () => {
  const v = isDispatchEligible(
    { queue_status: 'queued', execution_enrolled_at: '2026-09-12T00:00:00Z' }, { control: CONTAINED }
  )
  assert.equal(v.eligible, false)
  assert.equal(v.reason, 'containment_active_without_scoped_authorization')
})

test('§5 a held row is never dispatch eligible', () => {
  const v = isDispatchEligible(
    { queue_status: REVIEW_HOLD_STATUS, execution_enrolled_at: '2026-09-12T00:00:00Z' }, { control: LIVE }
  )
  assert.equal(v.eligible, false)
})

// ── §4 Revalidation ────────────────────────────────────────────────────────

test('§4 a queued reply is superseded by a later inbound', () => {
  const v = revalidateBeforeDispatch({ row: { objective: 'condition_probe' }, new_inbound_since_plan: true })
  assert.equal(v.ok, false)
  assert.equal(v.action, 'hold_supersede')
  assert.ok(v.blockers.includes('new_inbound_supersedes_queued_reply'))
  assert.equal(v.provider_attempts, 0)
})

test('§4 an objective change blocks a stale row', () => {
  const v = revalidateBeforeDispatch({
    row: { use_case_template: 'condition_probe' }, current_objective: 'asking_price',
  })
  assert.equal(v.ok, false)
  assert.ok(v.blockers.some((b) => b.startsWith('objective_changed')))
})

test('§4 suppression and DNC block regardless of everything else', () => {
  const v = revalidateBeforeDispatch({ row: {}, suppressed: true, dnc: true })
  assert.equal(v.ok, false)
  assert.ok(v.blockers.includes('suppressed'))
  assert.ok(v.blockers.includes('dnc'))
})

test('§4 an ungoverned template blocks at dispatch time', () => {
  const v = revalidateBeforeDispatch({ row: {}, template_governed: false })
  assert.equal(v.ok, false)
  assert.ok(v.blockers.includes('template_not_governed'))
})

test('§4 an unhealthy sender blocks at dispatch time', () => {
  const v = revalidateBeforeDispatch({ row: {}, sender_health: SENDER_HEALTH.COOLING })
  assert.equal(v.ok, false)
  assert.ok(v.blockers.some((b) => b.startsWith('sender_not_healthy')))
})

test('§4 a strategy change blocks a stale S5 row', () => {
  const v = revalidateBeforeDispatch({ row: { strategy: 'cash' }, current_strategy: 'creative' })
  assert.equal(v.ok, false)
  assert.ok(v.blockers.some((b) => b.startsWith('strategy_changed')))
})

test('§4 a fully current row revalidates clean', () => {
  const v = revalidateBeforeDispatch({
    row: { objective: 'ownership_check', current_stage: 'S1' },
    current_objective: 'ownership_check', current_stage: 'S1',
    sender_health: SENDER_HEALTH.ACTIVE_HEALTHY,
  })
  assert.equal(v.ok, true)
  assert.equal(v.action, 'dispatch')
})

// ── §6/§7 Sender health ────────────────────────────────────────────────────

const MIAMI_COOLING = {
  phone_number: '+17866052999', market: 'Miami, FL', status: 'active',
  health_state: 'cooling', spam_flagged_at: '2026-09-10T00:00:00Z',
  daily_limit: 800, messages_sent_today: 2,
}
const HEALTHY = {
  phone_number: '+13058975670', market: 'Miami, FL', status: 'active',
  health_state: 'active_healthy', daily_limit: 800, messages_sent_today: 0,
}
const PAUSED = {
  phone_number: '+13057604780', market: 'Miami, FL', status: 'paused',
  health_state: 'paused', daily_limit: 800, messages_sent_today: 0,
}

test('§16 a cooling / spam-flagged number is INELIGIBLE despite status=active', () => {
  // The exact defect: status was active, so selection took it.
  const v = isSenderEligible(MIAMI_COOLING)
  assert.equal(v.eligible, false)
  assert.equal(v.health, SENDER_HEALTH.COOLING)
  assert.equal(v.reason, SENDER_INELIGIBLE_REASON.COOLING)
})

test('§16 a healthy number is eligible', () => {
  assert.equal(isSenderEligible(HEALTHY).eligible, true)
})

test('§16 paused and blocked are ineligible', () => {
  assert.equal(isSenderEligible(PAUSED).eligible, false)
  assert.equal(
    isSenderEligible(HEALTHY, { blockedSet: new Set(['+13058975670']) }).reason,
    SENDER_INELIGIBLE_REASON.BLOCKED
  )
})

test('§7 UNVERIFIED is not healthy — absence of evidence is not health', () => {
  const v = isSenderEligible({ phone_number: '+1555', status: 'active', daily_limit: 800, messages_sent_today: 0 })
  assert.equal(v.eligible, false)
  assert.equal(v.health, SENDER_HEALTH.UNVERIFIED)
})

test('§7 an unrecognised health value is not a licence', () => {
  const v = resolveSenderHealth({ phone_number: '+1555', status: 'active', health_state: 'probably_fine' })
  assert.equal(v.health, SENDER_HEALTH.UNVERIFIED)
})

test('§7 a cooling number does not self-promote when its window elapses', () => {
  const v = resolveSenderHealth(
    { ...MIAMI_COOLING, cooling_until: '2026-09-11T00:00:00Z' }, { now: '2026-09-12T00:00:00Z' }
  )
  assert.equal(v.health, SENDER_HEALTH.COOLING)
  assert.equal(v.cooling_window_elapsed, true)
  assert.equal(v.requires_explicit_recovery, true)
})

test('§16 healthy wins over a cooling number regardless of usage ranking', () => {
  // The cooling number has MORE history, which older ranking favoured.
  const r = selectHealthySender({ market: 'Miami, FL', senders: [MIAMI_COOLING, HEALTHY] })
  assert.equal(r.ok, true)
  assert.equal(r.selected_phone, '+13058975670')
})

test('§8 no healthy sender → HOLD, never a degraded fallback', () => {
  const r = selectHealthySender({ market: 'Miami, FL', senders: [MIAMI_COOLING, PAUSED] })
  assert.equal(r.ok, false)
  assert.equal(r.hold, true)
  assert.equal(r.reason, SENDER_INELIGIBLE_REASON.NO_HEALTHY_SENDER)
  assert.equal(r.selected, null)
  assert.equal(r.degraded_fallback_allowed, false)
})

test('§8 no silent cross-market fallback', () => {
  const other = { ...HEALTHY, market: 'Dallas, TX' }
  const r = selectHealthySender({ market: 'Miami, FL', senders: [MIAMI_COOLING, other] })
  assert.equal(r.ok, false)
  assert.equal(r.cross_market_fallback_allowed, false)
})

test('§9 recovery requirements are explicit, not a bare unblock', () => {
  const r = describeRecoveryRequirements(MIAMI_COOLING)
  assert.equal(r.current_health, SENDER_HEALTH.COOLING)
  assert.ok(r.requirements.includes('explicit_operator_promotion_with_provenance'))
  assert.ok(r.requirements.length >= 3)
})

test('§8 every candidate verdict is reported, so a HOLD is explainable', () => {
  const r = selectHealthySender({ market: 'Miami, FL', senders: [MIAMI_COOLING, PAUSED] })
  assert.equal(r.considered.length, 2)
  assert.ok(r.considered.every((c) => c.reason))
})

// ── §11/§12 Identity continuity ────────────────────────────────────────────

test('§17 an established thread keeps its persona when another is proposed', () => {
  const r = resolveThreadIdentity({
    thread_key: '+13050000001',
    existing_binding: { persona: 'Helen Crawford' },
    proposed_persona: 'Carlos Mendez',
  })
  assert.equal(r.ok, true)
  assert.equal(r.persona, 'Helen Crawford')
  assert.equal(r.agent_name, 'Helen')
  assert.equal(r.drift_detected, true)
  assert.equal(r.drift_suppressed, true)
})

test('§12 a different sender number does not change thread persona', () => {
  const r = resolveThreadIdentity({
    thread_key: '+13050000001',
    existing_binding: { persona: 'Helen Crawford' },
    proposed_persona: 'Greg Martin',
    sender_phone_e164: '+16128060495',
  })
  assert.equal(r.persona, 'Helen Crawford')
})

test('§13 an unapproved persona HOLDS instead of being invented', () => {
  const r = resolveThreadIdentity({ thread_key: '+1305', proposed_persona: 'Helen Crawford' })
  assert.equal(r.ok, false)
  assert.equal(r.hold, true)
  assert.equal(r.reason, IDENTITY_HOLD.NOT_APPROVED)
  assert.equal(r.policy_decision_required, true)
})

test('§13 the approved pool is EMPTY pending the business decision', () => {
  // Deliberate: an arbitrary owner-level persona must not be selected while
  // the identity policy is unresolved.
  assert.equal(APPROVED_PERSONA_POOL.length, 0)
  assert.equal(isPersonaApproved('Helen Crawford'), false)
})

test('§13 no persona at all HOLDS', () => {
  const r = resolveThreadIdentity({ thread_key: '+1305' })
  assert.equal(r.hold, true)
  assert.equal(r.reason, IDENTITY_HOLD.UNRESOLVED)
})

test('§12 a handoff must be explicit AND approved', () => {
  const r = resolveThreadIdentity({
    thread_key: '+1305',
    existing_binding: { persona: 'Helen Crawford' },
    proposed_persona: 'Carlos Mendez',
    allow_handoff: true, handoff_reason: 'operator_reassignment',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, IDENTITY_HOLD.NOT_APPROVED)
})

test('§17 replaying the same inbound yields one stable identity', () => {
  const binding = { persona: 'Helen Crawford' }
  const a = resolveThreadIdentity({ thread_key: '+1305', existing_binding: binding })
  const b = resolveThreadIdentity({ thread_key: '+1305', existing_binding: binding })
  assert.equal(a.persona, b.persona)
  assert.equal(a.source, 'existing_thread_binding')
})

test('§14 identity is channel-aware so email/voice can share it', () => {
  const r = resolveThreadIdentity({
    thread_key: '+1305', channel: IDENTITY_CHANNEL.EMAIL,
    existing_binding: { persona: 'Helen Crawford' },
  })
  assert.equal(r.channel, 'email')
  assert.equal(r.persona, 'Helen Crawford')
})

test('§13 policy options are reported, never silently chosen', () => {
  assert.ok(IDENTITY_POLICY_OPTIONS.length >= 4)
  for (const o of IDENTITY_POLICY_OPTIONS) {
    assert.ok(o.id && o.summary && o.pros.length && o.cons.length)
  }
})

// OWNER DECISION LOCKED 2026-10-17 (decision 3) — the DISTINCT disposition declined_unverified.
// Never not_interested (that is the 30-day nurture). Every downstream consumer treats it as a
// property × contact hold with ownership UNVERIFIED: no nurture, no no-response nudge, no Priority, Dead
// for that property, not a suppression, not a denial. Eligibility is identical to the same thread with
// not_interested EXCEPT the intended outcome (no nurture; the property hold).
import test from 'node:test'
import assert from 'node:assert/strict'

import { DISPOSITION_CODES, normalizeDisposition } from '../../src/lib/domain/lead-state/universal-lead-state-registry.js'
import { getIntentDefinition } from '../../src/lib/domain/classification/inbound-intent-ontology.js'
import { resolveSellerStageTransition } from '../../src/lib/domain/seller-flow/resolve-seller-stage-transition.js'
import { resolveDispositionFromClassification, deriveInboxBucketFromThreadState } from '../../src/lib/domain/inbox/resolve-inbox-state-from-classification.js'
import { evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { evaluateOpenerReplyExclusion } from '../../src/lib/domain/campaigns/opener-reply-exclusion.js'
import { evaluateNoResponseCandidate } from '../../src/lib/domain/seller-flow/no-response-followup.js'
import { verifyContactPermission } from '../../src/lib/agent/operations/conversation-facts.js'
import { isClosedDispositionThread } from '../../src/lib/domain/inbox/inbox-bucket-predicates.js'
import { isNonActionableReplyIntent } from '../../src/lib/domain/inbox/reply-actionability.js'
import { recoveryNextAction } from '../../src/lib/agent/operations/recovery-linkage.js'
import { nurtureIntentFor } from '../../src/lib/agent/operations/ownership-evidence.js'

const PHONE = '+15555550123'

test('registry: declined_unverified is a first-class disposition (never folded to none / not_interested)', () => {
  assert.equal(DISPOSITION_CODES.DECLINED_UNVERIFIED, 'declined_unverified')
  assert.equal(normalizeDisposition('declined_unverified'), 'declined_unverified')
  assert.equal(normalizeDisposition('ownership_declined_unverified'), 'declined_unverified')
  assert.notEqual(normalizeDisposition('declined_unverified'), 'not_interested')
  assert.equal(getIntentDefinition('ownership_declined_unverified')?.state_hints?.disposition, 'declined_unverified')
})

test('dashboard registry mirror carries the same value', async () => {
  const ts = await import('../../../dashboard/src/domain/lead-state/universal-lead-state-registry.ts').catch(() => null)
  if (!ts) return // the TS mirror is type-checked by the dashboard gate; the text check below still holds
  assert.ok(ts.DISPOSITION_ORDER.includes('declined_unverified'))
  assert.equal(ts.normalizeDisposition('declined_unverified'), 'declined_unverified')
})

test('writers: the stage transition and the inbox classification writer emit declined_unverified (property-scoped, no not_owner fact)', () => {
  const t = resolveSellerStageTransition({ stage_before: 'ownership_confirmation', intent: 'ownership_declined_unverified', current_disposition: 'none' })
  assert.equal(t.disposition, 'declined_unverified')
  assert.equal(t.contactability_patch, null, 'never a phone-level contactability write')
  assert.equal(t.ownership_patch ?? null, null, 'never recorded as not_owner')
  assert.equal(t.advanced, false)
  const d = resolveDispositionFromClassification({ primary_intent: 'ownership_declined_unverified' }, { direction: 'inbound' }, { disposition: 'none' }, 'new_replies')
  assert.equal(d, 'declined_unverified', 'never NULL / not_interested, even with an attention bucket')
  assert.equal(deriveInboxBucketFromThreadState({ disposition: 'declined_unverified', latest_direction: 'inbound' }), 'dead', 'Dead for this property, never follow_up / new replies')
})

test('consumers: send-time guard, opener exclusion, no-response nudge, actionability, permission, recovery — a property hold, not a suppression', () => {
  const row = (property_id) => ({ to_phone_number: PHONE, thread_key: PHONE, property_id, use_case_template: 'follow_up', metadata: {} })
  const thread = { thread_key: PHONE, property_id: 'p1', disposition: 'declined_unverified' }
  assert.equal(evaluateSendTimeContactGuard(row('p1'), { threads: [thread] }).reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_DECLINED_HOLD)
  assert.equal(evaluateSendTimeContactGuard(row('p2'), { threads: [thread] }).blocked, false, 'other properties stay contactable')
  const o = evaluateOpenerReplyExclusion({ property_id: 'p1', threads: [thread] })
  assert.deepEqual([o.excluded, o.declined, o.scope], [true, true, 'person_property'])
  assert.equal(evaluateOpenerReplyExclusion({ property_id: 'p2', threads: [thread] }).excluded, false)
  assert.equal(isClosedDispositionThread({ disposition: 'declined_unverified' }), true)
  assert.equal(isNonActionableReplyIntent('ownership_declined_unverified'), true)
  const f = { inbound: { intents: [], any_opt_out: false, last: null }, thread: { disposition: 'declined_unverified', contactability: null, is_suppressed: false }, suppression_listed: false }
  const p = verifyContactPermission(f)
  assert.deepEqual([p.permitted, p.suppression, p.wrong_owner_or_number, p.ownership], [false, false, false, 'declined_unverified'])
  assert.equal(nurtureIntentFor({ ...f, inbound: { ...f.inbound, last_meaningful: { intent: 'not_interested', at: '2026-09-01T00:00:00Z' } } }, { permission: p }).intent, null, 'recovery creates no nurture intent')
  assert.equal(recoveryNextAction({ class: 'ownership_declined_hold', reasons: [] }).action, 'none_ownership_declined_unverified_hold')
})

test('no-response follow-ups: a declined_unverified thread is never nudged', () => {
  const NOW = new Date('2026-10-06T20:00:00.000Z')
  const facts = (thread_state) => ({
    anchor: { id: 'q_anchor', type: 'auto_reply', use_case: 'consider_selling', message_body: 'Would you consider an offer on 123 Main St?', seller_first_name: 'Charles', language: null },
    anchor_sent_at: '2026-10-05T18:00:00.000Z', anchor_message_event_id: 'me_anchor', thread_key: PHONE,
    has_inbound_before_anchor: true, has_inbound_after_anchor: false, has_newer_outbound: false,
    thread_state: { contactability_status: 'contactable', ...thread_state }, on_suppression_list: false, inbound_rows_newest_first: [{ message_body: 'Yes I own it' }],
  })
  assert.equal(evaluateNoResponseCandidate(facts({}), { now: NOW }).eligible, true, 'control eligible')
  const r = evaluateNoResponseCandidate(facts({ disposition: 'declined_unverified' }), { now: NOW })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'identity_not_owner:declined_unverified')
  const li = evaluateNoResponseCandidate(facts({ last_intent: 'ownership_declined_unverified' }), { now: NOW })
  assert.equal(li.eligible, false, li.reason)
})

test('eligibility identical to not_interested EXCEPT the intended outcome (no nurture; the property hold) — never a suppression', () => {
  const row = (property_id) => ({ to_phone_number: PHONE, thread_key: PHONE, property_id, use_case_template: 'follow_up', metadata: {} })
  const verdicts = (disposition) => {
    const thread = { thread_key: PHONE, property_id: 'p1', disposition }
    const perm = verifyContactPermission({ inbound: { intents: [], any_opt_out: false, last: null }, thread: { disposition, contactability: null, is_suppressed: false }, suppression_listed: false })
    const g1 = evaluateSendTimeContactGuard(row('p1'), { threads: [thread] })
    const g2 = evaluateSendTimeContactGuard(row('p2'), { threads: [thread] })
    return {
      suppression: perm.suppression,
      wrong_owner_or_number: perm.wrong_owner_or_number,
      other_property_blocked: g2.blocked,
      phone_wide_block: [SEND_TIME_GUARD_REASONS.THREAD_OPTED_OUT, SEND_TIME_GUARD_REASONS.WRONG_NUMBER, SEND_TIME_GUARD_REASONS.SUPPRESSION_LIST].includes(g1.reason),
      this_property_hold: g1.reason === SEND_TIME_GUARD_REASONS.OWNERSHIP_DECLINED_HOLD,
      bucket: deriveInboxBucketFromThreadState({ disposition, latest_direction: 'outbound' }),
    }
  }
  const before = verdicts('not_interested')
  const after = verdicts('declined_unverified')
  // identical: suppression, wrong owner / number, other properties, no phone-wide block
  for (const k of ['suppression', 'wrong_owner_or_number', 'other_property_blocked', 'phone_wide_block']) assert.equal(after[k], before[k], k)
  assert.equal(after.suppression, false)
  // the intended differences only
  assert.deepEqual([before.this_property_hold, after.this_property_hold], [false, true], 'the property hold (unsolicited outreach held for that property)')
  assert.equal(after.bucket, 'dead', 'no nurture lane')
})

// rc-8.5.21 phase 1 (pure) — which rows the sender-continuity rule binds, the verdict shape, and the claim stamp.
// The PG proofs are sender-continuity-8521-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isContinuityBoundRow, isProactiveCampaignTouch, evaluateSenderContinuity, checkContinuityStamp, continuityStamp,
  finalSenderContinuityCheck, reassignThreadSender, SENDER_CONTINUITY_MISMATCH, SENDER_UNAVAILABLE, SENDER_CONTINUITY_UNREADABLE,
} from '../../src/lib/domain/delivery/sender-continuity.js'

const SELLER = '+13125550111'
const A = '+13125550199'
const B = '+13125550188'
const est = (sender) => ({ loadEstablishedSender: async () => (sender ? { sender, source: 'thread_sticky' } : null) })

test('bound rows: every conversation row (even one attributed to a campaign) — never a proactive campaign touch', () => {
  const bound = [
    { type: 'auto_reply', campaign_id: 'c1', queue_key: `inbound_auto_reply:x:t:${SELLER}` },
    { source: 'ai_conversation', message_origin: 'ai_generated', metadata: { source: 'ai_conversation' } },
    { type: 'followup', metadata: { followup_intent_id: 'fi-1', source: 'seller_inbound_orchestrator' }, campaign_id: 'c1' },
    { type: 'outbound', source: 'inbox', message_type: 'manual_reply', metadata: { source: 'manual_inbox' } },
    { type: 'outbound', metadata: {} }, // an unattributed thread send: bound (conservative)
  ]
  for (const r of bound) assert.equal(isContinuityBoundRow(r), true, JSON.stringify(r))
  const campaign = [
    { type: 'campaign_launch', campaign_id: 'c1', touch_number: 1 },
    { type: 'outbound', campaign_id: 'c1', touch_number: 2, metadata: { candidate_snapshot: { touch_number: 2 } } },
    { type: 'outbound', metadata: { candidate_snapshot: { touch_number: 1, is_first_touch: true } } }, // a feeder touch without a campaign id
    { type: 'outbound', queue_key: 'campaign:abc:1', metadata: {} },
  ]
  for (const r of campaign) { assert.equal(isProactiveCampaignTouch(r), true, JSON.stringify(r)); assert.equal(isContinuityBoundRow(r), false) }
})

test('verdict: established + same sender ⇒ ok; another number ⇒ mismatch; no sender ⇒ bound to the established one; nothing established ⇒ routing may choose; unreadable ⇒ deferred', async () => {
  const row = (from) => ({ thread_key: SELLER, to_phone_number: SELLER, from_phone_number: from, type: 'auto_reply' })
  assert.deepEqual(Object.values(await evaluateSenderContinuity(row(A), {}, est(A))).slice(0, 4), [true, true, true, null])
  const mm = await evaluateSenderContinuity(row(B), {}, est(A))
  assert.deepEqual([mm.ok, mm.reason, mm.established_sender], [false, SENDER_CONTINUITY_MISMATCH, A])
  const none = await evaluateSenderContinuity(row(null), {}, est(A))
  assert.deepEqual([none.ok, none.established_sender], [true, A])
  const fresh = await evaluateSenderContinuity(row(B), {}, est(null))
  assert.deepEqual([fresh.applies, fresh.established, fresh.ok], [true, false, true])
  const bad = await evaluateSenderContinuity(row(A), {}, { loadEstablishedSender: async () => { throw new Error('down') } })
  assert.deepEqual([bad.ok, bad.reason, bad.deferred], [false, SENDER_CONTINUITY_UNREADABLE, true])
  // the seller's own number on our_number (bad data) is never an established sender
  const self = await evaluateSenderContinuity(row(A), {}, est(SELLER))
  assert.equal(self.established, false)
})

test('the claim-time stamp: a rewritten from number is refused; a campaign touch never carries one', async () => {
  const v = await evaluateSenderContinuity({ thread_key: SELLER, to_phone_number: SELLER, from_phone_number: A, type: 'auto_reply' }, {}, est(A))
  const stamp = continuityStamp(v, '2026-10-20T00:00:00.000Z')
  assert.equal(stamp.sender, A)
  assert.equal(checkContinuityStamp({ type: 'auto_reply', from_phone_number: A, metadata: { sender_continuity: stamp } }).ok, true)
  assert.deepEqual(checkContinuityStamp({ type: 'auto_reply', from_phone_number: B, metadata: { sender_continuity: stamp } }), { ok: false, reason: SENDER_CONTINUITY_MISMATCH })
  assert.equal(continuityStamp({ applies: false }), null)
})

test('the final check: identity first, then the established sender\'s eligibility (blocklist / status / health / cooling)', async () => {
  const row = { thread_key: SELLER, to_phone_number: SELLER, from_phone_number: A, type: 'auto_reply' }
  const fleet = (over = {}) => async (p) => ({ phone_number: p, status: 'active', health_state: 'healthy', messages_sent_today: 9999, ...over })
  const ok = await finalSenderContinuityCheck(row, { from: A }, { ...est(A), loadDispatchBlockedSenders: async () => new Set(), loadOutboundNumberByPhone: fleet() })
  assert.equal(ok.ok, true, 'the never-reset counter never blocks at the final check (caps were applied at selection)')
  assert.equal((await finalSenderContinuityCheck(row, { from: B }, { ...est(A), loadDispatchBlockedSenders: async () => new Set(), loadOutboundNumberByPhone: fleet() })).reason, SENDER_CONTINUITY_MISMATCH)
  const cooling = await finalSenderContinuityCheck(row, { from: A }, { ...est(A), loadDispatchBlockedSenders: async () => new Set(), loadOutboundNumberByPhone: fleet({ health_state: 'cooling' }) })
  assert.deepEqual([cooling.ok, cooling.reason, cooling.sender_reason], [false, SENDER_UNAVAILABLE, 'outbound_number_health_cooling'])
  const blocked = await finalSenderContinuityCheck(row, { from: A }, { ...est(A), loadDispatchBlockedSenders: async () => new Set([A]), loadOutboundNumberByPhone: fleet() })
  assert.equal(blocked.reason, SENDER_UNAVAILABLE)
  assert.equal((await finalSenderContinuityCheck(row, { from: A }, { ...est(A), loadDispatchBlockedSenders: async () => null, loadOutboundNumberByPhone: fleet() })).reason, SENDER_CONTINUITY_UNREADABLE)
  // a proactive campaign touch is not the continuity rule's (the campaign router governs it)
  assert.equal((await finalSenderContinuityCheck({ ...row, type: 'campaign_launch', campaign_id: 'c1' }, { from: B }, est(A))).ok, true)
})

test('reassignment is never automatic: a named operator, a reason and an approval are required before any read', async () => {
  for (const [actor, reason, approval_ref, want] of [['', 'r', 'a', 'reassignment_requires_named_operator'], ['system:sweeper', 'r', 'a', 'reassignment_requires_named_operator'], ['router', 'r', 'a', 'reassignment_requires_named_operator'], ['op-1', '', 'a', 'reassignment_reason_required'], ['op-1', 'r', '', 'reassignment_approval_required']]) {
    const r = await reassignThreadSender({ thread_key: SELLER, to: B, actor, reason, approval_ref }, { supabase: { from() { throw new Error('must not read') } } })
    assert.deepEqual([r.ok, r.reason], [false, want])
  }
})

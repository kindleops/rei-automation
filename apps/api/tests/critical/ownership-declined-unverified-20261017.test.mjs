// OWNER DECISION LOCKED 2026-10-17 (supersedes 831df6cd) — regression tests.
// A polite "No thanks" (and polite equivalents) to OUR ownership question:
//   * is NOT the 30-day selling nurture;
//   * is a NEW state, ownership_declined_unverified (declined engagement, ownership UNVERIFIED);
//   * gets a PROPERTY × CONTACT no-recontact hold;
//   * is NEVER recorded as verified non-ownership (no not_owner / former_owner, no rejected_at, no
//     "denied" flag).
// Unchanged: a bare "No" to the ownership question = property-specific denial; "No" to SELLING = the
// 30-day follow-up; explicit STOP = contact-wide suppression.
// Paths: classifier (shared matcher + context rule + ledger), decision, follow-up interface, contact
// resolution, recontact guard, send-time guard, campaign opener exclusion, permission checker, AI writer.
import test from 'node:test'
import assert from 'node:assert/strict'

import { bareNoAnswer, isOwnershipDecline } from '../../src/lib/domain/conversation-ai/answers.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { resolveOwnershipEvidence as resolveAiOwnershipEvidence } from '../../src/lib/domain/conversation-ai/ownership-evidence.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { classify } from '../../src/lib/domain/classification/classify.js'
import { resolveFollowUpPlan } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'
import { resolveDeclineFollowupPolicy } from '../../src/lib/domain/seller-flow/decline-followup-policy.js'
import { deriveS1Outcome } from '../../src/lib/domain/seller-flow/resolve-contact-outcome-phase.js'
import { runContactResolutionPhase } from '../../src/lib/domain/seller-flow/resolve-contact-outcome-phase.js'
import { OUTCOME_TO_ROLE } from '../../src/lib/domain/seller-flow/contact-resolution-repository.js'
import { evaluateOwnershipRecontact, evaluateContactPropertyResolution, ownershipEvidenceItems, OWNERSHIP_DECLINED_REASON, OWNERSHIP_DECLINED_ROLE } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS, SEND_TIME_REPLY_INTENTS } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { SEND_TIME_BLOCK_REASONS } from '../../src/lib/domain/compliance/canonical-no-contact-states.js'
import { evaluateOpenerReplyExclusion, NOT_OWNER_REPLY_INTENTS } from '../../src/lib/domain/campaigns/opener-reply-exclusion.js'
import { verifyContactPermission, NON_REOPENING_INTENTS } from '../../src/lib/agent/operations/conversation-facts.js'
import { replayReply } from '../helpers/reply-replay-harness.mjs'

const PHONE = '+15555550123'
const T0 = Date.parse('2026-09-01T15:00:00.000Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const ownQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', created_at: at(min), property_id })
const interestQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Would you consider an offer on 1 Main St if the number made sense?', created_at: at(min), property_id })
const inb = (id, body, min, extra = {}) => ({ id, direction: 'inbound', message_body: body, created_at: at(min), ...extra })
const row = (property_id = 'p1', extra = {}) => ({ to_phone_number: PHONE, thread_key: PHONE, property_id, use_case_template: 'follow_up', metadata: {}, ...extra })
const declinedRow = (property_id = 'p1', extra = {}) => ({ property_id, contact_phone_e164: PHONE, contact_property_role: OWNERSHIP_DECLINED_ROLE, suppression_scope: 'contact_property_pair', rejected_at: null, updated_at: at(6), ...extra })
const S1 = { message_type: 'sms', template_id: 'tpl-own', template_use_case: 'ownership_check', text: 'Hi Pat, this is Jake. Are you still the owner of 1 Main St?', sent_at: '2026-09-01T15:00:00Z', delivered_at: '2026-09-01T15:00:05Z' }
const S2 = { ...S1, template_id: 'tpl-s2', template_use_case: 'consider_selling', text: 'Would you consider an offer on 1 Main St if the number made sense?' }
const replay = (message, prior) => replayReply({ fixture_id: 'od17', seller_message: message, received_at: '2026-09-01T15:10:00Z', prior_question: prior }, { catalog: [] })
const POLITE = ['No thanks', 'No thank you', 'No gracias', 'No gracias Carlos!', 'Nope thanks']

// ── classifier ──────────────────────────────────────────────────────────────
test('the shared matcher: polite ⇒ ownership_declined (never ownership_denial); bare ⇒ ownership_denial', () => {
  for (const t of POLITE) {
    const r = bareNoAnswer(t, { names: ['Carlos'] })
    assert.deepEqual([r.matched, r.ownership_declined, r.ownership_denial], [true, true, false], t)
    assert.equal(isOwnershipDecline(t, { names: ['Carlos'] }), true, t)
  }
  for (const t of ['No', 'Nope', 'No!!!', 'No 👎']) assert.deepEqual([bareNoAnswer(t).ownership_denial, bareNoAnswer(t).ownership_declined], [true, false], t)
})

test('classifier: a polite No to the OWNERSHIP question is ownership_declined_unverified — no nurture, no suppression, no review, never property_specific_non_owner', async () => {
  for (const t of ['No thanks', 'No thank you', 'No gracias']) {
    const r = await replay(t, S1)
    assert.equal(r.classification.primary_intent, 'ownership_declined_unverified', t)
    assert.ok(r.classification.matched_rule_ids.includes('ctx_polite_no_after_ownership_check_declined_unverified'), t)
    assert.equal(r.decision.should_suppress_contact, false)
    assert.equal(r.decision.should_queue_reply, false)
    assert.equal(r.decision.should_mark_human_review, false)
    assert.equal(r.decision.follow_up_at ?? null, null, 'no 30-day selling nurture')
    assert.equal(r.decision.next_action, 'end_outreach_in_scope', 'never a follow-up next_action (the deferred scheduler is not called)')
    assert.equal(r.classification.automation_decision.suppression_action, 'none')
  }
})

test('unchanged: a bare "No" to the ownership question is the property denial; "No thanks" to SELLING is the 30-day nurture; STOP is contact-wide', async () => {
  const bare = await replay('No', S1)
  assert.equal(bare.classification.primary_intent, 'property_specific_non_owner')
  const selling = await replay('No thanks', S2)
  assert.equal(selling.classification.primary_intent, 'not_interested')
  assert.ok(selling.decision.follow_up_at || selling.decision.next_action === 'do_not_reply', 'the existing 30-day nurture route')
  const stop = await classify('STOP', null, { heuristicOnly: true })
  assert.equal(stop.primary_intent, 'opt_out')
})

test('follow-up engine interface: the state creates NO nurture intent', () => {
  const plan = resolveFollowUpPlan('ownership_declined_unverified', { thread_key: PHONE })
  assert.equal(plan.followup_created, false, JSON.stringify(plan))
  const pol = resolveDeclineFollowupPolicy({ primary_intent: 'ownership_declined_unverified' })
  assert.deepEqual([pol.kind, pol.audit_reason], ['ownership_declined_unverified', 's1_ownership_declined_unverified_no_followup'])
})

// ── contact resolution: a hold, never a rejection / non-ownership fact ──────
test('contact resolution records role ownership_declined_unverified with rejected_at NULL, pair scope, and never runs the waterfall', async () => {
  assert.equal(deriveS1Outcome({ canonical_intent: 'ownership_declined_unverified' }), 'ownership_declined_unverified')
  assert.equal(OUTCOME_TO_ROLE.ownership_declined_unverified, 'ownership_declined_unverified')
  const writes = []
  const sb = {
    from: (table) => {
      const b = {
        upsert: (r) => { writes.push({ table, r }); return b },
        select: () => b,
        eq: () => b, range: () => b,
        maybeSingle: async () => ({ data: { id: 'cpr-1', contact_property_role: writes.at(-1)?.r?.contact_property_role, rejected_at: writes.at(-1)?.r?.rejected_at }, error: null }),
        then: (res) => res({ data: [], error: null }),
      }
      return b
    },
  }
  const r = await runContactResolutionPhase({ supabaseClient: sb, property_id: 'p1', inbound_from: PHONE, canonical_intent: 'ownership_declined_unverified', source_message_id: 'i1', source_thread_key: PHONE })
  assert.equal(r.ran, true)
  assert.equal(r.waterfall_invoked, false)
  assert.equal(r.hold, 'ownership_declined_unverified')
  assert.equal(writes.length, 1, 'one pair row, no waterfall reads / selections')
  const w = writes[0].r
  assert.deepEqual([w.contact_property_role, w.rejected_at, w.rejection_reason, w.suppression_scope], ['ownership_declined_unverified', null, null, 'contact_property_pair'])
  assert.ok(!['not_owner', 'former_owner'].includes(w.contact_property_role), 'never recorded as verified non-ownership')
})

// ── recontact guard / send-time guard / opener exclusion ───────────────────
test('recontact guard: thread text "No thanks" to the ownership question holds THAT property for this contact (not a denial); other properties go out', () => {
  const messages = [ownQ('o1', 0, 'p1'), inb('i1', 'No thanks', 5)]
  assert.deepEqual(ownershipEvidenceItems({ messages }).map((i) => [i.state, i.basis]), [['declined', 'polite_no_to_ownership_question']])
  const r = evaluateOwnershipRecontact(row('p1'), messages)
  assert.deepEqual([r.blocked, r.reason, r.detail.scope, r.detail.ownership], [true, OWNERSHIP_DECLINED_REASON, 'person_property', 'unverified'])
  assert.notEqual(r.reason, 'property_ownership_denied_no_recontact')
  assert.equal(evaluateOwnershipRecontact(row('p2'), [ownQ('o1', 0, 'p1'), inb('i1', 'No thanks', 5)]).blocked, false)
  // newer explicit confirmation / engagement clears it (recency AND confidence)
  assert.equal(evaluateOwnershipRecontact(row('p1'), [...messages, ownQ('o2', 30, 'p1'), inb('i2', 'Yes I still own it', 35)]).blocked, false)
  // a property-less polite decline holds the THREAD (rule 2), never every property as declined
  const loose = evaluateOwnershipRecontact(row('p7'), [{ ...ownQ('o1', 0), property_id: null }, inb('i1', 'No thanks', 5)])
  assert.deepEqual([loose.blocked, loose.hold, loose.detail.scope], [true, true, 'thread_hold'])
})

test('store: a declined row holds its property for this phone — never phone-wide, never a denial', () => {
  const s = evaluateContactPropertyResolution({ property_id: 'p1', resolutions: [declinedRow('p1')] })
  assert.deepEqual([s.excluded, s.declined, s.reason, s.scope], [true, true, OWNERSHIP_DECLINED_REASON, 'person_property'])
  assert.equal(evaluateContactPropertyResolution({ property_id: 'p2', resolutions: [declinedRow('p1')] }).excluded, false)
  const g = evaluateSendTimeContactGuard(row('p1'), { contact_property_resolution: [declinedRow('p1')] })
  assert.equal(g.reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_DECLINED_HOLD)
  assert.equal(g.reason_code, SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED, 'a hold (deferred), never terminal')
  assert.equal(evaluateSendTimeContactGuard(row('p2'), { contact_property_resolution: [declinedRow('p1')] }).blocked, false)
  // a later engagement on the property supersedes the stored hold (rank: store = engagement)
  const later = evaluateOwnershipRecontact(row('p1'), [interestQ('o1', 20, 'p1'), inb('i1', 'make me an offer', 25)], { resolutions: [declinedRow('p1')] })
  assert.equal(later.blocked, false)
})

test('labels: send-time guard + campaign opener treat the state as a property-scoped hold (fetched, blocking, own reason)', () => {
  assert.ok(SEND_TIME_REPLY_INTENTS.includes('ownership_declined_unverified'))
  assert.ok(NOT_OWNER_REPLY_INTENTS.includes('ownership_declined_unverified'))
  const threads = [{ thread_key: PHONE, property_id: 'p1', last_intent: 'ownership_declined_unverified' }]
  const g = evaluateSendTimeContactGuard(row('p1'), { threads })
  assert.equal(g.reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_DECLINED_HOLD)
  assert.equal(evaluateSendTimeContactGuard(row('p2'), { threads }).blocked, false)
  const o = evaluateOpenerReplyExclusion({ property_id: 'p1', threads })
  assert.deepEqual([o.excluded, o.declined, o.reason, o.scope], [true, true, OWNERSHIP_DECLINED_REASON, 'person_property'])
  assert.equal(evaluateOpenerReplyExclusion({ property_id: 'p2', threads }).excluded, false)
  const st = evaluateOpenerReplyExclusion({ property_id: 'p1', resolutions: [declinedRow('p1')] })
  assert.deepEqual([st.excluded, st.declined, st.reason], [true, true, OWNERSHIP_DECLINED_REASON])
})

// ── permission checker ──────────────────────────────────────────────────────
test('permission checker: the state is NOT ownership-confirmed and NOT a denial fact; it blocks (hold) and never reopens a deal', () => {
  const f = (intents, extra = {}) => ({ inbound: { intents, any_opt_out: false, last: null }, thread: { disposition: null, contactability: null, is_suppressed: false }, suppression_listed: false, ...extra })
  const p = verifyContactPermission(f(['ownership_declined_unverified']))
  assert.equal(p.ownership, 'declined_unverified')
  assert.equal(p.permitted, false)
  assert.ok(p.blocks.includes('ownership_declined_unverified'))
  assert.ok(!p.blocks.includes('ownership_denied'), 'never a denial fact')
  assert.equal(p.wrong_owner_or_number, false)
  assert.notEqual(p.ownership, 'confirmed')
  assert.equal(verifyContactPermission(f(['ownership_declined_unverified', 'ownership_confirmed'])).ownership, 'declined_unverified', 'not counted as confirmed')
  assert.ok(NON_REOPENING_INTENTS.includes('ownership_declined_unverified'))
})

// ── AI writer: never a nurture, never a selling question ────────────────────
test('AI writer: the ledger records declined_unverified (never denied); decideActions composes NOTHING (no nurture, no selling question)', () => {
  const thread = [{ id: 'o1', direction: 'outbound', body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', at: at(0), property_id: 'p1' }, { id: 'i1', direction: 'inbound', body: 'No thanks', at: at(5), property_id: 'p1' }]
  const ledger = buildCanonicalLedger({ messages: thread, now: at(6) })
  assert.equal(ledger.facts?.ownership?.value, 'declined_unverified', JSON.stringify(ledger.facts?.ownership))
  // a bare "No" is still the denial, a "No thanks" to the INTEREST question still the selling decline
  assert.equal(buildCanonicalLedger({ messages: [thread[0], { ...thread[1], body: 'No' }], now: at(6) }).facts.ownership.value, 'denied')
  const s2 = buildCanonicalLedger({ messages: [{ ...thread[0], body: 'Would you consider an offer on 1 Main St if the number made sense?' }, thread[1]], now: at(6) })
  assert.equal(s2.facts.seller_interest?.value, 'not_interested')
  assert.equal(s2.facts.ownership?.value ?? null, null)
  const fakeLedger = { facts: { ownership: { value: 'declined_unverified', source_message_ids: ['i1'], history: [{ value: 'declined_unverified', source_message_id: 'i1', basis: 'stated' }] } } }
  const own = resolveAiOwnershipEvidence({ ledger: fakeLedger, inboundId: 'i1', inboundText: 'No thanks' })
  assert.deepEqual([own.class, own.action], ['ownership_declined_unverified', 'ownership_declined_no_reply'])
  for (const [ledgerArg, deterministic, eligibility] of [
    [fakeLedger, null, null],
    [{ facts: {} }, { intent: 'ownership_declined_unverified' }, null],
    [{ facts: {} }, null, { blocked: true, reasons: ['ownership_declined_unverified_hold'], guard: { reason: 'ownership_declined_unverified_hold' } }],
  ]) {
    const plan = decideActions({ ledger: ledgerArg, inboundText: 'No thanks', inboundId: 'i1', deterministic, eligibility })
    const types = plan.actions.map((a) => a.type)
    assert.deepEqual(types, [ACTIONS.NO_RESPONSE], JSON.stringify(plan))
    assert.ok(!types.includes(ACTIONS.SCHEDULE_FOLLOWUP) && !types.includes(ACTIONS.AI_GENERATED_REPLY), 'no nurture, no composed reply')
  }
})

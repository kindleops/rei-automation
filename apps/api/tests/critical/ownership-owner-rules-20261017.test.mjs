// OWNER RULES 2026-10-17 (binding for rc-8.5.21) — regression tests.
//   1. a property-specific ownership denial NEVER automatically becomes a phone-level suppression;
//   2. an ambiguous denial (no reliably identified property) HOLDS the thread for operator resolution —
//      it never labels every associated property as denied (reverses 8.5.21-a's "conservative" rule);
//   3. evidence is ordered by recency AND confidence — a later explicit confirmation / seller engagement
//      supersedes an earlier low-confidence denial label, and vice versa; a newer but LESS confident
//      contradiction is a conflict (hold), never a silent win;
//   4. STOP / opt-out / wrong number / compliance stay absolute and contact-wide, and the only
//      channel_compliance / suppressed writer is the explicit opt-out outcome.
// Fictional 555-01xx numbers only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateOwnershipRecontact, evaluateContactPropertyResolution, ownershipEvidenceItems, resolveOwnershipEvidence, OWNERSHIP_UNRESOLVED_REASON, EVIDENCE_RANK } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { SEND_TIME_BLOCK_REASONS } from '../../src/lib/domain/compliance/canonical-no-contact-states.js'
import { evaluateOpenerReplyExclusion } from '../../src/lib/domain/campaigns/opener-reply-exclusion.js'
import { deriveS1Outcome, RELATIONSHIP_TO_S1_OUTCOME } from '../../src/lib/domain/seller-flow/resolve-contact-outcome-phase.js'
import { OUTCOME_TO_ROLE } from '../../src/lib/domain/seller-flow/contact-resolution-repository.js'
import { resolveFollowUpPlan } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'
import { classify } from '../../src/lib/domain/classification/classify.js'
import { replayReply } from '../helpers/reply-replay-harness.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const PHONE = '+15555550123'
const T0 = Date.parse('2026-09-01T15:00:00.000Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const ownQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', created_at: at(min), property_id })
const interestQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Would you consider an offer on 1 Main St if the number made sense?', created_at: at(min), property_id })
const inb = (id, body, min, extra = {}) => ({ id, direction: 'inbound', message_body: body, created_at: at(min), ...extra })
const row = (property_id = 'p1', extra = {}) => ({ to_phone_number: PHONE, thread_key: PHONE, property_id, use_case_template: 'follow_up', metadata: {}, ...extra })
const pair = (property_id, role = 'not_owner', extra = {}) => ({ property_id, contact_phone_e164: PHONE, contact_property_role: role, suppression_scope: 'contact_property_pair', rejected_at: at(1), ...extra })
const OWN_Q_FIXTURE = { message_type: 'sms', template_id: 'tpl-own', template_use_case: 'ownership_check', text: 'Hi Pat, are you still the owner of 1 Main St?', sent_at: '2026-09-01T15:00:00Z', delivered_at: '2026-09-01T15:00:05Z' }

// ── 1. a property denial never becomes a phone suppression ──────────────────
test('rule 1: "Never have" as the SECOND reply of a burst is the property-scoped denial, never wrong_number + archive (owner-wide phone flag)', async () => {
  for (const message of ['Never have', 'No never have']) {
    const r = await replayReply({ fixture_id: 'r1', seller_message: message, received_at: '2026-09-01T15:10:30Z', prior_question: OWN_Q_FIXTURE, intervening_inbound: [{ created_at: '2026-09-01T15:10:00Z', text: 'No', intent: 'property_specific_non_owner' }] }, { catalog: [] })
    assert.equal(r.classification.primary_intent, 'property_specific_non_owner', message)
    assert.notEqual(r.classification.automation_decision?.suppression_action, 'archive_wrong_number', message)
    assert.equal(r.decision.should_suppress_contact, false, message)
    assert.notEqual(r.decision.next_action, 'archive_wrong_number', message)
  }
})

test('rule 1: written ownership disconnects and former-owner statements are property-scoped; phone-identity statements stay wrong_number', async () => {
  for (const message of ['not mine', 'I am not the owner', "I don't own that", 'never owned it']) {
    const c = await classify(message, null, { heuristicOnly: true })
    assert.equal(c.primary_intent, 'property_specific_non_owner', message)
    assert.notEqual(c.automation_decision?.suppression_action, 'archive_wrong_number', message)
  }
  for (const message of ['I used to own it', 'that was mine a long time ago']) {
    const c = await classify(message, null, { heuristicOnly: true })
    assert.notEqual(c.primary_intent, 'wrong_number', message)
    assert.notEqual(c.automation_decision?.suppression_action, 'archive_wrong_number', message)
  }
  // rule 4: a PHONE-IDENTITY statement is contact-wide, absolute
  for (const message of ['wrong number', 'Wrong person', 'this is no longer my number', 'you have the wrong number']) {
    const c = await classify(message, null, { heuristicOnly: true })
    assert.equal(c.primary_intent, 'wrong_number', message)
    assert.equal(c.automation_decision?.suppression_action, 'archive_wrong_number', message)
  }
})

test('rule 1: no recontact-guard verdict from a property denial is phone-scoped', () => {
  const cases = [
    [[ownQ('o1', 0), inb('i1', 'No', 5)], []],
    [[ownQ('o1', 0), inb('i1', 'I never owned it', 5)], []],
    [[inb('i1', 'x', 5, { detected_intent: 'property_specific_non_owner', property_id: 'p1' })], []],
    [[], [pair('p1')]],
    [[], [pair(null)]],
  ]
  for (const [messages, resolutions] of cases) {
    for (const p of ['p1', 'p2', null]) {
      const r = evaluateOwnershipRecontact(row(p), messages, { resolutions })
      assert.notEqual(r.detail?.scope, 'phone', JSON.stringify({ messages: messages.map((m) => m.message_body), p }))
      const g = evaluateSendTimeContactGuard(row(p), { thread_messages: messages, contact_property_resolution: resolutions })
      assert.ok(![SEND_TIME_GUARD_REASONS.WRONG_NUMBER, SEND_TIME_GUARD_REASONS.THREAD_OPTED_OUT, SEND_TIME_GUARD_REASONS.SUPPRESSION_LIST].includes(g.reason), `${p}: ${g.reason}`)
    }
  }
})

// ── 2. an ambiguous denial holds the thread, never denies every property ────
test('rule 2: a denial with no identified property HOLDS (deferred, operator review) — never a property denial for every property', () => {
  // the ownership question carries no property, the inbound neither
  const messages = [{ ...ownQ('o1', 0), property_id: null }, inb('i1', 'No', 5)]
  for (const p of ['p1', 'p2']) {
    const r = evaluateOwnershipRecontact(row(p), messages)
    assert.deepEqual([r.blocked, r.hold, r.reason, r.detail.scope, r.detail.property_scoped], [true, true, OWNERSHIP_UNRESOLVED_REASON, 'thread_hold', false], p)
    const g = evaluateSendTimeContactGuard(row(p), { thread_messages: messages })
    assert.equal(g.reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_UNRESOLVED_HOLD, p)
    assert.equal(g.reason_code, SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED, 'deferred like an automation hold, never terminal')
    assert.notEqual(g.reason_code, SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL)
  }
  // a store row without a property, and an outbound without a property, hold too
  const s = evaluateContactPropertyResolution({ property_id: 'p1', resolutions: [pair(null)] })
  assert.deepEqual([s.excluded, s.hold, s.scope, s.reason], [true, true, 'thread_hold', OWNERSHIP_UNRESOLVED_REASON])
  const noRowProp = evaluateContactPropertyResolution({ property_id: null, resolutions: [pair('p1')] })
  assert.deepEqual([noRowProp.hold, noRowProp.scope], [true, 'thread_hold'])
  // an IDENTIFIED denial stays property-scoped: p1 denied, p2 untouched
  const known = [ownQ('o1', 0, 'p1'), inb('i1', 'No', 5)]
  assert.equal(evaluateOwnershipRecontact(row('p1'), known).reason, 'property_ownership_denied_no_recontact')
  assert.equal(evaluateOwnershipRecontact(row('p2'), known).blocked, false)
})

test('rule 2: a property-scoped not-owner LABEL without a property holds (send-time guard + campaign opener), it is not a denial of every property', () => {
  const threads = [{ thread_key: PHONE, property_id: null, disposition: 'property_specific_non_owner' }]
  const g = evaluateSendTimeContactGuard(row('p7'), { threads })
  assert.equal(g.reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_UNRESOLVED_HOLD)
  assert.equal(g.detail.scope, 'thread_hold')
  const o = evaluateOpenerReplyExclusion({ property_id: 'p7', threads })
  assert.deepEqual([o.excluded, o.hold, o.reason, o.scope], [true, true, OWNERSHIP_UNRESOLVED_REASON, 'thread_hold'])
  // labelled for ANOTHER known property: this property goes out
  assert.equal(evaluateOpenerReplyExclusion({ property_id: 'p7', threads: [{ ...threads[0], property_id: 'p1' }] }).excluded, false)
  assert.equal(evaluateSendTimeContactGuard(row('p7'), { threads: [{ ...threads[0], property_id: 'p1' }] }).blocked, false)
  // the campaign planner records the hold under its own skip reason
  const src = fs.readFileSync(path.join(SRC, 'lib/domain/campaigns/campaign-automation-service.js'), 'utf8')
  assert.match(src, /recordSkip\(notOwner\.hold \? 'ownership_property_unresolved_hold' : 'prior_reply_not_owner'/)
})

// ── 3. recency AND confidence, both directions ──────────────────────────────
test('rule 3: a later explicit confirmation or seller engagement supersedes an earlier low-confidence denial LABEL', () => {
  const label = inb('i0', 'ok', 2, { detected_intent: 'property_specific_non_owner', property_id: 'p1' })
  const confirmed = [label, ownQ('o1', 10), inb('i1', 'Yes I still own it', 15)]
  assert.equal(evaluateOwnershipRecontact(row('p1'), confirmed).blocked, false)
  const engaged = [label, interestQ('o1', 10), inb('i1', 'I would take 250k for it', 15)]
  assert.equal(evaluateOwnershipRecontact(row('p1'), engaged).blocked, false, 'engagement on the property supersedes the label')
  // a store (classifier-derived) denial is superseded by later engagement too
  const storeThenEngaged = evaluateOwnershipRecontact(row('p1'), [interestQ('o1', 10), inb('i1', 'make me an offer', 15)], { resolutions: [pair('p1', 'not_owner', { rejected_at: at(3) })] })
  assert.equal(storeThenEngaged.blocked, false)
  // but engagement never overturns an EXPLICIT denial: the weaker, newer contradiction is a conflict
  // HOLD for an operator (still not sent, not cleared, not a silent win either way)
  const explicitThenEngaged = [ownQ('o0', 0), inb('i0', 'I never owned it', 2), interestQ('o1', 10), inb('i1', 'what is your offer', 15)]
  const e = evaluateOwnershipRecontact(row('p1'), explicitThenEngaged)
  assert.deepEqual([e.blocked, e.hold, e.detail.conflict], [true, true, true])
})

test('rule 3 (vice versa): a later explicit denial supersedes an earlier low-confidence confirmation LABEL', () => {
  const messages = [inb('i0', 'ok', 2, { detected_intent: 'ownership_confirmed', property_id: 'p1' }), ownQ('o1', 10), inb('i1', 'I never owned that house', 15)]
  const r = evaluateOwnershipRecontact(row('p1'), messages)
  assert.deepEqual([r.blocked, r.reason, r.detail.scope], [true, 'property_ownership_denied_no_recontact', 'person_property'])
})

test('rule 3: a stale low-confidence label never defeats newer explicit evidence; a NEWER weaker contradiction is a conflict hold', () => {
  // older label, newer explicit confirmation → confirmed
  assert.equal(resolveOwnershipEvidence([{ state: 'denied', at: 1, rank: EVIDENCE_RANK.label }, { state: 'confirmed', at: 2, rank: EVIDENCE_RANK.explicit }]).state, 'confirmed')
  // explicit confirmation, then a newer low label → neither wins: conflict
  const messages = [ownQ('o1', 0), inb('i1', 'Yes I own it', 5), inb('i2', 'k', 20, { detected_intent: 'property_specific_non_owner', property_id: 'p1' })]
  const r = evaluateOwnershipRecontact(row('p1'), messages)
  assert.deepEqual([r.blocked, r.hold, r.detail.conflict, r.reason], [true, true, true, OWNERSHIP_UNRESOLVED_REASON])
  // the send-time guard: a not-owner label vs a thread-text confirmation is a conflict hold, not terminal
  const g = evaluateSendTimeContactGuard(row('p1'), { threads: [{ thread_key: PHONE, property_id: 'p1', last_intent: 'property_specific_non_owner' }], thread_messages: [ownQ('o1', 0), inb('i1', 'Yes I own it', 5)] })
  assert.equal(g.reason, SEND_TIME_GUARD_REASONS.OWNERSHIP_UNRESOLVED_HOLD)
  assert.equal(g.detail.conflict, true)
  // a newer answer to a NEW ownership question is equally confident: it wins
  const reasked = [ownQ('o1', 0), inb('i1', 'Yes', 5), ownQ('o2', 30), inb('i2', 'No', 35)]
  assert.equal(evaluateOwnershipRecontact(row('p1'), reasked).reason, 'property_ownership_denied_no_recontact')
  const items = ownershipEvidenceItems({ messages: reasked })
  assert.deepEqual(items.map((i) => [i.state, i.kind]), [['confirmed', 'answer'], ['denied', 'answer']])
})

// ── 4. contact-wide restrictions stay absolute; their only writer is the opt-out ─
test('rule 4: channel_compliance / STOP / wrong number stay absolute and contact-wide, whatever the ownership evidence', () => {
  const confirmed = [ownQ('o1', 0), inb('i1', 'Yes I own it', 5)]
  const cc = evaluateSendTimeContactGuard(row('p9'), { thread_messages: confirmed, contact_property_resolution: [pair('p1', 'suppressed', { suppression_scope: 'channel_compliance' })] })
  assert.equal(cc.reason, SEND_TIME_GUARD_REASONS.THREAD_OPTED_OUT)
  assert.equal(evaluateSendTimeContactGuard(row('p9'), { thread_messages: confirmed, threads: [{ thread_key: PHONE, property_id: 'p1', last_intent: 'wrong_number' }] }).reason, SEND_TIME_GUARD_REASONS.WRONG_NUMBER)
  assert.equal(evaluateSendTimeContactGuard(row('p9'), { thread_messages: confirmed, inbound_replies: [{ from_phone_number: PHONE, detected_intent: 'opt_out', is_opt_out: true }] }).reason, SEND_TIME_GUARD_REASONS.OPT_OUT_REPLY)
})

test('rule 4 (writers): channel_compliance / suppressed rows come ONLY from an explicit opt-out — never from a property denial', () => {
  // deriveS1Outcome: OPT_OUT only for opt_out / unsubscribe / stop intents; no relationship outcome maps to it
  for (const intent of ['property_specific_non_owner', 'former_owner_respondent', 'wrong_number', 'not_interested', 'sold_property']) {
    for (const rel of [...Object.keys(RELATIONSHIP_TO_S1_OUTCOME), null]) {
      assert.notEqual(deriveS1Outcome({ canonical_intent: intent, relationship_outcome: rel }), 'opt_out', `${intent} × ${rel}`)
    }
  }
  assert.ok(!Object.values(RELATIONSHIP_TO_S1_OUTCOME).includes('opt_out'))
  for (const intent of ['opt_out', 'unsubscribe', 'stop']) assert.equal(deriveS1Outcome({ canonical_intent: intent }), 'opt_out')
  assert.deepEqual(Object.entries(OUTCOME_TO_ROLE).filter(([, role]) => role === 'suppressed').map(([o]) => o), ['opt_out'])
  // the single contact_property_resolution writer: channel_compliance only when the outcome is OPT_OUT
  const phase = fs.readFileSync(path.join(SRC, 'lib/domain/seller-flow/resolve-contact-outcome-phase.js'), 'utf8')
  assert.match(phase, /suppression_scope:\s*\n?\s*outcome === S1_CONTACT_OUTCOME\.OPT_OUT \? 'channel_compliance' : 'contact_property_pair'/)
  const writers = (function list(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)) : /\.m?js$/.test(e.name) ? [path.join(d, e.name)] : [])) })(SRC)
    .filter((f) => {
      const c = fs.readFileSync(f, 'utf8')
      if (!c.includes('contact_property_resolution')) return false
      const tableConst = /const\s+(\w+)\s*=\s*['"]contact_property_resolution['"]/.exec(c)?.[1]
      const target = tableConst ? `(?:${tableConst}|['"]contact_property_resolution['"])` : `['"]contact_property_resolution['"]`
      return new RegExp(`\\.from\\(\\s*${target}\\s*\\)[\\s\\S]{0,400}?\\.(?:insert|upsert|update)\\(`).test(c)
    })
    .map((f) => path.relative(SRC, f))
  assert.deepEqual(writers.sort(), ['lib/domain/seller-flow/contact-resolution-repository.js'], 'one writer of contact_property_resolution')
  // the follow-up scheduler: a property denial is a contact × property pair suppression, never channel compliance
  for (const intent of ['property_specific_non_owner', 'former_owner_respondent']) {
    const plan = resolveFollowUpPlan(intent, { thread_key: PHONE })
    assert.equal(plan.suppression_scope, 'contact_property_pair', intent)
  }
  assert.equal(resolveFollowUpPlan('opt_out', { thread_key: PHONE }).suppression_scope, 'channel_compliance')
})

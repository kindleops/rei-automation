// rc-8.5.21 (owner P0 2026-10-16) — the automation-hold port, the ownership RECONTACT GUARD and
// the opportunity-desk classifier / flow defects. Pure + in-memory; no network, no DB.
//
//   holds     every 8.5.21 automated path consults ONE port (holds-port/automation-hold-port.js),
//             bound to the hotfix registry; no registry / a lookup error = HELD (fail closed)
//   recontact a property-scoped ownership denial (contact_property_resolution, or the thread's
//             own text) blocks every outbound about THAT property; opt-out stays contact-wide;
//             only later ownership evidence or an audited MANUAL override crosses it
//   defects   "I'm listening" / "What amount ?" / "Hi Jake. Yes" / "No never have" / emoji S1 "No 👎";
//             Pittsburgh 8d03a7c4 (no price question after a stated price); El Paso 7a17fd6c
//             (Spanish continuity); row 8992ba40 (one language truth in the target snapshot)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { checkAutomationHoldPort, registerAutomationHoldChecker, __resetAutomationHoldChecker, AUTOMATION_HOLD_PORT_VERSION } from '../../src/lib/domain/holds-port/automation-hold-port.js'
import { evaluateSendTimeContactGuard, loadSendTimeContactFacts, SEND_TIME_GUARD_REASONS, statedAskingPrice } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { evaluateContactPropertyResolution, evaluateOwnershipRecontact, ownershipEvidenceByProperty } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { evaluateOpenerReplyExclusion, loadOpenerReplyFacts } from '../../src/lib/domain/campaigns/opener-reply-exclusion.js'
import { aiSendAuthorizedFor } from '../../src/lib/ai/conversation-turn-wiring.js'
import { evaluateAiConversationRowGate } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { resolveSellerReplyLanguage, identifyReplyLanguage } from '../../src/lib/domain/classification/seller-reply-language.js'
import { detectMessageLanguage } from '../../src/lib/domain/classification/reply-disposition-signals.js'
import { buildTargetSnapshotFromGraphRow } from '../../src/lib/domain/campaigns/campaign-automation-service.js'
import { bareNoAnswer } from '../../src/lib/domain/conversation-ai/answers.js'
import { replayReply } from '../helpers/reply-replay-harness.mjs'
import { TEST_NO_HOLD_CHECKER } from '../helpers/critical-test-environment.mjs'

// fictional 555-01xx numbers only
const PHONE = '+15555550111'
const HELD = async () => ({ held: true, hold_type: 'operator_hold', reason: 'owner_took_over', hold_id: 'hold-1' })
const NO_HOLD = async () => ({ held: false, hold_type: null, reason: null, hold_id: null })
const T0 = '2026-09-01T15:00:00.000Z'
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString()

// ── 1. the automation-hold port ─────────────────────────────────────────────
test('hold port: no registry bound = HELD (lookup_error) — the fail-closed default', async () => {
  __resetAutomationHoldChecker()
  try {
    const r = await checkAutomationHoldPort({ threadKey: PHONE, capability: 'send_time_dispatch' })
    assert.equal(r.held, true)
    assert.equal(r.hold_type, 'lookup_error')
    assert.equal(r.reason, 'automation_hold_registry_unavailable')
    assert.equal(r.version, AUTOMATION_HOLD_PORT_VERSION)
  } finally { registerAutomationHoldChecker(TEST_NO_HOLD_CHECKER) }
})

test('hold port: a throwing / malformed registry is a hold; a missing capability is a hold', async () => {
  const thrown = await checkAutomationHoldPort({ threadKey: PHONE, capability: 'x' }, { checker: async () => { throw new Error('db down') } })
  assert.deepEqual([thrown.held, thrown.hold_type, thrown.reason], [true, 'lookup_error', 'automation_hold_lookup_failed'])
  const malformed = await checkAutomationHoldPort({ threadKey: PHONE, capability: 'x' }, { checker: async () => ({ held: 'no' }) })
  assert.deepEqual([malformed.held, malformed.reason], [true, 'automation_hold_result_invalid'])
  const nocap = await checkAutomationHoldPort({ threadKey: PHONE }, { checker: NO_HOLD })
  assert.equal(nocap.held, true)
})

test('hold port: passes the hotfix interface arguments through and reports the registry verdict', async () => {
  const seen = []
  const checker = async (a) => { seen.push(a); return { held: true, hold_type: 'deal_hold', reason: 'negotiating', hold_id: 'h9' } }
  const r = await checkAutomationHoldPort({ threadKey: PHONE, threadId: 't1', propertyId: 'p1', opportunityId: 'o1', masterOwnerId: 'm1', capability: 'followup_dispatch' }, { checker })
  assert.deepEqual(seen, [{ threadKey: PHONE, threadId: 't1', propertyId: 'p1', opportunityId: 'o1', masterOwnerId: 'm1', capability: 'followup_dispatch' }])
  assert.deepEqual([r.held, r.hold_type, r.reason, r.hold_id], [true, 'deal_hold', 'negotiating', 'h9'])
  const free = await checkAutomationHoldPort({ threadKey: PHONE, capability: 'x' }, { checker: NO_HOLD })
  assert.equal(free.held, false)
})

test('hold port: the owner-handled thread (3746 Baltimore Ave) is a hold even with a "no hold" registry', async () => {
  const r = await checkAutomationHoldPort({ threadKey: PHONE, propertyAddress: '3746 Baltimore Ave', capability: 'x' }, { checker: NO_HOLD })
  assert.deepEqual([r.held, r.hold_type], [true, 'owner_handled'])
})

// ── 2. a held thread is never advanced or sent ──────────────────────────────
const switchesOn = async (k) => (k === AI_SEND_KILL_SWITCH_KEY ? 'true' : k === AI_SEND_POLICY_KEY ? JSON.stringify({ enabled: true, scope: { thread_keys: [PHONE] } }) : null)

test('held thread: the turn decider never authorises an AI send (held, and registry-less)', async () => {
  const held = await aiSendAuthorizedFor({ threadKey: PHONE, readSwitch: switchesOn, automationHoldChecker: HELD })
  assert.deepEqual(held, { ok: false, reason: 'automation_hold:operator_hold' })
  __resetAutomationHoldChecker()
  try {
    const unbound = await aiSendAuthorizedFor({ threadKey: PHONE, readSwitch: switchesOn })
    assert.deepEqual(unbound, { ok: false, reason: 'automation_hold:lookup_error' })
  } finally { registerAutomationHoldChecker(TEST_NO_HOLD_CHECKER) }
})

test('held thread: an AI queue row is deferred by the row gate, never sent', async () => {
  const row = { id: 'q1', queue_key: 'ai:q1', thread_key: PHONE, property_id: 'p1', message_origin: 'ai_generated', metadata: { source: 'ai_conversation', message_origin: 'ai_generated' } }
  const r = await evaluateAiConversationRowGate(row, { readSwitch: switchesOn, automationHoldChecker: HELD, loadRecord: async () => { throw new Error('must not reach the record check') } })
  if (r.applies) {
    assert.equal(r.action, 'defer')
    assert.equal(r.reason, 'ai_conversation_automation_hold:operator_hold')
  } else {
    assert.fail(`the fixture row must be an AI row: ${JSON.stringify(r)}`)
  }
})

test('held thread: the send-time guard (every outbound path) blocks with automation_hold_active; a lookup error does too', async () => {
  const row = { to_phone_number: PHONE, thread_key: PHONE, property_id: 'p1', message_body: 'Following up on 1 Main St', use_case_template: 'follow_up' }
  const r = evaluateSendTimeContactGuard(row, { automation_hold: { held: true, hold_type: 'operator_hold', reason: 'x', hold_id: 'h1' } })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, SEND_TIME_GUARD_REASONS.AUTOMATION_HOLD)
  assert.equal(r.detail.hold_id, 'h1')
  // the loader asks the port with the row's keys; a throwing registry = held
  const facts = await loadSendTimeContactFacts(fakeSupabase({}), row, { automationHoldChecker: async () => { throw new Error('boom') } })
  assert.equal(facts.automation_hold.held, true)
  assert.equal(evaluateSendTimeContactGuard(row, facts).reason, SEND_TIME_GUARD_REASONS.AUTOMATION_HOLD)
  // not held: the guard moves on to the other checks
  const ok = await loadSendTimeContactFacts(fakeSupabase({}), row, { automationHoldChecker: NO_HOLD })
  assert.equal(evaluateSendTimeContactGuard(row, ok).blocked, false)
})

// ── 3. the recontact guard ──────────────────────────────────────────────────
const pair = (property_id, role = 'not_owner', extra = {}) => ({ property_id, contact_phone_e164: PHONE, contact_property_role: role, suppression_scope: 'contact_property_pair', rejected_at: at(1), ...extra })

test('store: a rejected pair excludes THAT property only; channel compliance excludes the phone everywhere', () => {
  for (const role of ['not_owner', 'former_owner', 'referral_source']) {
    const r = evaluateContactPropertyResolution({ property_id: 'p1', resolutions: [pair('p1', role)] })
    assert.deepEqual([r.excluded, r.reason, r.scope], [true, 'prior_reply_not_owner', 'person_property'], role)
  }
  assert.equal(evaluateContactPropertyResolution({ property_id: 'p2', resolutions: [pair('p1')] }).excluded, false, 'other property stays eligible')
  assert.equal(evaluateContactPropertyResolution({ property_id: 'p1', resolutions: [pair('p1', 'not_owner', { rejected_at: null })] }).excluded, false, 'no rejected_at = not a recorded denial')
  assert.equal(evaluateContactPropertyResolution({ property_id: 'p1', resolutions: [pair('p1', 'confirmed_owner')] }).excluded, false)
  const optout = evaluateContactPropertyResolution({ property_id: 'p9', resolutions: [pair('p1', 'suppressed', { suppression_scope: 'channel_compliance' })] })
  assert.deepEqual([optout.excluded, optout.scope, optout.reason], [true, 'phone', 'contact_channel_suppressed'])
})

const ownershipQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', created_at: at(min), property_id })
const inbound = (id, body, min, extra = {}) => ({ id, direction: 'inbound', message_body: body, created_at: at(min), ...extra })

test('text evidence: a bare / emoji "No" or "never have" to our ownership question denies THAT property; a polite "No thanks" is a decline', () => {
  for (const body of ['No', 'Nope 🙅', 'No 👎', 'No never have', 'Never owned it']) {
    const ev = ownershipEvidenceByProperty({ messages: [ownershipQ('o1', 0), inbound('i1', body, 5)] })
    assert.equal(ev.get('p1')?.state, 'denied', body)
  }
  assert.equal(bareNoAnswer('No thanks').ownership_denial, false)
  assert.notEqual(ownershipEvidenceByProperty({ messages: [ownershipQ('o1', 0), inbound('i1', 'No thanks', 5)] }).get('p1')?.state, 'denied', 'polite = decline (30-day nurture)')
  // the same "No" to an INTEREST question is disinterest (30-day nurture), never a denial
  const s2 = ownershipEvidenceByProperty({ messages: [{ id: 'o1', direction: 'outbound', message_body: 'Would you consider an offer on 1 Main St if the number made sense?', created_at: at(0), property_id: 'p1' }, inbound('i1', 'No', 5)] })
  assert.notEqual(s2.get('p1')?.state, 'denied')
})

test('recontact: every automated outbound about the denied property is blocked; other properties go out', () => {
  const messages = [ownershipQ('o1', 0), inbound('i1', 'No', 5)]
  for (const use_case_template of ['ownership_check', 'follow_up', 'not_interested_nurture', 'auto_reply']) {
    const r = evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', use_case_template, metadata: {} }, messages)
    assert.equal(r.blocked, true, use_case_template)
    assert.equal(r.detail.scope, 'person_property')
  }
  assert.equal(evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p2', metadata: {} }, [ownershipQ('o1', 0, 'p1'), inbound('i1', 'No', 5)]).blocked, false)
})

test('recontact: only LATER ownership evidence clears a denial (text or store)', () => {
  const later = [ownershipQ('o1', 0), inbound('i1', 'No', 5), ownershipQ('o2', 10), inbound('i2', 'Actually yes I do own it', 15)]
  assert.equal(evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', metadata: {} }, later).blocked, false)
  // the store row was written AFTER the confirmation: still blocked
  const storeAfter = [pair('p1', 'not_owner', { rejected_at: at(60) })]
  assert.equal(evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', metadata: {} }, later, { resolutions: storeAfter }).blocked, true)
  // a confirmation AFTER the recorded rejection clears the store verdict
  const storeBefore = [pair('p1', 'not_owner', { rejected_at: at(2) })]
  assert.equal(evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', metadata: {} }, later, { resolutions: storeBefore }).blocked, false)
})

test('recontact: a MANUAL send may cross it only with an audited override; an automated row never can', () => {
  const messages = [ownershipQ('o1', 0), inbound('i1', 'No', 5)]
  const override = { actor: 'operator@example.test', reason: 'seller called back and confirmed ownership', at: at(30) }
  const manual = evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', message_type: 'manual_reply', metadata: { ownership_recontact_override: override } }, messages)
  assert.equal(manual.blocked, false)
  assert.equal(manual.detail.overridden, true)
  assert.equal(manual.detail.override.actor, 'operator@example.test')
  const automated = evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', use_case_template: 'follow_up', metadata: { ownership_recontact_override: override } }, messages)
  assert.equal(automated.blocked, true)
  const shortReason = evaluateOwnershipRecontact({ to_phone_number: PHONE, property_id: 'p1', message_type: 'manual_reply', metadata: { ownership_recontact_override: { ...override, reason: 'ok' } } }, messages)
  assert.equal(shortReason.blocked, true, 'an override needs a real reason')
})

test('send-time guard: the store blocks at dispatch (property scope) and opt-out rows are contact-wide', () => {
  const row = { to_phone_number: PHONE, thread_key: PHONE, property_id: 'p1', use_case_template: 'follow_up', metadata: {} }
  const r = evaluateSendTimeContactGuard(row, { contact_property_resolution: [pair('p1')] })
  assert.equal(r.reason, SEND_TIME_GUARD_REASONS.PRIOR_REPLY_NOT_OWNER)
  assert.equal(evaluateSendTimeContactGuard({ ...row, property_id: 'p2' }, { contact_property_resolution: [pair('p1')] }).blocked, false)
  const opt = evaluateSendTimeContactGuard({ ...row, property_id: 'p2' }, { contact_property_resolution: [pair('p1', 'suppressed', { suppression_scope: 'channel_compliance' })] })
  assert.equal(opt.reason, SEND_TIME_GUARD_REASONS.THREAD_OPTED_OUT)
})

test('send-time guard loader reads contact_property_resolution and the thread; a store read error fails closed', async () => {
  const row = { to_phone_number: PHONE, thread_key: PHONE, property_id: 'p1', use_case_template: 'follow_up', metadata: {} }
  const facts = await loadSendTimeContactFacts(fakeSupabase({ contact_property_resolution: [pair('p1')] }), row, { automationHoldChecker: NO_HOLD })
  assert.equal(evaluateSendTimeContactGuard(row, facts).reason, SEND_TIME_GUARD_REASONS.PRIOR_REPLY_NOT_OWNER)
  await assert.rejects(loadSendTimeContactFacts(fakeSupabase({}, { fail: 'contact_property_resolution' }), row, { automationHoldChecker: NO_HOLD }))
})

test('campaign opener exclusion reads the store (e767ad0d: labels were unclear / not_interested)', async () => {
  const threads = [{ thread_key: PHONE, property_id: 'p1', disposition: 'not_interested', last_intent: 'unclear' }]
  assert.equal(evaluateOpenerReplyExclusion({ property_id: 'p1', threads }).excluded, false, 'labels alone miss it')
  const r = evaluateOpenerReplyExclusion({ property_id: 'p1', threads, resolutions: [pair('p1')] })
  assert.deepEqual([r.excluded, r.scope, r.source], [true, 'person_property', 'contact_property_resolution'])
  assert.equal(evaluateOpenerReplyExclusion({ property_id: 'p2', threads, resolutions: [pair('p1')] }).excluded, false)
  const facts = await loadOpenerReplyFacts(fakeSupabase({ contact_property_resolution: [pair('p1'), pair('p3', 'confirmed_owner', { rejected_at: null })] }), [PHONE])
  const slot = [...facts.values()][0]
  assert.equal(slot.resolutions.length, 1, 'only rejected / compliance rows are kept')
  await assert.rejects(loadOpenerReplyFacts(fakeSupabase({}, { fail: 'contact_property_resolution' }), [PHONE]), 'fail closed')
})

// ── 4. opportunity-desk classifier defects ──────────────────────────────────
const CATALOG = JSON.parse(readFileSync(new URL('../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json', import.meta.url), 'utf8')).rows
const Q = {
  s1: ['ownership_check', 'Hey Pat, this is Jake. Do you still own 1 Main St?'],
  s2: ['consider_selling', 'Would you consider an offer on 1 Main St if the number made sense?'],
}
const replay = (message, q) => {
  const [use_case, text] = Q[q]
  return replayReply({ fixture_id: 'r8521', received_at: '2026-10-16T18:00:00.000Z', seller_message: message, prior_question: { template_id: 't-r8521', template_use_case: use_case, text, sent_at: '2026-10-16T17:00:00.000Z', delivered_at: '2026-10-16T17:00:05.000Z' }, intervening_inbound: [], r7_history: [], valuation: null }, { catalog: CATALOG })
}

for (const [message, q, intent, rule] of [
  ["I'm listening", 's2', 'seller_interested', 'ctx_listening_after_proposal_interest'],
  ['What amount ?', 's2', 'asks_offer', 'ctx_amount_question_after_proposal_interest'],
  ['Hi Jake. Yes', 's1', 'ownership_confirmed', 'ctx_yes_after_ownership_check_after_greeting'],
  ['No never have', 's1', 'property_specific_non_owner', 'ctx_never_owned_after_ownership_check'],
  ['Never have', 's1', 'property_specific_non_owner', 'ctx_never_owned_after_ownership_check'],
  ['No 👎', 's1', 'property_specific_non_owner', 'ctx_emoji_no_after_ownership_check_ownership_unverified'],
  ['No thanks', 's1', 'not_interested', 'ctx_polite_no_after_ownership_check_not_interested'],
]) {
  test(`classifier reads the previous question: ${JSON.stringify(message)} after ${q} → ${intent} (never unclear / not_interested)`, async () => {
    const r = await replay(message, q)
    assert.equal(r.classification.primary_intent, intent)
    assert.ok(r.classification.matched_rule_ids.includes(rule), r.classification.matched_rule_ids.join(','))
    if (intent === 'property_specific_non_owner') {
      assert.equal(r.decision.should_suppress_contact, false, 'never a phone suppression')
      assert.equal(r.decision.follow_up_at ?? null, null, 'no nurture after a denial')
    }
  })
}

// ── 5. Pittsburgh 8d03a7c4: never re-ask a STATED asking price ─────────────
test('Pittsburgh 8d03a7c4: after "460 k not a penny less" no path sends an asking-price question', () => {
  const thread = [
    { id: 'o1', direction: 'outbound', message_body: 'Would you consider an offer on it?', created_at: at(0) },
    { id: 'i1', direction: 'inbound', message_body: '460 k not a penny less', created_at: at(5) },
  ]
  assert.ok(statedAskingPrice(thread), 'the fact extractor reads the stated price')
  const ask = { to_phone_number: PHONE, thread_key: PHONE, property_id: 'p1', message_body: 'What price would you want for it?', use_case_template: 'asking_price', metadata: {} }
  const r = evaluateSendTimeContactGuard(ask, { thread_messages: thread })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, SEND_TIME_GUARD_REASONS.ASKING_PRICE_ALREADY_STATED)
  // a condition question (the next stage) goes out
  assert.equal(evaluateSendTimeContactGuard({ ...ask, message_body: 'Got it. What kind of shape is it in?', use_case_template: 'ask_condition_clarifier' }, { thread_messages: thread }).blocked, false)
  // a manual send can re-ask only with the audited repeat-ask override
  const override = { scope: 'repeat_asking_price', actor: 'operator@example.test', reason: 'seller asked us to confirm the number', at: at(30) }
  assert.equal(evaluateSendTimeContactGuard({ ...ask, metadata: { manual_operator_send: true, repeat_ask_override: override } }, { thread_messages: thread }).blocked, false)
  assert.equal(evaluateSendTimeContactGuard({ ...ask, metadata: { repeat_ask_override: override } }, { thread_messages: thread }).blocked, true, 'never for an automated row')
})

// ── 6. El Paso 7a17fd6c: Spanish thread stays Spanish ──────────────────────
test('El Paso 7a17fd6c: everyday Spanish replies keep the Spanish thread language', () => {
  for (const body of ['Si cabron y que pedo', 'Ya te dije cabron. 300k']) {
    assert.equal(detectMessageLanguage(body), 'Spanish', body)
    const r = resolveSellerReplyLanguage({ message: body, detected_language: 'English', thread_language: 'Spanish' })
    assert.equal(r.language, 'Spanish', body)
  }
  // the word evidence decides before the classifier's English default ("no speako aspanish" stays English)
  assert.equal(identifyReplyLanguage('Si cabron y que pedo', { detected_language: 'English' }), 'Spanish')
  // real English stays English
  assert.equal(resolveSellerReplyLanguage({ message: 'Yes I still own it', detected_language: 'English', thread_language: 'Spanish' }).language, 'English')
})

// ── 7. row 8992ba40: one language truth for template and snapshot ──────────
test('8992ba40: the candidate snapshot carries the SAME resolved language as the target (graph value kept as evidence)', () => {
  const t = buildTargetSnapshotFromGraphRow({ id: 'c1' }, { property_id: 'p1', canonical_e164: PHONE, language: 'English', resolved_language: 'Spanish', resolved_language_source: 'prospect' })
  const snap = findKey(t, 'candidate_snapshot')
  assert.ok(snap, 'snapshot present')
  assert.equal(t.language, 'Spanish')
  assert.equal(snap.language, t.language)
  assert.equal(snap.graph_language, 'English')
  assert.equal(snap.language_source, 'prospect')
  assert.equal(snap.language_conflict, true)
  const plain = buildTargetSnapshotFromGraphRow({ id: 'c1' }, { property_id: 'p1', canonical_e164: PHONE, language: 'English' })
  const s2 = findKey(plain, 'candidate_snapshot')
  assert.deepEqual([plain.language, s2.language, s2.language_source, s2.language_conflict], ['English', 'English', 'graph', false])
})

// ── helpers ─────────────────────────────────────────────────────────────────
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) { const r = findKey(v, key, depth + 1); if (r) return r }
  return null
}

function fakeSupabase(tables = {}, { fail = null } = {}) {
  return {
    from(table) {
      const filters = []
      const q = {
        select() { return q }, eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return q },
        in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return q },
        order() { return q }, limit() { return q },
        then(res, rej) {
          if (fail === table) return Promise.resolve({ data: null, error: new Error(`read failed: ${table}`) }).then(res, rej)
          return Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej)
        },
      }
      return q
    },
  }
}

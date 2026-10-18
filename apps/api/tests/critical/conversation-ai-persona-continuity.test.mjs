// rc-8.5.20 part A, Phase 2 — persona + sender continuity and the playbook v2 persona rules.
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveThreadContinuity, checkOutboundContinuity, rowPersonaName } from '../../src/lib/domain/conversation-ai/persona-continuity.js'
import { resolveOutboundPersona, shownPersonas } from '../../src/lib/domain/outbound/outbound-persona.js'
import { validatePlaybookStyle, claimedNames, deniesAutomation, inventsBackstory } from '../../src/lib/domain/conversation-ai/playbook/v2/style-validator.js'
import { PLAYBOOK_RULES, PLAYBOOK_VERSION, PERSONA_POLICY_DEFAULT } from '../../src/lib/domain/conversation-ai/playbook/v2/index.js'
import { PLAYBOOK_RULES as V1_RULES, PLAYBOOK_VERSION as V1_VERSION } from '../../src/lib/domain/conversation-ai/playbook/v1/index.js'
import { validatePlaybookStyle as validateV1 } from '../../src/lib/domain/conversation-ai/playbook/v1/style-validator.js'
import { buildComposePrompt, checkComposedText } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { executeAiConversationReply } from '../../src/lib/ai/conversation-ai-r3-executor.js'
import { toRecord } from '../helpers/canonical-record.mjs'
import { resetMemoryIdempotencyLedger } from '../helpers/memory-idempotency-ledger.mjs'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { insertSupabaseSendQueueRow } from '../../src/lib/supabase/sms-engine.js'

const SELLER = '+15555550101'
const OURS = '+15555550199'
const OTHER = '+15555550188'
const NOW = '2026-10-14T17:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString()
const sent = (over = {}) => ({ queue_status: 'sent', agent_name: 'Helen', from_phone_number: OURS, created_at: ago(30), message_body: 'Hi Dana, this is Helen. Do you still own 12 Elm St?', ...over })

// ── continuity resolution ───────────────────────────────────────────────────
test('continuity: the persona already shown on the thread and the sticky number are kept', () => {
  const c = resolveThreadContinuity({ sentRows: [sent()], threadState: { our_number: OURS }, inboundTo: OURS })
  assert.deepEqual([c.ok, c.persona_name, c.persona_source, c.sender_number, c.sender_source], [true, 'Helen', 'thread_established', OURS, 'thread_sticky'])
  // the persona is read from the signed body when agent_name was never stamped
  const signed = resolveThreadContinuity({ sentRows: [sent({ agent_name: null, message_body: 'Hey Dana, this is Mason. Do you still own 12 Elm St?' })], inboundTo: OURS })
  assert.equal(signed.persona_name, 'Mason')
  assert.equal(signed.sender_source, 'inbound_to')
  // only seller-visible rows establish a persona
  const unsent = resolveThreadContinuity({ sentRows: [sent({ queue_status: 'cancelled', agent_name: 'Alex', message_body: 'x' })], inboundTo: OURS })
  assert.deepEqual([unsent.ok, unsent.persona_name, unsent.persona_source], [true, null, 'none_established'])
})

test('continuity: two shown personas = conflict (hold, never switch); sticky vs texted number mismatch = hold', () => {
  const conflict = resolveThreadContinuity({ sentRows: [sent(), sent({ agent_name: 'Alex', message_body: 'Hi, this is Alex.' })], inboundTo: OURS })
  assert.equal(conflict.ok, false)
  assert.ok(conflict.reasons.includes('persona_conflict'))
  const moved = resolveThreadContinuity({ sentRows: [sent()], threadState: { our_number: OURS }, inboundTo: OTHER })
  assert.deepEqual([moved.ok, moved.reasons], [false, ['sender_number_mismatch']])
  const none = resolveThreadContinuity({})
  assert.deepEqual(none.reasons, ['sender_number_unresolved'])
})

test('continuity: AI and template origins resolve the SAME persona through the one existing resolver', () => {
  const rows = [sent(), sent({ created_at: ago(10) })]
  const template = resolveOutboundPersona({ thread_persona: shownPersonas(rows) }) // the template renderer's call (hotfix 8.4.8)
  const ai = resolveThreadContinuity({ sentRows: rows, inboundTo: OURS })
  assert.equal(template.first_name, ai.persona_name)
  assert.equal(rowPersonaName(rows[0]), 'Helen')
  const c = resolveThreadContinuity({ sentRows: rows, threadState: { our_number: OURS } })
  assert.equal(checkOutboundContinuity({ continuity: c, fromNumber: OURS, personaName: 'Helen' }).ok, true)
  assert.deepEqual(checkOutboundContinuity({ continuity: c, fromNumber: OTHER, personaName: 'Helen' }).reasons, ['continuity:sender_number_changed'])
  assert.deepEqual(checkOutboundContinuity({ continuity: c, fromNumber: OURS, personaName: 'Alex' }).reasons, ['continuity:persona_changed'])
})

// ── playbook v2 persona rules ───────────────────────────────────────────────
test('playbook v2: only the persona rule changed from v1; the established name is allowed, nothing else is', () => {
  assert.equal(PLAYBOOK_VERSION, 'playbook.v2')
  assert.equal(V1_VERSION, 'playbook.v1')
  assert.equal(PERSONA_POLICY_DEFAULT.allow_established_persona, true)
  assert.ok(!PLAYBOOK_RULES.some((r) => /Never claim to be a specific person/.test(r)))
  assert.ok(V1_RULES.some((r) => /Never claim to be a specific person/.test(r)), 'v1 is unchanged')
  assert.ok(PLAYBOOK_RULES.some((r) => /never deny it/.test(r)))
  assert.ok(PLAYBOOK_RULES.some((r) => /Never invent a backstory/.test(r)))
  const P = { establishedPersona: 'Helen' }
  assert.equal(validatePlaybookStyle('This is Helen, a local buyer. Do you still own it?', P).ok, true)
  assert.equal(validatePlaybookStyle('Helen here. Is the house still yours?', P).ok, true)
  assert.deepEqual(validatePlaybookStyle('This is Mike. Would you consider selling?', P).reasons, ['persona:name_not_established'])
  assert.deepEqual(validatePlaybookStyle('This is Helen. Would you consider selling?', {}).reasons, ['persona:name_not_established'], 'no persona on record: no name')
  assert.deepEqual(validatePlaybookStyle('My name is Helen. Would you sell?', { establishedPersona: 'Helen', personaPolicy: { allow_established_persona: false } }).reasons, ['persona:name_not_established'])
  assert.deepEqual(claimedNames('Thanks Dana. This is about your house.'), [])
  // v1 still refuses the established name (its own record stays reproducible)
  assert.equal(validateV1('This is Helen. Would you sell?', { establishedPersona: 'Helen' }).ok, false)
})

test('playbook v2: never deny automation; never invent a backstory or credentials; every v1 style rule still applies (em dash)', () => {
  for (const t of ["I'm a real person, not a bot.", 'No, this is not automated. Would you sell?', "I'm human, I promise.", 'Not a bot! Just a local buyer.', 'This is a real person texting.', 'I typed this myself.']) {
    assert.ok(deniesAutomation(t), t)
    assert.ok(validatePlaybookStyle(t, { establishedPersona: 'Helen' }).reasons.includes('persona:denies_automation'), t)
  }
  for (const t of ['Yes, I use an automated assistant to help with texts.', 'Thanks. Is the roof in good shape?', 'Would you consider selling it?']) assert.ok(!deniesAutomation(t), t)
  for (const t of ['I grew up in the neighborhood. Would you sell?', "I've been investing for 12 years.", "I'm a licensed realtor.", 'Born and raised here.', 'My wife and I buy homes nearby.', 'I live down the street.', "We've closed 200 deals."]) {
    assert.ok(inventsBackstory(t) || validatePlaybookStyle(t, { establishedPersona: 'Helen' }).reasons.some((r) => /invented/.test(r)), t)
  }
  assert.ok(!inventsBackstory('This is Helen, a local buyer.'))
  for (const t of ['Got it — what price?', 'Thanks – would you sell?']) assert.ok(!validatePlaybookStyle(t, { establishedPersona: 'Helen' }).ok, t)
})

test('compose: the composer is told the persona; a draft naming anyone else is rejected by the code check', () => {
  const ledger = buildCanonicalLedger({ messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, this is Helen. Do you still own it?', at: ago(30), use_case: 'ownership_check' }, { id: 'i1', direction: 'inbound', body: 'who is this?', at: ago(5) }], now: NOW })
  const p = buildComposePrompt({ ledger, inboundText: 'who is this?', category: 'identity_answer', objective: 'ownership', tone: 'skeptical', establishedPersona: 'Helen' })
  assert.match(p.user, /PERSONA: Helen/)
  assert.match(p.system, /never deny it/)
  assert.equal(p.prompt_version, 'compose.v3')
  const none = buildComposePrompt({ ledger, inboundText: 'who is this?', category: 'identity_answer', objective: 'ownership', tone: 'skeptical' })
  assert.match(none.user, /PERSONA: none on record: give no name/)
  const bad = checkComposedText('This is Mike, a local buyer. Do you still own it?', { ledger, objective: 'ownership', category: 'identity_answer', inboundIntent: 'who_is_this', establishedPersona: 'Helen' })
  assert.ok(bad.includes('persona:name_not_established'), JSON.stringify(bad))
  const good = checkComposedText('This is Helen, a local buyer. Do you still own it?', { ledger, objective: 'ownership', category: 'identity_answer', inboundIntent: 'who_is_this', establishedPersona: 'Helen' })
  assert.ok(!good.some((r) => r.startsWith('persona:')), JSON.stringify(good))
})

test('decide: "is this a bot?" goes to a person (a truthful answer), never to an AI draft', () => {
  for (const t of ['Is this a bot?', 'are you a real person', 'Am I talking to a robot?', 'is this automated?', 'Is this AI?']) {
    const ledger = buildCanonicalLedger({ messages: [{ id: 'o1', direction: 'outbound', body: 'Do you still own 12 Elm St?', at: ago(30), use_case: 'ownership_check' }, { id: 'i1', direction: 'inbound', body: t, at: ago(1) }], now: NOW })
    const p = decideActions({ ledger, inboundText: t, inboundId: 'i1', language: 'en' })
    assert.ok(p.actions.some((a) => a.type === 'ESCALATE_TO_OPERATOR' && a.reason === 'asked_if_automated'), `${t}: ${JSON.stringify(p.actions)}`)
  }
})

// ── R3 executor: persona + sender continuity on the queue row ───────────────
function executorDeps({ queueRows = [], threadState = null, ourPhone = OURS } = {}) {
  const inserts = []
  const thread = [
    { id: 'o1', direction: 'outbound', body: 'Hi Dana, this is Helen. Do you still own the house on Elm St?', at: ago(30), thread_key: SELLER, seller_phone: SELLER, property_id: 'p1', use_case: 'ownership_check' },
    { id: 'i1', direction: 'inbound', body: 'Yes I still own it, who is this?', at: ago(5), thread_key: SELLER, seller_phone: SELLER, property_id: 'p1' },
  ]
  const state = {
    input: { now: NOW, inbound: { id: 'i1', body: thread[1].body, at: thread[1].at, thread_key: SELLER, from_phone: SELLER, property_id: 'p1' }, thread, properties: [{ property_id: 'p1', property_type: 'sfr', state: 'TX', city: 'Dallas' }], offers: [], followups: [], names: { full_names: [], first_name: null }, language: 'en' },
    queueRows, thread_state: threadState, timezone: 'America/Chicago', geography: { state: 'TX', zip: '75201' }, language: 'en', seller_phone: SELLER, our_phone: ourPhone, property_id: 'p1', prospect_id: 'pr1', master_owner_id: null, market_id: null, campaign_id: null,
  }
  return {
    inserts,
    d: {
      now: NOW,
      readSwitch: async (k) => (k === AI_SEND_KILL_SWITCH_KEY ? 'true' : k === AI_SEND_POLICY_KEY ? JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) : null),
      loadState: async () => structuredClone(state),
      eligibility: async () => ({ blocked: false, reasons: [], outside_window: false }),
      insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, { now: NOW, insertSupabaseSendQueueRow: (row) => { const stored = { ...row, id: `q${inserts.length + 1}` }; inserts.push(stored); return { ok: true, queue_row_id: stored.id, raw: stored } } }),
      insertRecord: async () => ({ ok: true, id: 'aim-1' }),
      lookupRecord: async () => ({ found: false, read_failed: false, record: null }),
      recordEvent: async () => ({ ok: true }),
    },
  }
}
const identityCandidate = (text) => {
  const decision = makeDecision({ intent: 'who_is_this', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: text, confidence: 0.95, source_message_ids: ['i1'], facts_extracted: [{ fact: 'ownership', value: 'confirmed', source_message_id: 'i1', confidence: 0.95 }], stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['i1'], rationale: 'ownership confirmed' } })
  return { record: toRecord(decision, 'i1'), decision_id: 'conv-ai:v1:i1', inbound: { id: 'i1', provider_message_sid: 'SMfixture', thread_key: SELLER } }
}

test('R3: the queue row carries the thread persona and sticky number; another name, a conflict or a moved number holds', async () => {
  resetMemoryIdempotencyLedger()
  const ok = executorDeps({ queueRows: [{ id: 'q0', ...sent() }], threadState: { our_number: OURS } })
  const r = await executeAiConversationReply(identityCandidate("This is Helen, I'm a local buyer. Would you consider selling it?"), ok.d)
  assert.equal(r.status, 'enqueued', JSON.stringify(r))
  const row = ok.inserts[0]
  assert.equal(row.agent_name, 'Helen')
  assert.equal(row.from_phone_number, OURS)
  assert.equal(row.metadata.agent_persona, 'Helen')
  assert.deepEqual(row.metadata.persona_continuity, { version: 'conv-ai.persona-continuity.v1', persona_source: 'thread_established', sender_source: 'thread_sticky' })

  resetMemoryIdempotencyLedger()
  const other = executorDeps({ queueRows: [{ id: 'q0', ...sent() }] })
  const r2 = await executeAiConversationReply(identityCandidate("This is Mike, I'm a local buyer. Would you consider selling it?"), other.d)
  assert.deepEqual([r2.status, r2.reasons], ['held', ['persona:name_not_established']])
  assert.equal(other.inserts.length, 0)

  resetMemoryIdempotencyLedger()
  const conflict = executorDeps({ queueRows: [{ id: 'q0', ...sent() }, { id: 'q00', ...sent({ agent_name: 'Alex', message_body: 'Hi, this is Alex.' }) }] })
  const r3 = await executeAiConversationReply(identityCandidate("I'm a local buyer. Would you consider selling it?"), conflict.d)
  assert.deepEqual([r3.status, r3.reasons], ['held', ['continuity:persona_conflict']])

  resetMemoryIdempotencyLedger()
  const moved = executorDeps({ queueRows: [{ id: 'q0', ...sent() }], threadState: { our_number: OTHER } })
  const r4 = await executeAiConversationReply(identityCandidate("I'm a local buyer. Would you consider selling it?"), moved.d)
  assert.deepEqual([r4.status, r4.reasons], ['held', ['continuity:sender_number_mismatch']])

  resetMemoryIdempotencyLedger()
  const denial = executorDeps({ queueRows: [{ id: 'q0', ...sent() }] })
  const r5 = await executeAiConversationReply(identityCandidate("I'm a real person, a local buyer. Would you consider selling it?"), denial.d)
  assert.equal(r5.status, 'held')
  assert.ok(r5.reasons.includes('persona:denies_automation'), JSON.stringify(r5.reasons))
})

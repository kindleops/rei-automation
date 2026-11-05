// rc-8.5.21 blind re-evaluation (v2 of 736a1e07) fixes, written from the evaluator's DESCRIPTIONS
// (new addresses / phrasings; the case files were never opened).
import test from 'node:test'
import assert from 'node:assert/strict'

import { classify } from '../../src/lib/domain/classification/classify.js'
import { languageVerdict } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { resolveInboundRelationship } from '../../src/lib/domain/seller-flow/resolve-inbound-relationship.js'
import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput, mixedAnswerTarget } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { clauseFacts, propertyAddressIndex, perPropertyObjective } from '../../src/lib/domain/conversation-ai/property-facts.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { propertyMentionReasons } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { runContactResolutionPhase } from '../../src/lib/domain/seller-flow/resolve-contact-outcome-phase.js'

const T = (min) => new Date(Date.parse('2026-10-19T16:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min, property_id) => ({ id, direction: 'outbound', body, at: T(min), property_id })
const inb = (id, body, min, property_id) => ({ id, direction: 'inbound', body, at: T(min), property_id })
function world(thread, properties, extra = {}) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: last.property_id }, thread: thread.filter((m) => m !== last), properties, language: extra.language ?? 'English' }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const plan = decideActions({ ledger, inboundText: last.body, inboundId: last.id, eligibility: { blocked: false }, judgment: extra.judgment ?? null, language: input.language, propertyCount: properties.length, thread: input.thread, inbound: input.inbound })
  return { input, ledger, plan }
}

// ── 2. language: the INBOUND text decides; an unknown language is never English ──
test('v2 language: a Spanish or Creole reply under a stored "English" label is NOT English (held / escalated, never answered in English)', () => {
  for (const t of ['Sí, es mía', 'Sí, es mi casa', 'Wi se kay mwen. Konbyen ou ofri?', 'Mwen pa vle vann', 'Oui, elle est à moi', 'Sim, é minha']) {
    const v = languageVerdict({ language: 'English', inboundText: t })
    assert.equal(v.english, false, `${t}: ${JSON.stringify(v)}`)
  }
  for (const t of ['Yes I still own it', 'which company r u with', 'ok', 'actually 300k']) assert.equal(languageVerdict({ language: 'English', inboundText: t }).english, true, t)
  // the decision escalates the non-English turn instead of composing English
  const w = world([out('o1', '¿Es usted el dueño de 77 Calle Ceiba?', 30, 'pA'), inb('i1', 'Sí, es mía', 2, 'pA')], [{ property_id: 'pA', address: '77 Calle Ceiba' }])
  assert.ok(!w.plan.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY), JSON.stringify(w.plan.actions))
})

// ── 6. identity / channel ──
test('v2 IDN-04: "Are you a realtor? I\'m not paying commission" is a question about us, never a not-owner agent role', async () => {
  const r = resolveInboundRelationship({ message: "Are you an agent? I'm not paying any commission", classification: { primary_intent: 'who_is_this' } })
  assert.notEqual(r.relationship_claim, 'agent', JSON.stringify(r))
  assert.notEqual(r.relationship_outcome, 'agent_representative_respondent')
  // a statement of the role still is one
  assert.equal(resolveInboundRelationship({ message: "I'm the listing agent for the owner" }).relationship_claim, 'agent')
})

test('v2 IDN-10: "I don\'t text much, can someone call me?" is a callback (channel preference), never an opt-out; a directive stays an opt-out', async () => {
  const pref = await classify("Yes. I don't really text much, could someone give me a call?", null, { heuristicOnly: true })
  assert.notEqual(pref.primary_intent, 'opt_out')
  assert.equal(pref.compliance_flag ?? null, null)
  const stop = await classify("don't text me, call me instead", null, { heuristicOnly: true })
  assert.equal(stop.primary_intent, 'opt_out', 'an explicit "don\'t text me" stays a compliance stop')
})

test('v2 RUN-18: "my husband wants to keep it" is selling disinterest (the 30-day nurture)', async () => {
  for (const t of ['My husband wants to keep it', 'my wife would rather keep the house', "We're keeping it"]) {
    const r = await classify(t, null, { heuristicOnly: true })
    assert.equal(r.primary_intent, 'not_interested', t)
  }
})

// ── 5. multi-property ──
const PROPS = [{ property_id: 'pA', address: '18 Bramble Hollow Ln' }, { property_id: 'pB', address: '260 Kestrel Crest Dr' }]
test('v2 MUL-02/05: "I don\'t own X, never did. Y is mine though" — the denial on X, the conversation CONTINUES on Y (its next stage question)', () => {
  const thread = [out('o1', 'Hi, this is Helen. Do you own 18 Bramble Hollow Ln?', 50, 'pA'), out('o2', 'Also, are you the owner of 260 Kestrel Crest Dr?', 40, 'pB'), inb('i1', "I don't own the Bramble Hollow one, never did. Kestrel Crest is mine though", 2, 'pB')]
  const w = world(thread, PROPS)
  assert.deepEqual([w.ledger.property.ownership.by_property.pA.state, w.ledger.property.ownership.by_property.pB.state], ['denied', 'confirmed'])
  const reply = w.plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.ok(reply, JSON.stringify(w.plan.actions))
  assert.deepEqual([reply.objective, reply.target_property], ['interest', 'pB'])
  // the text may name Y only
  assert.deepEqual(propertyMentionReasons('Thanks for confirming 260 Kestrel Crest Dr is yours. Would you ever consider selling it?', w.ledger, { questionKind: 'interest' }), [])
  assert.ok(propertyMentionReasons('Would you sell 18 Bramble Hollow Ln?', w.ledger, { questionKind: 'interest' }).includes('property:names_denied_property'))
})

test('v2 MUL-14: "X is my rental, I\'d sell that one. Y is where I live, not selling" — S3 on X, never a nurture on X', () => {
  const props = [{ property_id: 'pR', address: '903 Saddle Brook Rd' }, { property_id: 'pH', address: '41 Linden Shade Ct' }]
  const thread = [out('o1', 'Hi, Greg here. Do you own 903 Saddle Brook Rd and 41 Linden Shade Ct?', 30, 'pR'), inb('i1', "Saddle Brook is my rental, I'd sell that one. Linden Shade is where I live, not selling my home", 2, 'pR')]
  const w = world(thread, props)
  const t = mixedAnswerTarget(w.ledger.property.ownership)
  assert.deepEqual([t.property, t.objective, t.not_interested], ['pR', 'asking_price', ['pH']])
  const reply = w.plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.deepEqual([reply?.objective, reply?.target_property], ['asking_price', 'pR'])
  assert.ok(!w.plan.actions.some((a) => a.type === ACTIONS.SCHEDULE_FOLLOWUP), 'no nurture on the property they want to sell')
})

test('v2 MUL-03: "44 X is mine. Y was my aunt\'s" — the denial goes on Y (the denying clause), never on the confirmed X', async () => {
  const idx = propertyAddressIndex({ properties: [{ property_id: 'pX', address: '44 Larch Knoll Rd' }, { property_id: 'pY', address: '7 Copper Mill Rd' }] })
  assert.deepEqual(clauseFacts("Sorry I was confused last week. 44 Larch Knoll is mine. Copper Mill was my aunt's", idx).map((c) => [c.property, c.ownership]), [['pX', 'confirmed'], ['pY', 'denied']])
  const rows = new Map()
  const sb = {
    from(table) {
      if (table === 'message_events') return { select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [
        { id: 'o1', direction: 'outbound', message_body: 'Do you own 44 Larch Knoll Rd?', property_id: 'pX', created_at: T(60) },
        { id: 'o2', direction: 'outbound', message_body: 'And 7 Copper Mill Rd?', property_id: 'pY', created_at: T(50) },
        { id: 'm1', direction: 'inbound', message_body: "Sorry I was confused last week. 44 Larch Knoll is mine. Copper Mill was my aunt's", property_id: 'pX', created_at: T(1) },
      ], error: null }) }) }) }) }
      if (table === 'contact_property_resolution') return { upsert: (row) => ({ select: () => ({ maybeSingle: async () => { rows.set(row.property_id, row); return { data: { id: 'r1', ...row }, error: null } } }) }), select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }) }
      return { select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }) }
    },
  }
  const r = await runContactResolutionPhase({ supabaseClient: sb, property_id: 'pX', inbound_from: '+16125550190', relationship: { relationship_outcome: 'property_specific_non_owner' }, source_message_id: 'm1', source_thread_key: '+16125550190' })
  assert.equal(r.property_id, 'pY', JSON.stringify(r))
  assert.deepEqual([...rows.keys()], ['pY'])
})

test('v2 MUL-08/13: in a multi-property thread, a stage question about an UNCONFIRMED property becomes the ownership question for it', () => {
  const po = { by_property: { pA: { state: 'confirmed' }, pB: { state: 'unknown' } }, inbound: { property: 'pB' } }
  assert.deepEqual(perPropertyObjective(po, 'interest'), { property: 'pB', objective: 'ownership' })
  assert.equal(perPropertyObjective({ ...po, inbound: { property: 'pA' } }, 'interest'), null, 'a confirmed property continues')
  assert.equal(perPropertyObjective({ by_property: { pA: { state: 'unknown' } }, inbound: { property: 'pA' } }, 'interest'), null, 'single-property threads unchanged')
})

// rc-8.5.21 v4 fix pass — ownership / multi-property defects, written from the evaluator's DESCRIPTIONS
// (new phrasings and addresses; the v4 case files were never opened):
//   1. a seller who wants OUT of the house ("I want to get out of that house") was recorded as an
//      ownership DENIAL — it is a reason to sell (interest);
//   2. "wrong person for <one property>, this is my number for <another>" marked the WHOLE phone invalid —
//      a property denial is never global;
//   3. a later question about the OTHER property ("is this about the house on <street>?") was attributed to
//      the property just denied and closed with no reply;
//   4. the forward view migration + the duplicate-scan note for 20261010120000.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classify, expressesDesireToDispose } from '../../src/lib/domain/classification/classify.js'
import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput, mixedAnswerTarget } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { attributeInbounds, clauseFacts, propertiesNamedIn, propertyAddressIndex } from '../../src/lib/domain/conversation-ai/property-facts.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { inboundReplyPropertyId } from '../../src/lib/ai/conversation-canonical-inputs.js'
import { ALLOWLIST } from '../../../../scripts/db/scan-duplicate-migration-versions.mjs'
import { MIGRATION_TESTS } from '../../../../scripts/db/migration-tests.manifest.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const H = (t) => classify(t, null, { heuristicOnly: true })
const DENIAL_INTENTS = new Set(['property_specific_non_owner', 'wrong_number', 'sold_property', 'former_owner_respondent'])

// ── 1. wanting OUT of a property is interest, never a denial ────────────────────────────────────────────
test('v4 ownership: a desire to leave / get rid of / sell the property (EN + ES, every frame) is seller interest, never an ownership denial', async () => {
  const forms = [
    // Spanish: desire / need / obligation + leave / dispose / sell (+ clitics), with "ya no" / "no aguanto" around it
    'Ya no aguanto esa casa, necesito salirme de ahí y venderla',
    'No puedo más, quisiera deshacerme de esa casa pronto',
    'Tenemos que irnos de esa casa, ya no la soportamos',
    'Me urge vender esa casa, ya no quiero saber nada de ella',
    'Ojalá pudiera librarme de esa casa este mes',
    'Queremos mudarnos de esa casa antes de diciembre',
    // English
    'Honestly I need to get out of that place, it has been a nightmare',
    'We just want to get rid of the rental',
    "I'm so done with this house, make it easy",
    'Trying to unload the duplex before winter',
    'Gotta move out of that home asap',
    "We're sick of it with that property, tired of tenants",
  ]
  for (const t of forms) {
    const r = await H(t)
    assert.ok(!DENIAL_INTENTS.has(r.primary_intent), `${t}: ${r.primary_intent}`)
    assert.notEqual(r.automation_decision?.suppression_action, 'archive_wrong_number', t)
  }
  for (const t of ['Ya no aguanto, necesito salirme de esa casa', 'I need to get out of that house', 'quiero deshacerme de esa casa']) {
    assert.equal(expressesDesireToDispose(t), true, t)
    assert.equal((await H(t)).primary_intent, 'seller_interested', t)
  }
  // the ledger never records 'denied' for it
  const input = { now: '2026-10-20T16:00:00Z', inbound: { id: 'i1', body: 'Ya no aguanto, necesito salirme de esa casa', at: '2026-10-20T15:59:00Z', property_id: 'p1', intent: 'seller_interested' }, thread: [{ id: 'o1', direction: 'outbound', body: '¿Es usted el dueño de 14 Calle Robles?', at: '2026-10-20T15:00:00Z', property_id: 'p1' }], properties: [{ property_id: 'p1', address: '14 Calle Robles' }] }
  const ledger = ledgerFromContextInput(input, { now: input.now })
  assert.notEqual(ledger.facts.ownership?.value, 'denied')
})

test('v4 ownership negatives: real denials stay denials; a negated desire is not interest; "esa casa es mía" confirms', async () => {
  for (const t of ['Esa casa no es mía', 'Nunca fue mía esa casa', 'No, esa casa ya la vendí', "That's not my house", "I don't own that property", 'Sold it years ago']) {
    assert.ok(DENIAL_INTENTS.has((await H(t)).primary_intent), t)
  }
  for (const t of ["I don't want to get rid of it", 'We never wanted to get out of that house', 'No quiero vender esa casa']) {
    assert.equal(expressesDesireToDispose(t), false, t)
  }
  const mine = await H('Esa casa es mía')
  assert.ok(!DENIAL_INTENTS.has(mine.primary_intent), `"Esa casa es mía" is never a denial (${mine.primary_intent})`)
})

// ── 2. a property denial is never global ────────────────────────────────────────────────────────────────
test('v4 multi-property: "wrong person for <property>" is a PROPERTY denial (never archive_wrong_number), with or without a claim of another property', async () => {
  const scoped = [
    'wrong person for the Hawthorne Ave house, but this is my number for the Birch one',
    'Wrong guy for 77 Calloway. That number is right for the other one though',
    'you have the wrong owner for that property on Delmar Blvd',
    'wrong lady for the lake house, I own the one on Cedar',
  ]
  for (const t of scoped) {
    const r = await H(t)
    assert.equal(r.primary_intent, 'property_specific_non_owner', `${t}: ${r.primary_intent}`)
    assert.notEqual(r.automation_decision?.suppression_action, 'archive_wrong_number', t)
  }
  // phone-identity statements stay contact-wide
  for (const t of ['wrong number', 'You have the wrong person', 'wrong person for this number', 'Wrong guy for the Garnet St one. wrong number anyway, lose it']) {
    const r = await H(t)
    assert.equal(r.primary_intent === 'wrong_number' || r.primary_intent === 'opt_out', true, `${t}: ${r.primary_intent}`)
  }
})

test('v4 multi-property: the clause reader splits "wrong person for A … my number for B" (A denied, B confirmed) and the conversation continues on B', () => {
  const properties = [{ property_id: 'pA', address: '4410 Hawthorne Ave' }, { property_id: 'pB', address: '28 Ash St' }]
  const idx = propertyAddressIndex({ properties })
  const c = clauseFacts('wrong person for the hawthorne ave house but this is my number for the ash one', idx)
  assert.deepEqual(c.map((x) => [x.property, x.ownership]), [['pA', 'denied'], ['pB', 'confirmed']])
  const T = (m) => new Date(Date.parse('2026-10-20T16:00:00Z') - m * 60_000).toISOString()
  const thread = [{ id: 'o1', direction: 'outbound', body: 'Hi, do you still own 4410 Hawthorne Ave and 28 Ash St?', at: T(30), property_id: 'pA' }]
  const inbound = { id: 'i1', body: 'wrong person for the hawthorne ave house but this is my number for the ash one', at: T(1), property_id: 'pA' }
  const input = { now: T(0), inbound, thread, properties, language: 'English' }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const t = mixedAnswerTarget(ledger.property.ownership)
  assert.equal(t?.property, 'pB', JSON.stringify(ledger.property.ownership.inbound))
  const plan = decideActions({ ledger, inboundText: inbound.body, inboundId: 'i1', eligibility: { blocked: false }, language: 'English', propertyCount: 2, thread, inbound, deterministic: { intent: 'property_specific_non_owner' } })
  const reply = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.equal(reply?.target_property, 'pB', JSON.stringify(plan))
})

// ── 3. a question about the OTHER property is about that property ───────────────────────────────────────
test('v4 attribution: a short street name inside a property phrase names that property ("the house on Elm", "the Ash one"); a bare word never does', () => {
  const properties = [{ property_id: 'p1', address: '903 Juniper Rd' }, { property_id: 'p2', address: '22 Elm Ct' }]
  const idx = propertyAddressIndex({ properties })
  for (const t of ['hey is this about the house on Elm?', 'the elm one is mine', 'what about Elm house', 'is that at Elm?']) assert.deepEqual(propertiesNamedIn(t, idx), ['p2'], t)
  for (const t of ['I like elm trees', 'elm']) assert.deepEqual(propertiesNamedIn(t, idx), [], t)
})

test('v4 rt-pl-05: a question about the OTHER property after a denial of the first is attributed to the other property, judged for it, and gets its S1 question (never the denied property\'s closure)', () => {
  const T = (m) => new Date(Date.parse('2026-10-20T16:00:00Z') - m * 60_000).toISOString()
  const properties = [{ property_id: 'p1', address: '903 Juniper Rd' }, { property_id: 'p2', address: '22 Elm Ct' }]
  const thread = [
    { id: 'o1', direction: 'outbound', body: 'Hi Dana, do you still own 903 Juniper Rd?', at: T(40), property_id: 'p1' },
    { id: 'i1', direction: 'inbound', body: 'No', at: T(20), property_id: 'p1' },
  ]
  const inbound = { id: 'i2', body: 'hey is this about the house on Elm?', at: T(10), property_id: 'p1' }
  const att = attributeInbounds({ messages: [...thread, { ...inbound, direction: 'inbound' }], properties, questionKindOf })
  assert.equal(att.get('i1').property, 'p1', 'the bare No answers the Juniper question')
  assert.equal(att.get('i2').property, 'p2', 'the Elm question is about Elm')
  const input = { now: T(0), inbound, thread, properties, language: 'English' }
  // the canonical inputs judge the reply's eligibility for the property the inbound is ABOUT
  assert.equal(inboundReplyPropertyId(input, 'p1'), 'p2')
  assert.equal(inboundReplyPropertyId({ ...input, inbound: { ...inbound, body: 'what do you mean?' } }, 'p1'), 'p1', 'no property named ⇒ the row property')
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const plan = decideActions({ ledger, inboundText: inbound.body, inboundId: 'i2', eligibility: { blocked: false }, language: 'English', propertyCount: 2, thread, inbound })
  const term = plan.actions.find((a) => [ACTIONS.NO_RESPONSE, ACTIONS.AI_GENERATED_REPLY, ACTIONS.HOLD, ACTIONS.ESCALATE_TO_OPERATOR].includes(a.type))
  assert.notEqual(term?.type, ACTIONS.NO_RESPONSE, JSON.stringify(plan))
  assert.equal(term?.type, ACTIONS.AI_GENERATED_REPLY, JSON.stringify(plan))
  assert.deepEqual([term.objective, term.target_property], ['ownership', 'p2'])
  // a STOP in the same message still wins (the deterministic pre-check runs first)
  const stop = decideActions({ ledger, inboundText: 'is this about Elm? stop texting me', inboundId: 'i2', eligibility: { blocked: false }, language: 'English', propertyCount: 2, thread, inbound })
  assert.ok(stop.actions.some((a) => a.type === ACTIONS.SUPPRESS), JSON.stringify(stop))
})

// ── 4. migration bookkeeping ────────────────────────────────────────────────────────────────────────────
test('v4 migrations: 20261010120000 inbox_price_gap_gate is recorded APPLIED with its body drift; the forward view migration carries the 10-17 mapping under a NEW stamp and never re-applies 20261010120000', () => {
  const note = ALLOWLIST['20261010120000']
  assert.match(note, /inbox_price_gap_gate: APPLIED \(owner apply\.sh, 2026-10-12; body drift/)
  assert.match(note, /31f405e3/)
  assert.match(note, /PROPOSED_20261020120500_inbox_bucket_views_declined_unverified/)
  assert.ok(!/PROBABLY APPLIED/.test(note))
  const fwd = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020120500_inbox_bucket_views_declined_unverified.sql'), 'utf8')
  const rb = fs.readFileSync(path.join(REPO, 'supabase/migrations/PROPOSED_20261020120500_inbox_bucket_views_declined_unverified_rollback.sql'), 'utf8')
  const code = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.match(code(fwd), /'sold','unqualified','declined_unverified'/)
  assert.match(code(fwd), /'ownership_declined_unverified'/)
  assert.ok(!/declined_unverified/.test(code(rb)), 'the rollback is the production 10-10 body')
  assert.ok(!/20261010120000/.test(code(fwd)), 'the forward migration never applies / includes the old stamp')
  const entry = MIGRATION_TESTS.find((m) => m.id === 'inbox_bucket_views_declined_unverified')
  assert.ok(entry && !entry.requires, 'part of run-migration-test --all')
  assert.ok(!JSON.stringify(entry).includes('PROPOSED_20261010120000_inbox_price_gap_gate'), 'the old file is never applied by the test either')
})

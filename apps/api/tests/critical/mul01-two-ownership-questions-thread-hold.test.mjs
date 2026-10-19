// blind-eval v2 MUL-01 (safety; owner rule 2026-10-17), written from the description: we asked about
// TWO properties ("Are you the owner of <A>?", then "Do you also own <B>?") and the seller answered
// one bare "No". It says nothing about which property: a THREAD HOLD (ownership_denial_property_unresolved),
// RECORDED in the hold authority, so no layer plans a nurture, writes a denial or sends a close.
import test from 'node:test'
import assert from 'node:assert/strict'

import { memoryDb, runSellerTurn } from '../helpers/seller-autopilot-v2-harness.mjs'
import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { matchAutomationHolds } from '../../src/lib/domain/holds/automation-hold.js'

const THREAD = '+16125550177'
const T0 = Date.parse('2026-10-18T15:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function world() {
  const db = memoryDb({})
  db.tables.message_events = [
    { id: 'o1', thread_key: THREAD, direction: 'outbound', created_at: iso(T0 - 40 * 60_000), event_timestamp: iso(T0 - 40 * 60_000), property_id: 'pA', message_body: 'Hi Lena, this is Helen. Are you the owner of 77 Larkspur Way?' },
    { id: 'o2', thread_key: THREAD, direction: 'outbound', created_at: iso(T0 - 20 * 60_000), event_timestamp: iso(T0 - 20 * 60_000), property_id: 'pB', message_body: 'Hi Lena, Helen again. Do you also own 512 Foundry Rd?' },
  ]
  db.tables.send_queue = [
    { id: 'q1', to_phone_number: THREAD, thread_key: THREAD, message_type: 'ownership_check', message_body: 'Hi Lena, this is Helen. Are you the owner of 77 Larkspur Way?', provider_message_id: 'SM1', sent_at: iso(T0 - 40 * 60_000), delivered_at: iso(T0 - 40 * 60_000), queue_status: 'delivered', type: 'campaign', created_at: iso(T0 - 40 * 60_000), property_id: 'pA' },
    { id: 'q2', to_phone_number: THREAD, thread_key: THREAD, message_type: 'ownership_check', message_body: 'Hi Lena, Helen again. Do you also own 512 Foundry Rd?', provider_message_id: 'SM2', sent_at: iso(T0 - 20 * 60_000), delivered_at: iso(T0 - 20 * 60_000), queue_status: 'delivered', type: 'campaign', created_at: iso(T0 - 20 * 60_000), property_id: 'pB' },
  ]
  return db
}

test('MUL-01: "Do you also own <B>?" is an ownership question (the open-question set holds BOTH properties)', () => {
  assert.equal(questionKindOf({ body: 'Hi Lena, Helen again. Do you also own 512 Foundry Rd?' }), 'ownership')
})

test('MUL-01 inbound path: a bare "No" to two ownership questions RECORDS a thread hold; zero follow-ups, zero queue rows, no denial on the latest property', async () => {
  for (const reply of ['No', 'Nope', 'No thanks']) {
    const db = world()
    const r = await runSellerTurn({ db, thread: THREAD, message: reply, receivedAt: iso(T0), propertyId: 'pB', stageBefore: 'ownership_check' })
    const holds = (db.tables.automation_holds || []).filter((h) => h.thread_key === THREAD && !h.released_at)
    assert.equal(holds.length, 1, `${reply}: one recorded thread hold`)
    assert.equal(holds[0].reason, 'ownership_denial_property_unresolved')
    assert.ok(holds[0].blocked_capabilities.includes('follow_up') && holds[0].blocked_capabilities.includes('auto_reply'))
    assert.ok(!holds[0].blocked_capabilities.includes('manual_send'), 'an operator can still resolve it')
    assert.deepEqual(r.followups, [], `${reply}: no nurture / follow-up planned`)
    assert.equal(r.inserts.length, 0, `${reply}: no close message`)
    assert.equal((db.tables.contact_property_resolution || []).length, 0, `${reply}: no denial written to any property`)
    // the hold authority covers every automated capability of the thread
    for (const capability of ['follow_up', 'auto_reply', 'ai_action', 'campaign']) {
      const m = matchAutomationHolds(holds, { thread_key: THREAD, property_id: 'pB' }, capability)
      assert.ok(m.length > 0, `${capability} held`)
    }
  }
})

test('MUL-01: one answer to ONE open ownership question is NOT held (single property, unchanged)', async () => {
  const db = world()
  db.tables.message_events = db.tables.message_events.slice(1)
  await runSellerTurn({ db, thread: THREAD, message: 'No', receivedAt: iso(T0), propertyId: 'pB', stageBefore: 'ownership_check' })
  assert.equal((db.tables.automation_holds || []).length, 0)
})

test('MUL-01 AI layer: the canonical decision is the same thread HOLD (never a not_interested close or a nurture)', () => {
  const thread = [
    { id: 'o1', direction: 'outbound', body: 'Hi Lena, this is Helen. Are you the owner of 77 Larkspur Way?', at: iso(T0 - 40 * 60_000), property_id: 'pA' },
    { id: 'o2', direction: 'outbound', body: 'Hi Lena, Helen again. Do you also own 512 Foundry Rd?', at: iso(T0 - 20 * 60_000), property_id: 'pB' },
  ]
  const input = { now: iso(T0), inbound: { id: 'i1', body: 'No', at: iso(T0), property_id: 'pB' }, thread, properties: [{ property_id: 'pA', address: '77 Larkspur Way' }, { property_id: 'pB', address: '512 Foundry Rd' }] }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: iso(T0) }), input)
  const plan = decideActions({ ledger, inboundText: 'No', inboundId: 'i1', eligibility: { blocked: false }, judgment: { intent: 'not_interested', confidence: 0.95, outcome: 'REPLY_CANDIDATE' }, language: 'en', propertyCount: 2, thread, inbound: input.inbound })
  assert.deepEqual(plan.actions.map((a) => [a.type, a.reason ?? null]), [[ACTIONS.HOLD, 'ownership_denial_property_unresolved']])
  assert.ok(!plan.actions.some((a) => a.type === ACTIONS.SCHEDULE_FOLLOWUP))
})

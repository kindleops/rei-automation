// agntei ↔ LeadCommand synchronization hardening (the agntei side lives in agntau packages/engine: acquisitions-sync and
// comms-canonical tests). LeadCommand's two changes:
//   1. A number newly suppressed (the one writer, record-phone-suppression.js) is an opt_out event on the agents' feed,
//      source "suppression": an agent holding that lead loses its sending authority at once. Codes only — the phone
//      seals into the thread ref and is never in the event id or payload; the feed never blocks the suppression.
//   2. G10: a queued agent text is cancelled at dispatch when anyone else texted the seller since it was written (a
//      person's manual send from the inbox, another path): one voice at a time. Unreadable → defer (fail closed).
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { recordPhoneSuppression } from '../../src/lib/domain/compliance/record-phone-suppression.js'
import { evaluateAgentTextRowGate } from '../../src/lib/domain/queue/agent-text-row-gate.js'
import { buildAgentTextMessage, sha256Hex } from '../../src/lib/domain/messages/ai-generated-message.js'

const PHONE = '+18133409070'
const writeClient = ({ fail = false, fallbackError = null } = {}) => ({
  from() {
    return {
      upsert() { return { select: () => ({ maybeSingle: async () => (fail ? { data: null, error: { message: 'fetch failed' } } : { data: { id: 's1' }, error: null }) }) } },
      insert() { return { select: () => ({ maybeSingle: async () => ({ data: fallbackError ? null : { id: 'a1' }, error: fallbackError }) }) } },
    }
  },
})

test('a recorded suppression is an opt_out event on the agents\' feed (codes only, never the phone)', async () => {
  const events = []
  const r = await recordPhoneSuppression({ supabase: writeClient(), phone: '8133409070', reason: 'manual_dnc', source: 'discord_suppress', sourceEventId: 'msg-42', threadKey: PHONE }, { sleep: async () => {}, appendLeadEvent: async (_s, e) => { events.push(e); return { ok: true } }, now: '2026-10-30T15:00:00.000Z' })
  assert.equal(r.ok, true)
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.kind, 'opt_out'); assert.equal(e.threadKey, PHONE)
  assert.deepEqual(e.payload, { source: 'suppression', reason: 'manual_dnc', recorded_by: 'discord_suppress' })
  assert.equal(e.eventKey, `suppression:msg-42:${Date.parse('2026-10-30T15:00:00.000Z')}`)
  assert.ok(!/8133409070/.test(JSON.stringify({ k: e.eventKey, p: e.payload })), 'never the phone in the event id or payload')
})

test('the fail-closed fallback block is announced too; a failing feed never fails the suppression', async () => {
  const events = []
  const r = await recordPhoneSuppression({ supabase: writeClient({ fail: true }), phone: PHONE, threadKey: PHONE }, { sleep: async () => {}, alert: async () => ({ ok: true }), appendLeadEvent: async (_s, e) => { events.push(e); return { ok: true } } })
  assert.equal(r.fail_closed, true); assert.equal(r.fallback_block, true)
  assert.equal(events.length, 1, 'the number is blocked (fallback): agents hear it')
  const ok = await recordPhoneSuppression({ supabase: writeClient(), phone: PHONE }, { sleep: async () => {}, appendLeadEvent: async () => { throw new Error('feed down') } })
  assert.equal(ok.ok, true, 'the feed never blocks or fails the suppression')
  const none = []
  await recordPhoneSuppression({ supabase: writeClient({ fail: true }), phone: PHONE }, { sleep: async () => {}, alert: async () => ({ ok: true }), appendLeadEvent: async (_s, e) => { none.push(e) } })
  assert.equal(none.length, 1)
  const failedBoth = []
  await recordPhoneSuppression({ supabase: writeClient({ fail: true, fallbackError: { message: 'down' } }), phone: PHONE }, { sleep: async () => {}, alert: async () => ({ ok: true }), appendLeadEvent: async (_s, e) => { failedBoth.push(e) } })
  assert.equal(failedBoth.length, 0, 'nothing announced when nothing was recorded (the critical alert covers it)')
})

const INTENT = '3c1f8a2e-5b6d-4e7f-9a0b-1c2d3e4f5a6b'
const generatedAt = '2026-10-29T16:55:00.000Z'
function agentRow(body = 'Hi Dana, this is Nova with Reivesti. What are your plans for the house these days?') {
  const rec = { id: 'rec-1', ...buildAgentTextMessage({ intentId: INTENT, purpose: 'followup', body, inReplyTo: null, attribution: { employee: 'nova', route: 'agntei.acq' }, threadKey: PHONE, recipientPhone: PHONE, senderPhone: '+13125550199',
    decisionId: `action_gateway:${INTENT}`, contextVersion: 'agent-text.v1', validation: { status: 'validated' }, ledgerSnapshot: {}, policy: {}, generatedAt }) }
  const row = { id: 'q1', queue_key: `agent_text:${INTENT}`, message_body: body, to_phone_number: PHONE, thread_key: PHONE, message_origin: 'ai_generated', source: 'ai_conversation', created_at: generatedAt,
    metadata: { agent_text_intent_id: INTENT, agent_id: 'agt_nova', source: 'ai_conversation', message_origin: 'ai_generated', ai_message_id: 'rec-1', ai_message_body_sha256: sha256Hex(body), recipient_zones: ['America/Chicago'],
      agent_text: { purpose: 'followup', generated_at: generatedAt, in_reply_to_message_id: null, inbound_received_at: null } } }
  return { rec, row }
}
const gate = (o = {}) => { const { rec, row } = agentRow(); return evaluateAgentTextRowGate(row, { now: '2026-10-29T17:00:00.000Z', readActivation: async () => ({ available: true }), loadRecord: async () => ({ record: rec }), readHolder: async () => ({ agent_id: 'agt_nova' }), loadInbounds: async () => ({ rows: [] }), automationHoldChecker: async () => ({ held: false }), ...o }) }

test('G10: a person texted the seller after the agent wrote its text: the queued agent text is cancelled', async () => {
  let asked = null
  assert.equal((await gate({ loadOutbounds: async (k, since) => { asked = [k, since]; return { rows: [] } } })).action, 'proceed')
  assert.deepEqual(asked, [PHONE, generatedAt], 'since the agent wrote it')
  assert.deepEqual(await gate({ loadOutbounds: async () => ({ rows: [{ id: 'manual-1', created_at: '2026-10-29T16:58:00.000Z' }] }) }), { applies: true, action: 'cancel', reason: 'agent_text_stale_new_outbound' })
  assert.deepEqual(await gate({ loadOutbounds: async () => ({ read_failed: true, rows: [] }) }), { applies: true, action: 'defer', reason: 'agent_text_latest_outbound_unreadable' })
})

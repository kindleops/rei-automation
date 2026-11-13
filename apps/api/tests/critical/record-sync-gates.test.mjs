// Link 10: an archived lead (sold, unavailable, duplicate, dead — archived in agntei or LeadCommand) is out of active
// work. The agent-text dispatch gate re-reads the lead's archive state just before sending: archived → cancelled (nothing
// is sent), unreadable → deferred (fail closed), not archived → the gate goes on as before. A gate wired without the read
// (older callers) behaves exactly as before.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateAgentTextRowGate } from '../../src/lib/domain/queue/agent-text-row-gate.js'
import { buildAgentTextMessage, sha256Hex } from '../../src/lib/domain/messages/ai-generated-message.js'

const PHONE = '+18133409070'
const INTENT = '3c1f8a2e-5b6d-4e7f-9a0b-1c2d3e4f5a6b'
const generatedAt = new Date(Date.now() - 60_000).toISOString()
const body = 'Hi Dana, this is Nova with Reivesti. What are your plans for the house these days?'
const rec = { id: 'rec-1', ...buildAgentTextMessage({ intentId: INTENT, purpose: 'followup', body, inReplyTo: null, attribution: { employee: 'nova', route: 'agntei.acq' }, threadKey: PHONE, recipientPhone: PHONE, senderPhone: '+13125550199',
  decisionId: `action_gateway:${INTENT}`, contextVersion: 'agent-text.v1', validation: { status: 'validated' }, ledgerSnapshot: {}, policy: {}, generatedAt }) }
const row = { id: 'q1', queue_key: `agent_text:${INTENT}`, message_body: body, to_phone_number: PHONE, thread_key: PHONE, message_origin: 'ai_generated', source: 'ai_conversation', created_at: generatedAt,
  metadata: { agent_text_intent_id: INTENT, agent_id: 'agt_nova', source: 'ai_conversation', message_origin: 'ai_generated', ai_message_id: 'rec-1', ai_message_body_sha256: sha256Hex(body), recipient_zones: ['UTC'],
    agent_text: { purpose: 'followup', generated_at: generatedAt, in_reply_to_message_id: null, inbound_received_at: null } } }
const deps = (extra = {}) => ({ readActivation: async () => ({ available: true }), loadRecord: async () => ({ record: rec }), readHolder: async () => ({ agent_id: 'agt_nova' }),
  loadInbounds: async () => ({ rows: [] }), loadOutbounds: async () => ({ rows: [] }), automationHoldChecker: async () => ({ held: false }), ...extra })

test('link 10: an archived lead gets no agent text — cancelled at dispatch; an unreadable archive state defers', async () => {
  const archived = await evaluateAgentTextRowGate(row, deps({ readLeadArchive: async () => ({ archived: true }) }))
  assert.deepEqual([archived.action, archived.reason], ['cancel', 'agent_text_lead_archived'])
  const unreadable = await evaluateAgentTextRowGate(row, deps({ readLeadArchive: async () => { throw new Error('down') } }))
  assert.deepEqual([unreadable.action, unreadable.reason], ['defer', 'agent_text_lead_archive_unreadable'])
  const open = await evaluateAgentTextRowGate(row, deps({ readLeadArchive: async () => ({ archived: false }) }))
  assert.notEqual(open.reason, 'agent_text_lead_archived')
  const legacy = await evaluateAgentTextRowGate(row, deps())
  assert.equal(legacy.action, open.action, 'a gate wired without the read behaves exactly as before')
})

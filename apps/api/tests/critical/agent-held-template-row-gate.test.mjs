// One voice on an agent-held lead: an automated template row for a lead an Agntei employee holds is cancelled; a manual
// send, the AI rows and every row of an unheld lead are untouched; an unreadable holder defers (independent review 2026-10-30).
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAgentHeldTemplateRowGate } from '../../src/lib/domain/queue/agent-held-template-row-gate.js'

const held = async () => ({ agent_id: 'agt_nova' })
const free = async () => ({ agent_id: null })
const row = (o = {}) => ({ id: 'q1', thread_key: '+13125550161', message_origin: 'template', metadata: {}, ...o })

test('a template row on an agent-held lead is cancelled; nothing else changes', async () => {
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row(), { readHolder: held }), { applies: true, action: 'cancel', reason: 'template_row_lead_held_by_agent' })
  assert.equal((await evaluateAgentHeldTemplateRowGate(row({ message_origin: null }), { readHolder: held })).action, 'cancel', 'an unlabelled automated row is a template row')
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row(), { readHolder: free }), { applies: false })
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row({ message_origin: 'operator_manual' }), { readHolder: held }), { applies: false }, 'a person\'s manual send passes')
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row({ message_origin: 'ai_generated' }), { readHolder: held }), { applies: false }, 'AI rows have their own gates')
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row({ metadata: { agent_text_intent_id: 'i1' } }), { readHolder: held }), { applies: false }, 'the agent\'s own text')
  assert.deepEqual(await evaluateAgentHeldTemplateRowGate(row(), { readHolder: async () => ({ agent_id: null, link_absent: true }) }), { applies: false }, 'without link #32 nobody holds a lead')
  assert.equal((await evaluateAgentHeldTemplateRowGate(row(), { readHolder: async () => ({ read_failed: true }) })).action, 'defer')
  assert.equal((await evaluateAgentHeldTemplateRowGate(row(), { readHolder: async () => { throw new Error('x') } })).action, 'defer')
})

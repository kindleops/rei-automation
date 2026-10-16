// rc-8.5.20 review item (e): the escalation policy merged in understand.js (8.5.15 + 8.5.16) is
// KEPT and documented there; these tests pin both the REPAIR path and the HOLD paths.
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { understandInbound } from '../../src/lib/domain/conversation-ai/understand.js'
import { buildConversationContext } from '../../src/lib/domain/conversation-ai/context-builder.js'
import { createConversationModelClient, createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'

const PHONE = '+15555550123'
const NOW = '2026-10-13T17:00:00.000Z'
const OPEN = { blocked: false, reasons: [], outside_window: false }
const msg = (id, direction, body, at, extra = {}) => ({ id, direction, body, at, thread_key: 'thr_test', seller_phone: PHONE, ...extra })
function ctxFor(body, thread = []) {
  const inbound = { id: 'in-1', body, at: '2026-10-13T16:58:00.000Z', thread_key: 'thr_test', from_phone: PHONE, property_id: 'p1' }
  return buildConversationContext({ now: NOW, inbound, thread: [...thread, msg('in-1', 'inbound', body, inbound.at)], properties: [{ property_id: 'p1', property_type: 'SFR', city: 'Dallas', state: 'TX' }], offers: [], followups: [], names: { full_names: [], first_name: 'Jane' }, eligibility: OPEN })
}
const S2 = [msg('o1', 'outbound', 'Hi Jane, do you still own 12 Elm St?', '2026-10-12T15:00:00.000Z', { use_case: 'ownership_check' }), msg('i0', 'inbound', 'Yes I do', '2026-10-12T15:05:00.000Z', { intent: 'ownership_confirmed' })]
const candidate = (over = {}) => makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'Thanks. Would you consider selling it?', confidence: 0.92, source_message_ids: ['in-1'], stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['in-1'], rationale: 'x' }, ...over })
function client(respond) {
  const calls = []
  const provider = {
    calls,
    async listModels() { return [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' }] },
    async createMessage(params) { calls.push(params); const out = respond(params, calls.length); return { content: [{ type: 'tool_use', name: params.tools[0].name, input: out }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 } } },
  }
  return { calls, mc: createConversationModelClient({ provider, tracker: createSpendTracker({ capUsd: 1 }), env: {} }) }
}
const run = (text, mc, thread = S2) => understandInbound({ context: ctxFor(text, thread), inboundText: text, inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })

test('REPAIR: an invalid Haiku answer gets one Haiku repair that sees its errors; a valid repair continues (no Sonnet)', async () => {
  const { calls, mc } = client((p, n) => (n === 1 ? { intent: 'nonsense' } : candidate()))
  const r = await run('yes I still own it', mc)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => /haiku/.test(c.model)), 'never Sonnet for a repair')
  assert.match(JSON.stringify(calls[1].messages), /FAILED VALIDATION/)
  assert.deepEqual(r.trace.repair, { attempted: true, ok: true })
  assert.equal(r.trace.path, 'haiku(retry)')
  assert.equal(r.decision.outcome, 'REPLY_CANDIDATE')
})

test('REPAIR: a repair that also fails closes to NEEDS_REVIEW with no draft (no Sonnet)', async () => {
  const { calls, mc } = client(() => ({ intent: 'nonsense' }))
  const r = await run('yes I still own it', mc)
  assert.equal(calls.length, 2)
  assert.deepEqual([r.decision.outcome, r.decision.proposed_message, r.trace.path], ['NEEDS_REVIEW', null, 'haiku(invalid)'])
})

test('HOLD: a reply candidate on a human-bound turn (financing / multiple owners) loses its draft and names the reason; no Sonnet', async () => {
  for (const [text, reason] of [['would you do owner financing on it?', 'financing'], ['my brother and I own it together', 'multiple_owners']]) {
    const { calls, mc } = client(() => candidate())
    const r = await run(text, mc)
    assert.equal(calls.length, 1, text)
    assert.deepEqual([r.decision.outcome, r.decision.proposed_message, r.decision.escalation_required, r.decision.escalation_reason], ['NEEDS_REVIEW', null, true, reason], text)
    assert.equal(r.trace.escalation_skipped, 'human_bound', text)
  }
})

test('HOLD: an offer request / a non-English inbound is never sent to Sonnet (the pipeline routes it: NegotiationAuthority / operator)', async () => {
  for (const text of ["what's your offer?", 'hola, si es mia']) {
    const { calls, mc } = client(() => candidate({ escalation_required: true, escalation_reason: 'low_confidence' }))
    const r = await run(text, mc)
    assert.equal(calls.length, 1, text)
    assert.equal(r.trace.escalation_skipped, 'human_bound', text)
  }
})

test('HOLD: two far-apart seller prices are a deterministic contradiction hold; a Haiku ESCALATE without a candidate is a human item', async () => {
  const priced = [...S2, msg('o2', 'outbound', 'What number makes sense for you?', '2026-10-12T15:11:00.000Z', { use_case: 'seller_asking_price' }), msg('i1', 'inbound', 'I want $100k', '2026-10-12T15:20:00.000Z')]
  const { calls, mc } = client(() => candidate())
  const r = await run('actually make it $300k', mc, priced)
  assert.equal(calls.length, 1)
  assert.deepEqual([r.decision.outcome, r.decision.escalation_reason, r.trace.escalation_skipped], ['NEEDS_REVIEW', 'contradiction', 'price_contradiction_hold'])
  const e = client(() => candidate({ outcome: 'ESCALATE_TO_SONNET', proposed_message: null, response_needed: false, escalation_required: true, escalation_reason: 'low_confidence' }))
  const r2 = await run('hmm', e.mc)
  assert.equal(e.calls.length, 1)
  assert.equal(r2.decision.outcome, 'NEEDS_REVIEW')
})

test('SONNET: only a candidate with a remaining reason on a turn that is not human-bound; Sonnet cannot keep a ledger contradiction', async () => {
  const { calls, mc } = client((p, n) => (n === 1 ? candidate({ escalation_required: true, escalation_reason: 'low_confidence' }) : candidate({ next_objective: 'confirm_ownership', proposed_message: 'Do you still own it?' })))
  const r = await run('yes I still own it', mc)
  assert.equal(calls.length, 2)
  assert.match(calls[1].model, /sonnet/)
  assert.equal(r.trace.path, 'haiku→sonnet')
  assert.equal(r.decision.outcome, 'NEEDS_REVIEW', 'asking a known ownership is a ledger contradiction ⇒ held')
})

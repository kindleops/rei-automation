// Action Gateway T3 / T4 — unit + static proofs (no database): R4 (the ceiling at the persistence layer, pure),
// D6 (envelope + send-authorization approvals are decidable through the ONE decide route, by a human only), the
// decide-only specs never reach the model tool list, and the LeadCommand execution module reaches R3 ONLY through
// the one dispatcher module.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateOfferCeiling, ceilingOverrideOf } from '../../src/lib/domain/seller-flow/seller-offer-authority.js'
import { createCapabilityPlane, FIRST_CAPABILITIES, DEFAULT_ORG_ID, capabilityToolDefs } from '../../src/lib/agent/capabilities/index.js'
import { DECIDE_ONLY_IDS, createDecisionRegistry } from '../../src/lib/agent/capabilities/decision-registry.js'
import { createMemoryCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createThreadRefCodec } from '../../src/lib/agent/capabilities/thread-ref.js'
import { handleApprovalDecide } from '../../src/lib/agent/actions/routes.js'
import { createEnvelopeApprovals, encodePropertyRef, ENVELOPE_CAPABILITY_ID } from '../../src/lib/domain/negotiation/envelope-approval.js'
import { SEND_AUTHORIZATION_CAPABILITY_ID } from '../../src/lib/domain/negotiation/send-authorization.js'
import { createMemoryNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { grantEnvelope } from '../../src/lib/domain/negotiation/negotiation-service.js'
import { scopeKey } from '../../src/lib/domain/negotiation/envelope.js'
import { importClosure } from '../helpers/import-graph.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')

test('R4 (pure): an outbound price needs an independent ceiling and must be ≤ the LOWEST; only a complete HUMAN override passes (Hartford $315K vs $126.1K)', () => {
  assert.deepEqual([evaluateOfferCeiling({ purchase_price: 315000, authorized_ceiling: 126100 }).ok, evaluateOfferCeiling({ purchase_price: 315000, authorized_ceiling: 126100 }).reason], [false, 'offer_above_authorized_ceiling'])
  assert.equal(evaluateOfferCeiling({ purchase_price: 100000 }).reason, 'offer_ceiling_missing')
  assert.equal(evaluateOfferCeiling({ purchase_price: 140000, authorized_ceiling: 200000, envelope_max_price: 150000, mao: 139999 }).reason, 'offer_above_authorized_ceiling')
  const ok = evaluateOfferCeiling({ purchase_price: 140000, authorized_ceiling: 200000, envelope_max_price: 150000 })
  assert.deepEqual([ok.ok, ok.ceiling], [true, 150000])
  for (const o of [{ operator_id: 'agt_alpha', reason: 'long enough reason', approval_ref: 'x' }, { operator_id: 'agent:x', reason: 'long enough reason', approval_ref: 'x' },
    { operator_id: 'u1', reason: 'short', approval_ref: 'x' }, { operator_id: 'u1', reason: 'long enough reason', approval_ref: '' }, { force: true }, true, null]) assert.equal(ceilingOverrideOf(o), null, JSON.stringify(o))
  const human = evaluateOfferCeiling({ purchase_price: 131000, authorized_ceiling: 126100, ceiling_override: { operator_id: 'u-1', reason: 'owner reviewed the comps', approval_ref: 'ticket-77' } })
  assert.deepEqual([human.ok, human.override.over_by, human.override.kind], [true, 4900, 'above_ceiling'])
})

test('D6: the decide-only specs (envelope grant, send authorization, gateway intent) are decidable, and NEVER in the model registry or tool list', () => {
  for (const id of [ENVELOPE_CAPABILITY_ID, SEND_AUTHORIZATION_CAPABILITY_ID, 'agent_actions.authorize_action']) {
    assert.ok(DECIDE_ONLY_IDS.includes(id), id)
    assert.ok(!FIRST_CAPABILITIES.some((c) => c.id === id), `${id} is not model-facing`)
  }
  const reg = createDecisionRegistry(FIRST_CAPABILITIES)
  for (const id of DECIDE_ONLY_IDS) assert.ok(reg.get(id), id)
  const plane = createCapabilityPlane({ env: {}, store: createMemoryCapabilityStore(), services: {}, secret: 'x'.repeat(32) })
  assert.ok(!capabilityToolDefs(plane.registry).some((t) => /negotiation|authorize_action/.test(t.name)))
})

test('D6 through the ONE decide route (POST /api/cockpit/agent/actions/approvals/:id/decide): an operator envelope approval is decided by a HUMAN and grants the envelope; an agent identity is refused', async () => {
  const NOW = Date.now()
  const ORG = DEFAULT_ORG_ID
  const OP = '11111111-1111-4111-8111-111111111111'
  const TK = '+15555550123'
  const PID = '227876842'
  const ECON = { class: 'NEGOTIATE', reasons: [], uncertainty: { level: 'low' }, evidence: { valuation_snapshot_id: 'snap-1', computed_at: '2026-10-10T12:00:00.000Z' }, metrics: { lane: 'sfr', mao: 150000, recommended_offer: 138000, realistic_value: { mid: 200000 } } }
  const store = createMemoryCapabilityStore({ members: [{ org_id: ORG, user_id: OP, role: 'owner' }], now: () => NOW })
  const neg = createMemoryNegotiationStore({ now: () => NOW })
  const secret = 'test-secret-0123456789abcdef'
  const refs = createThreadRefCodec({ secret })
  const negotiation = { openThread: (r, o) => refs.open(r, o), underwriting: async () => ECON, latestEnvelope: (k) => neg.latestEnvelope(k), grant: (a) => grantEnvelope({ ...a, now: NOW }, { store: neg }) }
  const proposals = createEnvelopeApprovals({ store, services: { negotiation }, now: () => NOW })
  const human = { user_id: OP, verified: true, named: true }
  const req = await proposals.propose({ org_id: ORG, identity: human, input: { thread_ref: refs.seal(TK, ORG), property_ref: encodePropertyRef(PID), max_price: 150000, opening_price: 132000, closing_window_min_days: 14, closing_window_max_days: 30, earnest_money_min: 1000, earnest_money_max: 1000, closing_costs_paid_by: 'buyer', expires_in_days: 7 } })
  assert.equal(req.ok, true, JSON.stringify(req))
  const plane = createCapabilityPlane({ env: {}, store, services: { negotiationFor: () => negotiation }, secret, now: () => NOW })
  const a = await store.getApproval(ORG, req.approval_id)
  const route = (identity) => handleApprovalDecide(new Request('http://x/decide', { method: 'POST', body: JSON.stringify({ decision: 'approve', payload_hash: a.payload_hash }) }), req.approval_id,
    { env: { AGENT_ENABLED: '1', AGENT_CAPABILITIES_ENABLED: '1' }, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity }) }, limiter: { check: () => ({ ok: true }) }, plane })
  const agentTry = await (await route({ user_id: 'agt_alpha', verified: true, named: true, agent_id: 'agt_alpha' })).json()
  assert.equal(agentTry.code, 'HUMAN_DECISION_REQUIRED')
  assert.equal((await neg.latestEnvelope(scopeKey(TK, PID))).envelope, null)
  const res = await route(human)
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.state, 'executed', JSON.stringify(body))
  const env = (await neg.latestEnvelope(scopeKey(TK, PID))).envelope
  assert.deepEqual([env.max_price, env.opening_price, env.approval_id, env.granted_by], [150000, 132000, req.approval_id, OP])
})

test('STATIC: LeadCommand\'s execution module reaches R3 ONLY through the one dispatcher module; the T3 / T4 gateway family reaches none of the send stack', () => {
  const exec = path.join(SRC, 'lib/ai/action-gateway-execution.js')
  const src = fs.readFileSync(exec, 'utf8')
  assert.ok(!/conversation-ai-r3-executor/.test(src.replace(/\/\/.*$/gm, '')), 'no direct R3 import')
  assert.ok(/conversation-turn-dispatch\.js/.test(src))
  // the T3 / T4 family's own closure (the phase-1 gateway's closure includes services.js's lazy import specifiers)
  const g = importClosure([path.join(SRC, 'lib/domain/action-gateway/actions/t34/index.js')])
  for (const f of g.files) assert.ok(!/(conversation-ai-r3-executor|conversation-turn-dispatch|process-send-queue|supabase\/sms-engine|providers\/textgrid|negotiation-send|action-gateway-execution)\.js$/.test(f), `the gateway reaches ${path.relative(SRC, f)}`)
})

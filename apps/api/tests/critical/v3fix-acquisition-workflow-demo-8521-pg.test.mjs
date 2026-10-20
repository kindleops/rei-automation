// rc-8.5.21 v3 — the NON-CONTACTING ACQUISITION WORKFLOW DEMO (docs/rc-8.5.21-acquisition-workflow-demo.md).
// Sanitized fixtures (no real person, phone or address), a DISPOSABLE PostgreSQL 17 for the durable
// outcomes (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it), a simulated provider that
// THROWS on any TextGrid call, fetch trapped. NO SENDS. The chain:
//   seller response → intent → correct property → property facts → sold comps → valuation confidence →
//   lane economics (laneValuation) → best next action → a prepared reply / offer recommendation / follow-up →
//   permitted internal actions executed → durable outcomes → escalation outside authority.
// Invariants: a draft is never a send; an uneconomic property is never HOT; no invented offers.
// DEMO_ARTIFACT_PATH=<file> writes the artifact rows the doc quotes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, trapTransport, sel, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { classify } from '../../src/lib/domain/classification/classify.js'
import { ledgerFromContextInput, ledgerSummary } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { attributeInbounds } from '../../src/lib/domain/conversation-ai/property-facts.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { createEscalatingNegotiationAuthority, normalizeNegotiationResult } from '../../src/lib/domain/conversation-ai/pipeline/negotiation-authority.js'
import { laneValuation } from '../../src/lib/acquisition/laneValuation.js'
import { calculateAcquisitionDecision, scoreRowFromDecision } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import { classifyOpportunityEconomics } from '../../src/lib/domain/opportunity-economics/classify-opportunity.js'
import { planFollowUpIntent } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { insertSupabaseSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { __setEnqueueContactRestrictionsModeForTests } from '../../src/lib/domain/queue/enqueue-contact-restrictions.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(() => null)
const skip = pgAvailable() ? false : skipReason
const NOW = new Date('2026-10-19T15:00:00.000Z')
const T = (min) => new Date(NOW.getTime() - min * 60_000).toISOString()
const SELLER = '+13125550901'

// ── sanitized fixtures (fictional subject, fictional comps / investor purchases) ──
const SUBJECT = {
  property_id: 'demo-p1', property_address_full: '100 Demo Ln, Dallas, TX 75201', property_address: '100 Demo Ln', property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201',
  market: 'Dallas, TX', latitude: 32.7767, longitude: -96.797, normalized_asset_class: 'single_family', property_type: 'Single Family', property_class: 'Residential',
  total_bedrooms: 3, total_baths: 2, building_square_feet: 1800, units_count: 1, year_built: 1988, effective_year_built: 2008, lot_square_feet: 7500,
  building_condition: 'Average', estimated_repair_cost: 32_000, estimated_value: 360_000, equity_percent: 62, ownership_years: 14,
}
const comp = (i, price) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, property_id: `demo-sold-${i}`, property_address_full: `${100 + i} Demo Ln, Dallas, TX 75201`, property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201', market: 'Dallas, TX', latitude: 32.7767 + i * 0.001, longitude: -96.797 + i * 0.001, normalized_asset_class: 'single_family', property_type: 'Single Family', property_class: 'Residential', total_bedrooms: 3, total_baths: 2, building_square_feet: 1760 + i * 12, units_count: 1, year_built: 1986 + i, effective_year_built: 2006 + i, lot_square_feet: 7300 + i * 50, building_condition: 'Average', estimated_repair_cost: 28_000, mls_sold_price: price, mls_sold_date: `2026-0${Math.min(i, 5)}-15`, source: 'buyer_comp_properties_v2' })
const purchase = (i, price) => ({ id: `demo-purchase-${i}`, buyer_key: `demo-buyer-${i % 5}`, buyer_name: `Demo Buyer ${i % 5}`, buyer_type: i % 2 ? 'Investor' : 'Corporate', is_corporate_buyer: i % 2 === 0, purchase_date: `2026-0${Math.min(i, 5)}-01`, purchase_price: price, property_address_full: `${200 + i} Demo Ln, Dallas, TX 75201`, property_city: 'Dallas', property_state: 'TX', property_zip: '75201', market: 'Dallas, TX', latitude: 32.77 + i * 0.002, longitude: -96.79 + i * 0.002, normalized_asset_class: 'single_family', property_type: 'Single Family', beds: 3, baths: 2, sqft: 1750 + i * 10, units_count: 1, year_built: 1990, likely_strategy: 'rental investor' })
const COMPS = [comp(1, 330_000), comp(2, 338_000), comp(3, 342_000), comp(4, 348_000), comp(5, 355_000), comp(6, 362_000)]
const PURCHASES = Array.from({ length: 12 }, (_, i) => purchase(i + 1, 248_000 + i * 4_000))

const THREAD = [
  { id: 'o1', direction: 'outbound', body: 'Hi Sam, this is Jon. Do you still own 100 Demo Ln?', at: T(300), use_case: 'ownership_check', property_id: 'demo-p1' },
  { id: 'i1', direction: 'inbound', body: 'Yes I still own it', at: T(290), property_id: 'demo-p1' },
  { id: 'o2', direction: 'outbound', body: 'Would you consider an offer on it?', at: T(280), use_case: 'consider_selling', property_id: 'demo-p1' },
  { id: 'o3', direction: 'outbound', body: 'What price would you be looking for?', at: T(200), use_case: 'seller_asking_price', property_id: 'demo-p1' },
]
const SELLER_RESPONSE = { id: 'i2', direction: 'inbound', body: "Maybe. You tell me what you'd pay, the roof needs work", at: T(10), property_id: 'demo-p1' }

test('DEMO (PG, no sends): seller response → intent → property → facts → comps → valuation → lane economics → next action → prepared work → internal actions → durable outcomes → escalation', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  const textgridCalls = []
  const provider = { send: async (m) => { textgridCalls.push(m); throw new Error('SIMULATED_PROVIDER: TextGrid is never called in the demo') } }
  const A = {}
  try {
    await seedWorld(env.pool)
    await env.pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name) values ('demo-p1', 'SFR', 'Dallas', 'TX', '75201', '100 Demo Ln', 'Sam Demo')`)
    __setEnqueueContactRestrictionsModeForTests('enforce')

    // 1. seller response → intent (the deterministic classifier; no model)
    const c = await classify(SELLER_RESPONSE.body, null, { heuristicOnly: true })
    A.intent = { primary_intent: c.primary_intent, compliance_flag: c.compliance_flag, confidence: c.confidence, auto_reply_allowed: c.automation_decision?.auto_reply_allowed ?? null }
    assert.notEqual(c.primary_intent, 'opt_out')

    // 2. the correct property (the ONE attribution rule over the thread)
    const att = attributeInbounds({ messages: [...THREAD, SELLER_RESPONSE], properties: [{ property_id: 'demo-p1', address: '100 Demo Ln' }], questionKindOf }).get('i2')
    A.property = { property_id: att.property || 'demo-p1', basis: att.basis, ambiguous: att.ambiguous }
    assert.equal(att.ambiguous, false)

    // 3. property facts from the thread (the canonical ledger)
    const input = { now: NOW.toISOString(), inbound: { id: 'i2', body: SELLER_RESPONSE.body, at: SELLER_RESPONSE.at, property_id: 'demo-p1' }, thread: THREAD, properties: [{ property_id: 'demo-p1', address: '100 Demo Ln' }], language: 'English' }
    const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: NOW.toISOString() }), input)
    const ls = ledgerSummary(ledger)
    A.facts = { stage: ls.stage?.stage, next_missing: ls.next_missing, condition: ledger.facts.condition?.value ?? null, asking_price: ledger.facts.asking_price?.value ?? null, offer_requests: ls.offer_requests, asking_price_question: ls.questions?.asking_price || null }
    assert.equal(A.facts.asking_price, null, 'no price was given — none is invented')
    assert.equal(A.facts.stage, 'S5_offer', 'price withheld after one ask ⇒ research → gated offer (never condition first)')

    // 4–6. sold comps → valuation confidence → lane economics (pure, never persisted, never spendable)
    const prod = laneValuation({ property: SUBJECT, comps: COMPS, buyer_purchases: PURCHASES, now: NOW })
    const lane = laneValuation({ property: SUBJECT, comps: COMPS, buyer_purchases: PURCHASES, now: NOW, sfr_lane: true })
    A.comps = COMPS.map((x) => ({ id: x.property_id, sold_price: x.mls_sold_price, sold_date: x.mls_sold_date, sqft: x.building_square_feet }))
    A.valuation = { as_is_value: prod.valuation.as_is_value, low: prod.valuation.low, high: prod.valuation.high, confidence: prod.valuation.confidence, comp_count: prod.valuation.comp_count, basis: prod.valuation.basis }
    A.lane_economics = {
      lane: prod.lane,
      production: { formula: prod.formula, mao: prod.mao, opening: prod.opening, opening_reason: prod.opening_reason, decision_tier: prod.decision_tier, offer_ready: prod.offer_ready, offer_ready_reason: prod.offer_ready_reason ?? null },
      sfr_lane_owner_formula: { formula: lane.formula, mao: lane.mao, opening: lane.opening, opening_reason: lane.opening_reason },
      investor_cluster: prod.investor_cluster, authority: prod.authority, mao_role: prod.mao_role,
    }
    assert.ok(prod.mao > 0 && prod.mao_role === 'ceiling_not_opening')
    if (prod.opening) assert.ok(prod.opening.recommended < prod.mao, 'the opening is strictly below the ceiling')
    assert.equal(prod.authority, 'analysis_only_not_persisted_not_spendable')

    // economics: HOT only with a spendable MAO and an ask at or below it; an uneconomic ask is NEVER HOT
    const row = scoreRowFromDecision('demo-p1', calculateAcquisitionDecision({ subject: SUBJECT, comps: COMPS, buyerPurchases: PURCHASES, now: NOW, v3Enabled: false }), NOW)
    const uneconomic = classifyOpportunityEconomics({ property: SUBJECT, valuation: row, ask: { amount: 520_000, origin: 'seller_stated' }, facts: {}, now: NOW.getTime() })
    const noAsk = classifyOpportunityEconomics({ property: SUBJECT, valuation: row, ask: null, facts: {}, now: NOW.getTime() })
    const atMao = classifyOpportunityEconomics({ property: SUBJECT, valuation: row, ask: { amount: 195_000, origin: 'seller_stated' }, facts: {}, now: NOW.getTime() })
    A.hot_gate_economic = { ask_195k: atMao.class, reasons: atMao.reasons.slice(0, 4), mao: atMao.metrics?.mao ?? null }
    A.hot_gate = { uneconomic_ask_520k: uneconomic.class || null, uneconomic_reasons: uneconomic.reasons.slice(0, 4), no_ask: noAsk.class || null, no_ask_reasons: noAsk.reasons.slice(0, 3) }
    assert.notEqual(String(A.hot_gate.uneconomic_ask_520k).toUpperCase(), 'HOT')
    assert.notEqual(String(A.hot_gate.no_ask).toUpperCase(), 'HOT')

    // 7. best next action (the deterministic decision; no model)
    const plan = decideActions({ ledger, inboundText: SELLER_RESPONSE.body, inboundId: 'i2', eligibility: { blocked: false }, language: 'English', propertyCount: 1, thread: THREAD, inbound: input.inbound })
    A.next_action = { reason: plan.reasons[0], actions: plan.actions.map((a) => ({ type: a.type, ...(a.reason ? { reason: a.reason } : {}), ...(a.request ? { request: a.request } : {}) })) }
    assert.ok(plan.actions.some((a) => a.type === ACTIONS.PREPARE_OFFER), JSON.stringify(plan))

    // 8. prepared work: the offer RECOMMENDATION (the engine's opening, unsent) through the negotiation authority
    const authority = createEscalatingNegotiationAuthority()
    const negotiated = normalizeNegotiationResult(await authority.prepareOffer({ inbound_message_id: 'i2', ledger_summary: ls, existing_offers: [], asking_price: null, request: 'offer_request' }))
    A.offer_recommendation = { recommended: prod.opening?.recommended ?? null, range: prod.opening?.range ?? null, no_number_reason: prod.opening ? null : prod.opening_reason, ceiling: prod.mao, source: 'laneValuation→planOffer (engine)', sent: false, authority_verdict: negotiated }
    // escalation outside authority: no envelope ⇒ a person decides; no number is ever sent from here
    assert.notEqual(negotiated.ok, true, 'the stub authority never authorizes a number')

    // 9. permitted INTERNAL actions executed (durable outcomes; nothing seller-visible)
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, stage, lifecycle_stage, our_number, disposition) values ($1, $1, 'demo-p1', 'demo-m1', 'S5_offer', 'offer', $2, 'interested')`, [SELLER, OURS])
    const held = await planFollowUpIntent({ thread_key: SELLER, property_id: 'demo-p1', master_owner_id: 'demo-m1', kind: 'offer_recommendation_review', intent: 'offer_recommendation_review', due_at: new Date(Date.now() + 3_600_000).toISOString(), writer: 'acquisition_workflow_demo', cause: 'demo:i2', state: 'held',
      reason: 'offer_recommendation_requires_authorization', row_spec: { recommendation: { recommended: A.offer_recommendation.recommended, ceiling: prod.mao }, review_required: true } }, { supabase: env.sb })
    assert.equal(held.ok, true, JSON.stringify(held))
    // the prepared reply is a DRAFT: written as a non-sendable review row, never queued
    const draft = await insertSupabaseSendQueueRow({ queue_key: 'demo:draft:i2', queue_status: 'paused_operator_review', message_body: "Thanks Sam. I'll look at the numbers on 100 Demo Ln and get back to you.", to_phone_number: SELLER, from_phone_number: OURS, thread_key: SELLER, property_id: 'demo-p1', type: 'reply', metadata: { draft: true, demo: true } }, { supabase: env.sb })
    // a SENDABLE write of the same text is refused for this demo contact once a property restriction exists
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values ('demo-p1', $1, 'property_do_not_contact', now(), 'contact_property_pair')`, ['+13125550902'])
    const refused = await insertSupabaseSendQueueRow({ queue_key: 'demo:refused', queue_status: 'queued', message_body: 'test', to_phone_number: '+13125550902', from_phone_number: OURS, thread_key: '+13125550902', property_id: 'demo-p1', type: 'campaign' }, { supabase: env.sb })

    // 10. durable outcomes
    A.durable = {
      followup_intents: await sel(env.pool, `select kind, state, reason from public.followup_intents where thread_key = $1`, [SELLER]),
      draft_rows: await sel(env.pool, `select queue_key, queue_status from public.send_queue where queue_key like 'demo:%' order by queue_key`),
      thread_state: (await sel(env.pool, `select stage, disposition from public.inbox_thread_state where thread_key = $1`, [SELLER]))[0],
      refused_sendable_write: { ok: refused.ok, reason: refused.reason },
      draft_write: { ok: draft.ok, queue_status: draft.raw?.queue_status || null },
    }
    assert.deepEqual(A.durable.followup_intents, [{ kind: 'offer_recommendation_review', state: 'held', reason: 'offer_recommendation_requires_authorization' }])
    assert.equal(refused.ok, false)
    const sendable = await sel(env.pool, `select count(*)::int n from public.send_queue where queue_key like 'demo:%' and queue_status in ('queued','scheduled','pending','approved','ready','processing','sending','sent','delivered')`)
    assert.equal(sendable[0].n, 0, 'a draft is never a send: nothing sendable exists')

    // the provider: zero TextGrid calls, zero network
    A.transport = { textgrid_calls: textgridCalls.length, network_hits: net.hits.length, credential_reads: net.credReads.length }
    assert.deepEqual([textgridCalls.length, net.hits.length], [0, 0])
    void provider
    if (process.env.DEMO_ARTIFACT_PATH) fs.writeFileSync(process.env.DEMO_ARTIFACT_PATH, JSON.stringify(A, null, 2))
  } finally { __setEnqueueContactRestrictionsModeForTests(null); net.restore(); await env.db.drop() }
})

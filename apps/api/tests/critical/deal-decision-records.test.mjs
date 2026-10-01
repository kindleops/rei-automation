/**
 * DEAL DECISION — recorded documents, loans, gates and the desktop decision
 * room's read-model additions. Row shapes are copied from production
 * (seller.property_lien / property_mortgage, property_acquisition_scores,
 * inbox_thread_state) as measured 2026-10-01; no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyLienDocument, classifyLienDocuments, classifyMortgages, describeCode, describeText, summarizeLienDocuments,
} from '../../src/lib/domain/deal-intelligence/deal-record-documents.js'
import {
  aosComposition, automationState, contactFromThread, decisionGates, deriveDealRisks, investorEvidence, sellerFactsWithProvenance, strategyBasis,
} from '../../src/lib/domain/deal-intelligence/deal-decision-service.js'

test('a release is never a lien: Satisfaction of Assignment of Rents (273312064)', () => {
  const d = classifyLienDocument({ doc_title: 'SATISFACTION OF ASSIGNMENT OF RENTS', doc_category: 'ASSIGNMENT OF RENTS', lien_type: 'lien', party_2_name: 'Landmark Community Bank' })
  assert.equal(d.status, 'release')
  assert.equal(d.kind, 'rents')
  assert.equal(d.claimant, null)
})

test('release codes and texts are recognised; doc_category alone is a last resort', () => {
  assert.deepEqual(describeCode('LENCTYREL', 'RELEASE OF CITY LIEN'), { kind: 'municipal', release: true })
  assert.deepEqual(describeCode('UCCTER', null), { kind: 'ucc', release: true })
  assert.deepEqual(describeCode('MLN', 'MECHANICS LIEN'), { kind: 'mechanic', release: false })
  assert.equal(describeText('UNKNOWN TYPE'), null)
  const onlyCategory = classifyLienDocument({ doc_category: 'LIS PENDENS', lien_type: 'lien' })
  assert.equal(onlyCategory.status, 'lien')
  assert.equal(onlyCategory.kind, 'lis_pendens')
})

test('the money is amount_due; party_2 is the claimant on lien documents', () => {
  const fed = classifyLienDocument({ doc_type: 'FLN', doc_title: 'NOTICE OF FEDERAL TAX LIEN', doc_category: 'FEDERAL TAX LIEN', lien_type: 'lien', party_1_name: 'Taxpayer Name', party_2_name: 'Department Of The Treasury-int', amount_due: '337727.34' })
  assert.equal(fed.status, 'lien')
  assert.equal(fed.kind, 'federal_tax')
  assert.equal(fed.amount, 337727.34)
  assert.equal(fed.claimant, 'Department Of The Treasury-int')
  assert.deepEqual(fed.parties, ['Taxpayer Name', 'Department Of The Treasury-int'])
})

test('orders and judgments assert no claimant — the party order is split 50/50 there', () => {
  const order = classifyLienDocument({ doc_type: 'LENUTL', doc_title: 'ORDER IMPOSING FINE', lien_type: 'lien', party_1_name: 'City Of Fort Lauderdale', party_2_name: 'Owner LLC', amount_due: '16200' })
  assert.equal(order.status, 'lien')
  assert.equal(order.kind, 'municipal')
  assert.equal(order.claimant, null)
  assert.equal(order.amount, 16200)
})

test('descriptions that disagree on lien vs release become a conflict, not a lien', () => {
  const d = classifyLienDocument({ doc_type: 'CERREL', doc_type_description: 'CERTIFICATE OF CANCELLATION/RELEASE', doc_title: 'MECHANIC LIEN', lien_type: 'lien', party_1_name: 'Reedley Center Inc', party_2_name: 'Global Plumbing', amount_due: '5875.00' })
  assert.equal(d.status, 'conflict')
  assert.equal(d.conflict.title, 'Mechanic Lien')
  assert.match(d.conflict.type, /Certificate Of Cancellation/)
  const ucc = classifyLienDocument({ doc_type: 'UCC', doc_type_description: 'FINANCING STATEMENT', doc_title: 'MECHANIC LIEN', party_2_name: 'Sierra Roof Inc', amount_due: '30750' })
  assert.equal(ucc.status, 'conflict')
})

test('estate filings and UCC statements are documents, not debt', () => {
  assert.equal(classifyLienDocument({ doc_type: 'PROORD', doc_type_description: 'PROBATE ORDER', doc_title: 'PROBATE ORDER' }).status, 'document')
  assert.equal(classifyLienDocument({ doc_type: 'AFD', doc_type_description: 'AFFIDAVIT OF DEATH', doc_title: 'AFFIDAVIT OF DEATH' }).kind, 'death')
  assert.equal(classifyLienDocument({ doc_type: 'UCC', doc_type_description: 'FINANCING STATEMENT', doc_title: 'FINANCING STATEMENT' }).status, 'document')
})

test('HOA rows: amount and holder from the HOA columns; enforcement steps flagged', () => {
  const nod = classifyLienDocument({ lien_type: 'hoa_lien', transaction_type: 'NOD', hoa_lien_name: 'HAMPTON COMMUNITY ASSOCIATION INC', hoa_lien_amount: 44882.81, nod_recording_date: '2024-11-05' })
  assert.equal(nod.kind, 'hoa')
  assert.equal(nod.title, 'HOA notice of default')
  assert.equal(nod.amount, 44882.81)
  assert.equal(nod.claimant, 'HAMPTON COMMUNITY ASSOCIATION INC')
  assert.equal(nod.at, '2024-11-05')
  assert.equal(nod.enforcement, true)
})

test('provider placeholder dates are not presented as dates', () => {
  const d = classifyLienDocument({ doc_type: 'SLN', doc_title: 'NOTICE OF STATE TAX LIEN', party_2_name: 'Franchise Tax Board', amount_due: 8325.32, date_updated: '1963-01-01' })
  assert.equal(d.updatedAt, null)
  assert.equal(d.at, null)
})

test('summary counts liens separately from releases, documents and conflicts', () => {
  const docs = classifyLienDocuments([
    { doc_type: 'MLN', doc_title: 'MECHANICS LIEN', party_2_name: 'Roofer', amount_due: 1000 },
    { doc_type: 'MLNREL', doc_title: 'MECHANICS LIEN RELEASE' },
    { doc_type: 'PROORD', doc_title: 'PROBATE ORDER' },
    { doc_type: 'CERREL', doc_title: 'MECHANIC LIEN', amount_due: 5 },
  ])
  assert.equal(docs[0].status, 'lien') // most consequential first
  const s = summarizeLienDocuments(docs)
  assert.deepEqual([s.liens, s.releases, s.documents, s.conflicts, s.estate], [1, 1, 1, 1, 1])
  assert.equal(s.statedAmount, 1000)
})

test('mortgages: empty slots dropped, prev1 duplicate of mtg1 dropped, prior kept as history (273312064 / 234359844)', () => {
  const a = classifyMortgages([
    { slot: 'mtg1', lender_name: 'First Guaranty Mortgage Corp', loan_amount: 91617, est_balance: 63743, loan_type: 'Fha', lien_position: 1, recording_date: '2011-07-27' },
    { slot: 'mtg2', lender_name: null, loan_amount: 0, est_balance: 0 },
    { slot: 'mtg3', lender_name: null, loan_amount: 0, est_balance: 0 },
    { slot: 'mtg4', lender_name: null, loan_amount: 0, est_balance: 0 },
    { slot: 'prev1', lender_name: 'FIRST GUARANTY MORTGAGE CORP', loan_amount: 91617, est_balance: null, loan_type: 'FHA', recording_date: '2011-07-27' },
  ])
  assert.equal(a.current.length, 1)
  assert.equal(a.prior.length, 0)
  assert.equal(a.emptySlots, 3)
  assert.equal(a.current.filter((m) => !m.balanceKnown).length, 0)

  const d = classifyMortgages([
    { slot: 'concurrent1', lender_name: 'BANK OF AMERICA NA', loan_amount: 257744, recording_date: '2009-08-05', loan_type: 'FHA' },
    { slot: 'mtg1', lender_name: 'CARRINGTON MTG SERVICES LLC', loan_amount: 243181, est_balance: 0, recording_date: '2025-12-05', loan_type: 'Mortgage Modification' },
    { slot: 'mtg2', lender_name: 'SECRETARY OF HOUSING AND URBAN', loan_amount: 52990, est_balance: 50516, recording_date: '2022-09-02' },
  ])
  assert.equal(d.current.length, 2)
  assert.equal(d.current.filter((m) => !m.balanceKnown).length, 1) // the modification: provider 0 = unknown
  assert.equal(d.prior[0].kind, 'purchase')
})

test('gates carry the engine threshold and the value it compared; the legacy fee key is labelled', () => {
  const score = {
    aos_score: 650, confidence: 45, valuation_confidence: 25, expected_assignment_fee: 47000, recommended_cash_offer: 364600, comp_count: 0,
    evidence: {
      comp_data_status: { selected_comp_count: 0 },
      offer_calculation: { target_assignment_fee: 15000 },
      engine: { target_assignment_fee: 15000 },
      decision_tier_reasoning: { hard_gate_checks: { aos_at_least_780: false, comp_count_at_least_4: false, confidence_at_least_85: false, assignment_fee_meets_target: true, recommended_offer_available: true, valuation_confidence_at_least_80: false } },
    },
  }
  const gates = decisionGates(score)
  assert.equal(gates[0].key, 'comp_count_at_least_4')
  const fee = gates.find((g) => g.key === 'assignment_fee_meets_target')
  assert.equal(fee.legacy, true)
  assert.equal(fee.canonicalKey, 'assignment_fee_meets_minimum_economics')
  assert.equal(fee.threshold, 15000)
  assert.equal(fee.current, 47000)
  assert.match(fee.label, /earlier rule/)
  const aos = gates.find((g) => g.key === 'aos_at_least_780')
  assert.deepEqual([aos.current, aos.threshold, aos.pass], [650, 780, false])
  assert.deepEqual(decisionGates(null), [])
})

test('AOS composition keeps the engine maxima; best-strategy basis replays the engine rule (273312064)', () => {
  const score = {
    aos_score: 725, valuation_confidence: 74, expected_assignment_fee: 20300,
    seller_finance_score: 57, subject_to_score: 13, lease_option_score: 70, novation_score: 74,
    evidence: {
      offer_calculation: { assignment_margin_floor: 15000 },
      aos_breakdown: { score: 725, components: { liquidity: 68, buyer_demand: 112.5, equity_finance: 100, assignment_margin: 250, valuation_strength: 111, distress_motivation: 9, strategy_optionality: 74 }, motivation: { score: 6, reasons: [{ points: 6, reason: 'active_lien' }] } },
      investor_ceiling_summary: { method: 'weighted_nearby_investor_purchase_quantiles', local_purchase_count: 59, distinct_buyer_count: 13, recent_purchase_count: 1, eligible_purchase_count: 59, cash_investor_proxy_count: 59, buyer_demand_score: 75, liquidity_score: 68, confidence: 75 },
    },
  }
  const aos = aosComposition(score)
  assert.equal(aos.components.reduce((s, c) => s + c.max, 0), 1000)
  assert.equal(Math.round(aos.components.reduce((s, c) => s + c.points, 0)), 725)
  assert.equal(aos.motivation.reasons[0].reason, 'Active lien')
  const basis = strategyBasis(score)
  assert.equal(basis.cashViable, true) // 20,300 ≥ 0.75 × 15,000 and 74 ≥ 60
  assert.equal(basis.feeNeeded, 11250)
  assert.equal(basis.creativeBest, 'Novation')
  const inv = investorEvidence(score)
  assert.deepEqual([inv.local, inv.distinctBuyers, inv.confidence], [59, 13, 75])
})

test('contact + automation read the thread and the Pipeline lane without inventing state', () => {
  const thread = { thread_key: '+16122756497', canonical_e164: '+16122756497', seller_display_name: 'Gale D Leflore', contactability_status: 'contactable', is_suppressed: false, lead_temperature: 'warm', lifecycle_stage: 'offer', operational_status: 'waiting_on_seller', automation_state: 'running', next_action_at: '2026-09-30T15:18:26.743Z', latest_direction: 'outbound', last_inbound_at: '2026-09-30T15:18:34Z', last_outbound_at: '2026-10-01T00:55:56Z', pending_queue_count: 0 }
  const c = contactFromThread(thread)
  assert.equal(c.phone, '+16122756497')
  assert.equal(c.sellerName, 'Gale D Leflore')
  assert.equal(contactFromThread(null), null)
  const opp = { acquisition_stage: 'offer', opportunity_status: 'active', next_action: 'send_message_now', next_action_due: '2026-09-30T15:18:26.743Z', last_activity_at: '2026-09-30T15:18:26.743Z', stage_entered_at: '2026-10-01T02:40:13Z' }
  const ns = { next_move: 'send_message_now', last_action: 'offer_queued', human_review_reason: 'ambiguous_intent', contract_readiness: 'not_ready', unresolved_contract_fields: ['signers_identified', 'seller_email'] }
  const a = automationState({ opp, thread, execution: { status: 'blocked', reason: 'execution_gated', created_at: '2026-09-30T15:18:33Z', stage: 'asking_price', mode: 'full_autopilot' }, closing: null, ns, now: Date.parse('2026-10-01T10:15:00Z') })
  assert.equal(a.lane.key, 'blocked')
  assert.equal(a.lane.label, 'Automation overdue')
  assert.equal(a.execution.reasonLabel, 'Execution gated')
  assert.deepEqual(a.negotiation.unresolvedContractFields.map((f) => f.label), ['Signers identified', 'Seller email'])
  assert.equal(automationState({ opp: null, thread: null, execution: null, closing: null, ns: null }).lane, null)
})

test('seller facts: interest is said, ownership is said only when confirmed, else an inference', () => {
  const said = sellerFactsWithProvenance({ ns: {}, sellerFacts: { interest: 'interested', ownership_status: 'confirmed', condition_disclosed: true, extractor_version: 'seller_fact_extractor_v1' }, props: {}, parcel: {}, score: null })
  assert.equal(said.find((f) => f.key === 'interest_seller').provenance, 'seller')
  assert.equal(said.find((f) => f.key === 'ownership_seller').display, 'Confirmed by seller')
  assert.ok(said.find((f) => f.key === 'condition_disclosed'))
  const inferred = sellerFactsWithProvenance({ ns: {}, sellerFacts: { ownership_status: 'inferred_from_seller_engagement' }, props: {}, parcel: {}, score: null })
  assert.equal(inferred.find((f) => f.key === 'ownership_system').provenance, 'system')
})

test('risks count classified liens only — a release no longer reads as "1 recorded lien"', () => {
  const base = { score: null, props: {}, parcel: {}, ns: null, replay: null, quality: null, thread: null, propertyId: '273312064', ask: null, avm: 213000, now: Date.parse('2026-10-01') }
  const releaseOnly = deriveDealRisks({ ...base, records: { liens: [{ doc_title: 'SATISFACTION OF ASSIGNMENT OF RENTS', doc_category: 'ASSIGNMENT OF RENTS', party_2_name: 'Landmark Community Bank' }] } })
  assert.equal(releaseOnly.some((r) => r.key === 'liens'), false)
  const conflictOnly = deriveDealRisks({ ...base, records: { liens: [{ doc_type: 'CERREL', doc_title: 'MECHANIC LIEN', amount_due: 5875 }] } })
  assert.equal(conflictOnly.find((r) => r.key === 'lien_conflict').severity, 'low')
})

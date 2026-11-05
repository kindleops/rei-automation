// 8.5.20-b — property research: dossier provenance contract, listings ≠ sales, MAO +
// opening plan invariants, the ceiling never in seller-facing output, preparePosition
// wiring, fair-housing input stripping. Pure; no network, no DB.
import test from 'node:test'
import assert from 'node:assert/strict'

import { field, isField, validateFieldMap, UNDATED_CONFIDENCE_CAP } from '../../src/lib/domain/property-research/provenance.js'
import { buildPropertyDossier, mergeWebFindings } from '../../src/lib/domain/property-research/dossier.js'
import { assembleCompsAndArea, soldOnly, isListingRow, listingFromWeb, AREA_FUNDAMENTALS_FIELDS } from '../../src/lib/domain/property-research/comps-area.js'
import { planOffer, strictlyBelow, OPENING_STRATEGY } from '../../src/lib/domain/property-research/offer-plan.js'
import { loadResearchInputs, runInternalResearch } from '../../src/lib/domain/property-research/research-pipeline.js'
import { parseWebAnswer, buildWebQuestion } from '../../src/lib/domain/property-research/web-listings.js'
import { checkSellerFacingText, composerView, extractMoneyAmounts } from '../../src/lib/domain/negotiation/seller-facing-guard.js'
import { decidePosition } from '../../src/lib/domain/negotiation/position.js'
import { preparePosition, handleDecisionOutcome } from '../../src/lib/domain/negotiation/conversation-engine-interface.js'
import { createMemoryNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { scopeOf, scopeKey, underwritingHash } from '../../src/lib/domain/negotiation/envelope.js'
import { emptyLedgerState } from '../../src/lib/domain/negotiation/ledger.js'
import { classifyOpportunityEconomics } from '../../src/lib/domain/opportunity-economics/classify-opportunity.js'
import { NOW, PID, SECRET_NAME, SECRET_PHONE, score, propertyRow, SALES, MORTGAGES, LIENS, marketSales, memorySource } from '../helpers/property-research-fixtures.mjs'

const dossierOf = (over = {}) => buildPropertyDossier({ property: propertyRow(), valuation: score(), sales: SALES, mortgages: MORTGAGES, liens: LIENS, facts: {}, history: { inbound_count: 3, outbound_count: 2 }, now: NOW, ...over })

// ── provenance contract ─────────────────────────────────────────────────────

test('provenance: every dossier field is {value, source, as_of, confidence, kind}; unknown is null with confidence 0; undated is capped', () => {
  const f = field(5, { source: 'public.properties.x', as_of: '2026-01-01', confidence: 0.9 })
  assert.ok(isField(f))
  assert.deepEqual(Object.keys(f).sort(), ['as_of', 'confidence', 'kind', 'source', 'value'])
  assert.equal(field(null, { source: 's', confidence: 0.9, as_of: '2026-01-01' }).confidence, 0, 'unknown is never confident')
  assert.equal(field(1, { source: 's', confidence: 0.95 }).confidence, UNDATED_CONFIDENCE_CAP, 'undated sources are capped')
  assert.throws(() => field(1, { source: '' }), /PROVENANCE_SOURCE_REQUIRED/)
  assert.throws(() => field(1, { source: 's', kind: 'guessed' }), /PROVENANCE_KIND_INVALID/)
  const d = dossierOf()
  assert.equal(d.contract.ok, true, d.contract.violations.join(','))
  const v = validateFieldMap(d.sections)
  assert.ok(v.fields > 50 && v.known > 30, JSON.stringify({ fields: v.fields, known: v.known }))
  for (const [sec, map] of Object.entries(d.sections)) for (const [k, x] of Object.entries(map)) {
    assert.ok(isField(x), `${sec}.${k}`)
    assert.ok(['recorded', 'derived', 'inferred', 'seller_stated'].includes(x.kind))
  }
  // kinds are honest: the engine MAO is derived, the parcel recorded, potential units inferred
  assert.equal(d.sections.valuation.authoritative_mao.kind, 'derived')
  assert.equal(d.sections.valuation.authoritative_mao.value, 150000)
  assert.equal(d.sections.identity.parcel.kind, 'recorded')
  assert.equal(d.sections.lot_zoning.potential_units.kind, 'inferred')
  assert.ok(d.coverage.share > 0 && d.coverage.share <= 1)
})

test('provenance: seller-stated facts are labelled seller_stated with their message ref; record vs seller condition conflict is surfaced', () => {
  const facts = { asking_price: { value: { amount: 185000, price_type: 'firm' }, origin: 'seller_stated', source_message_id: 'in-7' }, condition: { value: { condition: 'needs a new roof', repairs: 'roof' }, origin: 'seller_stated', source_message_id: 'in-8' } }
  const d = dossierOf({ facts })
  assert.equal(d.sections.seller_facts.asking_price.kind, 'seller_stated')
  assert.equal(d.sections.seller_facts.asking_price.source, 'seller:message.in-7')
  assert.equal(d.sections.seller_facts.asking_price.value.amount, 185000)
  assert.equal(d.sections.condition.seller_stated_condition.kind, 'seller_stated')
  assert.equal(d.sections.condition.conflict.value, 'seller_reports_worse_than_record')
})

test('provenance: a web merge adds inferred fields with a web source; a stale / missing valuation is reported', () => {
  const d = mergeWebFindings(dossierOf({ valuation: null }), [{ topic: 'zoning', value: 'SF-7 single family', url: 'https://www.cityexample.gov/zoning', retrieved_at: '2026-10-15T00:00:00.000Z' }, { topic: 'zoning', value: 'dup', url: '' }])
  assert.equal(d.sections.web.zoning.kind, 'inferred')
  assert.equal(d.sections.web.zoning.source, 'web:cityexample.gov')
  assert.ok(d.sections.web.zoning.confidence <= 0.6)
  assert.equal(d.contract.ok, true)
  assert.ok(d.stale.includes('valuation_missing'))
  const old = dossierOf({ valuation: score({ computed: '2026-09-13T00:00:00.000Z' }) })
  assert.ok(old.stale.some((s) => s.startsWith('valuation_not_offer_ready:score_stale')))
  assert.equal(old.sections.valuation.authoritative_mao.value, null, 'a stale score is never an authoritative MAO')
})

// ── fair housing / privacy ──────────────────────────────────────────────────

test('fair housing: protected attributes, names, phones, e-mails, party names, dates of death / divorce never reach any output', () => {
  const research = runInternalResearch({ found: true, property_id: PID, property: propertyRow(), valuation: score(), sales: SALES, mortgages: MORTGAGES, liens: LIENS, thread: { inbound: [{ id: 'in-1', body: `I want 185k. call me ${SECRET_PHONE}`, at: '2026-10-14T10:00:00Z' }], outbound_count: 1 }, opportunity: null, offers: [], soldComps: [], marketSales: marketSales(), area: { fundamentals: { housing_units: 1000, vacancy_rate: 0.05, median_household_income: 51000, population: 4000, renter_share: 0.4, owner_share: 0.6 } }, subject: { lat: 32.73, lng: -97.0 }, zip: '75051', age: 70, marital_status: 'married' }, { now: NOW })
  const s = JSON.stringify(research)
  for (const bad of [SECRET_NAME, SECRET_PHONE, '2145550147', 'owner@example.com', '9 Private Rd', 'widowed', 'Private Person Lender', '2025-01-01', '2020-01-01', 'Somebody Else', 'median_household_income', 'population', 'renter_share', 'owner_share']) {
    assert.ok(!s.includes(bad), `leaked: ${bad}`)
  }
  assert.ok(research.ignored.protected_attributes_stripped.some((p) => /age|marital_status|race|religion|familial_status/.test(p)))
  assert.deepEqual(Object.keys(research.comps_area.sections.neighborhood.housing_stock.value).sort(), ['housing_units', 'vacancy_rate'])
  assert.ok(AREA_FUNDAMENTALS_FIELDS.every((f) => !/(^|_)(income|population|households?|renter|owner|race|age|ethnicity)(_|$)/.test(f)))
  // a protected attribute cannot move the plan
  const a = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 185000 }, now: NOW })
  const b = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 185000 }, age: 88, marital_status: 'divorced', race: 'x', now: NOW })
  assert.deepEqual(b.opening, a.opening)
  assert.ok(b.ignored.protected_attributes_stripped.length >= 3)
})

// ── listings are never sales ────────────────────────────────────────────────

test('listings ≠ sales: listing rows, web prices and "sold" claims on web pages never feed a sold statistic', () => {
  const base = assembleCompsAndArea({ subject: { lat: 32.73, lng: -97.0 }, lane: 'sfr', engine_comps: score().evidence.selected_comps, market_sales: marketSales(), now: NOW })
  const listingInSales = { id: 'L1', sale_price: 999000, sale_date: '2026-09-01', sale_source: 'MLS Active Listing', latitude: 32.731, longitude: -97.001 }
  const taggedListing = { comp_id: 'L2', sale_price: 950000, sale_date: '2026-09-01', source: 'mls_sold', evidence_kind: 'listing', distance_miles: 0.2 }
  const web = [{ status: 'active', list_price: 899000, url: 'https://listings.example.com/a', retrieved_at: '2026-10-15T00:00:00Z' }, { status: 'sold_reported', list_price: 905000, url: 'https://listings.example.com/b' }, { is_subject: true, status: 'active', list_price: 260000, days_on_market: 40, price_reductions: 2, url: 'https://listings.example.com/subject' }]
  const mixed = assembleCompsAndArea({ subject: { lat: 32.73, lng: -97.0 }, lane: 'sfr', engine_comps: [...score().evidence.selected_comps, taggedListing], sold_comps: [listingInSales], market_sales: [...marketSales(), { comp_id: 'L3', source: 'listing', price: 990000, sold_on: '2026-09-01', lat: 32.73, lng: -97.0 }], listings: web, now: NOW })
  assert.deepEqual(mixed.sections.comps.sold_median_price.value, base.sections.comps.sold_median_price.value, 'listings do not move the sold median')
  assert.equal(mixed.sections.comps.sold_count.value, base.sections.comps.sold_count.value)
  assert.equal(mixed.evidence_counts.listings_rejected_from_sales, 3)
  assert.ok(mixed.sold_items.every((s) => s.evidence_kind === 'sale' && s.price < 900000))
  assert.ok(mixed.listing_items.every((l) => l.evidence_kind === 'listing'))
  assert.equal(listingFromWeb({ status: 'sold', list_price: 1 }).evidence_kind, 'listing', 'a web "sold" is still a listing')
  assert.equal(mixed.sections.listings.subject_listing.value.list_price, 260000)
  assert.equal(mixed.sections.listings.subject_listing.kind, 'inferred')
  assert.equal(soldOnly([{ evidence_kind: 'listing', price: 5 }, { evidence_kind: 'sale', price: 6 }]).length, 1)
  assert.equal(isListingRow({ sale_source: 'Public Record Sold' }), false)
  assert.equal(isListingRow({ sale_source: 'MLS Sold' }), false)
  assert.equal(isListingRow({ source: 'pending' }), true)
  // a web listing price never reaches the offer plan (the plan reads the engine only)
  const r1 = runInternalResearch({ found: true, property_id: PID, property: propertyRow(), valuation: score(), thread: { inbound: [] }, soldComps: [], marketSales: marketSales(), area: {}, subject: { lat: 32.73, lng: -97.0 } }, { now: NOW })
  const r2 = runInternalResearch({ found: true, property_id: PID, property: propertyRow(), valuation: score(), thread: { inbound: [] }, soldComps: [], marketSales: marketSales(), area: {}, subject: { lat: 32.73, lng: -97.0 } }, { now: NOW, listings: web })
  assert.deepEqual(r2.offer_plan.opening, r1.offer_plan.opening)
  assert.deepEqual(r2.offer_plan.mao, r1.offer_plan.mao)
})

test('web answer parsing keeps only items citing a provider-observed URL; web prices are listings', () => {
  const answer = 'Found it.\n```json\n{"items":[{"topic":"subject_listing","status":"active","list_price":"$259,900","days_on_market":41,"url":"https://www.listings.example.com/subject/"},{"topic":"nearby_listing","status":"pending","list_price":230000,"url":"https://made-up.example.com/x"},{"topic":"zoning","value":"SF-7","url":"https://city.example.gov/zoning"},{"topic":"owner","value":"Jane","url":"https://city.example.gov/zoning"}]}\n```'
  const p = parseWebAnswer(answer, [{ url: 'https://listings.example.com/subject', retrieved_at: '2026-10-15T00:00:00Z' }, { url: 'https://city.example.gov/zoning' }])
  assert.equal(p.listings.length, 1)
  assert.equal(p.listings[0].evidence_kind, 'listing')
  assert.equal(p.listings[0].list_price, 259900)
  assert.equal(p.dropped_uncited, 1)
  assert.deepEqual(p.notes.map((n) => n.topic), ['zoning'], 'non-property topics (people) are never parsed')
  const q = buildWebQuestion(dossierOf())
  assert.match(q, /Never look up or report people/)
  assert.match(q, /Listings are NOT sales/)
  assert.ok(!q.includes(SECRET_NAME) && !q.includes(SECRET_PHONE))
})

// ── MAO + opening plan ──────────────────────────────────────────────────────

test('offer plan: the engine MAO is the ceiling; the opening sits strictly below it and below the engine target, with listed strategy factors', () => {
  const p = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 185000 }, now: NOW })
  assert.equal(p.available, true, p.reason)
  assert.equal(p.visibility, 'internal_only')
  assert.equal(p.mao.amount, 150000)
  assert.equal(p.mao.role, 'ceiling_not_opening')
  assert.equal(p.mao.permission, 'recommendation_only_requires_granted_envelope')
  assert.ok(p.opening.recommended < 150000 && p.opening.recommended <= 140000)
  assert.ok(p.opening.range[0] <= p.opening.range[1])
  assert.ok(p.opening.factors.length >= 2 && p.opening.factors.every((f) => f.factor && typeof f.effect === 'number' && f.reason))
  assert.equal(p.counter_room.usd, 150000 - p.opening.recommended)
  assert.equal(p.escalation.hard_ceiling, 150000)
  assert.equal(p.escalation.review_above, 140000)
  assert.ok(p.escalation.conditions.some((c) => /seller_counter_above_ceiling/.test(c)))
  for (const k of ['transaction_costs', 'carrying_costs', 'risk_reserve', 'investor_margin_target']) assert.ok(isField(p.costs[k]) && p.costs[k].value > 0, k)
  assert.ok(isField(p.values.as_is_value) && p.values.as_is_value.value === 200000)
  assert.equal(p.values.retail_arv_cross_check.value.lane, 'mls_arv_separate_lane_cross_check_only')
  assert.equal(p.lane_check.owner_lane_reference, Math.round(172000 * 0.87))
})

test('offer plan: never one universal lowball % — strategy moves the opening with evidence, demand, flexibility and the ask', () => {
  const strong = planOffer({ valuation: score({ conf: 85, comps: 10, demand: 75 }), property: propertyRow(), now: NOW })
  const weak = planOffer({ valuation: score({ conf: 55, comps: 5, demand: 30 }), property: propertyRow(), now: NOW })
  const flexible = planOffer({ valuation: score(), property: propertyRow(), facts: { motivation: { value: 'divorce' }, timeline: { value: 'need to sell asap' }, condition: { value: { repairs: 'roof' } } }, now: NOW })
  const close = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 145000 }, now: NOW })
  const discounts = new Set([strong, weak, flexible, close].map((p) => p.opening.discount_from_target))
  assert.ok(discounts.size >= 3, [...discounts].join(','))
  assert.ok(weak.opening.recommended < strong.opening.recommended)
  assert.ok(flexible.opening.discount_from_target > strong.opening.discount_from_target)
  assert.ok(close.opening.factors.some((f) => f.factor === 'ask_inside_authority'))
  for (const p of [strong, weak, flexible, close]) assert.ok(p.opening.discount_from_target >= OPENING_STRATEGY.min_discount && p.opening.discount_from_target <= OPENING_STRATEGY.max_discount)
  // an implausibly low ask (a rent, a typo) is never agreed to: confirm it first
  const typo = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 25000 }, now: NOW })
  assert.equal(typo.recommendation, 'confirm_asking_price_before_any_offer')
  assert.equal(typo.seller.ask_used, false)
  assert.ok(typo.opening.recommended > 25000)
  // a seller at or under our opening: agree at THEIR number, never pay more than asked
  const low = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 120000 }, now: NOW })
  assert.equal(low.recommendation, 'seller_ask_at_or_below_opening:agree_at_seller_price')
  assert.equal(low.opening.recommended, 120000)
})

test('offer plan property: across 800 random engine rows / envelopes the opening is always < MAO and ≤ the envelope max', () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  let priced = 0
  for (let i = 0; i < 800; i += 1) {
    const mid = 60000 + Math.floor(rnd() * 900000)
    const mao = Math.floor(mid * (0.4 + rnd() * 0.5))
    const offer = Math.floor(mao * (0.85 + rnd() * 0.15))
    const env = rnd() < 0.5 ? { max_price: Math.floor(mao * (0.7 + rnd() * 0.3)) } : null
    const p = planOffer({ valuation: score({ mid, mao, offer, conf: Math.floor(40 + rnd() * 55), comps: Math.floor(3 + rnd() * 12), demand: Math.floor(rnd() * 100), investorMid: rnd() < 0.3 ? null : Math.floor(mid * (0.6 + rnd() * 0.5)) }), property: propertyRow(), ask: rnd() < 0.7 ? { amount: Math.floor(mid * (0.4 + rnd())) } : null, envelope: env, facts: rnd() < 0.3 ? { motivation: { value: 'x' } } : {}, now: NOW })
    if (!p.available) continue
    priced += 1
    assert.ok(p.opening.recommended < p.mao.amount, `opening ${p.opening.recommended} < MAO ${p.mao.amount}`)
    assert.ok(p.opening.range[0] <= p.opening.range[1] && p.opening.range[1] < p.mao.amount)
    if (env) assert.ok(p.opening.recommended <= env.max_price, `opening ${p.opening.recommended} ≤ envelope ${env.max_price}`)
    assert.ok(p.opening.recommended > 0)
  }
  assert.ok(priced > 400, `priced ${priced}`)
  assert.equal(strictlyBelow(150000, 150000), 145000)
  assert.equal(strictlyBelow(149999, 150000), 145000)
  assert.equal(strictlyBelow(50, 51), 50)
})

test('offer plan: no authoritative MAO ⇒ no opening (never a fabricated number)', () => {
  for (const v of [null, score({ tier: 'REVIEW_REQUIRED' }), score({ computed: '2026-08-01T00:00:00Z' }), score({ comps: 2, conf: 40, extra: { evidence: { ...score().evidence, offer_calculation: {} } } })]) {
    const p = planOffer({ valuation: v, property: propertyRow(), ask: { amount: 150000 }, now: NOW })
    assert.equal(p.available, false)
    assert.equal(p.opening, null)
    assert.equal(p.mao, null)
  }
})

// ── the ceiling never in seller-facing output ───────────────────────────────

const TK = '+15555550123'
const ECON = classifyOpportunityEconomics({ ask: { amount: 165000 }, property: propertyRow(), valuation: score(), freshness: { status: 'current' }, now: NOW })
const envRow = (over = {}) => {
  const scope = scopeOf({ thread_key: TK, property_id: PID })
  return { envelope_id: 'env-1', scope_key: scope.scope_key, version: 1, thread_ref: scope.thread_ref, property_id: PID, max_price: 150000, opening_price: 128000, max_moves: 3, closing_window_min_days: 7, closing_window_max_days: 30, earnest_money_min: 500, earnest_money_max: 2000, as_is: true, closing_costs_paid_by: 'buyer', valid_from: new Date(NOW - 864e5).toISOString(), expires_at: new Date(NOW + 6 * 864e5).toISOString(), granted_by: 'op-1', approval_id: 'apr_00000000-0000-4000-8000-000000000001', underwriting_hash: underwritingHash(ECON), ...over }
}

test('seller-facing: the composer view carries only the authorised move; drafts stating the ceiling, other numbers, ceiling language or comps are refused', () => {
  const pos = decidePosition({ scope: { thread_key: TK, property_id: PID }, economics: ECON, envelope: envRow(), envelope_meta: { latest_version: 1 }, ledger: emptyLedgerState(scopeKey(TK, PID)), seller_request: { amount: 165000 }, now: NOW })
  assert.equal(pos.status, 'within_authority')
  assert.equal(pos.move.kind, 'open')
  assert.equal(pos.move.amount, 128000)
  const view = composerView(pos)
  const vs = JSON.stringify(view)
  assert.ok(!vs.includes('150000') && !vs.includes('justification') && !vs.includes('proposed_envelope'), vs)
  assert.equal(view.move.amount, 128000)
  assert.ok(view.forbidden_claims.includes('ceiling_or_max_price'))
  const ok = checkSellerFacingText('Based on the condition and the numbers we could do $128,000 cash, as-is.', { position: pos, economics: ECON, envelope: envRow() })
  assert.equal(ok.ok, true, ok.violations.join(','))
  for (const [draft, code] of [
    ['We can do $128,000 now and could go up to $150,000.', 'internal_number_disclosed:envelope_max'],
    ['Our max is 150k.', 'internal_number_disclosed:envelope_max'],
    ['$128,000 is the most we can pay.', 'ceiling_language'],
    ['Houses nearby sold for $205,000 but we can do $128,000.', 'comparable_sales_detail'],
    ['Value is about $200,000; we offer $128,000.', 'internal_number_disclosed:value_mid'],
  ]) {
    const r = checkSellerFacingText(draft, { position: pos, economics: ECON, envelope: envRow() })
    assert.equal(r.ok, false, draft)
    assert.ok(r.violations.includes(code), `${draft} → ${r.violations.join(',')}`)
  }
  // no authority ⇒ no amount at all
  const none = decidePosition({ scope: { thread_key: TK, property_id: PID }, economics: ECON, envelope: null, ledger: emptyLedgerState(scopeKey(TK, PID)), now: NOW })
  assert.equal(composerView(none).may_state_amount, false)
  assert.ok(checkSellerFacingText('We could do 135k.', { position: none }).violations.includes('amount_without_authority'))
  assert.deepEqual(extractMoneyAmounts('$1.2M, 150k, 3 beds, built 1950, 30 days, $128,000'), [1200000, 150000, 128000])
})

test('the ceiling is never the opening: an envelope opening at the max escalates; preparePosition carries the plan in the PROPOSED envelope only', async () => {
  const atMax = decidePosition({ scope: { thread_key: TK, property_id: PID }, economics: ECON, envelope: envRow({ opening_price: 150000 }), envelope_meta: { latest_version: 1 }, ledger: emptyLedgerState(scopeKey(TK, PID)), seller_request: { amount: 170000 }, now: NOW })
  assert.equal(atMax.status, 'escalate')
  assert.deepEqual(atMax.escalation.reasons, ['opening_not_below_ceiling'])
  assert.equal(atMax.move, null)

  const plan = planOffer({ valuation: score(), property: propertyRow(), ask: { amount: 165000 }, now: NOW })
  const store = createMemoryNegotiationStore()
  const out = await handleDecisionOutcome('PREPARE_OFFER', { thread_key: TK, property_id: PID, economics: ECON, now: NOW }, { store, planOffer: async () => plan })
  assert.equal(out.position.status, 'needs_envelope')
  const pe = out.position.proposed_envelope
  assert.equal(pe.operator_only, true)
  assert.equal(pe.offer_plan.ceiling, 150000)
  assert.equal(pe.offer_plan.visibility, 'internal_only')
  assert.deepEqual(pe.offer_plan.opening_range, plan.opening.range)
  assert.ok(pe.proposal.opening_price < pe.proposal.max_price, 'the proposed opening is strictly below the ceiling')
  assert.equal(pe.proposal.opening_price, plan.opening.recommended)
  assert.ok(pe.offer_plan.expires_at && pe.offer_plan.escalation_conditions.length && pe.offer_plan.terms.closing_window_days.length === 2)
  assert.equal(out.composer_view.may_state_amount, false)
  assert.ok(!JSON.stringify(out.composer_view).includes('150000'))
  assert.equal(out.position.offer_plan_summary.visibility, 'internal_only')
  // a plan built on a DIFFERENT ceiling is ignored (the engine MAO is the authority)
  const stale = { ...plan, mao: { ...plan.mao, amount: 170000 } }
  const out2 = await preparePosition({ thread_key: TK, property_id: PID, economics: ECON, offer_plan: stale, now: NOW }, { store })
  assert.equal(out2.proposed_envelope.offer_plan, null)
})

test('pipeline: loadResearchInputs + runInternalResearch over the memory source produce a contract-valid dossier, comps, economics and a plan', async () => {
  const src = memorySource({ inbound: [{ id: 'in-1', body: 'I would take 185000 for it, needs a roof', at: '2026-10-14T10:00:00Z' }] })
  const inputs = await loadResearchInputs(src, PID, { now: NOW })
  assert.equal(inputs.found, true)
  const r = runInternalResearch(inputs, { now: NOW })
  assert.equal(r.dossier.contract.ok, true)
  assert.equal(r.ask.amount, 185000)
  assert.ok(['NEGOTIATE', 'NURTURE', 'HOT', 'INVESTIGATE'].includes(r.economics.class))
  assert.equal(r.offer_plan.available, true)
  assert.ok(r.offer_plan.opening.recommended < r.offer_plan.mao.amount)
  assert.ok(r.comps_area.sections.market_activity.investor_share.value != null)
  assert.ok(r.evidence.coverage.share > 0.3)
  assert.equal((await loadResearchInputs(src, '999', { now: NOW })).found, false)
})

test('timestamps survive the protected-attribute strip (pg returns Date objects): a Date-typed score is offer-ready, Date-typed sales stay in window', async () => {
  const v = score({ computed: new Date('2026-10-10T12:00:00.000Z') })
  const plan = planOffer({ valuation: v, property: propertyRow(), now: NOW })
  assert.equal(plan.available, true, plan.reason)
  const market = marketSales().map((m) => ({ ...m, sold_on: new Date(`${m.sold_on}T00:00:00Z`) }))
  const r = runInternalResearch({ found: true, property_id: PID, property: propertyRow(), valuation: v, thread: { inbound: [] }, soldComps: [], marketSales: market, area: {}, subject: { lat: 32.73, lng: -97.0 } }, { now: NOW })
  assert.equal(r.comps_area.evidence_counts.market_sales, market.length)
  assert.equal(r.offer_plan.available, true)
})

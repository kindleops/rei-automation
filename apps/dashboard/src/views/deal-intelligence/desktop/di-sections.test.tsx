import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiDecision } from './di-types'
import { DI_MODES } from './di-types'
import { evidenceLedger, familyCards, isSourceBasis, sellerIdentityFacts } from './di-evidence'
import { candidateRows, CompsSection, dealCompBuyer, EvidenceIndex, MarketTransactionsSection } from './modes/EvidenceMode'
import { modeFromSearch } from './di-subject'
import { SellerMode } from './modes/SellerMode'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'

// The comp candidates read is a network hook; the engine-comps path never calls it.
vi.mock('../../comp-intelligence/desktop/use-comps-workspace', () => ({
  useCompsWorkspace: () => ({ data: { comps: CANDIDATES, query: { radiusMiles: 1, months: 12 } }, settled: true, loading: false, failure: null, request: { radius: null, months: null }, setWindow: () => {}, retry: () => {} }),
}))

let CANDIDATES: EvidenceComp[] = []

/** The 273312064 read-model shape (names and phones redacted). */
function fixture(over: Partial<DiDecision> = {}): DiDecision {
  const base = {
    generatedAt: '2026-10-01T10:00:00Z',
    subject: { propertyId: '273312064', address: '3635 Emerson Ave N, Minneapolis, Mn 55412', city: 'Minneapolis', state: 'MN', zip: '55412', market: 'Minneapolis, MN', propertyType: 'Single Family', units: 1, beds: 4, baths: 2, sqft: 1853, yearBuilt: 1907, lat: 45.021381, lng: -93.294633, mls: null, isCanary: false },
    pipeline: { opportunityId: 'e1db7c94-60ba-4438-af41-80b6b08535b1', stage: 'offer', stageLabel: 'Offer', status: 'active', threadKey: '+15550000001', lastActivityAt: null, stageEnteredAt: null },
    decision: {
      status: 'available', tier: 'AUTO_RANGE_OFFER', tierLabel: 'Range offer authorized', tierTone: 'go',
      tierReasons: ['Valuation and margin support range but hard offer gates failed', 'Gate not met: aos at least 780'],
      gates: [
        { key: 'comp_count_at_least_4', label: '4+ qualified comps', pass: true, metric: 'comps', current: 12, threshold: 4, comparator: '>=', unit: 'count' },
        { key: 'valuation_confidence_at_least_80', label: 'Valuation confidence ≥ 80', pass: false, metric: 'valuationConfidence', current: 74, threshold: 80, comparator: '>=', unit: 'score' },
        { key: 'assignment_fee_meets_minimum_economics', label: 'Assignment fee clears minimum', pass: true, metric: 'fee', current: 20300, threshold: 15000, comparator: '>=', unit: 'usd' },
        { key: 'recommended_offer_available', label: 'Offer computed', pass: true, metric: 'offer', current: 168600, threshold: 0, comparator: '>', unit: 'usd' },
        { key: 'aos_at_least_780', label: 'Acquisition score ≥ 780', pass: false, metric: 'aos', current: 725, threshold: 780, comparator: '>=', unit: 'score' },
      ],
      aos: 725, confidence: 76, valuationConfidence: 74,
      confidenceBreakdown: { formula: '45% valuation + 20% subject completeness + 20% buyer behavior + 15% finance/distress completeness', valuation: 74, subject: 94, buyer: 75, finance: 56, missing: ['Ownership years', 'Motivation score'], subjectMissing: ['Ownership years'], financeMissing: ['Ownership years', 'Motivation score'], uncapped: 75.5, cap: 100, capReason: null },
      bestStrategy: 'CASH_ASSIGNMENT', bestStrategyLabel: 'Cash assignment', leadWith: 'Nurture', conversationAngle: 'Low pressure nurture', why: 'Patient follow-up.',
      computedAt: '2026-09-30T15:18:26.744Z', ageDays: 0, summary: [],
      authorization: { presentable: true, withheldReason: null, withheldText: null, economicFit: 'Unknown', zone: 'Insufficient confidence', band: null, authorizedFloor: 157700, authorizedCeiling: 188900, directPurchaseMax: 26150000, remainingMovement: 20300, strategy: null, nextMove: 'Send message now' },
      strategyBasis: { cashViable: true, fee: 20300, feeNeeded: 11250, valuationConfidence: 74, creativeBest: 'Novation', creativeBestScore: 74 },
      aosComposition: null, investorEvidence: { method: 'Weighted nearby investor purchase quantiles', eligible: 59, local: 59, recent: 1, distinctBuyers: 13, cashProxy: 59, demandScore: 75, liquidityScore: 68, confidence: 75 },
    },
    valuation: {
      low: 264300, mid: 362500, high: 451400, confidence: 74, avm: 213000, compLow: 115100, compHigh: 646400,
      spectrum: { min: 134204, max: 474896, band: { low: 264300, mid: 362500, high: 451400, from: 0.38, to: 0.93, at: 0.67 }, comps: { low: 115100, high: 646400, from: 0, to: 1 }, markers: [] },
    },
    offer: {
      recommended: 168600, floor: 157700, expectedFee: 20300, valuationCeiling: 188800, behaviorCeiling: 22115500, effectiveCeiling: 188900,
      ceilingBasis: 'Authoritative buyer behavior constrains valuation ceiling', buyerCeilingAuthoritative: true, buyerCeilingReasons: [],
      targetMargin: 18885, protectedMargin: 15000, marginPct: 0.1, marginPolicy: 'assignment_margin_v1', assignmentMarginFloor: 15000, negotiableMargin: 5300,
      repairs: { amount: 64900, source: 'Data-provider estimate', confidence: 90 }, maxArvFactor: 0.7,
      terms: { confidenceHaircutPct: 1.56, motivationDiscountPct: 0.21, demandPremiumPct: 1.07 }, protectedMarginEnforced: false,
      method: 'repair_adjusted_exit_ceiling_less_assignment_target',
      negotiation: { ask: null, initialAsk: null, currentOffer: null, counter: null, lowestIndication: null, sellerNet: null, concessions: 0 },
      offers: [], binding: false, lineage: { snapshotId: '10ad95b4', negotiationSnapshotId: '10ad95b4', negotiationUsesLatest: true },
    },
    sellerFacts: [
      { key: 'interest_seller', label: 'Interest', value: 'interested', display: 'Interested', provenance: 'seller', source: 'Seller message (extracted)' },
      { key: 'occupancy_seller', label: 'Occupancy', value: 'unknown', display: 'Unknown', provenance: 'seller', source: 'Seller message' },
      { key: 'occupancy_record', label: 'Occupancy', value: 'Owner Occupied', display: 'Owner Occupied', provenance: 'record', source: 'County / parcel record' },
      { key: 'repairs_system', label: 'Repair estimate', value: 64900, display: '$65K', provenance: 'system', source: 'Data-provider estimate' },
    ],
    comps: {
      status: 'comps_selected', message: null, raw: 100, eligible: 99, selected: 12, rejected: 88, rejectionBreakdown: [], dispersion: 0.382,
      avgDistanceMiles: 1.79, medianAgeMonths: 6, sources: { mls_sold: 11, public_record_sold: 1 }, avgScore: 80.6, completeness: 60,
      adjustedLow: 115100, adjustedHigh: 646400, buyerMix: null, assetIntegrity: null, anchor: null,
      top: [
        { id: 'c1', propertyId: '273414868', address: '3343 Emerson Ave N', salePrice: 280000, adjustedValue: 300500, saleDate: '2026-03-12', distanceMiles: 0.35, score: 85.8, weight: 0.64, confidence: 79, source: 'mls_sold', completeness: 60, mismatches: [], propertyType: 'Single Family', assetClass: 'single_family', family: 'single', assetMatch: true, beds: 4, baths: 2, sqft: 1538, lotSqft: null, units: 1, yearBuilt: 1907, effectiveYear: null, condition: 'Average', quality: null, construction: null, renovation: null, stories: null, pool: null, ppsf: 182, ppu: null, saleSource: 'MLS Sold', mlsSoldPrice: 280000, avmAtSale: 204000, buyerKind: 'individual', buyerLabel: 'Individual', photo: null, lat: 45.0163, lng: -93.2946 },
        { id: 'c2', propertyId: '273330226', address: '3722 Fremont Ave N', salePrice: 110000, adjustedValue: 115100, saleDate: '2026-04-03', distanceMiles: 0.11, score: 84.7, weight: 0.58, confidence: 78, source: 'public_record_sold', completeness: 60, mismatches: [], propertyType: 'Single Family', assetClass: 'single_family', family: 'single', assetMatch: true, beds: 3, baths: 1, sqft: 1473, lotSqft: null, units: 1, yearBuilt: 1907, effectiveYear: null, condition: 'Fair', quality: null, construction: null, renovation: null, stories: null, pool: null, ppsf: 75, ppu: null, saleSource: 'Public Record Sold', mlsSoldPrice: null, avmAtSale: 178000, buyerKind: 'company', buyerLabel: 'Pinewood LLC', photo: null, lat: 45.0226, lng: -93.2962 },
      ],
    },
    economics: {
      avm: 213000, avmRange: { low: 197000, high: 230000, confidence: 85 }, equityEstimate: 149257, equityPercent: 71,
      debt: { estOpenBalance: 63743, openMortgageCount: 1, monthlyPayment: 512, originalTotal: 91617, mortgages: [], priorMortgages: [], unknownBalances: 0 },
      liens: [], recordedDocuments: [], lienSummary: { liens: 0, releases: 1, documents: 0, conflicts: 0, withStatedAmount: 0, statedAmount: null, byKind: {}, estate: 0 },
      foreclosure: null, tax: { annual: 2696, year: 2025, delinquent: false, delinquentYear: null }, atOffer: { offer: 168600, ceilingSpread: 20300, debtCovered: true },
    },
    conversation: null,
    market: null,
    record: { sections: [{ title: 'Ownership', fields: [{ label: 'Owner of record', value: 'Owner Redacted' }, { label: 'Corporate owner', value: 'No' }] }, { title: 'Value & equity', fields: [{ label: 'AVM', value: '$213,000' }] }], owner: null, prospects: [] },
    history: [{ at: '2011-07-27', kind: 'mortgage', title: 'Fha recorded', amount: 91617, detail: 'Lender Redacted' }],
    valuationHistory: [
      { at: '2026-09-30T14:55:53Z', low: 264300, mid: 362500, high: 451400, offer: 168600, tier: 'Range offer authorized', comps: 12, confidence: 76 },
      { at: '2026-09-30T15:18:26Z', low: 264300, mid: 362500, high: 451400, offer: 168600, tier: 'Range offer authorized', comps: 12, confidence: 76 },
    ],
    strategies: [],
    risks: [{ key: 'wide_dispersion', severity: 'medium', title: 'Comps disagree', detail: null, source: 'x' }],
    buyers: null,
    actuals: null,
    scenario: {
      replayable: true, reason: null, delta: 0,
      inputs: { valuation_mid: 362500, valuation_confidence: 74, repairs: 64900, max_arv_factor: 0.7, behavior_ceiling: 22115500, buyer_ceiling_authoritative: true, asset_family: 'RESIDENTIAL_SINGLE', unit_count: null, buyer_demand_score: 75, liquidity_score: 68, minimum_margin_floor: 15000, motivation_score: 6 },
      current: null, sensitivity: [],
    },
    lineage: { engine: 'acquisition_decision_engine', engineVersion: '2.0.0', policyVersion: 'assignment_margin_v1', computedAt: '2026-09-30T15:18:26.744Z', snapshotCount: 2, latestSnapshotAt: null, snapshotMatchesProjection: true },
    contact: { threadKey: '+15550000001', phone: '+15550000001', sellerName: 'Owner Redacted', contactability: 'contactable', suppressed: false, temperature: 'warm', lifecycleStage: 'offer', operationalStatus: 'waiting_on_seller', conversationStatus: null, disposition: null, lastIntent: null, lastInboundAt: null, lastOutboundAt: null, latestDirection: 'outbound', messageCount: 11 },
    automation: {
      lane: { key: 'blocked', label: 'Automation overdue', detail: 'Queued reply never went out', since: null, reason: 'automation_overdue' }, stall: null, thread: null, execution: null,
      negotiation: { nextMove: 'send_message_now', nextMoveLabel: 'Send message now', nextActionDueAt: null, lastAction: 'Offer queued', strategy: null, humanReviewReason: 'Ambiguous intent', contractReadiness: 'Not ready', unresolvedContractFields: [{ key: 'signers_identified', label: 'Signers identified' }, { key: 'seller_email', label: 'Seller email' }], sellerSentiment: null, round: 0, minimumAssignmentMargin: 15000 },
    },
    freshness: null,
  }
  return { ...(base as unknown as DiDecision), ...over }
}


const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const noop = () => {}
const engine = { canRun: true, running: false, onRun: noop, error: null }

describe('IA: one section per evidence family, in reading order', () => {
  it('Decision · Evidence · Comps · Seller · Debt & liens · Market & transactions · Records · Model on keys 1–8, in tab order', () => {
    expect(DI_MODES.map((m) => m.label)).toEqual(['Decision', 'Evidence', 'Comps', 'Seller', 'Debt & liens', 'Market & transactions', 'Records', 'Model'])
    // keys stay consecutive after the merge: the Nth tab is key N
    expect(DI_MODES.map((m) => m.key)).toEqual(DI_MODES.map((_, i) => String(i + 1)))
    expect(new Set(DI_MODES.map((m) => m.id)).size).toBe(DI_MODES.length)
  })
  it('old links keep landing: ?mode=transactions opens Market & transactions', () => {
    expect(modeFromSearch('?mode=transactions')).toBe('market')
    expect(modeFromSearch('?mode=market')).toBe('market')
  })
  it('Market & transactions renders both halves in one section — compact empties, never two near-empty tabs', () => {
    const t = text(<MarketTransactionsSection d={fixture()} now={Date.parse('2026-10-10')} onSelect={noop} />)
    expect(t).toContain('Market & transactions')
    expect(t).toContain('Nearby sales unavailable')
    expect(t).toContain('Buyer Match demand')
    expect(t).toContain('1 recorded event on this property')
    expect(t).toContain('Fha recorded')
    const none = text(<MarketTransactionsSection d={fixture({ history: [] })} now={Date.parse('2026-10-10')} onSelect={noop} />)
    expect(none).toContain('No recorded transactions')
  })
  it('the evidence index separates source evidence from inference', () => {
    const rows = evidenceLedger(fixture())
    const by = Object.fromEntries(rows.map((r) => [r.key, r.basis]))
    expect(by.engine_value).toBe('modeled')
    expect(by.avm).toBe('estimated')
    expect(by.open_balance).toBe('estimated')
    expect(by.tax).toBe('recorded')
    expect(by['fact:occupancy_record']).toBe('recorded')
    expect(by['fact:occupancy_seller']).toBe('seller')
    expect(by['fact:interest_seller']).toBe('inferred') // extracted from the message, not said verbatim
    expect(rows.filter((r) => isSourceBasis(r.basis)).length).toBeGreaterThan(0)
    expect(familyCards(fixture()).map((c) => c.mode)).toEqual(['comps', 'seller', 'debt', 'market', 'records'])
    expect(familyCards(fixture()).find((c) => c.mode === 'market')?.label).toBe('Market & transactions')
    const t = text(<EvidenceIndex d={fixture()} onOpen={noop} />)
    expect(t).toContain('Source evidence')
    expect(t).toContain('Inference')
    expect(t).toContain('12 priced by the engine of 100 screened')
  })
})

describe('Comps render with data', () => {
  it('an analyzed property renders the engine comp set with a buyer type per comp', () => {
    const t = text(<CompsSection d={fixture()} selection={null} onSelect={noop} links={null} now={Date.parse('2026-10-10')} engine={engine} />)
    expect(t).toContain('12 qualified of 100 screened')
    expect(t).toContain('Every qualified comp, as the engine weighted it')
    expect(t).toContain('Buyer type on')
    expect(t).not.toContain('has not priced this property')
  })
  it('the DI comp buyer: an LLC deed buyer is an entity investor; a recorded individual is never named', () => {
    const [ind, llc] = fixture().comps!.top
    expect(dealCompBuyer(llc, null)).toMatchObject({ entity: 'entity', use: 'investor', label: 'LLC investor', name: 'Pinewood LLC' })
    expect(dealCompBuyer(ind, null)).toMatchObject({ entity: 'individual', label: 'Individual', name: null })
  })
  it('an UNANALYZED property shows the recorded nearby sales as candidates, plus Analyze', () => {
    const base = fixture().comps!.top[1]
    CANDIDATES = [0.4, 0.2, 0.9].map((mi, i) => ({
      key: `t:${i}`, corpus: 'transaction_corpus', compId: null, propertyId: `p${i}`, address: `${100 + i} Test St, Minneapolis`, city: null, zip: null, lat: 45, lng: -93,
      salePrice: 200000 + i, saleDate: '2026-05-01', distanceMiles: mi, propertyType: 'Single Family', units: 1, beds: 3, baths: 1, sqft: 1400, lotSqft: null, yearBuilt: 1920,
      condition: null, renovation: null, ppsf: 140, ppu: null, source: 'Recorded deed', mls: false, buyerKind: i === 0 ? 'company' : null, buyerCompany: i === 0 ? 'Test Homes LLC' : null,
      buyerId: null, buyerAcquisitions: null, buyerActivity: null, sellerKind: null, armsLength: true, cash: null, docType: null, photo: null, assetMatch: true, state: 'candidate',
      reasons: [], engine: null, compare: { sqftPct: null, beds: null, baths: null, years: null, lotPct: null, units: null, days: null },
    }) as EvidenceComp)
    expect(candidateRows(CANDIDATES).map((c) => c.distanceMiles)).toEqual([0.2, 0.4, 0.9])
    const t = text(<CompsSection d={fixture({ comps: null, decision: { status: 'not_run' } as DiDecision['decision'] })} selection={null} onSelect={noop} links={null} now={Date.parse('2026-10-10')} engine={engine} />)
    expect(t).toContain('The decision engine has not priced this property')
    expect(t).toContain('Analyze property')
    expect(t).toContain('3 nearest of 3 sales within 1 mi')
    void base
  })
})

describe('Seller: age shown (display only), contact score on 0–100', () => {
  const withPeople = () => fixture({ record: { ...fixture().record, prospects: [{ id: 'p1', name: 'Person Redacted', primary: true, age: 71, language: 'Spanish', contactScore: 88, fields: [{ label: 'Age', value: '71 (from birth month on record)' }, { label: 'Contact score', value: '88 / 100 (vendor 105 of 120)' }] }] } })
  it('reads age, language and the bounded contact score from the primary person', () => {
    expect(sellerIdentityFacts(withPeople())).toEqual({ age: 71, language: 'Spanish', contactScore: 88 })
    expect(sellerIdentityFacts(fixture({ record: { ...fixture().record, prospects: [{ id: 'p', name: 'x', primary: true, contactScore: 140, fields: [] }] } })).contactScore).toBe(100)
    expect(sellerIdentityFacts(fixture())).toEqual({ age: null, language: null, contactScore: null })
  })
  it('renders age and language beside each other, and the score with its scale', () => {
    const t = text(<SellerMode d={withPeople()} selection={null} onSelect={noop} links={null} now={Date.parse('2026-10-10')} />)
    expect(t).toContain('Age 71')
    expect(t).toContain('Language Spanish')
    expect(t).toContain('88 /100')
    expect(t).not.toContain('105 /100')
  })
})

import { describe, expect, it } from 'vitest'
import {
  confidenceModel, decisionState, economicBridge, evidenceGaps, factsDiffer, gateViews, layoutLanes, namesMatch, niceTicks,
  offerFigures, offerTrack, presetInputs, priceSteps, recordCategories, scenarioOutcome, sensitivityGrid, snapshotRows,
  spectrumModel, statusContradicted, thesis, underwritingStatus, weightsFromFormula,
} from './di-model'
import { buildDiPath, fetchKey, isDiLocation, modeFromSearch, sameSubject, searchOf, subjectFromSearch } from './di-subject'
import type { DiDecision } from './di-types'

/**
 * A decision shaped exactly like the read model returned for 273312064
 * (3635 Emerson Ave N, Minneapolis) on 2026-10-01 — trimmed to what the
 * model reads. No network: the shape is the contract.
 */
function fixture(over: Partial<DiDecision> = {}): DiDecision {
  const base = {
    generatedAt: '2026-10-01T10:00:00Z',
    subject: { propertyId: '273312064', address: '3635 Emerson Ave N, Minneapolis, Mn 55412', city: 'Minneapolis', state: 'MN', zip: '55412', market: 'Minneapolis, MN', propertyType: 'Single Family', units: 1, beds: 4, baths: 2, sqft: 1853, yearBuilt: 1907, lat: 45.021381, lng: -93.294633, mls: null, isCanary: false },
    pipeline: { opportunityId: 'e1db7c94-60ba-4438-af41-80b6b08535b1', stage: 'offer', stageLabel: 'Offer', status: 'active', threadKey: '+16122756497', lastActivityAt: null, stageEnteredAt: null },
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
    record: { sections: [{ title: 'Ownership', fields: [{ label: 'Owner of record', value: 'Gale D Leflore' }, { label: 'Corporate owner', value: 'No' }] }, { title: 'Value & equity', fields: [{ label: 'AVM', value: '$213,000' }] }], owner: null, prospects: [] },
    history: [{ at: '2011-07-27', kind: 'mortgage', title: 'Fha recorded', amount: 91617, detail: 'First Guaranty Mortgage Corp' }],
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
    contact: { threadKey: '+16122756497', phone: '+16122756497', sellerName: 'Gale D Leflore', contactability: 'contactable', suppressed: false, temperature: 'warm', lifecycleStage: 'offer', operationalStatus: 'waiting_on_seller', conversationStatus: null, disposition: null, lastIntent: null, lastInboundAt: null, lastOutboundAt: null, latestDirection: 'outbound', messageCount: 11 },
    automation: {
      lane: { key: 'blocked', label: 'Automation overdue', detail: 'Queued reply never went out', since: null, reason: 'automation_overdue' }, stall: null, thread: null, execution: null,
      negotiation: { nextMove: 'send_message_now', nextMoveLabel: 'Send message now', nextActionDueAt: null, lastAction: 'Offer queued', strategy: null, humanReviewReason: 'Ambiguous intent', contractReadiness: 'Not ready', unresolvedContractFields: [{ key: 'signers_identified', label: 'Signers identified' }, { key: 'seller_email', label: 'Seller email' }], sellerSentiment: null, round: 0, minimumAssignmentMargin: 15000 },
    },
    freshness: null,
  }
  return { ...(base as unknown as DiDecision), ...over }
}

describe('decision state + authority', () => {
  it('names the canonical tier and whether the machine may act', () => {
    const s = decisionState(fixture())
    expect(s.label).toBe('Range offer authorized')
    expect(s.tone).toBe('go')
    expect(s.authority.kind).toBe('may_present')
    expect(s.authority.range).toEqual([157700, 188900])
  })
  it('a property the engine never priced says so', () => {
    const s = decisionState(fixture({ decision: { status: 'not_run' } }))
    expect(s.analyzed).toBe(false)
    expect(s.label).toBe('Not analyzed')
  })
})

describe('offer geometry', () => {
  it('derives the margin boundaries from the engine’s own ceiling and policy', () => {
    const f = offerFigures(fixture())
    expect(f.maxForTarget).toBe(188900 - 18885)
    expect(f.maxForMinimum).toBe(173900)
    expect(f.behaviorBinds).toBe(false) // the $22M observed ceiling did not lower the $188.8K one
  })
  it('the offer band grades every price against target / minimum / ceiling', () => {
    const t = offerTrack(offerFigures(fixture()))!
    expect(t.zones.map((z) => z.key)).toEqual(['target', 'minimum', 'below', 'over'])
    for (const z of t.zones) expect(z.to).toBeGreaterThan(z.from)
  })
  it('a far ask stays a pin at the edge instead of crushing the band', () => {
    const d = fixture()
    d.offer!.negotiation.ask = 500000
    const t = offerTrack(offerFigures(d))!
    expect(t.pins.find((p) => p.key === 'ask')?.offScale).toBe('right')
  })
})

describe('spectrum', () => {
  it('places engine, AVM, offer and ceiling on the server scale, comps as weighted dots', () => {
    const s = spectrumModel(fixture())!
    expect(s.min).toBe(134204)
    expect(s.markers.map((m) => m.key)).toEqual(['recommended', 'ceiling', 'avm', 'engine'])
    expect(s.comps).toHaveLength(2)
    expect(s.offer!.from).toBeLessThan(s.offer!.to)
    expect(s.authorized!.to).toBeGreaterThan(s.offer!.to)
  })
  it('label lanes never stack two close markers on one row', () => {
    const lanes = layoutLanes([{ at: 0.1 }, { at: 0.12 }, { at: 0.5 }], 900, 104)
    expect(lanes[0]).not.toBe(lanes[1])
  })
  it('ticks are round numbers', () => {
    expect(niceTicks(134204, 474896, 7).map((t) => t.v)).toEqual([150000, 200000, 250000, 300000, 350000, 400000, 450000])
  })
})

describe('confidence decomposition', () => {
  it('follows the engine formula and names the largest loss', () => {
    expect(weightsFromFormula('45% valuation + 20% subject completeness + 20% buyer behavior + 15% finance/distress completeness')).toEqual({ valuation: 0.45, subject: 0.2, buyer: 0.2, finance: 0.15 })
    const c = confidenceModel(fixture())!
    expect(c.rows.reduce((s, r) => s + (r.contribution ?? 0), 0)).toBeCloseTo(75.5, 1)
    expect(c.largest?.key).toBe('valuation')
    expect(c.largest?.lost).toBe(11.7)
  })
})

describe('gates', () => {
  it('show the compared value, threshold and the gap', () => {
    const g = gateViews(fixture())
    const v = g.find((x) => x.key === 'valuation_confidence_at_least_80')!
    expect(v.display).toBe('74 < 80')
    expect(v.gapText).toBe('6 short')
    expect(g.find((x) => x.key === 'assignment_fee_meets_minimum_economics')!.display).toBe('$20.3K ≥ $15K')
  })
})

describe('economic bridge', () => {
  it('is the engine’s chain: value × factor − repairs = ceiling; ceiling − offer = fee', () => {
    const b = economicBridge(fixture())!
    expect(b.steps.map((s) => s.key)).toEqual(['value', 'factor', 'repairs', 'ceiling', 'offer', 'fee'])
    expect(b.steps.find((s) => s.key === 'fee')!.value).toBe(20300)
    expect(b.steps.find((s) => s.key === 'repairs')!.tag).toBe('estimated')
  })
})

describe('gaps, thesis, identity', () => {
  it('asks for the ask first when fit cannot be judged, then condition, then contract facts at offer', () => {
    const g = evidenceGaps(fixture())
    expect(g.map((x) => x.key).slice(0, 3)).toEqual(['ask', 'condition', 'contract'])
    expect(g[0].reason).toMatch(/fit: Unknown/)
  })
  it('the thesis explains the best strategy with the engine’s own rule', () => {
    const t = thesis(fixture())
    expect(t.find((l) => l.key === 'best')!.text).toMatch(/cash is viable: fee \$20\.3K ≥ \$11\.3K/)
    expect(t.find((l) => l.key === 'seller')!.text).toMatch(/Ask not captured/)
  })
  it('an unknown is an absence, not a conflict', () => {
    expect(factsDiffer([{ display: 'Unknown' }, { display: 'Owner Occupied' }])).toBe(false)
    expect(factsDiffer([{ display: 'Vacant' }, { display: 'Owner Occupied' }])).toBe(true)
    expect(namesMatch('Gale D Leflore', 'GALE D LEFLORE')).toBe(true)
    expect(namesMatch('Kevin Smith', 'Wendy Stuhr')).toBe(false)
  })
})

describe('scenario lab (engine arithmetic, never persisted)', () => {
  const base = fixture().scenario!.inputs!
  it('base replays the stored offer', () => {
    const o = scenarioOutcome(base)
    expect(o.result.recommended_offer).toBe(168600)
    expect(o.result.effective_ceiling).toBe(188900)
  })
  it('presets are the recorded sensitivity probes, applied together', () => {
    const c = presetInputs(base, 'conservative')
    expect(c.valuation_mid).toBeCloseTo(344375, 0)
    expect(c.repairs).toBe(74900)
    expect(c.valuation_confidence).toBe(64)
  })
  it('paying more moves the spread through the margin zones', () => {
    expect(scenarioOutcome(base, 165000).zone).toBe('target')
    expect(scenarioOutcome(base, 172000).zone).toBe('minimum')
    expect(scenarioOutcome(base, 180000).zone).toBe('below')
  })
  it('the price × repairs matrix gets worse as both rise', () => {
    const prices = priceSteps(157700, 188900, 8)
    expect(prices).toEqual([...prices].sort((a, b) => a - b))
    const grid = sensitivityGrid(base, prices, [44900, 64900, 84900])
    expect(grid[0][0].spread).toBeGreaterThan(grid[2][7].spread)
    expect(grid[2][7].zone).toBe('below')
  })
})

describe('snapshots, records, status', () => {
  it('compares each snapshot with the one before, newest first', () => {
    const rows = snapshotRows(fixture())
    expect(rows[0].delta?.mid).toBe(0)
    expect(rows[rows.length - 1].delta).toBeNull()
  })
  it('groups the record by category, leading with populated key values', () => {
    const cats = recordCategories(fixture())
    expect(cats.map((c) => c.key)).toEqual(['valuation', 'ownership', 'transactions'])
    expect(cats.find((c) => c.key === 'ownership')!.summary[0]).toMatchObject({ label: 'Owner of record', value: 'Gale D Leflore' })
  })
  it('stale only when an input changed after the analysis', () => {
    expect(underwritingStatus({ d: fixture(), pending: false, error: null, recomputing: false }).key).toBe('analyzed')
    const stale = fixture({ risks: [{ key: 'ask_changed_after_analysis', severity: 'medium', title: 'Ask changed', detail: 'Seller moved', source: 'x' }] })
    expect(underwritingStatus({ d: stale, pending: false, error: null, recomputing: false }).key).toBe('stale')
  })
})

describe('conversation status', () => {
  it('a not_contacted status on a thread with messages is contradicted by its own facts (273312064)', () => {
    const live = { lastInboundAt: '2026-10-01T12:58:37Z', lastOutboundAt: '2026-10-01T12:47:09Z', messageCount: 18 }
    expect(statusContradicted('not_contacted', live)).toBe(true)
    expect(statusContradicted('waiting_on_seller', live)).toBe(false)
    expect(statusContradicted('not_contacted', { lastInboundAt: null, lastOutboundAt: null, messageCount: 0 })).toBe(false)
    expect(statusContradicted(null, live)).toBe(false)
  })
})

describe('subject contract', () => {
  it('reads and writes only on its own route, as the workspace interceptor attributes paths', () => {
    expect(isDiLocation('/deal-intelligence')).toBe(true)
    expect(isDiLocation('/deal-intelligence?property_id=273312064&mode=record')).toBe(true)
    expect(isDiLocation(buildDiPath(subjectFromSearch('?property=273312064'), 'scenario'))).toBe(true)
    // the shell already pointed this pane at another app: never adopt its params or rewrite it
    expect(isDiLocation('/map?property_id=273312064')).toBe(false)
    expect(isDiLocation('/inbox?thread_key=%2B16122756497')).toBe(false)
    expect(isDiLocation('')).toBe(false)
  })
  it('reads every spelling of the subject from a pane location', () => {
    expect(subjectFromSearch(searchOf('/deal-intelligence?property=273312064')).propertyId).toBe('273312064')
    expect(subjectFromSearch('?property_id=1&thread_key=%2B16122756497').threadKey).toBe('+16122756497')
    expect(subjectFromSearch('?opp=e1db7c94').opportunityId).toBe('e1db7c94')
    expect(modeFromSearch('?mode=scenario')).toBe('scenario')
    expect(modeFromSearch('?mode=bogus')).toBeNull()
  })
  it('keys on property, then thread, then opportunity — a resolved thread is the same subject', () => {
    expect(fetchKey(subjectFromSearch('?property_id=1&thread_key=2'))).toBe('p:1')
    expect(fetchKey(subjectFromSearch('?thread_key=2'))).toBe('t:2')
    const fromThread = subjectFromSearch('?thread_key=%2B16122756497')
    const fromProperty = subjectFromSearch('?property_id=273312064')
    expect(sameSubject(fromThread, fromProperty, { propertyId: '273312064', threadKey: '+16122756497' })).toBe(true)
    expect(buildDiPath(fromProperty, 'evidence')).toBe('/deal-intelligence?property_id=273312064&mode=evidence')
  })
})

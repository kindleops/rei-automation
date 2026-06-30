import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBidSegments } from '../../src/modules/inbox/buyer-match-v4/buyerBidSegments'
import { filterAndSortBuyers, countBuyers, buildMatchChips } from '../../src/modules/inbox/buyer-match-v4/buyerFilters'
import { buildBuyerDossier } from '../../src/modules/inbox/buyer-match-v4/buildBuyerDossier'
import {
  fmtCurrency,
  fmtMarketValue,
  fmtBuyerExit,
  isUnavailableValue,
} from '../../src/modules/inbox/buyer-match-v4/formatters'
import { TAB_LAYOUT_COLUMNS, INITIAL_SHELL_STATE, PROJECTION_LOAD_TIMEOUT_MS } from '../../src/modules/inbox/buyer-match-v4/buyer-match-v4.types'

const sampleBuyer = {
  buyerId: 'b1',
  buyerName: 'Acme Capital',
  entityType: 'corporate',
  buyerArchetype: 'INSTITUTIONAL_OPERATOR',
  buyerClass: 'INSTITUTIONAL_OPERATOR' as const,
  institutionalStatus: 'VERIFIED_INSTITUTIONAL',
  matchScore: 92,
  matchGrade: 'A+',
  matchConfidence: 0.9,
  reasonSummary: ['5 purchases in this ZIP'],
  likelyBidLow: 280000,
  likelyBidBase: 320000,
  likelyBidHigh: 350000,
  purchases90d: 2,
  purchases180d: 4,
  purchases365d: 8,
  lastPurchaseAt: '2026-01-15',
  nearestPurchaseMiles: 0.8,
  contactReadiness: 'ENRICHMENT_REQUIRED' as const,
}

const sampleProjection = {
  version: 'buyer_match_v4.0',
  subject: { propertyId: '1', canonicalAddress: 'x', latitude: 1, longitude: 2, assetLane: null, propertySubtype: null, acquisitionContext: { marketValue: null, buyerExitLow: null, buyerExitBase: null, buyerExitHigh: null, strategy: null, executionState: null, source: 'UNAVAILABLE' as const } },
  market: {
    dataState: 'READY' as const,
    fallbackLevel: 'EXACT_ZIP' as const,
    verifiedBuyerCount: 2,
    highFitBuyerCount: 1,
    activeBuyerCount90d: 1,
    activeBuyerCount180d: 2,
    institutionalBuyerCount: 1,
    repeatBuyerCount: 1,
    verifiedPurchaseEventCount: 3,
    mappedPurchaseEventCount: 3,
    likelyBidLow: 191000,
    likelyBidBase: 344000,
    likelyBidHigh: 1190000,
    liquidityScore: 70,
    demandScore: 80,
    refreshedAt: null,
  },
  rankedBuyers: [sampleBuyer, { ...sampleBuyer, buyerId: 'b2', matchGrade: 'B', matchScore: 60, institutionalStatus: null }],
  purchaseEvents: [{
    eventId: 'e1', buyerId: 'b1', address: '123 Main', latitude: 1.1, longitude: 2.1,
    purchaseDate: '2026-02-01', purchasePrice: 310000, assetLane: 'single_family', distanceMiles: 0.5, source: 'buyer_purchase_events_v2',
  }],
  institutionalActivity: [],
  shortlist: [],
}

test('unavailable values never format as $0', () => {
  assert.equal(fmtCurrency(0), '—')
  assert.equal(fmtMarketValue(0, 'UNAVAILABLE'), 'Canonical V3 value unavailable')
  assert.equal(fmtBuyerExit(0, 0, 0), 'Not yet underwritten')
  assert.equal(isUnavailableValue(0), true)
})

test('bid segments prioritize high-fit and median over broad range', () => {
  const seg = buildBidSegments(sampleProjection)
  assert.ok(seg.highFitLow != null)
  assert.ok(seg.medianLikelyBid != null)
  assert.equal(seg.broadLow, 191000)
  assert.equal(seg.broadHigh, 1190000)
})

test('buyer filters and sort return filtered directory', () => {
  const filtered = filterAndSortBuyers(sampleProjection.rankedBuyers, {
    grade: 'A+',
    directoryMode: 'best_match',
    institutionalOnly: false,
    active90d: false,
    active180d: false,
    contactReady: false,
    exactZip: false,
    sort: 'best_match',
  })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].buyerId, 'b1')
  const counts = countBuyers(sampleProjection.rankedBuyers)
  assert.equal(counts.total, 2)
  assert.equal(counts.highFit, 1)
})

test('dossier populates from buyer and events', () => {
  const dossier = buildBuyerDossier(sampleBuyer, sampleProjection.purchaseEvents)
  assert.ok(dossier.matchThesis.length > 0)
  assert.equal(dossier.events.length, 1)
  assert.ok(dossier.buyBox.some((r) => r.inferred))
})

test('match chips are concise', () => {
  const chips = buildMatchChips(sampleBuyer)
  assert.ok(chips.length >= 1)
  assert.ok(chips.length <= 5)
})

test('tab layouts use distinct column ratios', () => {
  assert.equal(TAB_LAYOUT_COLUMNS.MARKET.main, '48%')
  assert.equal(TAB_LAYOUT_COLUMNS.BUYERS.main, '50%')
  assert.equal(TAB_LAYOUT_COLUMNS.PURCHASE_ACTIVITY.main, '55%')
  assert.equal(TAB_LAYOUT_COLUMNS.INSTITUTIONS.main, '50%')
  assert.notEqual(TAB_LAYOUT_COLUMNS.MARKET.right, TAB_LAYOUT_COLUMNS.BUYERS.right)
})

test('shell initial state preserves tab and clears shortlist on property reset pattern', () => {
  assert.equal(INITIAL_SHELL_STATE.activeTab, 'MARKET')
  assert.deepEqual(INITIAL_SHELL_STATE.shortlistIds, [])
})

test('projection load timeout is bounded', () => {
  assert.ok(PROJECTION_LOAD_TIMEOUT_MS >= 10_000)
  assert.ok(PROJECTION_LOAD_TIMEOUT_MS <= 60_000)
})
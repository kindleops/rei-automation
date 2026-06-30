import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBuyerMatchSubjectContext, subjectContextKey } from '../../src/modules/inbox/buyer-match-v4/buildSubjectContext'
import {
  shouldRejectStaleProjection,
  unwrapBuyerMatchV4Projection,
} from '../../src/modules/inbox/buyer-match-v4/useBuyerMatchV4Projection'

test('buildBuyerMatchSubjectContext uses property_id not address alone', () => {
  const subject = buildBuyerMatchSubjectContext({
    propertyId: '2131309217',
    propertyAddress: '4940 Broom St',
    propertyZip: '77091',
    propertyState: 'TX',
    acquisition_decision: {
      canonical_asset_lane: 'single_family',
      execution_state: 'SHADOW_MODE_READY',
      value_contract: {
        qualified_market_value: { mid: 332000 },
        qualified_buyer_exit: { conservative: 318000, base: 332000, optimistic: 346000 },
      },
      strategy: 'CASH',
    },
  } as never)

  assert.equal(subject.propertyId, '2131309217')
  assert.equal(subject.assetLane, 'single_family')
  assert.equal(subject.marketValue, 332000)
  assert.equal(subject.buyerExitBase, 332000)
  assert.equal(subject.executionState, 'SHADOW_MODE_READY')
  assert.equal(subject.strategy, 'CASH')
})

test('subjectContextKey prefers propertyId', () => {
  const key = subjectContextKey({
    propertyId: '2109544499',
    opportunityId: null,
    threadKey: null,
    canonicalAddress: '120 N 44th Ave W',
    latitude: null,
    longitude: null,
    assetLane: null,
    propertySubtype: null,
    units: null,
    buildingSquareFeet: null,
    lotSquareFeet: null,
    yearBuilt: null,
    acquisitionDecisionVersion: null,
    marketValue: null,
    buyerExitLow: null,
    buyerExitBase: null,
    buyerExitHigh: null,
    strategy: null,
    repairEstimate: null,
    executionState: null,
  })
  assert.equal(key, '2109544499')
})

test('shouldRejectStaleProjection rejects responses for previous property', () => {
  assert.equal(shouldRejectStaleProjection('property-a', 'property-b'), true)
  assert.equal(shouldRejectStaleProjection('property-a', 'property-a'), false)
})

test('unwrapBuyerMatchV4Projection unwraps callBackend API envelope', () => {
  const projection = {
    version: 'buyer_match_v4.0',
    subject: { propertyId: '2131309217' },
    market: { dataState: 'READY' },
    rankedBuyers: [],
    purchaseEvents: [],
    institutionalActivity: [],
    shortlist: [],
    meta: {},
  }
  const apiBody = { ok: true, data: projection }
  assert.deepEqual(unwrapBuyerMatchV4Projection(apiBody), projection)
  assert.deepEqual(unwrapBuyerMatchV4Projection(projection), projection)
})
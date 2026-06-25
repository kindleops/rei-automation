import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getAuthorizedOffer,
  getDisplayMarketValue,
  getShadowOffer,
  isAuthoritativeV3,
  isDegradedEvidenceOnly,
} from '../../src/views/comp-intelligence/adapters/compDecisionProjection'
import type { CompIntelligencePayload } from '../../src/domain/comp-intelligence/types'

const authoritativePayload: CompIntelligencePayload = {
  subject: {
    property_id: '2130847744',
    coordinate_source: 'properties',
    coordinate_confidence: 90,
    is_market_fallback: false,
    is_subject_resolved: true,
  },
  decision_projection: {
    engine_version: 'acquisition_v3',
    formula_version: '3.0',
    canonical_asset_lane: 'SFR',
    asset_lane_confidence: 88,
    execution_state: 'SHADOW_MODE_READY',
    value_classification: 'QUALIFIED',
    final_confidence: 72,
    dominant_model_universe: 'LOCAL_INVESTOR_VALUE',
    dominant_model_ess: 4,
    dominant_model_depth_score: 80,
    dominant_model_confidence_cap: 85,
    execution_state_basis: { basis_strategy: 'CASH' },
    value_contract: {
      qualified_market_value: { low: 180000, mid: 208000, high: 220000 },
      scenario_market_value: null,
      qualified_buyer_exit: { conservative: 175000, base: 190000, optimistic: 205000 },
      scenario_buyer_exit: null,
    },
    offer_authorization: {
      authorized_opening_offer: null,
      authorized_recommended_offer: null,
      authorized_maximum_offer: null,
      authorized_walkaway_price: null,
      scenario_opening_offer: 70000,
      scenario_recommended_offer: 80900,
      scenario_maximum_offer: 85000,
      scenario_walkaway_price: 65000,
    },
    strategy_ranking: { primary_strategy: 'CASH', backup_strategy: 'NOVATION', ranked: [] },
    projection_mode: 'authoritative_v3',
    shadow_mode: true,
    primary_strategy: 'CASH',
  },
  transaction_evidence: [],
  discovery: {
    search_mode: 'subject_radius',
    is_market_fallback: false,
    relaxations: [],
    candidates: [],
    included: [],
    excluded: [],
    counts: { total: 0, included: 0, excluded: 0 },
  },
  valuation: { model_version: 'legacy', arv: null, as_is_value: null, repair_estimate: null, confidence: 0, data_gaps: [], warnings: [], outputs: {} },
  valuation_state: { state: 'ready', label: 'Ready' },
  legacy_valuation: {
    model_version: 'comp_intelligence_valuation_v1',
    arv: 500000,
    as_is_value: null,
    repair_estimate: null,
    confidence: 70,
    data_gaps: [],
    warnings: [],
    outputs: {},
    authoritative: false,
    label: 'Legacy',
  },
}

test('official UI uses V3 decision projection', () => {
  assert.equal(isAuthoritativeV3(authoritativePayload), true)
  const market = getDisplayMarketValue(authoritativePayload.decision_projection!)
  assert.equal(market.value, 208000)
  assert.equal(market.classification, 'QUALIFIED')
})

test('legacy valuation is not authoritative', () => {
  assert.equal(authoritativePayload.legacy_valuation?.authoritative, false)
  assert.notEqual(authoritativePayload.legacy_valuation?.arv, getDisplayMarketValue(authoritativePayload.decision_projection!).value)
})

test('shadow versus authorized offer is distinct', () => {
  assert.equal(getAuthorizedOffer(authoritativePayload.decision_projection!), null)
  assert.equal(getShadowOffer(authoritativePayload.decision_projection!), 80900)
})

test('degraded fallback cannot be authoritative', () => {
  const degraded: CompIntelligencePayload = {
    ...authoritativePayload,
    data_source_mode: 'EVIDENCE_ONLY_DEGRADED',
    decision_projection: {
      ...authoritativePayload.decision_projection!,
      execution_state: 'EVIDENCE_ONLY_DEGRADED',
      projection_mode: 'evidence_only_degraded',
      value_contract: {
        qualified_market_value: null,
        scenario_market_value: null,
        qualified_buyer_exit: null,
        scenario_buyer_exit: null,
      },
      offer_authorization: {
        authorized_opening_offer: null,
        authorized_recommended_offer: null,
        authorized_maximum_offer: null,
        authorized_walkaway_price: null,
        scenario_opening_offer: null,
        scenario_recommended_offer: null,
        scenario_maximum_offer: null,
        scenario_walkaway_price: null,
      },
    },
  }
  assert.equal(isDegradedEvidenceOnly(degraded), true)
  assert.equal(getDisplayMarketValue(degraded.decision_projection!).value, null)
  assert.equal(getShadowOffer(degraded.decision_projection!), null)
})

test('no hardcoded Google Maps API key in workspace source', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const workspace = fs.readFileSync(
    path.join(process.cwd(), 'src/views/comp-intelligence/CompIntelligenceWorkspace.tsx'),
    'utf8',
  )
  assert.equal(workspace.includes('AIzaSy'), false)
  const evidenceMap = fs.readFileSync(
    path.join(process.cwd(), 'src/views/comp-intelligence/components/EvidenceMap.tsx'),
    'utf8',
  )
  assert.equal(evidenceMap.includes('AIzaSy'), false)
})
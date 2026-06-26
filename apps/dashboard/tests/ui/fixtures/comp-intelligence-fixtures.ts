import type { Page, Route } from '@playwright/test'

export const LAKE_WORTH_PROPERTY_ID = '234334277'

const SUBJECT_RECORD = {
  property_id: LAKE_WORTH_PROPERTY_ID,
  property_address_full: '1021 S N St, Lake Worth Beach, FL 33460',
  property_address_city: 'Lake Worth Beach',
  property_address_state: 'FL',
  property_address_zip: '33460',
  latitude: 26.602867,
  longitude: -80.053624,
  normalized_asset_class: 'SFR',
  market: 'Palm Beach',
}

const COMP_FIXTURE_PAYLOAD = {
  data: {
    subject: {
      property_id: LAKE_WORTH_PROPERTY_ID,
      coordinate_source: 'properties',
      coordinate_confidence: 95,
      is_market_fallback: false,
      is_subject_resolved: true,
      canonical_address: { value: SUBJECT_RECORD.property_address_full, source: 'properties' },
      normalized_address: { value: SUBJECT_RECORD.property_address_full, source: 'properties' },
      latitude: SUBJECT_RECORD.latitude,
      longitude: SUBJECT_RECORD.longitude,
    },
    decision_projection: {
      engine_version: 'acquisition_decision_engine_v3',
      formula_version: 'degraded',
      projection_mode: 'evidence_only_degraded',
      execution_state: 'EVIDENCE_ONLY_DEGRADED',
      value_classification: 'EVIDENCE_ONLY',
      final_confidence: 42,
      dominant_model_universe: 'LOCAL_INVESTOR_VALUE',
      dominant_model_ess: 0,
      dominant_model_depth_score: 40,
      dominant_model_confidence_cap: 55,
      execution_state_basis: { basis_strategy: 'CASH' },
      value_contract: {
        qualified_market_value: null,
        scenario_market_value: null,
        qualified_buyer_exit: null,
        scenario_buyer_exit: null,
      },
      offer_authorization: {
        authorized_opening_offer: null,
        shadow_opening_offer: null,
        offer_band: null,
      },
      strategy_matrix: [],
      model_health: { status: 'DEGRADED', reasons: ['fixture_mode'] },
    },
    transaction_evidence: [
      {
        candidate_id: '234330526',
        property_id: '234330526',
        address: '1015 S N St, Lake Worth Beach, FL',
        sale_price: 485000,
        sale_date: '2025-01-15',
        evidence_role: 'DEGRADED_COMP',
        routed_universe: 'LOCAL_INVESTOR_VALUE',
        pricing_eligibility: false,
        demand_eligibility: false,
        qualification_status: 'EVIDENCE_ONLY',
        evidence_authority: 'DEGRADED_NON_AUTHORITATIVE',
        display_eligible: true,
        geography: { latitude: 26.61051, longitude: -80.051485, distance_miles: 0.52 },
        rejection_review_reasons: [],
        source_lineage: { source_table: 'direct_rpc', source_record_id: '234330526' },
        comp_match_label: 'Recovered evidence',
      },
      {
        candidate_id: '234330527',
        property_id: '234330527',
        address: '1025 S N St, Lake Worth Beach, FL',
        sale_price: 512000,
        sale_date: '2024-11-02',
        evidence_role: 'DEGRADED_COMP',
        routed_universe: 'LOCAL_INVESTOR_VALUE',
        pricing_eligibility: false,
        demand_eligibility: false,
        qualification_status: 'EVIDENCE_ONLY',
        evidence_authority: 'DEGRADED_NON_AUTHORITATIVE',
        display_eligible: true,
        geography: { latitude: 26.60412, longitude: -80.05401, distance_miles: 0.18 },
        rejection_review_reasons: [],
        source_lineage: { source_table: 'direct_rpc', source_record_id: '234330527' },
        comp_match_label: 'Recovered evidence',
      },
    ],
    discovery: {
      search_mode: 'fixture',
      is_market_fallback: false,
      relaxations: [],
      candidates: [],
      included: [],
      excluded: [],
      counts: { total: 2, included: 2, excluded: 0 },
    },
    valuation: {
      model_version: 'degraded',
      arv: null,
      as_is_value: null,
      repair_estimate: null,
      confidence: 0,
      data_gaps: ['fixture_mode'],
      warnings: [],
      outputs: {},
    },
    valuation_state: {
      state: 'ready_with_limitations',
      label: 'Evidence recovered',
      detail: 'Deterministic fixture payload',
    },
    projection_meta: {
      read_only: true,
      persisted: false,
      score_table_write: false,
      snapshot_write: false,
      event_publication: false,
      outbound_execution: false,
    },
    data_source_mode: 'EVIDENCE_ONLY_DEGRADED',
  },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export async function installCompIntelligenceFixtures(page: Page, propertyId = LAKE_WORTH_PROPERTY_ID) {
  await page.route('**/api/cockpit/health**', (route) => json(route, { status: 'ok' }))
  await page.route('**/api/cockpit/inbox/live**', (route) => json(route, { threads: [], rows: [], meta: { fixture: true } }))
  await page.route('**/api/cockpit/inbox/counts**', (route) => json(route, { counts: {} }))
  await page.route(`**/api/cockpit/properties/${propertyId}/comp-intelligence**`, (route) =>
    json(route, COMP_FIXTURE_PAYLOAD),
  )
  await page.route(`**/api/cockpit/properties/${propertyId}/subject**`, (route) =>
    json(route, { data: COMP_FIXTURE_PAYLOAD.data.subject }),
  )
  await page.route('**/rest/v1/properties**', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return json(route, [SUBJECT_RECORD])
  })
}

export async function setNexusTheme(page: Page, theme: 'dark' | 'light' | 'red_ops') {
  await page.evaluate((next) => {
    document.documentElement.setAttribute('data-nexus-theme', next)
    document.documentElement.classList.toggle('nx-theme-light', next === 'light')
  }, theme)
}
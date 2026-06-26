import { expect, type Page, type Route } from '@playwright/test'

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

function evidenceNumber(value: number, source = 'properties') {
  return { value, source, present: true, missing_reason: null }
}

const CANONICAL_SUBJECT = {
  property_id: LAKE_WORTH_PROPERTY_ID,
  coordinate_source: 'properties',
  coordinate_confidence: 95,
  is_market_fallback: false,
  is_subject_resolved: true,
  canonical_address: { value: SUBJECT_RECORD.property_address_full, source: 'properties' },
  normalized_address: { value: SUBJECT_RECORD.property_address_full, source: 'properties' },
  latitude: evidenceNumber(SUBJECT_RECORD.latitude),
  longitude: evidenceNumber(SUBJECT_RECORD.longitude),
}

const COMP_FIXTURE_PAYLOAD = {
  data: {
    subject: CANONICAL_SUBJECT,
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

const RUNTIME_IDENTITY = {
  commit_sha: 'fixture-comp-intelligence-playwright',
  branch: 'fix/comp-intelligence-runtime-map',
  environment: 'development',
  worktree_id: 'comp-clean-fixtures',
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export async function installCompIntelligenceFixtures(page: Page, propertyId = LAKE_WORTH_PROPERTY_ID) {
  await page.route('**/api/cockpit/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/comp-intelligence')) {
      return json(route, COMP_FIXTURE_PAYLOAD)
    }
    if (url.includes('/subject')) {
      return json(route, { data: CANONICAL_SUBJECT })
    }
    if (url.includes('/runtime-identity')) {
      return json(route, RUNTIME_IDENTITY)
    }
    if (url.includes('/health')) {
      return json(route, { status: 'ok', fixture: true })
    }
    if (url.includes('/inbox/live')) {
      return json(route, { threads: [], rows: [], meta: { fixture: true } })
    }
    if (url.includes('/inbox/counts')) {
      return json(route, { counts: {} })
    }
    return json(route, { ok: true, fixture: true })
  })

  await page.route('**/rest/v1/properties**', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const url = route.request().url()
    if (url.includes(`property_id=eq.${propertyId}`) || url.includes(propertyId)) {
      return json(route, [SUBJECT_RECORD])
    }
    return json(route, [])
  })
  await page.route('**/rest/v1/rpc/**', (route) => json(route, []))
}

async function ensureIntelPaneVisible(workspace: import('@playwright/test').Locator) {
  const shellIntel = workspace.getByRole('button', { name: /^Intelligence$/i })
  if (await shellIntel.isVisible().catch(() => false)) {
    await shellIntel.click()
  }
}

export async function waitForRecoveredEvidence(page: import('@playwright/test').Page) {
  const workspace = page.locator('[data-comp-intelligence="true"]')
  await expect(workspace).toBeVisible({ timeout: 30000 })
  await expect(workspace.locator('.ci-status-bar')).toContainText(/EVIDENCE RECOVERED/i, { timeout: 45000 })
  await expect(workspace).toHaveAttribute('data-evidence-count', /[1-9]/, { timeout: 45000 })
  await expect(workspace).toHaveAttribute('data-mapped-count', /[1-9]/, { timeout: 45000 })

  await ensureIntelPaneVisible(workspace)
  await workspace.getByRole('tab', { name: /Comps/i }).click({ timeout: 10000 })
  await expect(workspace.locator('.ci-evidence-card').first()).toBeVisible({ timeout: 30000 })

  return workspace
}

export async function setNexusTheme(page: Page, theme: 'dark' | 'light' | 'red_ops') {
  await page.evaluate((next) => {
    document.documentElement.setAttribute('data-nexus-theme', next)
    document.documentElement.classList.toggle('nx-theme-light', next === 'light')
  }, theme)
}
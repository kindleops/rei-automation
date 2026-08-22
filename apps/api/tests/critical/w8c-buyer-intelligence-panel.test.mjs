import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildBuyerIntelligencePanel,
  PANEL_STATUS,
  PANEL_LABEL,
} from '../../src/lib/intel/w8c-panel-projection.js';

const DASHBOARD = path.resolve(process.cwd(), '../dashboard/src');
const PANEL_TSX = fs.readFileSync(path.join(DASHBOARD, 'modules/properties/BuyerIntelligencePanel.tsx'), 'utf8');
const LOADER_TS = fs.readFileSync(path.join(DASHBOARD, 'lib/data/buyerIntelligenceData.ts'), 'utf8');
const WORKSPACE_TSX = fs.readFileSync(path.join(DASHBOARD, 'modules/properties/PropertyDetailWorkspace.tsx'), 'utf8');
const ROUTE_SRC = fs.readFileSync(path.join(process.cwd(), 'src/app/api/intel/buyer-intelligence/route.js'), 'utf8');
const PROJECTION_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/intel/w8c-panel-projection.js'), 'utf8');

/**
 * Strip comments so structural assertions scan executable code, not the prose
 * describing it. The loader's header legitimately explains that
 * `reivesti.property_historical_buyers` is service-role only.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RUN = {
  run_id: 'w8c_w8c_buyer_intelligence_v1.0.0_a4f20ced6a54c9d5',
  model_version: 'w8c_buyer_intelligence_v1.0.0',
  w8a_params_version: 'w8a_entity_resolution_v1.1.0',
  w8b_params_version: 'w8b_buyer_behavior_v1.0.0',
};

const COMPANY = 'company:us_ca:202204010011';
const PERSON_RAW = 'person:15090498458';   // real production shape: person:{individual_key}
const INDIVIDUAL_KEY = '15090498458';

/**
 * Production-shaped fixture: one company buyer with a derived buybox and two
 * acquisitions, one person buyer with behavior but too little history for a
 * buybox, plus two REI buyer-match candidates.
 */
function fixtureQuery({ historicalRows = null, reiRows = null, ambiguity = null } = {}) {
  const calls = [];
  const fn = async (sql, params = []) => {
    calls.push({ sql, params });
    const id = params[0];

    if (/buyer_intelligence_version/.test(sql)) return { rows: [RUN] };

    if (/property_historical_buyers/.test(sql)) {
      return { rows: historicalRows ?? [
        { buyer_entity_id: COMPANY, buyer_role: 'buyer_1', entity_type: 'company',
          display_name: 'STONE OAK PARTNERS LLC', resolution_method: 'exact_registry_company_identity',
          confidence: '1.0000', acquired_on: '2026-05-24', acquisition_price: 3116190 },
        { buyer_entity_id: COMPANY, buyer_role: 'buyer_1', entity_type: 'company',
          display_name: 'STONE OAK PARTNERS LLC', resolution_method: 'seller_transaction_registry_exact',
          confidence: '0.9800', acquired_on: '2022-08-09', acquisition_price: null },
        { buyer_entity_id: PERSON_RAW, buyer_role: 'buyer_2', entity_type: 'person',
          display_name: null, resolution_method: 'transaction_linked_contact_evidence',
          confidence: '0.9400', acquired_on: '2026-05-28', acquisition_price: null },
      ] };
    }

    if (/WITH n\(name\)/.test(sql)) return { rows: ambiguity ?? [] };

    if (/reivesti\.buyer_summary/.test(sql)) {
      if (id === COMPANY) return { rows: [{ buyer_entity_id: COMPANY, entity_type: 'company',
        display_name: 'STONE OAK PARTNERS LLC', identity_confidence: '1.0000',
        identity_method: 'exact_registry_company_identity', has_buybox: true }] };
      if (id === PERSON_RAW) return { rows: [{ buyer_entity_id: PERSON_RAW, entity_type: 'person',
        display_name: null, identity_confidence: '0.9400',
        identity_method: 'transaction_linked_contact_evidence', has_buybox: false }] };
      return { rows: [] };
    }

    if (/reivesti\.buyer_behavior/.test(sql)) {
      if (id === COMPANY) return { rows: [{
        buyer_entity_id: COMPANY, acquisition_count: 72, disposition_count: 7,
        last_acquisition: '2026-05-24', days_since_last: 30, trailing_365d: 71,
        activity_status: 'active', activity_score: '88.0', archetype: 'institutional_high_volume_buyer',
        archetype_reasons: ['72 acquisitions (>= 10)'],
        hold_flip_classification: 'flip_like',
        hold_flip_profile: { classification: 'flip_like', median_hold_days: 184, dispositions: 7,
          disposition_rate: 0.0972, confidence: 0.0972 },
        geography_profile: { primary_markets: ['CA|Riverside'], counties: [['CA|Riverside', 58, 0.8056]],
          distinct_counties: 4, distinct_states: 1, concentration_index: 0.6702,
          provenance: ['comp_private'] },
        price_profile: { recent_365d: { median: 2260000 }, lifetime: { p50: 2260000 }, cash_share: 0.8611,
          provenance: ['comp_canonical_transactions.price'] },
        portfolio_state: null, evidence_count: 72, evidence_coverage: '1.0000', confidence: '1.0000',
      }] };
      if (id === PERSON_RAW) return { rows: [{
        buyer_entity_id: PERSON_RAW, acquisition_count: 2, last_acquisition: '2026-05-28',
        activity_status: 'active', activity_score: '41.0', archetype: 'low_volume_buyer',
        portfolio_state: 'empty', portfolio_property_count: 0,
        evidence_count: 2, evidence_coverage: '0.5000', confidence: '0.6100',
      }] };
      return { rows: [] };
    }

    if (/reivesti\.buyer_buybox/.test(sql)) {
      if (id === COMPANY) return { rows: [{
        buyer_entity_id: COMPANY, evidence_depth: 72,
        preferred_counties: ['CA|Riverside'], acceptable_states: ['CA'], preferred_asset_families: ['sfr'],
        price_low: 1633000, price_high: 2898000,
        price_robust_low: 0, price_robust_high: 4795500,
        price_basis: 'trailing_365d_p25_p75', recency_weighting_applied: true, confidence: '1.0000',
        building_sqft_p25: 1200, building_sqft_p75: 2400,
      }] };
      return { rows: [] }; // person: below the three-acquisition bar
    }

    if (/buyer_match_candidates/.test(sql)) {
      return { rows: reiRows ?? [
        { buyer_entity_id: '11111111-2222-3333-4444-555555555555', buyer_display_name: 'Alpha Capital',
          normalized_buyer_name: 'alpha capital', buyer_key: 'bk_alpha', match_grade: 'A', match_score: '91.4' },
        { buyer_entity_id: '99999999-2222-3333-4444-555555555555', buyer_display_name: 'Beta Homes',
          normalized_buyer_name: 'beta homes', buyer_key: 'bk_beta', match_grade: 'B', match_score: '72.0' },
      ] };
    }

    return { rows: [] };
  };
  fn.calls = calls;
  return fn;
}

// 1 ─────────────────────────────────────────────────────────────────────────
test('property with W8C historical buyers projects a full panel', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });

  assert.equal(panel.status, PANEL_STATUS.AVAILABLE);
  assert.equal(panel.label, PANEL_LABEL);
  assert.equal(panel.label, 'Buyer Intelligence — Shadow');
  assert.equal(panel.observationalOnly, true);
  assert.equal(panel.influencesRankingOrPricing, false);
  assert.equal(panel.buyerCount, 2);
  assert.equal(panel.occurrenceCount, 3, 'two company acquisitions + one person acquisition');
  assert.equal(panel.buyersWithBuybox, 1);
  assert.equal(panel.version.runId, RUN.run_id);
  assert.equal(panel.version.modelVersion, 'w8c_buyer_intelligence_v1.0.0');
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('property with no W8C history renders a distinct empty state', async () => {
  const panel = await buildBuyerIntelligencePanel('999', { query: fixtureQuery({ historicalRows: [] }) });
  assert.equal(panel.status, PANEL_STATUS.NO_HISTORY);
  assert.equal(panel.status, 'no_canonical_buyer_history');
  assert.deepEqual(panel.buyers, []);
  // "No history" must never be reported as a failure.
  assert.notEqual(panel.status, PANEL_STATUS.UNAVAILABLE);
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('company buyers expose their registry name and id', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const company = panel.buyers.find((b) => b.entityType === 'company');
  assert.ok(company);
  assert.equal(company.buyerRef, COMPANY);
  assert.equal(company.displayName, 'STONE OAK PARTNERS LLC');
  assert.equal(company.occurrenceCount, 2);
  // The strongest-confidence acquisition supplies the headline method.
  assert.equal(company.resolutionMethod, 'exact_registry_company_identity');
  assert.equal(company.resolutionConfidence, 1);
});

// 4 ─────────────────────────────────────────────────────────────────────────
test('person buyers are redacted and never named', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const person = panel.buyers.find((b) => b.entityType === 'person');
  assert.ok(person);
  assert.match(person.buyerRef, /^person:anon_[0-9a-f]{16}$/);
  assert.equal(person.displayName, null);
  assert.ok(!JSON.stringify(panel).includes(INDIVIDUAL_KEY));
});

// 5 ─────────────────────────────────────────────────────────────────────────
test('behavior metrics are projected as named scalars, not raw jsonb', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const { behavior } = panel.buyers.find((b) => b.entityType === 'company');

  assert.equal(behavior.acquisitionCount, 72);
  assert.equal(behavior.activityStatus, 'active');
  assert.equal(behavior.archetype, 'institutional_high_volume_buyer');
  assert.equal(behavior.holdFlip.classification, 'flip_like');
  assert.equal(behavior.holdFlip.medianHoldDays, 184);
  assert.equal(behavior.holdFlip.dispositionRatePct, 9.7);
  assert.equal(behavior.geography.primaryMarkets[0], 'CA|Riverside');
  assert.equal(behavior.priceMedian, 2260000);
  assert.equal(behavior.evidenceCount, 72);
  assert.equal(behavior.evidenceCoveragePct, 100);
  assert.equal(behavior.confidence, 1);

  // Raw jsonb (and its internal provenance) must not be forwarded.
  const serialized = JSON.stringify(panel);
  assert.ok(!serialized.includes('comp_private'), 'internal provenance leaked to the panel payload');
  assert.ok(!serialized.includes('comp_canonical_transactions'));
  assert.equal(behavior.geographyProfile, undefined);
  assert.equal(behavior.priceProfile, undefined);
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('the robust price band is primary and the core band is secondary', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const { buybox } = panel.buyers.find((b) => b.entityType === 'company');

  assert.equal(buybox.evidenceDepth, 72);
  assert.strictEqual(buybox.priceRobustLow, 0, 'a legitimate zero must survive');
  assert.equal(buybox.priceRobustHigh, 4795500);
  assert.equal(buybox.priceCoreLow, 1633000);
  assert.equal(buybox.priceCoreHigh, 2898000);
  assert.deepEqual(buybox.preferredCounties, ['CA|Riverside']);

  // The UI must present the robust band as the range and mark the core band
  // as narrow/secondary — never as the recommended filter.
  assert.match(PANEL_TSX, /Price range \(robust\)/);
  assert.match(PANEL_TSX, /Core band \(narrow, secondary\)/);
  const robustAt = PANEL_TSX.indexOf('Price range (robust)');
  const coreAt = PANEL_TSX.indexOf('Core band (narrow, secondary)');
  assert.ok(robustAt < coreAt, 'robust band must be rendered before the core band');
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('a buyer below the evidence bar reports insufficient evidence, not failure', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const person = panel.buyers.find((b) => b.entityType === 'person');

  assert.equal(person.buybox, null);
  assert.equal(person.buyboxStatus, 'insufficient_evidence');
  assert.ok(person.behavior, 'behavior still present without a buybox');
  assert.equal(person.behavior.confidence, 0.61);
  // 'empty' portfolio is evidence and must not collapse to 'unknown'.
  assert.equal(person.behavior.portfolioState, 'empty');
  assert.match(PANEL_TSX, /Insufficient history for buybox/);
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('W8C unavailable yields a quiet unavailable panel, never a throw', async () => {
  const failing = async () => { const e = new Error('down'); e.code = '28P01'; throw e; };
  const panel = await buildBuyerIntelligencePanel('278415515', { query: failing });
  assert.equal(panel.status, PANEL_STATUS.UNAVAILABLE);
  assert.match(panel.reason, /w8c_unavailable/);
  assert.deepEqual(panel.buyers, []);

  const noRun = await buildBuyerIntelligencePanel('1', {
    query: async (sql) => (/buyer_intelligence_version/.test(sql) ? { rows: [] } : { rows: [] }),
  });
  assert.equal(noRun.status, PANEL_STATUS.UNAVAILABLE);
  assert.equal(noRun.reason, 'no_current_w8c_run');

  const missingId = await buildBuyerIntelligencePanel('', { query: fixtureQuery() });
  assert.equal(missingId.status, PANEL_STATUS.UNAVAILABLE);
  assert.equal(missingId.reason, 'missing_property_id');
});

// 9 ─────────────────────────────────────────────────────────────────────────
test('the kill switch stops the panel issuing any query', async () => {
  const prior = process.env.W8C_SHADOW_INTELLIGENCE_ENABLED;
  process.env.W8C_SHADOW_INTELLIGENCE_ENABLED = '0';
  try {
    // No injected query: the panel must fall back to the real client, which is
    // disabled, and must not reach the database.
    const panel = await buildBuyerIntelligencePanel('278415515');
    assert.equal(panel.status, PANEL_STATUS.UNAVAILABLE);
    assert.equal(panel.reason, 'w8c_shadow_disabled');
  } finally {
    if (prior === undefined) delete process.env.W8C_SHADOW_INTELLIGENCE_ENABLED;
    else process.env.W8C_SHADOW_INTELLIGENCE_ENABLED = prior;
  }
});

// 10 ────────────────────────────────────────────────────────────────────────
test('property_historical_buyers is read server-side only', async () => {
  // The browser bundle must contain no reference to the service-role view, the
  // reivesti schema, or a database client.
  for (const [name, raw] of [['panel', PANEL_TSX], ['loader', LOADER_TS]]) {
    const src = codeOnly(raw);
    assert.doesNotMatch(src, /property_historical_buyers/, `${name} must not query the service-role view`);
    assert.doesNotMatch(src, /reivesti/, `${name} must not reference the serving schema`);
    assert.doesNotMatch(src, /comp_private/, `${name} must not reference private schema`);
    assert.doesNotMatch(src, /getPgPool|queryWithTimeout|createClient\(/, `${name} must not open a db client`);
  }
  // The client reaches the data only through the authenticated backend route.
  assert.match(LOADER_TS, /callBackend/);
  assert.match(LOADER_TS, /\/api\/intel\/buyer-intelligence/);
  // And that route enforces the existing dashboard auth boundary.
  assert.match(ROUTE_SRC, /ensureMutationAuth/);
  assert.doesNotMatch(ROUTE_SRC, /export async function (POST|PUT|PATCH|DELETE)/);
});

// 11 ────────────────────────────────────────────────────────────────────────
test('no raw person identifier can reach UI or API output', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const serialized = JSON.stringify(panel);

  // Scan for any `person:` token that is not the redacted form.
  const tokens = serialized.match(/person:[A-Za-z0-9_:.-]+/g) ?? [];
  assert.ok(tokens.length > 0, 'fixture must contain at least one person reference');
  for (const token of tokens) {
    assert.match(token, /^person:anon_[0-9a-f]{16}$/, `raw person identifier in payload: ${token}`);
  }
  assert.ok(!serialized.includes(INDIVIDUAL_KEY));

  // No PII columns anywhere in the payload or the UI layer.
  for (const forbidden of [/individual_key/i, /\bphone\b/i, /\bemail\b/i, /owner_name/i, /raw_payload/i]) {
    assert.doesNotMatch(serialized, forbidden, `payload references ${forbidden}`);
    assert.doesNotMatch(PANEL_TSX, forbidden, `panel references ${forbidden}`);
  }
});

// 12 ────────────────────────────────────────────────────────────────────────
test('W8C never reorders or rescores existing buyer-match candidates', async () => {
  const panel = await buildBuyerIntelligencePanel('278415515', { query: fixtureQuery() });
  const rows = panel.reiComparison.rows;

  // Order and scores must be exactly what REI supplied, untouched.
  assert.deepEqual(rows.map((r) => r.displayName), ['Alpha Capital', 'Beta Homes']);
  assert.deepEqual(rows.map((r) => r.matchScore), [91.4, 72]);
  assert.deepEqual(rows.map((r) => r.matchGrade), ['A', 'B']);

  // No W8C-derived score, rank, or ordering key is emitted at all.
  const serialized = JSON.stringify(panel.reiComparison);
  for (const forbidden of [/w8cScore/i, /adjustedScore/i, /\brank\b/i, /reorder/i, /boost/i]) {
    assert.doesNotMatch(serialized, forbidden);
  }
  // Identity is never asserted across namespaces.
  assert.ok(rows.every((r) => r.identityConfirmed === false));
  assert.equal(panel.reiComparison.namespacesSeparate, true);
});

// 13 ────────────────────────────────────────────────────────────────────────
test('the panel has no coupling to decision or write systems', async () => {
  const DECISION = /(mao|offer[-_ ]?price|send_queue|send-queue|suppression|campaign|outreach|autopilot|dispo)/i;

  // No decision-system imports anywhere in the new stack.
  for (const [name, src] of [['projection', PROJECTION_SRC], ['route', ROUTE_SRC], ['loader', LOADER_TS], ['panel', PANEL_TSX]]) {
    const imports = [...src.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.doesNotMatch(specifier, DECISION, `${name} must not import ${specifier}`);
    }
  }

  // The panel is read-only UI: no action handlers, no mutating verbs.
  for (const forbidden of [/onClick/, /<button/i, /sendDeal/i, /contactBuyer/i, /createOffer/i, /addToCampaign/i]) {
    assert.doesNotMatch(PANEL_TSX, forbidden, `panel must not expose an action (${forbidden})`);
  }
  // It does not receive the property action handlers at all.
  assert.doesNotMatch(PANEL_TSX, /PropertyActionHandlers|handlers/);
  assert.match(WORKSPACE_TSX, /<BuyerIntelligencePanel property=\{property\} \/>/);
  assert.doesNotMatch(WORKSPACE_TSX, /<BuyerIntelligencePanel[^>]*handlers/);

  // No write verbs in the server-side additions.
  for (const src of [PROJECTION_SRC, ROUTE_SRC]) {
    assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|\.insert\(|\.update\(|\.upsert\(|\.delete\()/i);
  }
});

// 14 ────────────────────────────────────────────────────────────────────────
test('the route rejects unauthenticated access before any W8C query', async () => {
  const prior = { ...process.env };
  process.env.OPS_DASHBOARD_SECRET = 'panel-test-secret';
  // W8C enabled: if auth did NOT short-circuit, a panel would be built and
  // returned. Its absence proves the gate ran first.
  process.env.W8C_SHADOW_INTELLIGENCE_ENABLED = '1';
  try {
    const { GET } = await import('../../src/app/api/intel/buyer-intelligence/route.js');

    const denied = await GET(new Request('http://localhost/api/intel/buyer-intelligence?property_id=282802636'));
    const deniedBody = await denied.json();
    assert.equal(denied.status, 401);
    assert.equal(deniedBody.ok, false);
    assert.equal(deniedBody.error, 'unauthorized');
    assert.equal(deniedBody.panel, undefined, 'no W8C data may be produced for an unauthorized caller');

    const wrong = await GET(new Request('http://localhost/api/intel/buyer-intelligence?property_id=282802636', {
      headers: { 'x-ops-dashboard-secret': 'not-the-secret' },
    }));
    assert.equal(wrong.status, 401);

    const allowed = await GET(new Request('http://localhost/api/intel/buyer-intelligence?property_id=282802636', {
      headers: { 'x-ops-dashboard-secret': 'panel-test-secret' },
    }));
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ok, true);
  } finally {
    process.env = prior;
  }
});

// 15 ────────────────────────────────────────────────────────────────────────
test('unconfigured authorization fails closed in production', async () => {
  const prior = { ...process.env };
  for (const name of ['OPS_DASHBOARD_SECRET', 'COCKPIT_MUTATION_SECRET', 'BUYER_MATCH_MUTATION_SECRET', 'API_MUTATION_SECRET']) {
    delete process.env[name];
  }
  try {
    const { GET } = await import('../../src/app/api/intel/buyer-intelligence/route.js');
    const url = 'http://localhost/api/intel/buyer-intelligence?property_id=282802636';

    // In production, an unconfigured secret must refuse rather than serve a
    // re-identifying dataset to anyone who can reach the route.
    process.env.VERCEL_ENV = 'production';
    const prod = await GET(new Request(url));
    const prodBody = await prod.json();
    assert.equal(prod.status, 500);
    assert.equal(prodBody.error, 'authorization_not_configured');
    assert.equal(prodBody.panel, undefined);

    // Outside production the existing permissive dev default is preserved.
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = 'test';
    const dev = await GET(new Request(url));
    assert.equal(dev.status, 200);
  } finally {
    process.env = prior;
  }
});

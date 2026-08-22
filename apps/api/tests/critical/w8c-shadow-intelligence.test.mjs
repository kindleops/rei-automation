import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createW8cClient,
  assertServingLayerOnly,
  mapSummary,
  mapBehavior,
  mapBuybox,
  W8C_SOURCE,
  W8C_VIEWS,
  SERVICE_ROLE_ONLY_VIEWS,
  redactBuyerEntityId,
  redactShadowEnvelope,
  scrubPersonIds,
} from '../../src/lib/intel/w8c-buyer-intelligence.js';
import {
  compareBuyerIntelligenceForProperty,
  IDENTITY_NAMESPACES,
} from '../../src/lib/intel/w8c-shadow-comparison.js';

const CLIENT_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/intel/w8c-buyer-intelligence.js'), 'utf8');
const COMPARE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/intel/w8c-shadow-comparison.js'), 'utf8');
const ROUTE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/app/api/internal/intel/w8c-buyer-intelligence/route.js'), 'utf8');

/**
 * Strip comments so structural assertions scan executable code rather than the
 * prose describing it. (The client's header comment legitimately mentions
 * `supabase.schema('reivesti')` to explain why PostgREST cannot be used.)
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');    // line comments, sparing http://
}

/** Query stub: returns canned rows and records every statement issued. */
function stubQuery(handler) {
  const calls = [];
  const fn = async (sql, params = []) => {
    calls.push({ sql, params });
    const rows = await handler(sql, params);
    return { rows: rows ?? [] };
  };
  fn.calls = calls;
  return fn;
}

const CURRENT_RUN = {
  run_id: 'w8c_run_test', model_version: 'w8c_buyer_intelligence_v1.0.0',
  w8a_params_version: 'w8a_entity_resolution_v1.1.0', w8b_params_version: 'w8b_buyer_behavior_v1.0.0',
  git_sha: 'deadbeef', completed_at: '2026-08-20T00:00:00Z', row_counts: { entities: 40487 },
};

// 1 ─────────────────────────────────────────────────────────────────────────
test('W8C being unavailable degrades gracefully instead of throwing', async () => {
  const query = stubQuery(() => { const e = new Error('connection refused'); e.code = '28P01'; throw e; });
  const client = createW8cClient({ query, enabled: true });

  const version = await client.getVersion();
  assert.equal(version.available, false);
  assert.match(version.reason, /^w8c_unavailable:28P01$/);

  // Every accessor must survive the same failure.
  for (const result of await Promise.all([
    client.getBuyerSummary('company:us_ak:1'),
    client.getBuyerBehavior('company:us_ak:1'),
    client.getBuyerBuybox('company:us_ak:1'),
    client.getPropertyHistoricalBuyers('123'),
    client.getShadowIntelligenceForProperty('123'),
  ])) {
    assert.equal(result.available, false, `expected unavailable, got ${JSON.stringify(result)}`);
  }
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('no promoted run is a legitimate state, not an error', async () => {
  const client = createW8cClient({ query: stubQuery(() => []), enabled: true });
  const version = await client.getVersion();
  assert.equal(version.available, false);
  assert.equal(version.reason, 'no_current_w8c_run');
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('natural-person names are never exposed, even if a row carries one', () => {
  // Defense in depth: the view already nulls this, so the mapper must too.
  const mapped = mapSummary({
    buyer_entity_id: 'person:opaque-123', entity_type: 'person',
    display_name: 'SHOULD NEVER SURFACE', acquisition_count: 4,
  });
  assert.equal(mapped.displayName, null);
  assert.equal(mapped.entityType, 'person');

  const company = mapSummary({
    buyer_entity_id: 'company:us_ak:10025043', entity_type: 'company',
    display_name: 'ACME HOLDINGS LLC',
  });
  assert.equal(company.displayName, 'ACME HOLDINGS LLC');
});

// 4 ─────────────────────────────────────────────────────────────────────────
test('an absent buybox means insufficient evidence, never "buys anything"', async () => {
  const client = createW8cClient({ query: stubQuery(() => []), enabled: true });
  const buybox = await client.getBuyerBuybox('company:us_ak:1');
  assert.equal(buybox.available, false);
  assert.equal(buybox.hasBuybox, false);
  assert.equal(buybox.reason, 'insufficient_evidence');
  assert.ok(!('priceLow' in buybox), 'must not emit an unbounded price band');
});

// 5 ─────────────────────────────────────────────────────────────────────────
test("portfolio 'empty' and 'unknown' are never collapsed", () => {
  assert.equal(mapBehavior({ portfolio_state: 'empty', portfolio_property_count: 0 }).portfolioState, 'empty');
  assert.equal(mapBehavior({ portfolio_state: 'nonempty' }).portfolioState, 'nonempty');
  // Companies have no portfolio row at all; absence must read as 'unknown'.
  assert.equal(mapBehavior({}).portfolioState, 'unknown');
  assert.equal(mapBehavior({ portfolio_state: null }).portfolioState, 'unknown');
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('the serving-layer guard rejects private schemas, PII and non-SELECT', () => {
  assert.ok(assertServingLayerOnly('SELECT * FROM reivesti.buyer_summary'));
  assert.ok(assertServingLayerOnly('WITH x AS (SELECT 1) SELECT * FROM reivesti.buyer_behavior'));

  for (const bad of [
    'SELECT * FROM comp_private.w8c_buyer_entities',
    'SELECT individual_key FROM reivesti.buyer_summary',
    'SELECT phone FROM reivesti.buyer_summary',
    'SELECT email FROM reivesti.buyer_summary',
    'SELECT owner_name FROM reivesti.buyer_summary',
    'SELECT raw_payload FROM reivesti.buyer_summary',
  ]) {
    assert.throws(() => assertServingLayerOnly(bad), /w8c_privacy_violation/, `should reject: ${bad}`);
  }

  for (const write of [
    "UPDATE reivesti.buyer_summary SET x = 1",
    "DELETE FROM reivesti.buyer_summary",
    "INSERT INTO reivesti.buyer_summary VALUES (1)",
  ]) {
    assert.throws(() => assertServingLayerOnly(write), /violation/, `should reject: ${write}`);
  }

  assert.throws(() => assertServingLayerOnly('SELECT * FROM public.properties'),
    /does not target the reivesti serving layer/);
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('every statement targets the serving views and reads only', async () => {
  const query = stubQuery((sql) => (/buyer_intelligence_version/.test(sql) ? [CURRENT_RUN] : []));
  const client = createW8cClient({ query, enabled: true });
  await client.getShadowIntelligenceForProperty('12345');
  await client.getBuyerCompanyLinks({ companyEntityId: 'company:us_ak:1' });

  assert.ok(query.calls.length > 0);
  for (const { sql } of query.calls) {
    assert.match(sql, /reivesti\./, 'statement must target the serving layer');
    assert.doesNotMatch(sql, /comp_private/i);
    assert.match(sql, /^\s*(SELECT|WITH)\b/i);
  }
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('all six serving views are addressed, and the roster view is service-role only', () => {
  assert.deepEqual(Object.values(W8C_VIEWS).sort(), [
    'buyer_behavior', 'buyer_buybox', 'buyer_company_links',
    'buyer_intelligence_version', 'buyer_summary', 'property_historical_buyers',
  ]);
  assert.deepEqual([...SERVICE_ROLE_ONLY_VIEWS], ['property_historical_buyers']);
  // The debug endpoint is the only caller, and it is secret-gated.
  assert.match(ROUTE_SRC, /requireInternalSecret/);
});

// 9 ─────────────────────────────────────────────────────────────────────────
test('buyer identity namespaces are kept separate and no crosswalk is fabricated', async () => {
  const query = stubQuery((sql) => {
    if (/buyer_intelligence_version/.test(sql)) return [CURRENT_RUN];
    if (/property_historical_buyers/.test(sql)) return [{
      buyer_entity_id: 'company:us_ak:10025043', buyer_role: 'buyer_1', entity_type: 'company',
      display_name: 'ACME HOLDINGS LLC', resolution_method: 'exact_registry_company_identity',
      confidence: 0.99, acquired_on: '2025-01-02', acquisition_price: 250000,
    }];
    if (/reivesti\.buyer_summary/.test(sql) && !/WITH n\(name\)/.test(sql)) return [{
      buyer_entity_id: 'company:us_ak:10025043', entity_type: 'company',
      display_name: 'ACME HOLDINGS LLC', has_buybox: false,
    }];
    if (/buyer_match_candidates/.test(sql)) return [{
      buyer_entity_id: '11111111-2222-3333-4444-555555555555',
      buyer_display_name: 'ACME HOLDINGS LLC', normalized_buyer_name: 'ACME HOLDINGS LLC',
      buyer_key: 'bk_a0a686a94ad573e3d1951b3f3ee211ee', match_grade: 'A', match_score: 91,
    }];
    if (/WITH n\(name\)/.test(sql)) return [{ name: 'acme', w8c_matches: 1, rei_matches: 1 }];
    return [];
  });

  const result = await compareBuyerIntelligenceForProperty('12345', { query });

  assert.equal(IDENTITY_NAMESPACES.buyer.shared, false);
  assert.equal(IDENTITY_NAMESPACES.buyer.crosswalk, 'none_proven');
  assert.equal(IDENTITY_NAMESPACES.property.shared, true);
  assert.equal(result.comparison.identityOverlap.count, 0);

  // Name agreement is reported, but never as identity.
  assert.equal(result.comparison.nameAgreement.length, 1);
  const [pair] = result.comparison.nameAgreement;
  assert.equal(pair.isIdentity, false);
  assert.equal(pair.basis, 'company_legal_name_agreement');
  assert.notEqual(pair.w8cBuyerEntityId, pair.reiBuyerEntityId);
  assert.match(pair.w8cBuyerEntityId, /^company:/);
  assert.match(pair.reiBuyerEntityId, /^[0-9a-f-]{36}$/);
});

// 10 ────────────────────────────────────────────────────────────────────────
test('a name held by several entities is flagged ambiguous', async () => {
  const query = stubQuery((sql) => {
    if (/buyer_intelligence_version/.test(sql)) return [CURRENT_RUN];
    if (/property_historical_buyers/.test(sql)) return [{
      buyer_entity_id: 'company:us_tx:1', buyer_role: 'buyer_1', entity_type: 'company',
      display_name: 'ABC PROPERTIES LLC', confidence: 0.9,
    }];
    if (/reivesti\.buyer_summary/.test(sql) && !/WITH n\(name\)/.test(sql)) return [{
      buyer_entity_id: 'company:us_tx:1', entity_type: 'company', display_name: 'ABC PROPERTIES LLC',
    }];
    if (/buyer_match_candidates/.test(sql)) return [{
      buyer_entity_id: '99999999-2222-3333-4444-555555555555',
      buyer_display_name: 'ABC Properties, LLC', normalized_buyer_name: 'ABC Properties, LLC',
      buyer_key: 'bk_x', match_grade: 'B', match_score: 70,
    }];
    if (/WITH n\(name\)/.test(sql)) return [{ name: 'abc', w8c_matches: 7, rei_matches: 3 }];
    return [];
  });

  const result = await compareBuyerIntelligenceForProperty('777', { query });
  assert.equal(result.comparison.nameAgreement.length, 1);
  assert.equal(result.comparison.nameAgreement[0].ambiguous, true);
  assert.equal(result.comparison.nameAgreement[0].isIdentity, false);
});

// 11 ────────────────────────────────────────────────────────────────────────
test('shadow output is labelled and marked non-influencing', async () => {
  const query = stubQuery((sql) => (/buyer_intelligence_version/.test(sql) ? [CURRENT_RUN] : []));
  const client = createW8cClient({ query, enabled: true });

  const property = await client.getShadowIntelligenceForProperty('12345');
  assert.equal(property.source, W8C_SOURCE);
  assert.equal(W8C_SOURCE, 'shadow_buyer_intelligence');

  const comparison = await compareBuyerIntelligenceForProperty('12345', { query });
  assert.equal(comparison.source, 'shadow_buyer_intelligence');
  assert.equal(comparison.observationalOnly, true);
  assert.equal(comparison.influencesPricingOrTargeting, false);
});

// 12 ────────────────────────────────────────────────────────────────────────
test('the integration cannot influence pricing, targeting or outreach', () => {
  // Structural lock: the shadow modules must not import or reference any
  // decision-making subsystem. If this fails, W8C has stopped being shadow.
  const FORBIDDEN = [
    /\bmao\b/i, /offer[-_]?price/i, /send_queue/i, /suppression/i,
    /campaign/i, /outreach/i, /seller_priority/i, /autopilot/i,
  ];
  for (const [name, src] of [['client', CLIENT_SRC], ['comparison', COMPARE_SRC]]) {
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(codeOnly(src), pattern, `${name} must not reference ${pattern}`);
    }
  }
  // And no writes anywhere in the integration.
  for (const src of [CLIENT_SRC, COMPARE_SRC, ROUTE_SRC]) {
    assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|\.insert\(|\.update\(|\.upsert\(|\.delete\()/i);
  }
});

// 13 ────────────────────────────────────────────────────────────────────────
test('the kill switch disables all reads', async () => {
  const query = stubQuery(() => [CURRENT_RUN]);
  const client = createW8cClient({ query, enabled: false });
  const version = await client.getVersion();
  assert.equal(version.available, false);
  assert.equal(version.reason, 'w8c_shadow_disabled');
  assert.equal(query.calls.length, 0, 'a disabled client must not query at all');
});

// 14 ────────────────────────────────────────────────────────────────────────
test('the robust price band is preserved distinctly from the core band', () => {
  const mapped = mapBuybox({
    buyer_entity_id: 'company:us_ak:1', price_low: 100000, price_high: 200000,
    price_robust_low: 50000, price_robust_high: 400000, evidence_depth: 12,
  });
  assert.equal(mapped.priceLow, 100000);
  assert.equal(mapped.priceRobustLow, 50000);
  assert.equal(mapped.priceRobustHigh, 400000);
  assert.notEqual(mapped.priceLow, mapped.priceRobustLow);
});

// 15 ────────────────────────────────────────────────────────────────────────
test('person entity IDs are redacted because they embed individual_key', () => {
  // W8A mints person IDs as `person:{individual_key}` — they are not opaque.
  const raw = 'person:15090498458';
  const redacted = redactBuyerEntityId(raw);
  assert.notEqual(redacted, raw);
  assert.ok(!redacted.includes('15090498458'), 'individual_key must not survive redaction');
  assert.match(redacted, /^person:anon_[0-9a-f]{16}$/);
  // Stable, so "same buyer?" still works downstream.
  assert.equal(redactBuyerEntityId(raw), redacted);
  assert.notEqual(redactBuyerEntityId('person:999'), redacted);
  // Company IDs are registry identifiers and pass through untouched.
  assert.equal(redactBuyerEntityId('company:us_tx:0000405305'), 'company:us_tx:0000405305');
});

// 16 ────────────────────────────────────────────────────────────────────────
test('redaction reaches every nested buyer id in an envelope', () => {
  const envelope = {
    buyers: [
      { buyerEntityId: 'person:15090498458', summary: { buyerEntityId: 'person:15090498458' } },
      { buyerEntityId: 'company:us_tx:1' },
    ],
    comparison: { nameAgreement: [{ w8cBuyerEntityId: 'person:1503410331097' }] },
    links: [{ principalEntityId: 'person:42' }],
  };
  const out = redactShadowEnvelope(envelope);
  const serialized = JSON.stringify(out);
  for (const leaked of ['15090498458', '1503410331097', 'person:42']) {
    assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(serialized.includes('company:us_tx:1'), 'company ids must be preserved');
  assert.equal(out.buyers[0].buyerEntityId, out.buyers[0].summary.buyerEntityId);
  // The original object must not be mutated.
  assert.equal(envelope.buyers[0].buyerEntityId, 'person:15090498458');
});

// 17 ────────────────────────────────────────────────────────────────────────
test('there is NO bypass for raw person ids anywhere in the integration', () => {
  const ALL_SOURCES = {
    client: codeOnly(CLIENT_SRC), comparison: codeOnly(COMPARE_SRC), route: codeOnly(ROUTE_SRC),
  };
  const BYPASS_PATTERNS = [
    /include_person_ids/i, /includePersonIds/, /include_?raw/i, /allow_?raw/i,
    /unredacted/i, /skip_?redact/i, /disable_?redact/i, /bypass/i,
  ];
  for (const [name, src] of Object.entries(ALL_SOURCES)) {
    for (const pattern of BYPASS_PATTERNS) {
      assert.doesNotMatch(src, pattern, `${name} must not contain a redaction bypass (${pattern})`);
    }
  }
  // The route must declare redaction unconditionally, never from a flag.
  assert.match(ROUTE_SRC, /person_ids_redacted: true/);
  assert.doesNotMatch(ROUTE_SRC, /person_ids_redacted:\s*!/);
  // Every response leaves through shield().
  const responses = ROUTE_SRC.split('\n').filter((l) => /return NextResponse\.json\(/.test(l));
  const shielded = responses.filter((l) => /shield\(/.test(l));
  const unshielded = responses.filter((l) => !/shield\(/.test(l));
  assert.ok(shielded.length >= 5, `expected the data branches to be shielded, saw ${shielded.length}`);
  // Only auth/validation errors may skip the shield, and they carry no ids.
  for (const line of unshielded) {
    assert.match(line, /unauthorized|missing_property_id|missing_buyer_entity_id|unknown_mode/,
      `unshielded response must carry no buyer data: ${line.trim()}`);
  }
});

// 18 ────────────────────────────────────────────────────────────────────────
test('legitimate zeros and numeric-as-string values survive mapping', () => {
  // Live W8C rows carry price_robust_low = 0 and confidence as the STRING
  // "1.0000" (pg numeric). A falsy-zero bug here would silently widen or drop
  // a buybox band.
  const mapped = mapBuybox({
    buyer_entity_id: 'company:us_ca:202204010011',
    price_robust_low: 0, price_robust_high: 4795500,
    price_low: 1633000, price_high: 2898000, confidence: '1.0000', evidence_depth: 72,
  });
  assert.equal(mapped.priceRobustLow, 0);
  assert.strictEqual(mapped.priceRobustLow, 0, 'zero must not become null');
  assert.equal(mapped.confidence, 1);
  assert.equal(typeof mapped.confidence, 'number');
  assert.equal(mapped.evidenceDepth, 72);

  // Genuinely absent values stay null rather than collapsing to 0.
  const sparse = mapBuybox({ buyer_entity_id: 'company:us_ca:1' });
  assert.equal(sparse.priceRobustLow, null);
  assert.deepEqual(sparse.preferredCounties, []);

  const behavior = mapBehavior({ acquisition_count: 0, days_since_last: 0, confidence: '0.9400' });
  assert.strictEqual(behavior.acquisitionCount, 0);
  assert.strictEqual(behavior.daysSinceLast, 0);
  assert.equal(behavior.confidence, 0.94);
});

// 19 ────────────────────────────────────────────────────────────────────────
test('raw person ids are scrubbed out of arbitrary strings, including errors', () => {
  // Postgres echoes bound parameters into error text; a keyed-only redactor
  // would let the id ride out inside the message.
  const pgError = 'error: invalid input for query with parameter $1 = person:15090498458';
  const scrubbed = scrubPersonIds(pgError);
  assert.ok(!scrubbed.includes('15090498458'));
  assert.match(scrubbed, /person:anon_[0-9a-f]{16}/);

  // The W8A.2 provisional form anonymises too.
  const provisional = scrubPersonIds('person:seller:15090498458');
  assert.ok(!provisional.includes('15090498458'));

  // Idempotent — re-scrubbing does not re-hash.
  const once = scrubPersonIds('person:15090498458');
  assert.equal(scrubPersonIds(once), once);

  // Non-person text is untouched.
  assert.equal(scrubPersonIds('company:us_tx:0000405305'), 'company:us_tx:0000405305');
  assert.equal(scrubPersonIds('no ids here'), 'no ids here');
});

// 20 ────────────────────────────────────────────────────────────────────────
test('error and reason envelopes cannot carry a raw person id', () => {
  const errorEnvelope = {
    ok: false,
    error: 'w8c_unavailable',
    reason: 'buyer_not_in_w8c for person:15090498458',
    detail: { cause: new Error('lookup failed for person:1503410331097').message },
    trace: ['person:42 not found'],
  };
  const serialized = JSON.stringify(redactShadowEnvelope(errorEnvelope));
  for (const leaked of ['15090498458', '1503410331097', 'person:42']) {
    assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
  }
  // Even an id used as an object KEY is scrubbed.
  const keyed = redactShadowEnvelope({ 'person:15090498458': { ok: true } });
  assert.ok(!JSON.stringify(keyed).includes('15090498458'));
});

// 21 ────────────────────────────────────────────────────────────────────────
test('the route never reflects a raw person id back to the caller', async () => {
  process.env.INTERNAL_API_SECRET = 'test-secret-w8c';
  process.env.W8C_SHADOW_INTELLIGENCE_ENABLED = '0'; // guarantee zero DB access
  const { GET } = await import('../../src/app/api/internal/intel/w8c-buyer-intelligence/route.js');

  const raw = 'person:15090498458';
  const request = new Request(
    `http://localhost/api/internal/intel/w8c-buyer-intelligence?mode=buyer&buyer_entity_id=${encodeURIComponent(raw)}`,
    { headers: { 'x-internal-api-secret': 'test-secret-w8c' } },
  );
  const response = await GET(request);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.person_ids_redacted, true);
  assert.ok(!serialized.includes('15090498458'), `raw individual_key reflected back: ${serialized}`);
  assert.match(body.buyer.buyer_entity_id, /^person:anon_[0-9a-f]{16}$/);
});

// 22 ────────────────────────────────────────────────────────────────────────
test('W8C never uses PostgREST and touches only the six approved views', () => {
  // PostgREST exposes only public/graphql_public, so .schema('reivesti') can
  // never work — the direct pg client is the architecture, not a preference.
  for (const [name, raw] of [['client', CLIENT_SRC], ['comparison', COMPARE_SRC]]) {
    const src = codeOnly(raw);
    assert.doesNotMatch(src, /supabase-js/, `${name} must not import the REST client`);
    assert.doesNotMatch(src, /\.schema\(/, `${name} must not use PostgREST schema routing`);
    assert.doesNotMatch(src, /from\s+["']@\/lib\/supabase/, `${name} must not import the supabase client`);
  }
  assert.match(CLIENT_SRC, /getPgPool|queryWithTimeout/);

  // Only the six approved serving views may be named.
  const APPROVED = new Set([
    'buyer_intelligence_version', 'buyer_summary', 'buyer_behavior',
    'buyer_buybox', 'buyer_company_links', 'property_historical_buyers',
  ]);
  for (const src of [codeOnly(CLIENT_SRC), codeOnly(COMPARE_SRC)]) {
    for (const match of src.matchAll(/reivesti\.([a-z_]+)/g)) {
      assert.ok(APPROVED.has(match[1]), `unapproved reivesti view referenced: ${match[1]}`);
    }
  }
  assert.equal(APPROVED.size, 6);
});

// 23 ────────────────────────────────────────────────────────────────────────
/**
 * The only modules permitted to import the W8C shadow layer. An explicit
 * allowlist rather than a path heuristic: adding a W8C consumer must be a
 * deliberate, reviewed act, and every entry here is a read-only surface.
 */
const SANCTIONED_W8C_CONSUMERS = [
  'src/lib/intel/w8c-buyer-intelligence.js',                       // the layer itself
  'src/lib/intel/w8c-shadow-comparison.js',                        // property comparison
  'src/lib/intel/w8c-panel-projection.js',                         // sanitized panel projection
  'src/app/api/internal/intel/w8c-buyer-intelligence/route.js',    // internal debug surface
  'src/app/api/intel/buyer-intelligence/route.js',                 // property panel surface
];

test('W8C cannot influence existing buyer ranking or any decision system', () => {
  // Structural: no existing REI module may import the W8C shadow layer. If one
  // ever does, W8C has stopped being observational.
  const roots = ['src/lib/intel', 'src/lib/domain', 'src/lib/acquisition', 'src/app/api'];
  const offenders = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (SANCTIONED_W8C_CONSUMERS.some((allowed) => full.endsWith(allowed))) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/w8c-buyer-intelligence|w8c-shadow-comparison/.test(src)) offenders.push(full);
    }
  };
  for (const root of roots) walk(path.join(process.cwd(), root));
  assert.deepEqual(offenders, [], `W8C must not be imported by decision code: ${offenders.join(', ')}`);

  // And the W8C layer itself must not import decision/write subsystems.
  for (const [name, src] of [['client', CLIENT_SRC], ['comparison', COMPARE_SRC], ['route', ROUTE_SRC]]) {
    const imports = [...src.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.doesNotMatch(specifier,
        /(campaign|offer|mao|outreach|send-queue|send_queue|suppression|autopilot|dispo)/i,
        `${name} must not import ${specifier}`);
    }
  }
});

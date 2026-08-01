/**
 * Offerr Evaluation Spine — deterministic property-resolution proof.
 *
 * Covers the mission's 20 required scenarios for realistic seller-entered
 * address variation: normalization (case, punctuation, suffix, directional,
 * state, ZIP+4, whitespace, units, glued directionals), fail-closed ambiguity
 * (duplicate parcels, missing units, conflicting geography, partial names),
 * INVALID_INPUT handling, idempotent replay through the evaluation service,
 * seller-safe candidate privacy, canonical-row immutability, and the
 * no-external-provider guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSellerAddress,
  normalizeStateCode,
  normalizeZip5,
} from '@/lib/domain/offerr/offerr-address-normalization.js';
import { resolveOfferrSubjectProperty } from '@/lib/domain/offerr/offerr-property-resolution.js';
import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import { createInMemoryOfferrEvaluationStore } from '@/lib/domain/offerr/offerr-evaluation-store.js';
import {
  OFFERR_OUTCOMES,
  OFFERR_RESOLUTION_STATUSES,
} from '@/lib/domain/offerr/offerr-contracts.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function row(id, full, city, state, zip, type = 'SFR') {
  return {
    property_id: id,
    property_export_id: `exp-${id}`,
    property_address_full: full,
    property_address: full.split(',')[0],
    property_address_city: city,
    property_address_state: state,
    property_address_zip: zip,
    property_type: type,
    market: `${city}, ${state}`,
  };
}

const HOUSTON = row('p-houston', '6310 Cambridge Glen Ln, Houston, TX 77035', 'Houston', 'TX', '77035');
const OCEAN = row('p-ocean', '1200 Ocean Boulevard, Long Beach, CA 90802', 'Long Beach', 'CA', '90802');
const ELM = row('p-elm', '425 N Elm St, Greensboro, NC 27401', 'Greensboro', 'NC', '27401');
const MAPLE_A = row('p-maple-a', '4501 Maple Ave Unit A, Dallas, TX 75219', 'Dallas', 'TX', '75219', 'Condo');
const MAPLE_B = row('p-maple-b', '4501 Maple Ave Unit B, Dallas, TX 75219', 'Dallas', 'TX', '75219', 'Condo');
const OAK_DUP_1 = row('p-oak-1', '901 Oak St, Tulsa, OK 74104', 'Tulsa', 'OK', '74104');
const OAK_DUP_2 = row('p-oak-2', '901 Oak St, Tulsa, OK 74104', 'Tulsa', 'OK', '74104');

const ALL_ROWS = [HOUSTON, OCEAN, ELM, MAPLE_A, MAPLE_B, OAK_DUP_1, OAK_DUP_2];

/** Realistic loader: street-number prefix behavior of the canonical query. */
function fixtureLoader(rows = ALL_ROWS) {
  return async (parsed) =>
    rows.filter((r) =>
      r.property_address_full.toLowerCase().startsWith(`${parsed.street_number} `),
    );
}

async function resolve(address, rows = ALL_ROWS) {
  return resolveOfferrSubjectProperty(
    { rawAddress: address },
    { loadCandidates: fixtureLoader(rows) },
  );
}

// ── Parser sanity for the normalization rules ───────────────────────────────

test('parser normalizes suffixes, directionals, states, ZIP+4, units, and glued spacing', () => {
  const a = parseSellerAddress('425 North Elm Street, Greensboro, North Carolina 27401-2210');
  assert.equal(a.street_number, '425');
  assert.equal(a.pre_directional, 'n');
  assert.equal(a.street_name, 'elm');
  assert.equal(a.suffix, 'st');
  assert.equal(a.state, 'nc');
  assert.equal(a.zip5, '27401');
  assert.equal(a.zip4, '2210');

  const b = parseSellerAddress('425N Elm St Greensboro NC 27401');
  assert.equal(b.pre_directional, 'n');
  assert.equal(b.base_key, a.base_key);

  const c = parseSellerAddress('4501 Maple Ave Apt B, Dallas, TX 75219');
  assert.equal(c.unit, 'B');
  const d = parseSellerAddress('4501 Maple Ave # B, Dallas, TX 75219');
  assert.equal(d.unit, 'B');

  // "10 North St" is a street NAMED North, not a directional.
  const e = parseSellerAddress('10 North St, Salem, MA 01970');
  assert.equal(e.street_name, 'north');
  assert.equal(e.suffix, 'st');

  // Comma-less "Ct"/"NE" homographs never get claimed as states.
  const f = parseSellerAddress('123 Main Ct Denver CO 80202');
  assert.equal(f.suffix, 'ct');
  assert.equal(f.state, 'co');

  assert.equal(normalizeStateCode('Texas'), 'tx');
  assert.equal(normalizeZip5('77035-4712'), '77035');
});

test('five-digit house numbers are never consumed as a ZIP (comma-less input)', () => {
  // Regression: extractZip scanned the whole token stream from the end. With
  // no comma tail the stream IS the street segment, so a five-digit house
  // number matched the ZIP pattern, was spliced out, and left tokens[0]='main'
  // -> reason 'missing_street_number' -> INVALID_INPUT for a valid address.
  // Canonical property_address_full values parse through this same function,
  // so those rows failed to parse too.
  const bare = parseSellerAddress('12345 Main St');
  assert.equal(bare.ok, true, bare.reason ?? 'should parse');
  assert.equal(bare.street_number, '12345');
  assert.equal(bare.street_name, 'main');
  assert.equal(bare.suffix, 'st');
  assert.equal(bare.zip5, null, 'the house number is not a ZIP');

  const noZip = parseSellerAddress('12345 Main St Houston TX');
  assert.equal(noZip.ok, true);
  assert.equal(noZip.street_number, '12345');
  assert.equal(noZip.city, 'houston');
  assert.equal(noZip.state, 'tx');
  assert.equal(noZip.zip5, null);

  // A real trailing ZIP is still extracted, and the house number survives.
  const withZip = parseSellerAddress('12345 Main St Houston TX 77002');
  assert.equal(withZip.street_number, '12345');
  assert.equal(withZip.zip5, '77002');

  // Comma-separated input was never affected and must stay correct.
  const commas = parseSellerAddress('12345 Main St, Houston, TX 77002');
  assert.equal(commas.street_number, '12345');
  assert.equal(commas.zip5, '77002');

  // A leading token that is genuinely not a street number is still refused.
  const noNumber = parseSellerAddress('tx houston area 77035');
  assert.equal(noNumber.ok, false);
  assert.equal(noNumber.reason, 'missing_street_number');
  assert.equal(noNumber.zip5, '77035');
});

test('a five-digit house number resolves end to end', async () => {
  const bigNumber = row(
    'p-bignum',
    '12345 Sandbox Ridge Rd, Houston, TX 77035',
    'Houston',
    'TX',
    '77035',
  );
  const r = await resolve('12345 Sandbox Ridge Rd, Houston, TX 77035', [bigNumber]);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-bignum');

  const commaless = await resolve('12345 Sandbox Ridge Rd Houston TX 77035', [bigNumber]);
  assert.equal(commaless.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(commaless.property_id, 'p-bignum');
});

// ── 1-8: variation that must still resolve ──────────────────────────────────

test('1. exact canonical address resolves', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Houston, TX 77035');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-houston');
});

test('2. case and punctuation variation resolves', async () => {
  const r = await resolve('6310 CAMBRIDGE GLEN LN., HOUSTON, TX 77035');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-houston');
});

test('3. street-suffix abbreviation resolves against spelled-out canonical', async () => {
  const r = await resolve('1200 Ocean Blvd, Long Beach, CA 90802');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-ocean');
});

test('4. directional spelled out resolves against abbreviated canonical', async () => {
  const r = await resolve('425 North Elm Street, Greensboro, NC 27401');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-elm');

  const glued = await resolve('425N Elm St Greensboro NC 27401');
  assert.equal(glued.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(glued.property_id, 'p-elm');
});

test('5. ZIP+4 resolves against five-digit canonical ZIP', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Houston, TX 77035-4712');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-houston');
});

test('6. full state name resolves against canonical abbreviation', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Houston, Texas 77035');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-houston');
});

test('7. excess whitespace and missing commas resolve', async () => {
  const spaced = await resolve('   6310   Cambridge  Glen   Ln ,  Houston ,  TX   77035  ');
  assert.equal(spaced.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);

  const commaless = await resolve('6310 cambridge glen ln houston tx 77035');
  assert.equal(commaless.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(commaless.property_id, 'p-houston');
});

test('8. unit designator variation (Apt/Unit/#) resolves to the right unit', async () => {
  const apt = await resolve('4501 Maple Ave Apt B, Dallas, TX 75219');
  assert.equal(apt.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(apt.property_id, 'p-maple-b');

  const hash = await resolve('4501 Maple Ave # A, Dallas, TX 75219');
  assert.equal(hash.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(hash.property_id, 'p-maple-a');
});

// ── 9-15: fail-closed paths ─────────────────────────────────────────────────

test('9. missing unit with multiple unit candidates never auto-resolves', async () => {
  const r = await resolve('4501 Maple Ave, Dallas, TX 75219');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'missing_unit_for_multi_unit_address');
  assert.equal(r.property_id, null);
});

test('9b. stated unit that matches nothing fails closed', async () => {
  const r = await resolve('4501 Maple Ave Unit C, Dallas, TX 75219');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'stated_unit_not_matched');
});

test('10. duplicate exact normalized matches fail closed as AMBIGUOUS', async () => {
  const r = await resolve('901 Oak St, Tulsa, OK 74104');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'multiple_structured_matches');
});

test('11. correct street with conflicting ZIP fails closed', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Houston, TX 77002');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.ok(r.reason.startsWith('geography_conflict:'), r.reason);
  assert.ok(r.reason.includes('zip'));
  assert.equal(r.property_id, null);
});

test('12. correct street with conflicting city fails closed', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Dallas, TX');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.ok(r.reason.startsWith('geography_conflict:'), r.reason);
  assert.ok(r.reason.includes('city'));
});

test('12b. conflicting state fails closed', async () => {
  const r = await resolve('6310 Cambridge Glen Ln, Houston, OK');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.ok(r.reason.includes('state'));
});

test('13. partial street-name similarity alone never resolves', async () => {
  const r = await resolve('6310 Cambridge St, Houston, TX 77035');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.equal(r.reason, 'no_structured_match');
});

test('14. no candidates at all is NOT_FOUND', async () => {
  const r = await resolve('9999 Nonexistent Way, Nowhere, TX 00001', []);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.equal(r.reason, 'no_candidates_found');
});

test('15. invalid or unparseable input is INVALID_INPUT', async () => {
  const empty = await resolveOfferrSubjectProperty({ rawAddress: '' }, { loadCandidates: fixtureLoader() });
  assert.equal(empty.status, OFFERR_RESOLUTION_STATUSES.INVALID_INPUT);

  const noNumber = await resolve('Main Street, Houston, TX 77035');
  assert.equal(noNumber.status, OFFERR_RESOLUTION_STATUSES.INVALID_INPUT);
  assert.equal(noNumber.reason, 'missing_street_number');
});

// ── 16-20: service-level behavior ───────────────────────────────────────────

function serviceDeps(overrides = {}) {
  let seq = 0;
  const subjects = new Map(
    ALL_ROWS.map((r) => [
      r.property_id,
      {
        ...r,
        property_class: 'Residential',
        building_square_feet: 1400,
        units_count: 1,
        estimated_value: 200000,
      },
    ]),
  );
  return {
    now: NOW,
    v3Enabled: true,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    loadCandidates: fixtureLoader(),
    loadSubjectProperty: async (id) => subjects.get(id) ?? null,
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

test('16. idempotent replay after successful resolution creates one snapshot', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const intake = {
    address: '6310 Cambridge Glen Ln, Houston, TX 77035',
    idempotency_key: 'resolution-replay-ok-1',
  };
  const first = await evaluateOfferrProperty(intake, serviceDeps({ store }));
  const second = await evaluateOfferrProperty(intake, serviceDeps({ store }));

  assert.equal(first.ok, true);
  assert.equal(first.internal_result.resolution.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.evaluation_id, first.evaluation_id);

  const stored = await store.findByIdempotencyKey(intake.idempotency_key);
  assert.equal(stored.evaluation.evaluation_version, 1);
});

test('17. idempotent replay after ambiguous resolution stays ambiguous, one snapshot', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const intake = {
    address: '4501 Maple Ave, Dallas, TX 75219',
    idempotency_key: 'resolution-replay-ambig-1',
  };
  const first = await evaluateOfferrProperty(intake, serviceDeps({ store }));
  const second = await evaluateOfferrProperty(intake, serviceDeps({ store }));

  assert.equal(first.ok, true);
  assert.equal(first.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(first.seller_projection.next_step, 'confirm_property_identity');
  assert.equal(second.idempotent_replay, true);
  assert.deepEqual(second.seller_projection, first.seller_projection);

  const stored = await store.findByIdempotencyKey(intake.idempotency_key);
  assert.equal(stored.evaluation.evaluation_version, 1);
});

test('18. seller-safe response never exposes candidate rows or identifiers', async () => {
  const result = await evaluateOfferrProperty(
    { address: '4501 Maple Ave, Dallas, TX 75219', idempotency_key: 'resolution-privacy-1' },
    serviceDeps(),
  );
  assert.equal(result.ok, true);

  const serialized = JSON.stringify(result.seller_projection);
  assert.equal(serialized.includes('candidate'), false, 'no candidate vocabulary');
  assert.equal(serialized.includes('p-maple'), false, 'no candidate identifiers');
  assert.equal(serialized.includes('4501 Maple'), false, 'unresolved property address not echoed');
  // Internal result retains full auditability.
  assert.ok(result.internal_result.resolution.candidates.length >= 2);
});

test('19. resolver never mutates canonical candidate rows', async () => {
  const frozenRows = ALL_ROWS.map((r) => Object.freeze({ ...r }));
  const snapshot = JSON.stringify(frozenRows);
  const r = await resolveOfferrSubjectProperty(
    { rawAddress: '6310 Cambridge Glen Ln, Houston, TX 77035' },
    { loadCandidates: async () => frozenRows.filter((x) => x.property_id === 'p-houston') },
  );
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(JSON.stringify(frozenRows), snapshot);
});

test('20. resolver makes no external provider request', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('external fetch attempted');
  };
  try {
    const r = await resolve('6310 Cambridge Glen Ln, Houston, TX 77035');
    assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
    assert.equal(fetchCalls, 0, 'no network request during resolution');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('service maps INVALID_INPUT resolution to a confirm-address review, no range', async () => {
  // A leading token that is not a street number is genuinely unparseable.
  // (The former fixture here was '77035 tx houston area', which only parsed as
  // INVALID_INPUT because a leading five-digit token was being eaten as a ZIP.
  // That defect is fixed, so the leading 77035 is now correctly read as a house
  // number — see the five-digit house-number regressions above. Both inputs
  // still fail closed to the same seller-facing confirm-address review.)
  const result = await evaluateOfferrProperty(
    { address: 'tx houston area 77035', idempotency_key: 'resolution-invalid-1' },
    serviceDeps(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.equal(result.seller_projection.next_step, 'confirm_property_address');
  assert.equal(
    result.internal_result.resolution.status,
    OFFERR_RESOLUTION_STATUSES.INVALID_INPUT,
  );
});

/* ── Legitimate-address compatibility ─────────────────────────────────────────
 *
 * The normalizer is applied to BOTH the seller's input and the canonical
 * `property_address_full`, so a form it cannot parse is not merely a rejected
 * submission — the canonical rows for those properties cannot be parsed
 * either, and the address could never resolve from either side. Each case
 * below is an ordinary US address form that previously failed closed.
 */

test('hyphenated house numbers (Queens/Hawaii style) parse and resolve', async () => {
  const canonical = row(
    'p-queens',
    '123-45 Roosevelt Ave, Queens, NY 11372',
    'Queens',
    'NY',
    '11372',
  );
  const parsed = parseSellerAddress('123-45 Roosevelt Ave, Queens, NY 11372');
  assert.equal(parsed.ok, true, parsed.reason ?? '');
  assert.equal(parsed.street_number, '123-45');
  assert.equal(parsed.street_name, 'roosevelt');

  const r = await resolveOfferrSubjectProperty(
    { rawAddress: '123-45 Roosevelt Ave, Queens, NY 11372' },
    { loadCandidates: async () => [canonical] },
  );
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'p-queens');
});

test('a highway street name is not eaten by the street-suffix scan', async () => {
  // "highway" is a suffix homograph; followed by a bare route number it is
  // part of the road's NAME. Treating it as a suffix consumed the street name
  // entirely and returned INVALID_INPUT for a valid rural address.
  const parsed = parseSellerAddress('1234 Highway 6, Alvin, TX 77511');
  assert.equal(parsed.ok, true, parsed.reason ?? '');
  assert.equal(parsed.street_name, 'highway 6');
  assert.equal(parsed.suffix, null);

  const canonical = row('p-hwy', '1234 Highway 6, Alvin, TX 77511', 'Alvin', 'TX', '77511');
  const r = await resolveOfferrSubjectProperty(
    { rawAddress: '1234 Highway 6, Alvin, TX 77511' },
    { loadCandidates: async () => [canonical] },
  );
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
});

test('a state-highway route number is not mistaken for the city', async () => {
  const parsed = parseSellerAddress('1234 State Highway 6, Alvin, TX 77511');
  assert.equal(parsed.ok, true, parsed.reason ?? '');
  assert.equal(parsed.street_name, 'state highway 6');
  assert.equal(parsed.city, 'alvin', 'the real city must survive, not the route number');

  const canonical = row(
    'p-sh6',
    '1234 State Highway 6, Alvin, TX 77511',
    'Alvin',
    'TX',
    '77511',
  );
  const r = await resolveOfferrSubjectProperty(
    { rawAddress: '1234 State Highway 6, Alvin, TX 77511' },
    { loadCandidates: async () => [canonical] },
  );
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
});

test('a street named only by a suffix homograph still parses', async () => {
  const parsed = parseSellerAddress('123 Way, Austin, TX 78701');
  assert.equal(parsed.ok, true, parsed.reason ?? '');
  assert.equal(parsed.street_name, 'way');
});

test('apostrophes and accents survive normalization on both sides', async () => {
  for (const [seller, canonicalFull] of [
    ["123 O'Connor St, Dallas, TX 75201", "123 O'Connor St, Dallas, TX 75201"],
    ['77 Cañada Rd, Woodside, CA 94062', '77 Cañada Rd, Woodside, CA 94062'],
    ['99 Peña Blvd, Denver, CO 80249', '99 Peña Blvd, Denver, CO 80249'],
  ]) {
    const seen = parseSellerAddress(seller);
    const canon = parseSellerAddress(canonicalFull);
    assert.equal(seen.ok, true, `${seller}: ${seen.reason ?? ''}`);
    assert.equal(seen.street_name, canon.street_name, `${seller}: name must match canonical`);
  }
});

test('a PO Box is rejected with a reason that names why, not a bogus parse error', async () => {
  const parsed = parseSellerAddress('PO Box 123, Dallas, TX 75201');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'po_box_not_supported');

  const r = await resolveOfferrSubjectProperty(
    { rawAddress: 'PO Box 123, Dallas, TX 75201' },
    { loadCandidates: async () => [] },
  );
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.INVALID_INPUT);
  assert.equal(r.reason, 'po_box_not_supported');
});

test('a rural route is rejected as a non-street address', async () => {
  const parsed = parseSellerAddress('RR 2 Box 45, Sulphur, OK 73086');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'non_street_address');
});

test('a genuinely unparseable address still reports missing_street_number', async () => {
  assert.equal(parseSellerAddress('tx houston area').reason, 'missing_street_number');
});

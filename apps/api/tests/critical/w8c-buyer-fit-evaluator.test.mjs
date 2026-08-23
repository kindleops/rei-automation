import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateBuyerFit, rankBuyerFits, normalizeSubject, normalizeAssetFamily,
  scoreGeography, scoreAsset, scoreRobustPrice, scoreCharacteristics,
  evidenceConfidence, DEFAULT_WEIGHTS, FIT_LABELS, EVIDENCE_FLOOR,
} from '../../src/lib/intel/w8c-buyer-fit-evaluator.js';
import { mapCandidate } from '../../src/lib/intel/w8c-fit-candidates.js';

const EVALUATOR_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/intel/w8c-buyer-fit-evaluator.js'), 'utf8');
const CANDIDATES_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/intel/w8c-fit-candidates.js'), 'utf8');
const PROJECTION_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/intel/w8c-panel-projection.js'), 'utf8');
const PANEL_TSX = fs.readFileSync(path.resolve(process.cwd(), '../dashboard/src/modules/properties/BuyerIntelligencePanel.tsx'), 'utf8');

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SUBJECT = normalizeSubject({
  property_id: 'p1', state: 'TX', county: 'Harris County', zip: '77520',
  property_type: 'Single Family', units_count: 1,
  building_square_feet: 1450, estimated_value: 211000,
});

const BUYER = {
  buyerRef: 'company:us_tx:1', entityType: 'company', displayName: 'ACME HOLDINGS LLC',
  states: ['TX'], counties: ['TX|Harris'], zips: ['77520'], assetFamilies: ['sfr'],
  priceRobustLow: 100000, priceRobustHigh: 300000,
  buildingSqftP25: 1200, buildingSqftP75: 2000, unitsP25: 1, unitsP75: 1,
  evidenceDepth: 11, buyboxConfidence: 0.9, behaviorConfidence: 0.8, daysSinceLast: 30,
};

// 1 ─────────────────────────────────────────────────────────────────────────
test('the score is deterministic and order-independent', () => {
  const a = evaluateBuyerFit(SUBJECT, BUYER);
  const b = evaluateBuyerFit(SUBJECT, { ...BUYER });
  assert.equal(a.observedBuyboxFitScore, b.observedBuyboxFitScore);

  // Shuffling the candidate list must not change any score or the order.
  const pool = [BUYER, { ...BUYER, buyerRef: 'company:us_tx:2' }, { ...BUYER, buyerRef: 'company:us_tx:3' }];
  const forward = rankBuyerFits(SUBJECT, pool).map((r) => [r.buyerRef, r.observedBuyboxFitScore]);
  const reverse = rankBuyerFits(SUBJECT, [...pool].reverse()).map((r) => [r.buyerRef, r.observedBuyboxFitScore]);
  assert.deepEqual(forward, reverse);
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('ties break deterministically: evidence, then depth, then ref', () => {
  const base = { ...BUYER, buyboxConfidence: 0.5, behaviorConfidence: 0.5 };
  const pool = [
    { ...base, buyerRef: 'company:us_tx:zzz', evidenceDepth: 5 },
    { ...base, buyerRef: 'company:us_tx:aaa', evidenceDepth: 5 },
    { ...base, buyerRef: 'company:us_tx:mmm', evidenceDepth: 9 },
  ];
  const ranked = rankBuyerFits(SUBJECT, pool);
  // Higher depth wins on evidence confidence; equal pairs fall back to ref order.
  assert.equal(ranked[0].buyerRef, 'company:us_tx:mmm');
  assert.deepEqual(ranked.slice(1).map((r) => r.buyerRef), ['company:us_tx:aaa', 'company:us_tx:zzz']);
  assert.deepEqual(rankBuyerFits(SUBJECT, [...pool].reverse()).map((r) => r.buyerRef),
    ranked.map((r) => r.buyerRef));
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('geography distinguishes zip / county / state / mismatch / unknown', () => {
  assert.equal(scoreGeography(SUBJECT, BUYER).tier, 'zip');
  assert.equal(scoreGeography(SUBJECT, { ...BUYER, zips: [] }).tier, 'county');
  assert.equal(scoreGeography(SUBJECT, { ...BUYER, zips: [], counties: [] }).tier, 'state');
  assert.equal(scoreGeography(SUBJECT, { ...BUYER, zips: [], counties: [], states: ['CA'] }).tier, 'mismatch');
  assert.equal(scoreGeography(SUBJECT, { ...BUYER, zips: [], counties: [], states: [] }).fit, null);
  // Missing subject state is unknown, never a mismatch.
  assert.equal(scoreGeography({ ...SUBJECT, state: null }, BUYER).fit, null);
  // "Harris County" and "HARRIS" are the same county.
  assert.equal(scoreGeography(SUBJECT, { ...BUYER, zips: [], counties: ['TX|HARRIS COUNTY'] }).tier, 'county');
  const tiers = ['zip', 'county', 'state'].map((t) =>
    scoreGeography(SUBJECT, t === 'zip' ? BUYER : t === 'county'
      ? { ...BUYER, zips: [] } : { ...BUYER, zips: [], counties: [] }).fit);
  assert.ok(tiers[0] > tiers[1] && tiers[1] > tiers[2], 'precision tiers must be ordered');
});

// 4 ─────────────────────────────────────────────────────────────────────────
test('asset match / compatible / mismatch / unknown', () => {
  assert.equal(scoreAsset(SUBJECT, BUYER).tier, 'match');
  assert.equal(scoreAsset(SUBJECT, { ...BUYER, assetFamilies: ['apartments_5plus'] }).tier, 'mismatch');
  const mf = normalizeSubject({ state: 'TX', property_type: 'Multi-Family', units_count: 3, estimated_value: 1 });
  assert.equal(mf.assetFamily, 'small_multifamily_2_4');
  assert.equal(scoreAsset(mf, { ...BUYER, assetFamilies: ['multifamily_unspecified'] }).tier, 'compatible');
  // Unmappable subject asset is unknown, not a mismatch.
  const land = normalizeSubject({ state: 'TX', property_type: 'Vacant Land', estimated_value: 1 });
  assert.equal(land.assetFamily, null);
  assert.equal(scoreAsset(land, BUYER).fit, null);
  assert.equal(scoreAsset(SUBJECT, { ...BUYER, assetFamilies: [] }).fit, null);
  // Units drive the multifamily split.
  assert.equal(normalizeAssetFamily('Multi-Family', 8), 'apartments_5plus');
  assert.equal(normalizeAssetFamily('Multi-Family', null), 'multifamily_unspecified');
});

// 5 ─────────────────────────────────────────────────────────────────────────
test('robust price: inside, outside, zero bound, degenerate, missing', () => {
  assert.equal(scoreRobustPrice(SUBJECT, BUYER).fit, 1);
  assert.equal(scoreRobustPrice(SUBJECT, BUYER).tier, 'inside');

  // A zero lower bound is "no lower constraint", not "buys at $0".
  const openLow = scoreRobustPrice({ ...SUBJECT, referencePrice: 5000 }, { ...BUYER, priceRobustLow: 0 });
  assert.equal(openLow.fit, 1);
  assert.equal(openLow.tier, 'inside');
  // With a real lower bound the same cheap subject is below.
  assert.equal(scoreRobustPrice({ ...SUBJECT, referencePrice: 5000 }, BUYER).tier, 'below');

  // Degenerate band decays smoothly instead of snapping to zero.
  const degenerate = { ...BUYER, priceRobustLow: 161400, priceRobustHigh: 161400 };
  assert.equal(scoreRobustPrice({ ...SUBJECT, referencePrice: 161400 }, degenerate).fit, 1);
  const near = scoreRobustPrice({ ...SUBJECT, referencePrice: 180000 }, degenerate);
  assert.ok(near.fit > 0 && near.fit < 1, `expected smooth decay, got ${near.fit}`);
  assert.equal(scoreRobustPrice({ ...SUBJECT, referencePrice: 5000000 }, degenerate).fit, 0);

  // Missing on either side is unknown, not a mismatch.
  assert.equal(scoreRobustPrice({ ...SUBJECT, referencePrice: null }, BUYER).fit, null);
  assert.equal(scoreRobustPrice(SUBJECT, { ...BUYER, priceRobustHigh: null }).fit, null);
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('characteristics use only comparable evidence; zeros are missing data', () => {
  assert.equal(scoreCharacteristics(SUBJECT, BUYER).tier, 'inside');
  assert.equal(scoreCharacteristics(SUBJECT, { ...BUYER, buildingSqftP25: null, unitsP25: null }).fit, null);

  // Vacant-land records carry 0 sqft / 0 units — that is absence, not a value.
  const land = normalizeSubject({
    state: 'OH', county: 'Cuyahoga', property_type: 'Vacant Land',
    units_count: 0, building_square_feet: 0, estimated_value: 216000,
  });
  assert.equal(land.buildingSqft, null);
  assert.equal(land.units, null);
  assert.equal(scoreCharacteristics(land, BUYER).fit, null);
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('missing dimensions are dropped from the mean, never scored as zero', () => {
  const full = evaluateBuyerFit(SUBJECT, BUYER);
  const noChars = evaluateBuyerFit(SUBJECT, { ...BUYER, buildingSqftP25: null, buildingSqftP75: null, unitsP25: null, unitsP75: null });
  assert.equal(noChars.characteristicsFit, null);
  assert.ok(!noChars.dimensionsUsed.includes('characteristics'));
  // Dropping a perfect dimension must not reduce the score toward zero.
  assert.ok(noChars.observedBuyboxFitScore >= full.observedBuyboxFitScore - 0.001);

  const nothing = evaluateBuyerFit(
    { ...SUBJECT, state: null, assetFamily: null, referencePrice: null, buildingSqft: null, units: null },
    { ...BUYER, states: [], counties: [], zips: [], assetFamilies: [], priceRobustLow: null, priceRobustHigh: null,
      buildingSqftP25: null, buildingSqftP75: null, unitsP25: null, unitsP75: null });
  assert.equal(nothing.evaluable, false);
  assert.equal(nothing.label, FIT_LABELS.NOT_EVALUABLE);
  assert.equal(nothing.observedBuyboxFitScore, 0);
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('evidence qualifies a fit but cannot manufacture one', () => {
  const strongEvidence = { ...BUYER, evidenceDepth: 80, buyboxConfidence: 1, behaviorConfidence: 1, daysSinceLast: 1 };
  const weakEvidence = { ...BUYER, evidenceDepth: 3, buyboxConfidence: 0.1, behaviorConfidence: 0.1, daysSinceLast: 2000 };
  assert.ok(evidenceConfidence(strongEvidence) > evidenceConfidence(weakEvidence));

  // Same dimensions, different evidence: score moves only within the band.
  const hi = evaluateBuyerFit(SUBJECT, strongEvidence).observedBuyboxFitScore;
  const lo = evaluateBuyerFit(SUBJECT, weakEvidence).observedBuyboxFitScore;
  assert.ok(hi > lo);
  assert.ok(lo >= hi * EVIDENCE_FLOOR - 0.01, 'evidence must not swing more than the floor allows');

  // Impeccable evidence with zero dimensional fit stays at zero.
  const noMatch = evaluateBuyerFit(SUBJECT, {
    ...strongEvidence, states: ['CA'], counties: [], zips: [], assetFamilies: ['self_storage'],
    priceRobustLow: 1, priceRobustHigh: 2, buildingSqftP25: null, buildingSqftP75: null, unitsP25: null, unitsP75: null });
  assert.equal(noMatch.observedBuyboxFitScore, 0);
});

// 9 ─────────────────────────────────────────────────────────────────────────
test('price cannot rank but caps the claim when outside every band', () => {
  assert.equal(DEFAULT_WEIGHTS.robustPrice, 0, 'backtest refuted price as a ranking input');

  const inside = evaluateBuyerFit(SUBJECT, BUYER);
  const outside = evaluateBuyerFit({ ...SUBJECT, referencePrice: 3271000 }, BUYER);
  // Ranking is unaffected by price...
  assert.equal(inside.observedBuyboxFitScore, outside.observedBuyboxFitScore);
  // ...but the label refuses to overstate.
  assert.equal(inside.label, FIT_LABELS.STRONG);
  assert.equal(outside.label, FIT_LABELS.PARTIAL);
  assert.equal(outside.robustPriceTier, 'above');
  assert.equal(outside.robustPriceFit, 0);
});

// 10 ────────────────────────────────────────────────────────────────────────
test('output uses observed-fit language, never prediction', () => {
  const r = evaluateBuyerFit(SUBJECT, BUYER);
  assert.ok(['strong observed fit', 'partial observed fit', 'weak observed fit', 'not evaluable'].includes(r.label));
  const serialized = JSON.stringify(r) + Object.values(FIT_LABELS).join(' ') + codeOnly(PANEL_TSX);
  for (const banned of [/\bguaranteed\b/i, /\bprobable\b/i, /\blikely to (buy|purchase)\b/i, /\bwill buy\b/i, /\bprobability\b/i]) {
    assert.doesNotMatch(serialized, banned, `prediction language: ${banned}`);
  }
  // Every required field is exposed.
  for (const key of ['geographyFit', 'assetFit', 'robustPriceFit', 'characteristicsFit',
                     'evidenceConfidence', 'observedBuyboxFitScore', 'reasons']) {
    assert.ok(key in r, `missing ${key}`);
  }
  assert.ok(r.reasons.length > 0);
});

// 11 ────────────────────────────────────────────────────────────────────────
test('only buyers with a real buybox are eligible; person ids are redacted', () => {
  // The candidate query selects FROM buyer_buybox, so no-buybox buyers cannot
  // enter the population at all.
  assert.match(CANDIDATES_SRC, /FROM reivesti\.buyer_buybox/);
  assert.doesNotMatch(codeOnly(CANDIDATES_SRC), /comp_private/);

  const person = mapCandidate({ buyer_entity_id: 'person:15090498458', entity_type: 'person', display_name: 'SHOULD NOT SURFACE' });
  assert.match(person.buyerRef, /^person:anon_[0-9a-f]{16}$/);
  assert.ok(!person.buyerRef.includes('15090498458'));
  assert.equal(person.displayName, null, 'natural-person names are never exposed');

  const company = mapCandidate({ buyer_entity_id: 'company:us_tx:1', entity_type: 'company', display_name: 'ACME LLC' });
  assert.equal(company.buyerRef, 'company:us_tx:1');
  assert.equal(company.displayName, 'ACME LLC');
});

// 12 ────────────────────────────────────────────────────────────────────────
test('no raw person identifier can appear in evaluator output', () => {
  const pool = [
    { ...BUYER, buyerRef: 'person:anon_ef2ad473370ed93e', entityType: 'person', displayName: null },
    { ...BUYER, buyerRef: 'company:us_tx:1' },
  ];
  const serialized = JSON.stringify(rankBuyerFits(SUBJECT, pool));
  for (const token of serialized.match(/person:[A-Za-z0-9_:.-]+/g) ?? []) {
    assert.match(token, /^person:anon_[0-9a-f]{16}$/, `raw person id: ${token}`);
  }
  assert.ok(!serialized.includes('15090498458'));
  for (const pii of [/individual_key/i, /\bphone\b/i, /\bemail\b/i, /owner_name/i]) {
    assert.doesNotMatch(serialized, pii);
  }
});

// 13 ────────────────────────────────────────────────────────────────────────
test('the evaluator is pure and cannot reach any decision or write system', () => {
  // Zero imports: it cannot reach a database, the W8C client, or REI at all.
  const imports = [...EVALUATOR_SRC.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], `evaluator must import nothing, found: ${imports.join(', ')}`);

  const DECISION = /(\bmao\b|offer[-_ ]?price|send_queue|send-queue|suppression|campaign|outreach|autopilot|\bdispo\b|match_score|matchGrade)/i;

  // The scoring path must not mention a decision system at all.
  for (const [name, src] of [['evaluator', EVALUATOR_SRC], ['candidates', CANDIDATES_SRC]]) {
    assert.doesNotMatch(codeOnly(src), DECISION, `${name} must not reference a decision system`);
  }

  // The projection legitimately DISPLAYS REI's own matchScore/matchGrade in the
  // side-by-side, so the name check would be wrong there. What must hold is
  // that those values are only ever read straight off the REI candidate — never
  // computed, adjusted, or derived from anything W8C.
  for (const line of codeOnly(PROJECTION_SRC).split('\n')) {
    if (!/matchScore|matchGrade/.test(line)) continue;
    assert.match(line, /candidate\.match(Score|Grade)|r\.matchScore/,
      `matchScore/matchGrade must be pass-through only: ${line.trim()}`);
    assert.doesNotMatch(line, /[+\-*/]\s*\w*[Ff]it|observedBuybox|w8c[A-Z]/,
      `REI match values must not be combined with W8C signal: ${line.trim()}`);
  }
  assert.doesNotMatch(codeOnly(PROJECTION_SRC),
    /(\bmao\b|offer[-_ ]?price|send_queue|send-queue|suppression|campaign|outreach|autopilot|\bdispo\b)/i,
    'projection must not reference a decision system');

  // No writes anywhere in the new stack.
  for (const src of [EVALUATOR_SRC, CANDIDATES_SRC, PROJECTION_SRC]) {
    assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|\.insert\(|\.update\(|\.upsert\(|\.delete\()/i);
  }
  // The UI section is read-only: no actions.
  for (const forbidden of [/onClick/, /<button/i, /contactBuyer/i, /sendDeal/i]) {
    assert.doesNotMatch(PANEL_TSX, forbidden);
  }
  assert.match(PANEL_TSX, /Shadow — does not affect buyer ranking/);
});

// 14 ────────────────────────────────────────────────────────────────────────
test('shadow ranking cannot reorder REI buyer-match output', () => {
  // The evaluator never sees REI candidates: its inputs are W8C buybox records
  // keyed by w8c buyerRef, and it emits no REI identifier at all.
  const r = evaluateBuyerFit(SUBJECT, BUYER);
  assert.equal(r.reiBuyerEntityId, undefined);
  assert.doesNotMatch(JSON.stringify(r), /reiBuyer|match_score|matchGrade/i);
  // Fits live in their own payload section, separate from reiComparison.
  assert.match(PROJECTION_SRC, /observedFits/);
  assert.match(PROJECTION_SRC, /reiComparison: projectComparison/);
});

// 15 ────────────────────────────────────────────────────────────────────────
test('price never reorders buyers, inside or outside the robust band', () => {
  // Two buyers identical on every ranked dimension, differing ONLY in their
  // robust price band. If price leaked into rank, their order would flip when
  // the subject price moves across one of the bands.
  const common = {
    entityType: 'company', states: ['TX'], counties: ['TX|Harris'], zips: ['77520'],
    assetFamilies: ['sfr'], buildingSqftP25: 1200, buildingSqftP75: 2000,
    unitsP25: 1, unitsP75: 1, evidenceDepth: 10,
    buyboxConfidence: 0.8, behaviorConfidence: 0.8, daysSinceLast: 30,
  };
  const inBand = { ...common, buyerRef: 'company:us_tx:aaa', priceRobustLow: 100000, priceRobustHigh: 300000 };
  const outBand = { ...common, buyerRef: 'company:us_tx:bbb', priceRobustLow: 900000, priceRobustHigh: 950000 };

  const cheap = normalizeSubject({ state: 'TX', county: 'Harris', zip: '77520',
    property_type: 'Single Family', units_count: 1, building_square_feet: 1450, estimated_value: 211000 });
  const dear = { ...cheap, referencePrice: 925000 };

  for (const subject of [cheap, dear]) {
    const a = evaluateBuyerFit(subject, inBand);
    const b = evaluateBuyerFit(subject, outBand);
    assert.equal(a.observedBuyboxFitScore, b.observedBuyboxFitScore,
      'identical ranked dimensions must yield identical scores regardless of price band');
  }

  // Order is decided by the deterministic tie-break (buyerRef), not by price:
  // 'aaa' precedes 'bbb' whether the subject is inside aaa's band or bbb's.
  assert.deepEqual(rankBuyerFits(cheap, [inBand, outBand]).map((r) => r.buyerRef),
                   rankBuyerFits(dear,  [inBand, outBand]).map((r) => r.buyerRef));
  assert.deepEqual(rankBuyerFits(dear, [outBand, inBand]).map((r) => r.buyerRef),
                   ['company:us_tx:aaa', 'company:us_tx:bbb']);

  // The DESCRIPTIVE label still reflects price — that is the permitted use.
  assert.equal(evaluateBuyerFit(cheap, inBand).label, FIT_LABELS.STRONG);
  assert.equal(evaluateBuyerFit(cheap, outBand).label, FIT_LABELS.PARTIAL);
});

// 16 ────────────────────────────────────────────────────────────────────────
test('a geography mismatch can never be labelled a strong fit', () => {
  // The failure mode this guards: every other dimension unknown, so the mean is
  // taken over geography alone — a mismatch must stay at zero, not become a
  // vacuous "strong" via an empty denominator.
  const stripped = {
    buyerRef: 'company:us_ca:1', entityType: 'company',
    states: ['CA'], counties: [], zips: [], assetFamilies: [],
    priceRobustLow: null, priceRobustHigh: null,
    buildingSqftP25: null, buildingSqftP75: null, unitsP25: null, unitsP75: null,
    evidenceDepth: 80, buyboxConfidence: 1, behaviorConfidence: 1, daysSinceLast: 1,
  };
  const subject = normalizeSubject({ state: 'TX', county: 'Harris', zip: '77520',
    property_type: 'Single Family', units_count: 1, building_square_feet: 1450, estimated_value: 211000 });

  const r = evaluateBuyerFit(subject, stripped);
  assert.equal(r.geographyTier, 'mismatch');
  assert.equal(r.observedBuyboxFitScore, 0);
  assert.notEqual(r.label, FIT_LABELS.STRONG);
  assert.equal(r.label, FIT_LABELS.WEAK);
  // And it is excluded from a displayed ranking entirely.
  assert.deepEqual(rankBuyerFits(subject, [stripped]), []);

  // Even a partial (state-level) geography hit with everything else unknown
  // must not reach "strong".
  const stateOnly = { ...stripped, states: ['TX'] };
  const s = evaluateBuyerFit(subject, stateOnly);
  assert.equal(s.geographyTier, 'state');
  assert.ok(s.observedBuyboxFitScore < 70, `state-only fit reached ${s.observedBuyboxFitScore}`);
  assert.notEqual(s.label, FIT_LABELS.STRONG);
});

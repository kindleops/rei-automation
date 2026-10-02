/**
 * IC8 comp micro-market challenger: North Minneapolis regression.
 *
 * The owner's case (ZIP 55412): the production engine valued the subject at
 * $362,500 (2026-09-30) and $327,900 (2026-10-01) with 41.6% of the weight on
 * NE/SE Minneapolis sales across the Mississippi, a different price regime.
 * This test asserts BEHAVIOUR, never a hard-coded ARV:
 *   (a) cross-discontinuity comps cannot dominate the weight without an
 *       explicit reason code;
 *   (b) the value interval is not driven by the east-bank regime;
 *   (c) every included and excluded comp carries structured reasons.
 * It also documents the champion replica's behaviour on the same fixture.
 *
 * Hermetic: a de-identified fixture (tests/intelligence/fixtures), no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadNorthMinneapolisFixture, subjectRecord, NORTH_ZIPS, EAST_BANK_ZIPS } from './helpers/north-minneapolis-fixture.mjs';
import { toSale } from '@/lib/domain/intelligence/comps/comp-records.js';
import { haversineKm } from '@/lib/domain/intelligence/comps/geo.js';
import { buildMicroMarketModel } from '@/lib/domain/intelligence/comps/micro-market.js';
import { valueSubjectChallenger, CHALLENGER_PARAMS } from '@/lib/domain/intelligence/comps/challenger.js';
import { valueSubjectChampion, probeEngineWindows } from '@/lib/domain/intelligence/comps/champion-replica.js';
import { REASON, INCLUSION_TIER_CODES, isKnownReasonCode } from '@/lib/domain/intelligence/comps/reason-codes.js';

const fx = loadNorthMinneapolisFixture();
const AS_OF = fx.asOf;
const unionRecords = fx.records.filter((r) => r.dedup?.role !== 'loser');
const sales = unionRecords.map(toSale);
const salesById = new Map(sales.map((s) => [s.id, s]));
const subject = toSale({ ...subjectRecord(fx.subject), sale_date: AS_OF, known_date: AS_OF });
const model = buildMicroMarketModel(sales, { asOf: AS_OF });
const FORCED_4MI = { ...CHALLENGER_PARAMS, radiusLadderMiles: [4], maxRadiusMiles: 4, radiusExtension: 1 };
const result = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: sales, model });
// Stress test: the challenger forced onto the champion's fixed 4-mile disc, so
// every east-bank sale is inside its search universe.
const forced = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: sales, model, params: FORCED_4MI });

const isEastBank = (entry) => EAST_BANK_ZIPS.has(entry.zip);
const includedWeightShare = (res, predicate) => {
  const inc = res.comps.filter((c) => c.included);
  const total = inc.reduce((s, c) => s + c.weight, 0);
  return total > 0 ? inc.filter(predicate).reduce((s, c) => s + c.weight, 0) / total : 0;
};

test('fixture is the de-identified North Minneapolis case', () => {
  assert.equal(fx.subject.zip, '55412');
  assert.ok(fx.records.length > 500, 'fixture carries both banks of evidence');
  assert.equal(fx.records.filter((r) => r.production_set_20261001).length, 12, 'the 12 stored production comps are flagged');
  assert.equal(fx.records.filter((r) => r.production_set_20261001 && EAST_BANK_ZIPS.has(r.zip)).length, 5, 'five of them are east-bank (NE/SE)');
  for (const r of fx.records) {
    assert.equal(r.pid, null);
    assert.equal(r.addr_key, null);
    assert.equal(Math.round(r.lat * 1000) / 1000, r.lat, 'coordinates are rounded');
  }
});

test('the layer learns the river discontinuity from transactions alone', () => {
  const assignment = model.assign(subject.lat, subject.lng, subject.zip);
  assert.notEqual(assignment.micro_market_id, null);
  assert.equal(assignment.confidence, 'strong');
  const dist = model.distancesFrom(subject.lat, subject.lng);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  // Same physical distance band (2.5-6 km), either side of the river.
  const band = (s) => {
    const km = haversineKm(subject.lat, subject.lng, s.lat, s.lng);
    return km >= 2.5 && km <= 6;
  };
  const east = sales.filter((s) => EAST_BANK_ZIPS.has(s.zip) && s.valid && s.family === 'sfr' && band(s));
  const north = sales.filter((s) => NORTH_ZIPS.has(s.zip) && s.valid && s.family === 'sfr' && band(s));
  assert.ok(east.length >= 20 && north.length >= 20, 'both banks have evidence 2.5-6 km away');
  const eff = (s) => {
    const rel = dist.to(s.lat, s.lng);
    return rel.reachable ? rel.effKm : Infinity;
  };
  const eastEff = median(east.map(eff));
  const northEff = median(north.map(eff));
  assert.ok(eastEff >= 1.5 * northEff, `at the same physical distance the east bank is effectively farther (median ${eastEff.toFixed(1)} vs ${northEff.toFixed(1)} km)`);
  // Support-aware level comparison of each east-bank sale's micro-market with the subject's.
  const pairs = east
    .map((s) => dist.to(s.lat, s.lng).micro_market_id)
    .filter((id) => id !== null)
    .map((id) => (id === assignment.micro_market_id ? { gap: 0, significant: false } : model.comparePair(assignment.micro_market_id, id)));
  const supported = pairs.filter((p) => p.gap >= 0.15 && p.significant).length / pairs.length;
  assert.ok(supported >= 0.9, `>= 90% of east-bank sales sit in a supported higher-priced regime (${supported.toFixed(3)})`);
  assert.ok(median(pairs.map((p) => p.gap)) >= 0.15, 'the east-bank level is at least ~16% above the subject micro-market');
  assert.ok(model.summary.boundary_classes.discontinuity > 0, 'discontinuity boundaries are learned');
});

test('(a) cross-discontinuity comps cannot dominate the weight without an explicit reason', () => {
  for (const res of [result, forced]) {
    const retail = res.values.retail;
    assert.ok(retail, 'a retail value is produced from North evidence');
    const crossShare = includedWeightShare(res, (c) => c.tier === 'T4');
    const crossComps = res.comps.filter((c) => c.included && c.tier === 'T4');
    for (const c of crossComps) {
      assert.ok(c.reasons.some((r) => r.code === REASON.CROSS_DISCONTINUITY_FALLBACK), 'a cross-discontinuity comp is only ever included under the explicit fallback code');
    }
    if (crossShare > 0) assert.ok(res.flags.some((f) => f.code === REASON.CROSS_DISCONTINUITY_EVIDENCE_USED), 'cross-discontinuity evidence is flagged on the value');
    assert.ok(crossShare <= 0.25, `cross-discontinuity weight share ${crossShare}`);
    assert.ok(includedWeightShare(res, isEastBank) <= 0.25, 'east-bank sales hold at most a quarter of the weight');
  }
  // The champion held 41.6% here; the challenger, even on the champion's 4-mile disc, holds none.
  assert.equal(includedWeightShare(forced, isEastBank), 0);
});

test('(b) the value interval is not driven by the east-bank regime', () => {
  const withoutEast = sales.filter((s) => !EAST_BANK_ZIPS.has(s.zip));
  for (const [label, params, res] of [['default', CHALLENGER_PARAMS, result], ['forced 4 mi', FORCED_4MI, forced]]) {
    const ablated = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: withoutEast, model, params });
    const [lo, hi] = res.values.retail.intervals.p80;
    const [lo2, hi2] = ablated.values.retail.intervals.p80;
    assert.ok(Math.abs(lo - lo2) / lo2 <= 0.05 && Math.abs(hi - hi2) / hi2 <= 0.05, `${label}: removing every east-bank sale moves the 80% interval by <= 5% ([${lo}, ${hi}] vs [${lo2}, ${hi2}])`);
    // The east-bank retail regime (size-matched) sits above the interval.
    const eastRetail = sales
      .filter((s) => EAST_BANK_ZIPS.has(s.zip) && s.valid && s.family === 'sfr' && s.regime === 'retail' && s.sqft >= 0.75 * subject.sqft && s.sqft <= 1.25 * subject.sqft)
      .map((s) => s.price)
      .sort((a, b) => a - b);
    const eastMedian = eastRetail[Math.floor(eastRetail.length / 2)];
    assert.ok(eastRetail.length >= 10 && hi < eastMedian, `${label}: the interval top ${hi} stays below the size-matched east-bank retail median ${eastMedian}`);
  }
});

test('(c) every included and excluded comp records structured reasons', () => {
  for (const res of [result, forced]) {
    assert.ok(res.comps.length > 100);
    for (const c of res.comps) {
      assert.ok(c.reasons.length >= 1, `comp ${c.id} has a reason`);
      for (const r of c.reasons) {
        assert.ok(isKnownReasonCode(r.code), `known code ${r.code}`);
        assert.equal(typeof r.code, 'string');
        if (r.detail !== undefined) assert.equal(typeof r.detail, 'object');
      }
      if (c.included) {
        assert.equal(c.reasons.filter((r) => INCLUSION_TIER_CODES.includes(r.code)).length, 1, 'one inclusion tier code');
        assert.ok(c.reasons.some((r) => r.code.startsWith('REGIME_')), 'a regime code');
        assert.ok(Number.isFinite(c.weight) && c.weight > 0);
        assert.ok(c.adjustments && Number.isFinite(c.adjusted_price));
      }
    }
  }
  // On the 4-mile disc, every gate-passing east-bank comp is excluded for a
  // micro-market reason carrying the measured level gap.
  const eastConsidered = forced.comps.filter((c) => isEastBank(c) && c.tier);
  assert.ok(eastConsidered.length >= 20);
  for (const c of eastConsidered) {
    assert.equal(c.included, false);
    assert.notEqual(c.tier, 'T1', 'no east-bank sale is ever in the subject micro-market');
    const first = c.reasons[0];
    assert.ok([REASON.ACROSS_DISCONTINUITY, REASON.OTHER_MICRO_MARKET, REASON.LOWER_TIER_NOT_NEEDED, REASON.RANK_BELOW_CUTOFF].includes(first.code), first.code);
    if (first.code === REASON.ACROSS_DISCONTINUITY || first.code === REASON.OTHER_MICRO_MARKET) assert.ok(first.detail.ppsf_gap_pct > 0);
    if (first.code === REASON.RANK_BELOW_CUTOFF) assert.notEqual(first.detail.tier, 'T1');
  }
  const acrossShare = eastConsidered.filter((c) => c.reasons[0].code === REASON.ACROSS_DISCONTINUITY).length / eastConsidered.length;
  assert.ok(acrossShare >= 0.8, `most east-bank comps are excluded as across a learned discontinuity (${acrossShare.toFixed(2)})`);
  // The champion's five east-bank comps are named and excluded in both runs.
  const prodEast = fx.records.filter((r) => r.production_set_20261001 && EAST_BANK_ZIPS.has(r.zip)).map((r) => r.id);
  for (const res of [result, forced]) {
    for (const id of prodEast) {
      const entry = res.comps.find((c) => c.id === id);
      assert.ok(entry, `production comp ${id} is in the universe`);
      assert.equal(entry.included, false);
      assert.ok(entry.reasons.length >= 1);
    }
  }
});

test('investor and retail values are separate and never silently blended', () => {
  const { retail, investor } = result.values;
  assert.ok(retail && investor);
  const inc = result.comps.filter((c) => c.included);
  const retailIds = inc.filter((c) => c.regime === 'retail');
  const investorIds = inc.filter((c) => c.regime === 'investor');
  assert.equal(retailIds.length, retail.n_comps);
  assert.equal(investorIds.length, investor.n_comps);
  assert.equal(result.headline.basis, 'retail');
  assert.ok(investor.value < retail.value, 'the as-is investor regime prices below retail here');
  for (const c of inc) assert.equal(salesById.get(c.id).regime, c.regime);
});

test('champion replica on the same fixture (documentation, not a gate)', (t) => {
  const windows = probeEngineWindows();
  assert.deepEqual([windows.residential.radius_miles, windows.residential.months_back], [4, 30], 'production residential window probed from the engine');
  const pool = fx.records.filter((r) => r.src === 'pool');
  const subj = subjectRecord(fx.subject);
  const runs = {};
  for (const asOf of ['2026-09-30', '2026-10-01']) {
    const r = valueSubjectChampion({ subjectRecord: subj, asOf, records: pool, windows });
    assert.equal(r.method, 'weighted_adjusted_comp_value');
    assert.equal(r.raw_candidate_count, 100, 'top-100 structural candidates, as the RPC');
    const total = r.selected.reduce((s, c) => s + c.weight, 0);
    const east = r.selected.filter((c) => EAST_BANK_ZIPS.has(c.zip)).reduce((s, c) => s + c.weight, 0);
    runs[asOf] = { value: r.value, east_bank_weight_share: Math.round((east / total) * 1000) / 1000, selected: r.selected.length, outlier_center: r.outlier_method?.median ?? null };
  }
  const challengerShare = includedWeightShare(result, isEastBank);
  t.diagnostic(`champion (fixture, rounded data) ${JSON.stringify(runs)}`);
  t.diagnostic(`champion month-boundary move 09-30 -> 10-01: ${runs['2026-10-01'].value - runs['2026-09-30'].value}`);
  t.diagnostic(`challenger retail ${JSON.stringify({ value: result.values.retail.value, p80: result.values.retail.intervals.p80, east_bank_weight_share: challengerShare })}`);
  t.diagnostic(`production stored (unrounded data, documentation only): ${JSON.stringify(fx.productionRecord)}`);
});

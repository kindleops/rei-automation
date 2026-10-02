/**
 * IC8 comp micro-market challenger: small synthetic tests.
 *   - adaptive radius: urban tighter, rural broader;
 *   - asset-type gate: a single-family subject is never priced by multifamily;
 *   - as-of leakage: a sale on or after T is never used, by the challenger,
 *     the micro-market layer, the baseline or the champion replica search.
 * Hermetic and deterministic (seeded synthetic data, no network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toSale } from '@/lib/domain/intelligence/comps/comp-records.js';
import { mulberry32 } from '@/lib/domain/intelligence/comps/stats.js';
import { buildMicroMarketModel } from '@/lib/domain/intelligence/comps/micro-market.js';
import { valueSubjectChallenger } from '@/lib/domain/intelligence/comps/challenger.js';
import { valueSubjectBaseline } from '@/lib/domain/intelligence/comps/baseline.js';
import { championSearch, probeEngineWindows } from '@/lib/domain/intelligence/comps/champion-replica.js';
import { REASON } from '@/lib/domain/intelligence/comps/reason-codes.js';

const KM_PER_DEG_LAT = 111.32;

function record({ id, lat, lng, date, price, sqft = 1600, type = 'Single Family', units = 1, saleType = 'mls', buyer = 'individual', beds = 3, baths = 2, yb = 1950, zip = '99901' }) {
  return {
    id, src: saleType === 'deed' ? 'deeds' : 'pool', region: 'TEST', market: null, pid: `pid-${id}`, addr_key: null, parcel_key: null,
    unit_designator: false, sale_date: date, known_date: date, date_kind: saleType === 'mls' ? 'mls_close' : 'deed_event',
    deed_date: date, mls_date: saleType === 'mls' ? date : null, lat, lng, zip, state: 'XX', property_type: type,
    nac: type === 'Multi-Family' ? 'multifamily' : 'single_family', units, sqft, beds, baths, year_built: yb, eff_year_built: null,
    lot_sqft: null, price, view_sale_price: price, mls_price: saleType === 'mls' ? price : null, price_estimated: false,
    sale_type: saleType, doc_type: null, arms_length: null, nominal_flag: false, distress_flag: false, buyer_type: buyer,
    usable_comp: true, est_value: null, eng: null, package_n: 0, dedup: null,
  };
}

function dateBefore(asOf, days) {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** n sales scattered in a ring [rMinKm, rMaxKm] around (lat, lng), sold in the 330 days before asOf. */
function scatter({ seed, n, lat, lng, rMinKm, rMaxKm, asOf, ppsf = 200, prefix, ...rest }) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = rMinKm + (rMaxKm - rMinKm) * Math.sqrt(rng());
    const a = 2 * Math.PI * rng();
    const dLat = (r * Math.sin(a)) / KM_PER_DEG_LAT;
    const dLng = (r * Math.cos(a)) / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    const sqft = Math.round(1300 + 600 * rng());
    const price = Math.round(ppsf * sqft * (0.9 + 0.2 * rng()));
    out.push(record({ id: `${prefix}${i}`, lat: lat + dLat, lng: lng + dLng, date: dateBefore(asOf, 10 + Math.floor(320 * rng())), price, sqft, ...rest }));
  }
  return out;
}

const AS_OF = '2026-06-01';
const CENTER = { lat: 41.5, lng: -90.5 };
const subjectSale = (overrides = {}) => toSale({ ...record({ id: 'subject', ...CENTER, date: AS_OF, price: null, sqft: 1600 }), ...overrides });

test('adaptive radius: dense urban evidence gives a tighter radius than sparse rural evidence', () => {
  const urban = scatter({ seed: 1, n: 160, ...CENTER, rMinKm: 0.05, rMaxKm: 1.0, asOf: AS_OF, prefix: 'u' }).map(toSale);
  const rural = scatter({ seed: 2, n: 40, ...CENTER, rMinKm: 4, rMaxKm: 16, asOf: AS_OF, prefix: 'r' }).map(toSale);
  const subject = subjectSale();
  const urbanResult = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: urban, model: buildMicroMarketModel(urban, { asOf: AS_OF }) });
  const ruralResult = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: rural, model: buildMicroMarketModel(rural, { asOf: AS_OF }) });
  assert.ok(urbanResult.adaptive_radius.radius_mi <= 1, `urban radius ${urbanResult.adaptive_radius.radius_mi}`);
  assert.ok(ruralResult.adaptive_radius.radius_mi >= 3, `rural radius ${ruralResult.adaptive_radius.radius_mi}`);
  assert.ok(urbanResult.adaptive_radius.radius_mi < ruralResult.adaptive_radius.radius_mi);
  assert.ok(['dense', 'urban'].includes(urbanResult.adaptive_radius.density_class));
  assert.ok(['suburban', 'sparse'].includes(ruralResult.adaptive_radius.density_class));
  assert.ok(urbanResult.headline && ruralResult.headline, 'both produce a value');
  // Urban comps that lie beyond the search radius are excluded with the radius reason.
  const far = urbanResult.comps.filter((c) => c.distance_mi > urbanResult.adaptive_radius.search_radius_mi);
  for (const c of far) assert.equal(c.reasons[0].code, REASON.OUTSIDE_ADAPTIVE_RADIUS);
});

test('asset-type gate: a single-family subject is never priced by multifamily sales', () => {
  // Many cheap-per-sqft 2-4 unit sales right next to the subject, a few SFR sales further out.
  const mf = scatter({ seed: 3, n: 60, ...CENTER, rMinKm: 0.05, rMaxKm: 0.8, asOf: AS_OF, ppsf: 90, type: 'Multi-Family', units: 3, prefix: 'mf' });
  const sfr = scatter({ seed: 4, n: 12, ...CENTER, rMinKm: 0.5, rMaxKm: 1.5, asOf: AS_OF, ppsf: 210, prefix: 's' });
  const sales = [...mf, ...sfr].map(toSale);
  const subject = subjectSale();
  assert.equal(subject.family, 'sfr');
  const res = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: sales, model: buildMicroMarketModel(sales, { asOf: AS_OF }) });
  const included = res.comps.filter((c) => c.included);
  assert.ok(included.length > 0);
  for (const c of included) assert.equal(c.family, 'sfr');
  for (const c of res.comps.filter((x) => x.family === 'mf_2_4')) {
    assert.equal(c.included, false);
    assert.ok(c.reasons.some((r) => r.code === REASON.ASSET_FAMILY_MISMATCH && r.detail.comp_family === 'mf_2_4'));
  }
  // With ONLY multifamily evidence there is no value at all, never a multifamily-priced one.
  const mfOnly = mf.map(toSale);
  const none = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: mfOnly, model: buildMicroMarketModel(mfOnly, { asOf: AS_OF }) });
  assert.equal(none.headline, null);
  assert.ok(none.flags.some((f) => f.code === REASON.INSUFFICIENT_EVIDENCE));
  assert.equal(none.comps.filter((c) => c.included).length, 0);
});

test('as-of leakage: sales on or after T are never used', () => {
  const past = scatter({ seed: 5, n: 120, ...CENTER, rMinKm: 0.05, rMaxKm: 1.2, asOf: AS_OF, prefix: 'p' });
  // Extreme future evidence right next to the subject: on T, and after T.
  const future = [
    record({ id: 'f0', lat: CENTER.lat + 0.0003, lng: CENTER.lng, date: AS_OF, price: 2_000_000 }),
    record({ id: 'f1', lat: CENTER.lat, lng: CENTER.lng + 0.0003, date: '2026-06-20', price: 2_500_000 }),
    record({ id: 'f2', lat: CENTER.lat - 0.0003, lng: CENTER.lng, date: '2026-09-01', price: 40_000 }),
  ];
  const pastSales = past.map(toSale);
  const allSales = [...past, ...future].map(toSale);
  const subject = subjectSale();

  const layerPast = buildMicroMarketModel(pastSales, { asOf: AS_OF });
  const layerAll = buildMicroMarketModel(allSales, { asOf: AS_OF });
  assert.equal(layerAll.fingerprint(), layerPast.fingerprint(), 'the layer is identical with or without future sales');
  assert.equal(layerAll.summary.evidence_sales, layerPast.summary.evidence_sales);

  const clean = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: pastSales, model: layerPast });
  const leaky = valueSubjectChallenger({ subject, asOf: AS_OF, candidates: allSales, model: layerAll });
  assert.deepEqual(leaky.values.retail.intervals, clean.values.retail.intervals);
  assert.equal(leaky.values.retail.value, clean.values.retail.value);
  for (const id of ['f0', 'f1', 'f2']) {
    const entry = leaky.comps.find((c) => c.id === id);
    assert.equal(entry.included, false);
    assert.ok(entry.reasons.some((r) => r.code === REASON.NOT_PRIOR_TO_AS_OF), `${id} excluded as not prior to as-of`);
  }

  const baseClean = valueSubjectBaseline({ subject, asOf: AS_OF, candidates: pastSales });
  const baseLeaky = valueSubjectBaseline({ subject, asOf: AS_OF, candidates: allSales });
  assert.equal(baseLeaky.value, baseClean.value);

  const windows = probeEngineWindows();
  const subjectRecordForEngine = record({ id: 'subject', ...CENTER, date: AS_OF, price: null });
  const search = championSearch({ subjectRecord: subjectRecordForEngine, asOf: AS_OF, records: [...past, ...future], windows });
  assert.ok(search.candidates.length > 0);
  for (const c of search.candidates) assert.ok(c.r.known_date < AS_OF, 'champion replica search is as-of bounded');

  assert.throws(() => valueSubjectChallenger({ subject, asOf: '2026-05-01', candidates: pastSales, model: layerPast }), /micro_market_layer_after_as_of/);
});

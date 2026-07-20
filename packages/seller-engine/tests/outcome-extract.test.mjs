import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractListingOutcomes, buildOutcomeCoverage, PRODUCTION_OUTCOME_SOURCES } from '../outcomes/extract.mjs';

const AS_OF = '2026-01-01T00:00:00Z';
const OBS = '2026-07-01T00:00:00Z';

test('listing outcomes extract sold/expired/price_cut events', () => {
  const ev = extractListingOutcomes([
    { property_id: 'p1', observed_at: '2026-03-01', sold_date: '2026-03-15', sold_price: 250000 },
    { property_id: 'p2', observed_at: '2026-02-01', status: 'Expired', date_updated: '2026-02-10' },
    { property_id: 'p3', observed_at: '2026-02-01', price_cut_abs: 15000, min_list_price_date: '2026-02-05' },
  ], { asOf: AS_OF, observedThrough: OBS });
  assert.deepEqual(ev.map((e) => e.event_key).sort(), ['expired', 'price_cut', 'sold']);
});

test('verified_sale: horizons beyond the observation window are censored, not negative; incomplete identity surfaced', () => {
  const properties = [{ id: 'p1' }, { id: 'p2' }];
  const propMeta = new Map([
    ['p1', { state: 'TN', asset_class: 'single_family', batch: 'b1', identity: 'high' }],
    ['p2', { state: 'GA', asset_class: 'single_family', batch: 'b1', identity: 'none' }],
  ]);
  // as_of near observed_through so the 365d horizon extends past the window
  const cov = buildOutcomeCoverage({
    properties, propMeta, transfersByProperty: new Map(), listingSnapshots: [],
    operationalEvents: [], asOf: '2026-06-01T00:00:00Z', observedThrough: OBS,
  });
  // 365d horizon extends past observed_through => censored, never a fabricated negative
  const h365 = cov.dimensions.horizon['365d'];
  assert.ok(h365.censored > 0, 'unobservable long-horizon outcomes are censored');
  assert.equal(cov.incomplete_identity_properties, 1, 'low/none identity flagged so operational absence stays censored');
});

test('timestamp-safe: an operational event before as-of never counts as a future outcome', () => {
  const cov = buildOutcomeCoverage({
    properties: [{ id: 'p1' }], propMeta: new Map([['p1', { identity: 'high' }]]),
    transfersByProperty: new Map(), listingSnapshots: [],
    operationalEvents: [{ property_id: 'p1', family: 'investor_conversion', event_key: 'offer_accepted', event_ts: '2025-06-01' }],
    asOf: AS_OF, observedThrough: OBS,
  });
  assert.equal(cov.dimensions.outcome_family?.investor_conversion?.positive ?? 0, 0);
});

test('production sources are documented specs, not executed queries', () => {
  assert.ok(PRODUCTION_OUTCOME_SOURCES.investor_conversion.offers.source.includes('offers'));
  assert.ok(PRODUCTION_OUTCOME_SOURCES.reliability_rule.includes('censored'));
});

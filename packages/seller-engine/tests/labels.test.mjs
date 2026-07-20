import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifiedSaleLabels, buildSellerIntentLabels, classifyTransfer, coverageReport } from '../labels/builders.mjs';

const AS_OF = '2026-01-01T00:00:00Z';

test('P2-1A: qualifying transfer -> positive within horizon; censored beyond observation', () => {
  const transfers = new Map([['p1', [{
    id: 't1', sale_date: '2026-03-01', sale_price: 250000,
    price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer',
  }]]]);
  const labels = buildVerifiedSaleLabels({
    propertyIds: ['p1', 'p2'], transfersByProperty: transfers,
    asOf: AS_OF, observedThrough: '2026-07-01T00:00:00Z',
  });
  const p1_90 = labels.find((l) => l.property_id === 'p1' && l.label_key === 'sale_90d' && l.state !== 'excluded');
  assert.equal(p1_90.state, 'positive');
  // p2: no event; 90d window fully observed -> negative; 365d window NOT observed -> censored
  const p2_90 = labels.find((l) => l.property_id === 'p2' && l.label_key === 'sale_90d');
  const p2_365 = labels.find((l) => l.property_id === 'p2' && l.label_key === 'sale_365d');
  assert.equal(p2_90.state, 'negative');
  assert.equal(p2_365.state, 'censored');
});

test('P2-1A exclusions: quitclaim/zero/unreliable are excluded WITH reasons, not negatives', () => {
  assert.equal(classifyTransfer({ sale_price: 0, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }).reason, 'zero_or_nominal_consideration');
  assert.match(classifyTransfer({ sale_price: 100, price_qualifier_class: 'valuation', document_type_group: 'non_arms_length_transfer' }).reason, /separately_classified/);
  assert.equal(classifyTransfer({ sale_price: 100000, price_qualifier_class: 'unusable' }).reason, 'unreliable_price_qualifier');
  assert.match(classifyTransfer({ sale_price: 100000, price_qualifier_class: 'distress_context' }).reason, /distress/);
});

test('event dates, not ingestion: outcome events at/before as-of never label', () => {
  const transfers = new Map([['p1', [{ id: 't0', sale_date: '2025-12-30', sale_price: 200000, price_qualifier_class: 'valuation', document_type_group: 'market_or_standard_transfer' }]]]);
  const labels = buildVerifiedSaleLabels({ propertyIds: ['p1'], transfersByProperty: transfers, asOf: AS_OF, observedThrough: '2027-02-01T00:00:00Z' });
  assert.ok(labels.filter((l) => l.property_id === 'p1').every((l) => l.state === 'negative'));
});

test('P2-1B intent labels: separate keys, censoring honored, coverage report shapes', () => {
  const events = [
    { property_id: 'p1', person_id: 'x', family: 'seller_intent', event_key: 'positive_response', event_ts: '2026-01-15T00:00:00Z', source: 'inbox' },
    { property_id: 'p1', person_id: 'x', family: 'seller_intent', event_key: 'asking_price_given', event_ts: '2026-02-01T00:00:00Z', source: 'inbox' },
  ];
  const labels = buildSellerIntentLabels({ events, asOf: AS_OF, horizonDays: 90, observedThrough: '2026-02-15T00:00:00Z' });
  const pos = labels.filter((l) => l.state === 'positive').map((l) => l.label_key).sort();
  assert.deepEqual(pos, ['asking_price_given', 'positive_response']);
  // window (90d to 2026-04-01) not fully observed by 2026-02-15 -> others censored
  assert.ok(labels.filter((l) => l.state === 'censored').length > 0);
  const rep = coverageReport(labels);
  assert.equal(rep.total, labels.length);
  assert.ok(rep.by_label_key.positive_response);
});
